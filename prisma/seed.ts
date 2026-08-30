import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // policy_config 초기값
  const policies = [
    { key: 'flex_window_start',     value: '08:00', description: '유연근무 시작', isLocked: false },
    { key: 'flex_window_end',       value: '09:00', description: '지각 기준', isLocked: false },
    { key: 'standard_work_hours',   value: '8',     description: '일 기준 근무시간', isLocked: false },
    { key: 'lunch_start',           value: '12:30', description: '점심 시작', isLocked: false },
    { key: 'lunch_end',             value: '13:30', description: '점심 종료', isLocked: false },
    { key: 'weekly_standard_hours', value: '40',    description: '주간 기준시간', isLocked: true },
    { key: 'weekly_max_hours',      value: '52',    description: '주간 최대시간', isLocked: true },
    { key: 'ot_grace_minutes',      value: '60',    description: 'OT 유예시간(분)', isLocked: false },
    { key: 'ot_unit_minutes',       value: '30',    description: 'OT 인정 단위(분)', isLocked: false },
    { key: 'night_shift_start',     value: '22:00', description: '야간 시작', isLocked: false },
    { key: 'ot_rate',               value: '1.5',   description: 'OT 배율', isLocked: false },
    { key: 'night_rate',            value: '0.5',   description: '야간 가산 배율', isLocked: false },
    { key: 'holiday_rate',          value: '1.5',   description: '휴일 기본 배율', isLocked: false },
    { key: 'holiday_excess_rate',   value: '2.0',   description: '휴일 초과 배율', isLocked: false },
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

  // 2026년 공휴일
  const holidays = [
    { date: new Date('2026-01-01'), name: '신정' },
    { date: new Date('2026-02-17'), name: '설날' },
    { date: new Date('2026-03-01'), name: '삼일절' },
    { date: new Date('2026-05-05'), name: '어린이날' },
    { date: new Date('2026-06-06'), name: '현충일' },
    { date: new Date('2026-08-15'), name: '광복절' },
    { date: new Date('2026-10-03'), name: '개천절' },
    { date: new Date('2026-10-09'), name: '한글날' },
    { date: new Date('2026-12-25'), name: '크리스마스' },
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
