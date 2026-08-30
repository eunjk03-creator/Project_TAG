import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet } from '@/lib/buildRecordSet'
import { upsertAttendanceRows } from '@/lib/upsertAttendanceRows'
import { buildEmployeesAndRawRecords } from '@/lib/recomputeFromNormalized'
import { DEFAULT_POLICY } from '@/types/tag'
import type { PolicySettings, RawRecord, EmployeeAttributeOverrides } from '@/types/tag'

// 한 페이지(offset/limit 슬라이스) 처리 + DB 왕복은 몇 초 내로 끝나야 하므로 여유를 넉넉히
// 잡아둔다. 페이지네이션이 도입된 뒤로는 이 값에 걸리는 일이 없어야 정상 — 계속 걸린다면
// RECOMPUTE_PAGE_SIZE(AttendanceSourceContext.tsx)를 줄여야 한다는 신호.
export const maxDuration = 300

// raw 원본 fetch + override/Slack 병합 + 정렬은 원래 페이지당 1회씩(총 ~28회) 반복되던
// 부분이었다 — 정작 페이지마다 달라지는 건 마지막에 슬라이스하는 processRecord() 호출뿐인데,
// 그 앞의 "전체 데이터셋 기준" 준비 작업을 매번 처음부터 다시 했다. 그 결과 페이지네이션이
// 타임아웃(B14)은 막았지만, 전체 재계산 완료까지 걸리는 총 시간은 오히려 페이지 수(N)배로
// 늘어나 있었다. 여기서 이 준비 작업을 offset=0(재계산 시작) 시점에 한 번만 하고 캐시해뒀다가,
// 이후 페이지들은 그 결과를 읽기만 하도록 바꾼다.
//
// 캐시는 attendance_records_N과 동일한 청크 컨벤션(4,000건/청크)을 따른다 — 병합·정렬된
// 전체 레코드(5만 건 이상, 10MB+)를 한 row에 통째로 넣었더니 이후 페이지가 그 큰 row를
// 다시 읽어올 때 DB 커넥션이 끊기는 문제가 실측으로 확인됐다(2026-08-05). 청크로 쪼개면
// 한 페이지가 필요한 1~2개 청크만 읽으면 되어 훨씬 가볍고, 이미 검증된 패턴이라 안전하다.
const STAGING_CHUNK_SIZE = 4000
const STAGING_META_KEY = 'compute_staging_meta'
const stagingChunkKey = (i: number) => `compute_staging_chunk_${i}`
const STAGING_IO_BATCH = 4  // 청크 읽기/쓰기 동시 실행 개수 — dbPut()의 CHUNK_BATCH_SIZE와 동일 컨벤션

interface StagingMeta {
  totalCount:   number
  chunkCount:   number
  finalAttrMap: [string, EmployeeAttributeOverrides][]
  otExemptIds:  string[]
  slackNoteMap: [string, { note: string; rawText: string }[]][]
}

async function writeStagingChunks(sorted: RawRecord[], meta: StagingMeta): Promise<void> {
  await prisma.sharedDataStore.upsert({
    where:  { key: STAGING_META_KEY },
    create: { key: STAGING_META_KEY, data: meta as unknown as object },
    update: { data: meta as unknown as object },
  })
  for (let start = 0; start < meta.chunkCount; start += STAGING_IO_BATCH) {
    await Promise.all(
      Array.from({ length: Math.min(STAGING_IO_BATCH, meta.chunkCount - start) }, (_, j) => {
        const i = start + j
        const records = sorted.slice(i * STAGING_CHUNK_SIZE, (i + 1) * STAGING_CHUNK_SIZE)
        const key = stagingChunkKey(i)
        return prisma.sharedDataStore.upsert({
          where:  { key },
          create: { key, data: { records } as object },
          update: { data: { records } as object },
        })
      }),
    )
  }
}

async function readStagingChunkRange(startChunk: number, endChunk: number): Promise<RawRecord[]> {
  const out: RawRecord[] = []
  for (let start = startChunk; start <= endChunk; start += STAGING_IO_BATCH) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(STAGING_IO_BATCH, endChunk - start + 1) }, (_, j) =>
        prisma.sharedDataStore.findUnique({ where: { key: stagingChunkKey(start + j) } })
          .then(r => (r?.data as unknown as { records?: RawRecord[] } | null)?.records ?? [])
          .catch(() => [] as RawRecord[]),
      ),
    )
    for (const recs of batch) out.push(...recs)
  }
  return out
}

