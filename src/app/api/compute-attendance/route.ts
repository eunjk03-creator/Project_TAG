import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet } from '@/lib/buildRecordSet'
import { upsertAttendanceRows } from '@/lib/upsertAttendanceRows'
import { DEFAULT_POLICY } from '@/types/tag'
import type { PolicySettings, RawRecord, Employee } from '@/types/tag'

// 한 페이지(offset/limit 슬라이스) 처리 + DB 왕복은 몇 초 내로 끝나야 하므로 여유를 넉넉히
// 잡아둔다. 페이지네이션이 도입된 뒤로는 이 값에 걸리는 일이 없어야 정상 — 계속 걸린다면
// RECOMPUTE_PAGE_SIZE(AttendanceSourceContext.tsx)를 줄여야 한다는 신호.
export const maxDuration = 300

interface StoredAttendance {
  employees:   Employee[]
  rawRecords?: RawRecord[]  // legacy: all records in one row
  chunkCount?: number        // new: records split across attendance_records_N keys
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
    const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

    // 3. Load admin overrides + Slack notes, merge (getProcessedRecords.ts와 공용 로직)
    const overrides = await prisma.attendanceOverride.findMany()
    const slackExcs  = await prisma.slackException.findMany()
    const { records: mergedRecords, slackNoteMap } = buildRecordSet({
      employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy,
    })

    // 4. 결정론적 정렬(employeeId, date) — 페이지 경계가 매 요청 동일하게 유지되도록.
    //    이 정렬/슬라이스 자체는 가벼운 JS 배열 연산이라 49,000건이어도 비용이 크지 않다 —
    //    비용이 큰 건 processRecord() 호출이라, 그걸 슬라이스에만 적용해서 요청당 작업량을
    //    실제로 줄인다(이게 B14 타임아웃의 구조적 해결책).
    const sorted = [...mergedRecords].sort((a, b) =>
      a.employeeId === b.employeeId ? a.date.localeCompare(b.date) : a.employeeId.localeCompare(b.employeeId),
    )
    const totalCount = sorted.length
    const effLimit   = rawLimit ?? totalCount
    const slice      = sorted.slice(offset, offset + effLimit)

    // 5. 슬라이스만 처리
    const processed = slice.map(r =>
      processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
    )

    // 6. 새 정규화 테이블에 배치 upsert
    await upsertAttendanceRows(processed)

    const processedAt = new Date().toISOString()
    const done = offset + slice.length >= totalCount

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
