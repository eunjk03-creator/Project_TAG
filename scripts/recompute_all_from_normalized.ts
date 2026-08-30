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
import type { CompanyHoliday } from '../src/types/tag'

// ⚠️ companyHolidays(회사 지정 휴일)는 DB 어디에도 저장되지 않고 PolicyContext가 브라우저
// localStorage에만 들고 있다 — 서버는 /api/compute-attendance 호출 시 클라이언트가 요청
// body로 보내주는 값만 그때그때 받아쓴다. 이 로컬 스크립트는 그 localStorage에 접근할 수
// 없어서, 이번 정규화 마이그레이션 직전 백업(daily_attendance.json)에서 실제로 HOLIDAY로
// 계산됐던 날짜 중 표준 공휴일이 아닌 13개를 역추출해 하드코딩했다(2026-08-30, 백업
// backups/pre_normalize_2026-08-30T07-55-54-135Z 기준) — 정확한 원래 라벨은 어디에도
// 남아있지 않아 전부 "회사 지정 휴일"로 통일. 이후 실제 재계산은 관리자가 화면에서
// "전체 재계산" 버튼을 눌러야 이 목록이 다시 정확히 반영된다(PolicyContext 설정 화면에서
// 재입력 필요) — companyHolidays를 DB에 영구 저장하도록 바꾸는 게 근본적인 해결책.
const RECOVERED_COMPANY_HOLIDAYS: CompanyHoliday[] = [
  '2026-01-16', '2026-02-13', '2026-03-02', '2026-03-20', '2026-04-17', '2026-05-22',
  '2026-05-25', '2026-06-03', '2026-06-19', '2026-07-16', '2026-07-17', '2026-08-14', '2026-08-17',
].map(date => ({ date, label: '회사 지정 휴일' }))

const policy = { ...DEFAULT_POLICY, companyHolidays: RECOVERED_COMPANY_HOLIDAYS }

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
    employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy,
  })
  console.log(`병합 결과 ${mergedRecords.length}건`)

  console.log('processRecord() 계산 중...')
  const processed = mergedRecords.map(r =>
    processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
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