async function deleteStagingChunks(chunkCount: number): Promise<void> {
  const keys = [STAGING_META_KEY, ...Array.from({ length: chunkCount }, (_, i) => stagingChunkKey(i))]
  await Promise.all(keys.map(key => prisma.sharedDataStore.delete({ where: { key } }).catch(() => {})))
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

    // offset>0인 페이지네이션 호출은 offset=0(재계산 시작) 때 만들어둔 메타 캐시를 먼저
    // 시도한다. 없으면(첫 페이지이거나, 어떤 이유로 비어있으면) 아래에서 처음부터 다시 만든다.
    const cachedMetaRow = isPaginated && offset > 0
      ? await prisma.sharedDataStore.findUnique({ where: { key: STAGING_META_KEY } })
      : null
    const cachedMeta = cachedMetaRow?.data as unknown as StagingMeta | undefined

    let totalCount:   number
    let finalAttrMap: Map<string, EmployeeAttributeOverrides>
    let otExemptIds:  Set<string>
    let slackNoteMap: Map<string, { note: string; rawText: string }[]>
    let sorted: RawRecord[] | null = null  // 전체 배열 — rebuild 시점이거나 마지막 페이지일 때만 채운다
    let chunkCount = 0

    if (cachedMeta) {
      totalCount   = cachedMeta.totalCount
      chunkCount   = cachedMeta.chunkCount
      finalAttrMap = new Map(cachedMeta.finalAttrMap)
      otExemptIds  = new Set(cachedMeta.otExemptIds)
      slackNoteMap = new Map(cachedMeta.slackNoteMap)
    } else {
      // 1. Load raw attendance data — caps_daily_logs/erp_applications(정규화 테이블) 전체
      const { employees, rawRecords } = await buildEmployeesAndRawRecords()

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
      totalCount = sorted.length

      // offset=0(재계산 시작) 시점에만 캐시를 새로 쓴다 — 전체가 한 페이지 안에 끝나면
      // (isPaginated인데도 이미 done) 다음 페이지가 없으니 캐시할 필요가 없다.
      const willNeedMorePages = isPaginated && offset + (rawLimit ?? totalCount) < totalCount
      if (willNeedMorePages) {
        chunkCount = Math.ceil(totalCount / STAGING_CHUNK_SIZE)
        await writeStagingChunks(sorted, {
          totalCount, chunkCount,
          finalAttrMap: [...finalAttrMap.entries()],
          otExemptIds:  [...otExemptIds],
          slackNoteMap: [...slackNoteMap.entries()],
        })
      }
    }

    const effLimit = rawLimit ?? totalCount
    const done     = offset + effLimit >= totalCount

    // 5. 이 페이지가 필요로 하는 레코드만 확보 — rebuild 직후(offset=0)라면 이미 전체를
    // 메모리에 들고 있고, 그 외(캐시 히트)엔 겹치는 청크 1~2개만 읽으면 된다. 마지막
    // 페이지라고 전체를 다시 읽어올 필요는 없다 — 필요한 건 이 페이지의 슬라이스뿐이다.
    let slice: RawRecord[]
    if (sorted) {
      slice = sorted.slice(offset, offset + effLimit)
    } else {
      const startChunk = Math.floor(offset / STAGING_CHUNK_SIZE)
      const endChunk   = Math.min(chunkCount - 1, Math.floor((offset + effLimit - 1) / STAGING_CHUNK_SIZE))
      const covering    = await readStagingChunkRange(startChunk, endChunk)
      const localOffset = offset - startChunk * STAGING_CHUNK_SIZE
      slice = covering.slice(localOffset, localOffset + effLimit)
    }

    // 6. 슬라이스만 처리 — 비용이 큰 processRecord()는 여전히 페이지당 슬라이스에만 적용된다.
    const processed = slice.map(r =>
      processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
    )

    // 7. 새 정규화 테이블에 배치 upsert
    await upsertAttendanceRows(processed)

    const processedAt = new Date().toISOString()

    // 8. 과도기 이중 쓰기 — "한 요청으로 전체 처리"(비페이지네이션 호출, 작은 데이터셋용)일
    // 때만 예전 processed_data blob도 (통짜로) 갱신한다. 페이지네이션 호출(실제 운영 경로)은
    // 슬라이스만 갖고 있어서 여기서 blob을 쓰면 안 됨 — 클라이언트가 전체 페이지를 다 모은 뒤
    // processed_data(메타) + processed_records_N(청크)로 나눠 쓴다
    // (AttendanceSourceContext.tsx의 apiCompute 참고, 2026-08-05 청크 저장으로 전환 — 이전엔
    // 5만 건+ 데이터에서 이 마지막 PUT이 Vercel 4.5MB 본문 제한에 걸려 HTTP 413로 실패했었음).
    if (!isPaginated) {
      await prisma.sharedDataStore.upsert({
        where:  { key: 'processed_data' },
        create: { key: 'processed_data', data: { processed, processedAt } as object },
        update: { data: { processed, processedAt } as object },
      })
    }

    // 마지막 페이지면 캐시 정리 — 다음 재계산은 다시 offset=0부터 새로 만든다.
    if (isPaginated && done && chunkCount > 0) {
      await deleteStagingChunks(chunkCount)
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
