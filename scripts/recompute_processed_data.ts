// /api/compute-attendance 라우트가 서버리스 타임아웃으로 실패해서 processed_data 캐시가
// 갱신 안 되는 문제 우회용 — 동일한 로직을 로컬(타임아웃 제한 없음)에서 실행해 DB에 직접 저장.
import { prisma } from '../src/lib/prisma'
import { processRecord } from '../src/lib/processRecord'
import { buildFinalAttrMap } from '../src/lib/attendanceDefaults'
import { buildRecordSet } from '../src/lib/buildRecordSet'
import { DEFAULT_POLICY } from '../src/types/tag'
import type { RawRecord, Employee } from '../src/types/tag'

;(async () => {
  const rawStore = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  if (!rawStore?.data) throw new Error('no attendance_data')
  const stored = rawStore.data as unknown as { employees?: Employee[]; rawRecords?: RawRecord[]; chunkCount?: number }
  const employees = stored.employees ?? []

  let rawRecords: RawRecord[] = []
  if (stored.rawRecords?.length) {
    rawRecords = stored.rawRecords
  } else if (stored.chunkCount) {
    const chunks = await Promise.all(
      Array.from({ length: stored.chunkCount }, (_, i) =>
        prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
          .then(r => (r?.data as { records?: RawRecord[] } | null)?.records ?? [])
          .catch(() => [] as RawRecord[]),
      ),
    )
    rawRecords = chunks.flat()
  }
  console.log('rawRecords:', rawRecords.length)

  const dbRules = await prisma.exceptionRule.findMany()
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  const overrides = await prisma.attendanceOverride.findMany()
  const slackExcs  = await prisma.slackException.findMany()

  // compute-attendance/route.ts, getProcessedRecords.ts와 공용 로직 (buildRecordSet.ts) —
  // 퇴사자 제외 필터를 포함해 세 곳이 항상 동일한 기준으로 병합/합성하도록 통합됨.
  const { records: mergedRecords, slackNoteMap } = buildRecordSet({
    employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy: DEFAULT_POLICY,
  })

  console.log('processing...')
  const processed = mergedRecords.map(r =>
    processRecord(r, DEFAULT_POLICY, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )
  const processedAt = new Date().toISOString()

  await prisma.sharedDataStore.upsert({
    where: { key: 'processed_data' },
    create: { key: 'processed_data', data: { processed, processedAt } as object },
    update: { data: { processed, processedAt } as object },
  })
  console.log(`✅ processed_data 갱신 완료: ${processed.length}건, processedAt=${processedAt}`)
  await prisma.$disconnect()
})().catch(e => { console.error(e); process.exit(1) })
