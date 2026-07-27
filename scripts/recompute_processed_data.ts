// /api/compute-attendance 라우트가 서버리스 타임아웃으로 실패해서 processed_data 캐시가
// 갱신 안 되는 문제 우회용 — 동일한 로직을 로컬(타임아웃 제한 없음)에서 실행해 DB에 직접 저장.
import { prisma } from '../src/lib/prisma'
import { processRecord } from '../src/lib/processRecord'
import { buildFinalAttrMap } from '../src/lib/attendanceDefaults'
import { leaveTypeOverrideFields, synthesizeOverrideRecord } from '../src/utils/attendanceCalc'
import { getDayInfo } from '../src/utils/dataParser'
import { DEFAULT_POLICY } from '../src/types/tag'

;(async () => {
  const rawStore = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  if (!rawStore?.data) throw new Error('no attendance_data')
  const stored = rawStore.data as any
  const employees = stored.employees ?? []

  let rawRecords: any[] = []
  if (stored.rawRecords?.length) {
    rawRecords = stored.rawRecords
  } else if (stored.chunkCount) {
    const chunks = await Promise.all(
      Array.from({ length: stored.chunkCount }, (_, i) =>
        prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
          .then(r => (r?.data as any)?.records ?? [])
          .catch(() => []),
      ),
    )
    rawRecords = chunks.flat()
  }
  console.log('rawRecords:', rawRecords.length)

  const dbRules = await prisma.exceptionRule.findMany()
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  const overrides = await prisma.attendanceOverride.findMany()
  const overrideMap = new Map(overrides.map(ov => [`${ov.employeeId}_${ov.workDate}`, ov]))
  const overridden = rawRecords.map(r => {
    const ov = overrideMap.get(`${r.employeeId}_${r.date}`)
    if (!ov) return r
    return {
      ...r,
      clockIn: ov.clockIn ?? r.clockIn,
      clockOut: ov.clockOut ?? r.clockOut,
      erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      // erpLeaveType 반영 누락 버그 수정 (compute-attendance/route.ts와 동일한 fix)
      ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
    }
  })

  // 원본 CAPS/ERP 행이 아예 없는 override(결근일/주말 수기입력) 합성 — DEFAULT_POLICY라
  // companyHolidays가 항상 빈 배열이라, 합성 레코드가 회사 지정 공휴일과 겹치면 dayType이
  // WEEKDAY로 잡힐 수 있음(기존 이 스크립트의 다른 레코드들도 동일한 한계).
  const companyHolsMap = new Map<string, string>()
  const rawKeys = new Set(rawRecords.map((r: any) => `${r.employeeId}_${r.date}`))
  const synthesizedRecords: any[] = []
  for (const ov of overrides) {
    if (ov.reasonLabel === '__DELETED__') continue
    const key = `${ov.employeeId}_${ov.workDate}`
    if (rawKeys.has(key)) continue
    if (!ov.clockIn && !ov.clockOut && !ov.erpLeaveType) continue
    const { dayType, dayLabel } = getDayInfo(ov.workDate, companyHolsMap)
    synthesizedRecords.push(synthesizeOverrideRecord(ov.employeeId, ov.workDate, dayType, dayLabel, ov))
  }

  const slackExcs = await prisma.slackException.findMany()
  const slackNoteMap = new Map<string, { note: string; rawText: string }[]>()
  for (const s of slackExcs) {
    const key = `${s.empId}_${s.date}`
    const arr = slackNoteMap.get(key) ?? []
    arr.push({ note: s.note, rawText: s.rawText })
    slackNoteMap.set(key, arr)
  }

  console.log('processing...')
  const processed = [...overridden, ...synthesizedRecords].map(r =>
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
