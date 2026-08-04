import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet } from '@/lib/buildRecordSet'
import { upsertAttendanceRows } from '@/lib/upsertAttendanceRows'
import { DEFAULT_POLICY } from '@/types/tag'
import type { PolicySettings, RawRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'

// 한 페이지(offset/limit 슬라이스) 처리 + DB 왕복은 몇 초 내로 끝나야 하므로 여유를 넉넉히
// 잡아둔다. 페이지네이션이 도입된 뒤로는 이 값에 걸리는 일이 없어야 정상 — 계속 걸린다면
// RECOMPUTE_PAGE_SIZE(AttendanceSourceContext.tsx)를 줄여야 한다는 신호.
export const maxDuration = 300

interface StoredAttendance {
  employees:   Employee[]
  rawRecords?: RawRecord[]  // legacy: all records in one row
  chunkCount?: number        // new: records split across attendance_records_N keys
}

// raw 원본 fetch + override/Slack 병합 + 정렬은 원래 페이지당 1회씩(총 ~28회) 반복되던
// 부분이었다 — 정작 페이지마다 달라지는 건 마지막에 슬라이스하는 processRecord() 호출뿐인데,
// 그 앞의 "전체 데이터셋 기준" 준비 작업을 매번 처음부터 다시 했다. 그 결과 페이지네이션이
// 타임아웃(B14)은 막았지만, 전체 재계산 완료까지 걸리는 총 시간은 오히려 페이지 수(N)배로
// 늘어나 있었다. 여기서 이 준비 작업을 offset=0(재계산 시작) 시점에 한 번만 하고
// compute_staging 키에 캐시해뒀다가, 이후 페이지들은 그 결과를 읽기만 하도록 바꾼다.
const STAGING_KEY = 'compute_staging'

interface ComputeStaging {
  sorted:       RawRecord[]
  finalAttrMap: [string, EmployeeAttributeOverrides][]
  otExemptIds:  string[]
  slackNoteMap: [string, { note: string; rawText: string }[]][]
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { policy: rawPolicy, offset: rawOffset, limit: rawLimit } = body as {
      policy?: Partial<PolicySettings>
      /** 지정하면 정렬된 전체 레코드 중 [offset, offset+limit) 슬라이스만 처리·upsert하고
       *  반환한다. 생략하면 기존처럼 전체를 한 요청에서 처리(작은 데이터셋/하위호환용). */
      offset?: number
      limit?:  number
    }
    const policy: PolicySettings = { ...DEFAULT_POLICY, ...(rawPolicy ?? {}) }
    const isPaginated = rawLimit != null
    const offset = rawOffset ?? 0

    // offset>0인 페이지네이션 호출은 offset=0(재계산 시작) 때 만들어둔 캐시를 먼저 시도한다.
    // 캐시가 없으면(첫 페이지이거나, 어떤 이유로 비어있으면) 아래에서 처음부터 다시 만든다.
    const cachedRow = isPaginated && offset > 0
      ? await prisma.sharedDataStore.findUnique({ where: { key: STAGING_KEY } })
      : null
    const cached = cachedRow?.data as unknown as ComputeStaging | undefined

    let sorted:       RawRecord[]
    let finalAttrMap: Map<string, EmployeeAttributeOverrides>
    let otExemptIds:  Set<string>
    let slackNoteMap: Map<string, { note: string; rawText: string }[]>

    if (cached) {
      sorted       = cached.sorted
      finalAttrMap = new Map(cached.finalAttrMap)
      otExemptIds  = new Set(cached.otExemptIds)
      slackNoteMap = new Map(cached.slackNoteMap)
    } else {
      // 1. Load raw attendance data
      const rawStore = await prisma.sharedDataStore.findUnique({
        where: { key: 'attendance_data' },
      })
      if (!rawStore?.data) {
        return NextResponse.json({ error: 'no attendance data found' }, { status: 404 })
      }

      const stored = rawStore.data as unknown as StoredAttendance
      const employees: Employee[] = stored.employees ?? []

      // Support both legacy (rawRecords in one row) and new chunked format
      let rawRecords: RawRecord[] = []
      if (stored.rawRecords?.length) {
        rawRecords = stored.rawRecords
      } else if (stored.chunkCount != null && stored.chunkCount > 0) {
        const chunkRows = await Promise.all(
          Array.from({ length: stored.chunkCount }, (_, i) =>
            prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
              .then(r => {
                const d = r?.data as unknown as { records?: RawRecord[] } | null
                return d?.records ?? []
              })
              .catch(() => [] as RawRecord[]),
          ),
        )
        rawRecords = chunkRows.flat()
      }

      if (!rawRecords.length) {
        return NextResponse.json({ ok: true, count: 0, totalCount: 0, offset: 0, done: true, processed: [], processedAt: new Date().toISOString() })
      }

      // 2. Load exception rules and build attribute maps
      const dbRules = await prisma.exceptionRule.findMany()
      const built = buildFinalAttrMap(employees, dbRules)
      finalAttrMap = built.finalAttrMap
      otExemptIds  = built.otExemptIds

      // 3. Load admin overrides + Slack notes, merge (getProcessedRecords.ts와 공용 로직)
      const overrides = await prisma.attendanceOverride.findMany()
      const slackExcs  = await prisma.slackException.findMany()
      const built2 = buildRecordSet({
        employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy,
      })
      slackNoteMap = built2.slackNoteMap

      // 4. 결정론적 정렬(employeeId, date) — 페이지 경계가 매 요청 동일하게 유지되도록.
      sorted = [...built2.records].sort((a, b) =>
        a.employeeId === b.employeeId ? a.date.localeCompare(b.date) : a.employeeId.localeCompare(b.employeeId),
      )

      // offset=0(재계산 시작) 시점에만 캐시를 새로 쓴다 — 이후 페이지들이 재사용.
      // 비페이지네이션(단발성) 호출은 어차피 한 번에 끝나므로 캐시할 필요가 없다.
      if (isPaginated) {
        const staging: ComputeStaging = {
          sorted,
          finalAttrMap: [...finalAttrMap.entries()],
          otExemptIds:  [...otExemptIds],
          slackNoteMap: [...slackNoteMap.entries()],
        }
        await prisma.sharedDataStore.upsert({
          where:  { key: STAGING_KEY },
          create: { key: STAGING_KEY, data: staging as unknown as object },
          update: { data: staging as unknown as object },
        })
      }
    }

    const totalCount = sorted.length
    const effLimit   = rawLimit ?? totalCount
    const slice      = sorted.slice(offset, offset + effLimit)

    // 5. 슬라이스만 처리 — 비용이 큰 processRecord()는 여전히 페이지당 슬라이스에만 적용된다.
    const processed = slice.map(r =>
      processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
    )

    // 6. 새 정규화 테이블에 배치 upsert
    await upsertAttendanceRows(processed)

    const processedAt = new Date().toISOString()
    const done = offset + slice.length >= totalCount

    // 마지막 페이지면 캐시 정리 — 다음 재계산은 다시 offset=0부터 새로 만든다.
    if (isPaginated && done) {
      await prisma.sharedDataStore.delete({ where: { key: STAGING_KEY } }).catch(() => {})
    }

    // 7. 과도기 이중 쓰기 — "한 요청으로 전체 처리"(비페이지네이션 호출)일 때만 예전
    // processed_data blob도 갱신한다. 페이지네이션 호출은 슬라이스만 갖고 있어서 여기서
    // blob을 쓰면 안 됨 — 클라이언트가 전체 페이지를 다 모은 뒤 한 번만 써야 한다
    // (AttendanceSourceContext.tsx의 apiCompute 참고). useProcessedAttendance.ts가
    // DailyAttendance를 직접 읽도록 전환되면(Phase C) 이 블록은 제거될 예정.
    if (!isPaginated) {
      await prisma.sharedDataStore.upsert({
        where:  { key: 'processed_data' },
        create: { key: 'processed_data', data: { processed, processedAt } as object },
        update: { data: { processed, processedAt } as object },
      })
    }

    return NextResponse.json({ ok: true, count: processed.length, totalCount, offset, done, processed, processedAt })
  } catch (err) {
    console.error('[compute-attendance] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    )
  }
}
