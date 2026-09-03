import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // policy_config 초기값 — PolicySettings 스칼라 필드(camelCase key)는 policyStore.ts의
  // SCALAR_KEYS와 1:1 대응. 그 외(weekly_*, batch_schedule 등)는 근태 계산 미사용, 향후
  // 기능용으로 그대로 둔다.
  const policies = [
    { key: 'flexStart',           value: '08:00', description: '유연근무 시작', isLocked: false },
    { key: 'flexEnd',             value: '09:00', description: '지각 기준', isLocked: false },
    { key: 'lunchStart',          value: '12:30', description: '점심 시작', isLocked: false },
    { key: 'lunchEnd',            value: '13:30', description: '점심 종료', isLocked: false },
    { key: 'standardHours',       value: '8',     description: '일 기준 근무시간', isLocked: false },
    { key: 'dinnerGraceMinutes',  value: '60',    description: '저녁 유예시간(분)', isLocked: false },
    { key: 'otUnitMinutes',       value: '30',    description: 'OT 인정 단위(분)', isLocked: false },
    { key: 'nightStart',          value: '22:00', description: '야간 시작', isLocked: false },
    { key: 'nightEnd',            value: '06:00', description: '야간 종료', isLocked: false },
    { key: 'otRate',              value: '1.5',   description: 'OT 배율', isLocked: false },
    { key: 'nightRate',           value: '0.5',   description: '야간 가산 배율', isLocked: false },
    { key: 'holidayRate',         value: '1.5',   description: '휴일 기본 배율', isLocked: false },
    { key: 'holidayExcessRate',   value: '2.0',   description: '휴일 초과 배율', isLocked: false },
    // OT 엔진 통합(2026-09) — processRecord.ts/attendanceCalc.ts에 하드코딩돼 있던 리터럴을
    // 승격한 값. 여기 값은 기존 하드코딩과 정확히 같아야 한다(verify_policy_refactor_no_diff.mjs로
    // 실데이터 46,385건 기준 diff 0건 확인됨).
    { key: 'otBreakLunchThresholdMins', value: '240', description: '4-1-4-1 휴게: 점심 구간 시작(분)', isLocked: false },
    { key: 'otBreakDinnerThresholdMins', value: '540', description: '4-1-4-1 휴게: 저녁 구간 시작(분)', isLocked: false },
    { key: 'otBreakCapMins',      value: '60',    description: '4-1-4-1 휴게: 구간별 상한(분)', isLocked: false },
    { key: 'amPmLeaveMinStayMins', value: '240',  description: '오전/오후반차 최소체류(분)', isLocked: false },
    { key: 'amQuarterLeaveMinStayMins', value: '360', description: '오전/오후반반차 필요근무(분)', isLocked: false },
    { key: 'pmQuarterLeaveMinStayMins', value: '420', description: '오후반반차 미달 판정 기준(분)', isLocked: false },
    { key: 'insufficientGraceMins', value: '60',  description: '근무시간 미달 판정 유예(분)', isLocked: false },
    { key: 'pregnantReducedStdHours', value: '6', description: '임신부 단축근무 표준시간(h)', isLocked: false },
    { key: 'pregnantAnomalyFloorMins', value: '360', description: '임신부 이상치 판정 최소 실근무(분)', isLocked: false },
    { key: 'tenAmStarterFlexEnd', value: '10:00', description: '10시 출근자 지각기준', isLocked: false },
    { key: 'fixedScheduleAStart', value: '08:00', description: '고정스케줄 A 출근시각', isLocked: false },
    { key: 'fixedScheduleABreakMins', value: '30', description: '고정스케줄 A 휴게(분)', isLocked: false },
    { key: 'fixedScheduleBStart', value: '08:30', description: '고정스케줄 B 출근시각', isLocked: false },
    { key: 'offsiteStdEndTime',   value: '18:00', description: '외근 기본 퇴근시각', isLocked: false },
    { key: 'weekly_standard_hours', value: '40',    description: '주간 기준시간', isLocked: true },
    { key: 'weekly_max_hours',      value: '52',    description: '주간 최대시간', isLocked: true },
    { key: 'batch_schedule',        value: '0 2 * * *', description: 'CAPS 배치 크론', isLocked: false },
    { key: 'slack_poll_interval',   value: '30',    description: 'Slack 폴링(분)', isLocked: false },
    { key: 'escalation_hours',      value: '24',    description: '자동 에스컬레이션(시간)', isLocked: false },
  ]

  for (const p of policies) {
    await prisma.policyConfig.upsert({
      where: { key: p.key },
      update: {},
      create: p,
    })
  }
  console.log('✅ policy_config 시드 완료')

  // 회사지정휴일(companyHolidays) — 표준 국경일(신정/설날 등)은 여기가 아니라
  // src/data/mockData.ts의 하드코딩 HOLIDAYS Set이 별도로 처리한다(범위 밖).
  // 아래는 실제로 등록돼 있던 회사지정휴일 13건(2026-08-30 복구 스크립트 기준).
  const holidays = [
    { date: new Date('2026-01-16'), name: '회사 지정 휴일' },
    { date: new Date('2026-02-13'), name: '회사 지정 휴일' },
    { date: new Date('2026-03-02'), name: '회사 지정 휴일' },
    { date: new Date('2026-03-20'), name: '회사 지정 휴일' },
    { date: new Date('2026-04-17'), name: '회사 지정 휴일' },
    { date: new Date('2026-05-22'), name: '회사 지정 휴일' },
    { date: new Date('2026-05-25'), name: '회사 지정 휴일' },
    { date: new Date('2026-06-03'), name: '회사 지정 휴일' },
    { date: new Date('2026-06-19'), name: '회사 지정 휴일' },
    { date: new Date('2026-07-16'), name: '회사 지정 휴일' },
    { date: new Date('2026-07-17'), name: '회사 지정 휴일' },
    { date: new Date('2026-08-14'), name: '회사 지정 휴일' },
    { date: new Date('2026-08-17'), name: '회사 지정 휴일' },
  ]

  for (const h of holidays) {
    await prisma.holiday.upsert({
      where: { date: h.date },
      update: {},
      create: h,
    })
  }
  console.log('✅ 공휴일 시드 완료')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
