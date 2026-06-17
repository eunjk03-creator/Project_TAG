'use client'
import { useMemo } from 'react'
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'
import { HOLIDAYS } from '@/data/mockData'
import {
  computeWorkA, computeDisplayBreakMins, parseTimeToMins,
} from '@/utils/attendanceCalc'
import { sortByDivisionOrder } from '@/data/orgChart'

// ── Public types ───────────────────────────────────────────────────────────

export interface DivisionMetrics {
  division: string
  headcount: number
  /** computeFinalWork hours across the date range (weekday only; holiday work excluded) */
  totalHours: number
  /** total extra hours: weekday OT + nightHours + holidayHours */
  otHours: number
  /** nightHours total (22:00–06:00 overlay) */
  nightHours: number
  /** unresolved anomaly count */
  anomalies: number
  /** otHours / headcount */
  avgOtPerPerson: number
  /** (totalHours / (bizDays × headcount × 8)) × 100 */
  workloadIntensity: number
  /** anomalies / headcount */
  anomalyFrequency: number
  /** employees exceeding 45 h in the current partial week (Mon–toDate) */
  weeklyOver45: number
}

export interface ManagementMetricsResult {
  /** Per-division rows, sorted by weeklyOver45 DESC then avgOtPerPerson DESC (all employees — backward compat) */
  metrics: DivisionMetrics[]
  /** Count of working days in the selected range (weekdays excl. holidays) */
  bizDays: number
  /** Grand-total row (all employees — backward compat) */
  total: Omit<DivisionMetrics, 'division'>
  /** Weekly hours (Mon of toDate's week → toDate) keyed by employeeId */
  weeklyHoursMap: Record<string, number>

  // ── Dual-grid split ───────────────────────────────────────────────────────
  /** Per-division rows for 사원 (non-leader employees) */
  employeeMetrics: DivisionMetrics[]
  /** Grand-total for 사원 */
  employeeTotal: Omit<DivisionMetrics, 'division'>
  /** Per-division rows for 직책자 (leader employees) */
  leaderMetrics: DivisionMetrics[]
  /** Grand-total for 직책자 */
  leaderTotal: Omit<DivisionMetrics, 'division'>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function countBizDays(from: string, to: string): number {
  let count = 0
  const cur = new Date(from + 'T12:00')
  const end = new Date(to   + 'T12:00')
  while (cur <= end) {
    const dow = cur.getDay()
    const ds  =
      `${cur.getFullYear()}-` +
      `${String(cur.getMonth() + 1).padStart(2, '0')}-` +
      `${String(cur.getDate()).padStart(2, '0')}`
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(ds)) count++
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

/** Returns the ISO date string for the Monday of the week containing `dateStr`. */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  const dow  = d.getDay()                  // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1     // days back to Monday
  d.setDate(d.getDate() - back)
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  )
}

/** Returns { totalH, otH } for a single record using the 14-column formula.
 *  Uses effectiveClockIn (clamped to flex-start, e.g. 08:00) so early arrivals
 *  don't inflate the duration — same clamp applied by processRecord.
 *  OT = max(0, finalWorkH − 8.0); non-weekday records contribute 0 to both. */
function recordHours(r: ProcessedRecord): { totalH: number; otH: number } {
  if (r.dayType !== 'WEEKDAY') return { totalH: 0, otH: 0 }
  const leaveAmt   = r.erpLeaveAmount ?? 0
  const workA      = computeWorkA(r.effectiveClockIn ?? r.clockIn, r.clockOut)
  const wAMins     = Math.round(workA * 60)
  const effIn      = r.effectiveClockIn ?? r.clockIn
  const ci         = effIn      ? parseTimeToMins(effIn)      : null
  const co         = r.clockOut ? parseTimeToMins(r.clockOut) : null
  const breakMins  = computeDisplayBreakMins(wAMins, ci, co)
  const leaveCredit = (r.isUnpaidLeave ? 0 : leaveAmt) * 8
  const finalWorkH = Math.max(0, wAMins - breakMins) / 60 + leaveCredit
  return { totalH: finalWorkH, otH: Math.max(0, finalWorkH - 8.0) }
}

