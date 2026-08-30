/**
 * daily_attendance 전체 재계산 — caps_daily_logs/erp_applications(정규화 테이블) 기준.
 * /api/compute-attendance와 완전히 같은 파이프라인(buildEmployeesAndRawRecords →
 * buildFinalAttrMap → buildRecordSet → processRecord → upsertAttendanceRows)을 로컬에서
 * 페이지네이션 없이 한 번에 돈다 — Vercel 서버리스 타임아웃 걱정이 없는 로컬 실행이라
 * 굳이 나눌 필요가 없다.
 *
 * 실행: npx tsx scripts/recompute_all_from_normalized.ts
 */
import { prisma } from '../src/lib/prisma'
import { processRecord } from '../src/lib/processRecord'
import { buildFinalAttrMap } from '../src/lib/attendanceDefaults'
import { buildRecordSet } from '../src/lib/buildRecordSet'
import { upsertAttendanceRows } from '../src/lib/upsertAttendanceRows'
import { buildEmployeesAndRawRecords } from '../src/lib/recomputeFromNormalized'
import { DEFAULT_POLICY } from '../src/types/tag'

async function main() {
  console.log('caps_daily_logs/erp_applications → RawRecord[] 로딩 중...')
  const { employees, rawRecords, skippedCount, erpOtMatchCount } = await buildEmployeesAndRawRecords()
  console.log(`직원 ${employees.length}명, RawRecord ${rawRecords.length}건 (스킵 ${skippedCount}건, ERP연장매칭 ${erpOtMatchCount}건)`)

  console.log('예외규칙/override/Slack 로딩 중...')
  const [dbRules, overrides, slackExcs] = await Promise.all([
    prisma.exceptionRule.findMany(),
    prisma.attendanceOverride.findMany(),
    prisma.slackException.findMany(),
  ])
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  console.log('병합 중 (override/합성 레코드/퇴사자 필터)...')
  const { records: mergedRecords, slackNoteMap } = buildRecordSet({
    employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy: DEFAULT_POLICY,
  })
  console.log(`병합 결과 ${mergedRecords.length}건`)

  console.log('processRecord() 계산 중...')
  const processed = mergedRecords.map(r =>
    processRecord(r, DEFAULT_POLICY, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )

  console.log('daily_attendance upsert 중...')
  const count = await upsertAttendanceRows(processed)
  console.log(`✅ 완료: ${count}건 upsert`)

  const total = await prisma.dailyAttendance.count()
  console.log(`daily_attendance 전체 행 수: ${total}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
