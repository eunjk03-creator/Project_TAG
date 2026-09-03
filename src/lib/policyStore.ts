/**
 * PolicySettings ↔ policy_config/holidays DB 매핑. 스칼라 12개 필드는 policy_config에
 * key(camelCase 필드명)/value(문자열) 행으로, companyHolidays는 holidays 테이블 행으로 저장한다.
 * slackGroupMap은 이 스토어 범위 밖(localStorage 유지) — 자세한 배경은
 * plans/functional-roaming-boot.md 참고.
 */
import { prisma } from '@/lib/prisma'
import { DEFAULT_POLICY, type PolicySettings, type CompanyHoliday } from '@/types/tag'

type ScalarKey = 'flexStart' | 'flexEnd' | 'lunchStart' | 'lunchEnd' | 'standardHours'
  | 'dinnerGraceMinutes' | 'otUnitMinutes' | 'nightStart' | 'nightEnd'
  | 'otRate' | 'nightRate' | 'holidayRate' | 'holidayExcessRate'
  | 'otBreakLunchThresholdMins' | 'otBreakDinnerThresholdMins' | 'otBreakCapMins'
  | 'amPmLeaveMinStayMins' | 'amQuarterLeaveMinStayMins' | 'pmQuarterLeaveMinStayMins'
  | 'insufficientGraceMins' | 'pregnantReducedStdHours' | 'pregnantAnomalyFloorMins'
  | 'tenAmStarterFlexEnd' | 'fixedScheduleAStart' | 'fixedScheduleABreakMins'
  | 'fixedScheduleBStart' | 'offsiteStdEndTime'

const SCALAR_KEYS: ScalarKey[] = [
  'flexStart', 'flexEnd', 'lunchStart', 'lunchEnd', 'standardHours',
  'dinnerGraceMinutes', 'otUnitMinutes', 'nightStart', 'nightEnd',
  'otRate', 'nightRate', 'holidayRate', 'holidayExcessRate',
  'otBreakLunchThresholdMins', 'otBreakDinnerThresholdMins', 'otBreakCapMins',
  'amPmLeaveMinStayMins', 'amQuarterLeaveMinStayMins', 'pmQuarterLeaveMinStayMins',
  'insufficientGraceMins', 'pregnantReducedStdHours', 'pregnantAnomalyFloorMins',
  'tenAmStarterFlexEnd', 'fixedScheduleAStart', 'fixedScheduleABreakMins',
  'fixedScheduleBStart', 'offsiteStdEndTime',
]

const NUMERIC_KEYS = new Set<ScalarKey>([
  'standardHours', 'dinnerGraceMinutes', 'otUnitMinutes', 'otRate', 'nightRate',
  'holidayRate', 'holidayExcessRate',
  'otBreakLunchThresholdMins', 'otBreakDinnerThresholdMins', 'otBreakCapMins',
  'amPmLeaveMinStayMins', 'amQuarterLeaveMinStayMins', 'pmQuarterLeaveMinStayMins',
  'insufficientGraceMins', 'pregnantReducedStdHours', 'pregnantAnomalyFloorMins',
  'fixedScheduleABreakMins',
])

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function getPolicyFromDB(): Promise<PolicySettings> {
  const [rows, holidayRows] = await Promise.all([
    prisma.policyConfig.findMany({ where: { key: { in: SCALAR_KEYS } } }),
    prisma.holiday.findMany({ orderBy: { date: 'asc' } }),
  ])

  const scalars: Partial<Pick<PolicySettings, ScalarKey>> = {}
  for (const row of rows) {
    const key = row.key as ScalarKey
    ;(scalars as Record<ScalarKey, string | number>)[key] =
      NUMERIC_KEYS.has(key) ? Number(row.value) : row.value
  }

  const companyHolidays: CompanyHoliday[] = holidayRows.map(h => ({
    date: toDateOnlyString(h.date),
    label: h.name,
  }))

  return { ...DEFAULT_POLICY, ...scalars, companyHolidays }
}

export async function savePolicyToDB(policy: PolicySettings, updatedBy?: string): Promise<void> {
  await prisma.$transaction(
    SCALAR_KEYS.map(key => {
      const value = String(policy[key])
      return prisma.policyConfig.upsert({
        where: { key },
        update: { value, updatedBy },
        create: { key, value, updatedBy },
      })
    }),
  )

  const incoming = policy.companyHolidays ?? []
  const incomingByDate = new Map(incoming.map(h => [h.date, h]))
  const existing = await prisma.holiday.findMany()
  const existingByDate = new Map(existing.map(h => [toDateOnlyString(h.date), h]))

  const toDelete = existing.filter(h => !incomingByDate.has(toDateOnlyString(h.date)))
  const toCreate = incoming.filter(h => !existingByDate.has(h.date))
  const toUpdate = incoming.filter(h => {
    const cur = existingByDate.get(h.date)
    return cur && cur.name !== h.label
  })

  await prisma.$transaction([
    ...toDelete.map(h => prisma.holiday.delete({ where: { id: h.id } })),
    ...toCreate.map(h => prisma.holiday.create({ data: { date: new Date(h.date), name: h.label } })),
    ...toUpdate.map(h => prisma.holiday.update({
      where: { date: new Date(h.date) },
      data: { name: h.label },
    })),
  ])
}