function buildMetrics(
  division: string,
  empIds: Set<string>,
  plannedHeadcount: number,
  records: ProcessedRecord[],
  approvedKeys: Set<string>,
  bizDays: number,
  weeklyHoursMap: Record<string, number>,
  empRawIdMap: Map<string, string>,
): DivisionMetrics {
  const recs = records.filter(r => empIds.has(r.employeeId))

  // 실제 해당 기간에 레코드가 존재하는 직원 수 — 퇴사자/미입사자 자동 제외
  const headcount = new Set(recs.map(r => r.employeeId)).size

  let totalHours = 0
  let weekdayOtH = 0
  for (const r of recs) {
    const { totalH, otH } = recordHours(r)
    totalHours += totalH
    weekdayOtH += otH
  }
  const nightHours    = recs.reduce((s, r) => s + r.nightHours, 0)
  const holidayHoursS = recs.reduce((s, r) => s + (r.dayType !== 'WEEKDAY' ? (r.holidayHours ?? 0) : 0), 0)
  const otHours       = weekdayOtH + nightHours + holidayHoursS
  const weeklyOver45 = [...empIds].filter(id => (weeklyHoursMap[id] ?? 0) > 45).length

  // 테이블 비정상 필터와 동일 기준: r.flag !== null
  let anomalies = 0
  for (const r of recs) {
    if (approvedKeys.has(`${r.employeeId}_${r.date}`)) continue
    if (r.flag !== null && r.flag !== undefined) anomalies++
  }

  const capacity          = bizDays * plannedHeadcount * 8
  const avgOtPerPerson    = headcount > 0 ? otHours   / headcount : 0
  const workloadIntensity = capacity  > 0 ? (totalHours / capacity) * 100 : 0
  const anomalyFrequency  = headcount > 0 ? anomalies / headcount : 0

  return {
    division, headcount,
    totalHours, otHours, nightHours, anomalies,
    avgOtPerPerson, workloadIntensity, anomalyFrequency,
    weeklyOver45,
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useManagementMetrics(
  processedRecords: ProcessedRecord[],
  employees: Employee[],
  approvedKeys: Set<string>,
  fromDate: string,
  toDate: string,
  employeeAttrMap: Map<string, EmployeeAttributeOverrides> = new Map(),
): ManagementMetricsResult {
  return useMemo(() => {
    const bizDays = countBizDays(fromDate, toDate)

    // Weekly hours: Mon of toDate's week → toDate, inclusive
    const weekMonday = getWeekMonday(toDate)
    const weeklyHoursMap: Record<string, number> = {}
    for (const r of processedRecords) {
      if (r.date < weekMonday || r.date > toDate) continue
      const { totalH } = recordHours(r)
      weeklyHoursMap[r.employeeId] =
        (weeklyHoursMap[r.employeeId] ?? 0) + totalH + (r.dayType !== 'WEEKDAY' ? (r.holidayHours ?? 0) : 0)
    }

    const empRawIdMap = new Map(employees.map(e => [e.id, e.rawId ?? e.id.split('_')[0]]))

    // ── Leader ID set: union of exception-rule/drawer isLeader + CSV-parsed isLeader ──
    const leaderIdSet = new Set<string>(
      employees
        .filter(e => (employeeAttrMap.get(e.id)?.isLeader === true) || (e.isLeader === true))
        .map(e => e.id),
    )

    // ── Backward-compat: all-employee metrics (used by existing dashboard) ─────
    const divisions = sortByDivisionOrder([...new Set(employees.map(e => e.division))])
    const metrics: DivisionMetrics[] = divisions.map(div => {
      const divEmps = employees.filter(e => e.division === div)
      const empIds  = new Set(divEmps.map(e => e.id))
      return buildMetrics(div, empIds, divEmps.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap, empRawIdMap)
    })
    const allIds           = new Set(employees.map(e => e.id))
    const gt               = buildMetrics('전체', allIds, employees.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap, empRawIdMap)
    const { division: _d, ...total } = gt

    // ── 사원 (non-leader) split ───────────────────────────────────────────────
    const employeeEmps = employees.filter(e => !leaderIdSet.has(e.id))
    const empDivisions = sortByDivisionOrder([...new Set(employeeEmps.map(e => e.division))])
    const employeeMetrics: DivisionMetrics[] = empDivisions.map(div => {
      const divEmps = employeeEmps.filter(e => e.division === div)
      const empIds  = new Set(divEmps.map(e => e.id))
      return buildMetrics(div, empIds, divEmps.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap, empRawIdMap)
    })
    const empAllIds        = new Set(employeeEmps.map(e => e.id))
    const empGt            = buildMetrics('전체', empAllIds, employeeEmps.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap, empRawIdMap)
    const { division: _d2, ...employeeTotal } = empGt

    // ── 직책자 (leader) split ─────────────────────────────────────────────────
    const leaderEmps   = employees.filter(e => leaderIdSet.has(e.id))
    const ldDivisions  = sortByDivisionOrder([...new Set(leaderEmps.map(e => e.division))])
    const leaderMetrics: DivisionMetrics[] = ldDivisions.map(div => {
      const divEmps = leaderEmps.filter(e => e.division === div)
      const empIds  = new Set(divEmps.map(e => e.id))
      return buildMetrics(div, empIds, divEmps.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap, empRawIdMap)
    })
    const ldAllIds         = new Set(leaderEmps.map(e => e.id))
    const ldGt             = buildMetrics('전체', ldAllIds, leaderEmps.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap, empRawIdMap)
    const { division: _d3, ...leaderTotal } = ldGt

    return {
      metrics, bizDays, total, weeklyHoursMap,
      employeeMetrics, employeeTotal,
      leaderMetrics,   leaderTotal,
    }
  }, [processedRecords, employees, approvedKeys, fromDate, toDate, employeeAttrMap])
}
