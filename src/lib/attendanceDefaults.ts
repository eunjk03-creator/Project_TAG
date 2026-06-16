import type { EmployeeAttributeOverrides } from '@/types/tag'

export const DEFAULT_GLOBAL_EXCLUSIONS = new Set([
  'E22100401','E22082202','E24010202','E23080702','E24031802',
  'E22061503','E24031806','E24010203','E18090302','E24111802','E24100705',
])
export const DEFAULT_FIXED_A  = new Set(['E25122301'])
export const DEFAULT_FIXED_B  = new Set(['E26030501','E24011001'])
export const DEFAULT_PREGNANT = new Set<string>([
  // 임신기단축근로 대상자는 DB exception_rules(pregnant_reduced)에서 날짜 범위로 관리
  // 하드코딩 제거: E25060901, E22080101, E25060902
])

/** Maps ExceptionRule.ruleType → EmployeeAttributeOverrides fields (server-side replication of context logic). */
export function buildAttrMapFromRules(
  rules: {
    employeeId:    string
    employeeName:  string
    ruleType:      string
    excludeFromOt: boolean
    shortenedHours: number
    validFrom:     string
    validTo:       string
  }[],
): Map<string, EmployeeAttributeOverrides> {
  const merged = new Map<string, EmployeeAttributeOverrides>()
  for (const rule of rules) {
    const ex = merged.get(rule.employeeId) ?? {}
    switch (rule.ruleType) {
      case 'manager_exemption':
        merged.set(rule.employeeId, { ...ex, isLeader: rule.excludeFromOt ? true : ex.isLeader })
        break
      case 'shortened_hours':
        merged.set(rule.employeeId, {
          ...ex, isShortenedHours: true,
          shortenedHoursValue: rule.shortenedHours,
          shortenedHoursFrom:  rule.validFrom || undefined,
          shortenedHoursTo:    rule.validTo   || undefined,
        })
        break
      case 'ten_am_starter':
        merged.set(rule.employeeId, { ...ex, isTenAMStarter: true })
        break
      case 'dispatched_worker':
        merged.set(rule.employeeId, {
          ...ex, isDispatchedWorker: true,
          dispatchedWorkerFrom: rule.validFrom || undefined,
          dispatchedWorkerTo:   rule.validTo   || undefined,
        })
        break
      case 'parental_leave':
        merged.set(rule.employeeId, {
          ...ex, isParentalLeave: true,
          parentalLeaveFrom: rule.validFrom || undefined,
          parentalLeaveTo:   rule.validTo   || undefined,
        })
        break
      case 'easy_logis':
        merged.set(rule.employeeId, { ...ex, isEasyLogis: true })
        break
      case 'fixed_schedule_a':
        merged.set(rule.employeeId, { ...ex, isFixedScheduleA: true })
        break
      case 'fixed_schedule_b':
        merged.set(rule.employeeId, { ...ex, isFixedScheduleB: true })
        break
      case 'pregnant_reduced':
        merged.set(rule.employeeId, {
          ...ex, isPregnantReduced:   true,
          pregnantReducedFrom: rule.validFrom || undefined,
          pregnantReducedTo:   rule.validTo   || undefined,
        })
        break
      case 'global_exclusion':
        merged.set(rule.employeeId, { ...ex, isGlobalExclusion: true })
        break
      case 'resigned':
        merged.set(rule.employeeId, {
          ...ex, isResigned: true,
          resignedFrom: rule.validFrom || undefined,
        })
        break
    }
  }
  return merged
}

/** Builds the final per-employee attribute map by merging hardcoded defaults + user-configured rules.
 *  Replicates the finalAttrMap / remappedExcludeIds logic from admin/page.tsx server-side. */
export function buildFinalAttrMap(
  employees: { id: string; rawId?: string; name: string; isLeader?: boolean }[],
  rules: {
    employeeId:    string
    employeeName:  string
    ruleType:      string
    excludeFromOt: boolean
    shortenedHours: number
    validFrom:     string
    validTo:       string
  }[],
): { finalAttrMap: Map<string, EmployeeAttributeOverrides>; otExemptIds: Set<string> } {
  const normName  = (s: string) => s.trim().replace(/\s+/g, '')
  const nameToId  = new Map(employees.map(e => [normName(e.name), e.id]))
  const liveIds   = new Set(employees.map(e => e.id))

  // staleId → liveId (rules saved before upload may have mock IDs)
  const toLive = new Map<string, string>()
  for (const rule of rules) {
    if (liveIds.has(rule.employeeId)) {
      toLive.set(rule.employeeId, rule.employeeId)
    } else {
      const liveId = nameToId.get(normName(rule.employeeName))
      if (liveId) toLive.set(rule.employeeId, liveId)
    }
  }

  const result = new Map<string, EmployeeAttributeOverrides>()

  // 1. Hardcoded defaults (lowest priority)
  for (const emp of employees) {
    const rawId = emp.rawId ?? emp.id.split('_')[0]
    let def: EmployeeAttributeOverrides | null = null
    if (DEFAULT_GLOBAL_EXCLUSIONS.has(rawId))   def = { isGlobalExclusion: true }
    else if (DEFAULT_FIXED_A.has(rawId))         def = { isFixedScheduleA: true }
    else if (DEFAULT_FIXED_B.has(rawId))         def = { isFixedScheduleB: true }
    else if (DEFAULT_PREGNANT.has(rawId))        def = { isPregnantReduced: true }
    if (def) result.set(emp.id, def)
  }

  // 2. User-configured rules on top (higher priority)
  const employeeAttrMap = buildAttrMapFromRules(rules)
  for (const [staleId, attrs] of employeeAttrMap) {
    const liveId = toLive.get(staleId) ?? staleId
    result.set(liveId, { ...(result.get(liveId) ?? {}), ...attrs })
  }

  // OT exempt: leaders + easyLogis + CSV-flagged leaders
  const otExemptIds = new Set<string>()
  for (const [empId, attrs] of result) {
    if (attrs.isLeader || attrs.isEasyLogis) otExemptIds.add(empId)
  }
  for (const emp of employees) {
    if (emp.isLeader) otExemptIds.add(emp.id)
  }

  return { finalAttrMap: result, otExemptIds }
}
