'use client'
import { useMemo } from 'react'
import type { ProcessedRecord, Employee } from '@/types/tag'
import { HOLIDAYS } from '@/data/mockData'

// ── Public types ───────────────────────────────────────────────────────────

export interface DivisionMetrics {
  division: string
  headcount: number
  /** regularHours + overtimeHours across the date range */
  totalHours: number
  /** overtimeHours total */
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
  /** Per-division rows, sorted by weeklyOver45 DESC then avgOtPerPerson DESC */
  metrics: DivisionMetrics[]
  /** Count of working days in the selected range (weekdays excl. holidays) */
  bizDays: number
  /** Grand-total row */
  total: Omit<DivisionMetrics, 'division'>
  /** Weekly hours (Mon of toDate's week → toDate) keyed by employeeId */
  weeklyHoursMap: Record<string, number>
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

function buildMetrics(
  division: string,
  empIds: Set<string>,
  headcount: number,
  records: ProcessedRecord[],
  approvedKeys: Set<string>,
  bizDays: number,
  weeklyHoursMap: Record<string, number>,
): DivisionMetrics {
  const recs = records.filter(r => empIds.has(r.employeeId))

  const totalHours        = recs.reduce((s, r) => s + r.regularHours + r.overtimeHours, 0)
  const otHours           = recs.reduce((s, r) => s + r.overtimeHours, 0)
  const nightHours        = recs.reduce((s, r) => s + r.nightHours, 0)
  const anomalies         = recs.filter(
    r => r.flag !== null && !approvedKeys.has(`${r.employeeId}_${r.date}`),
  ).length
  const weeklyOver45      = [...empIds].filter(id => (weeklyHoursMap[id] ?? 0) > 45).length

  const capacity          = bizDays * headcount * 8
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
): ManagementMetricsResult {
  return useMemo(() => {
    const bizDays = countBizDays(fromDate, toDate)

    // Weekly hours: Mon of toDate's week → toDate, inclusive
    const weekMonday = getWeekMonday(toDate)
    const weeklyHoursMap: Record<string, number> = {}
    for (const r of processedRecords) {
      if (r.date >= weekMonday && r.date <= toDate) {
        weeklyHoursMap[r.employeeId] =
          (weeklyHoursMap[r.employeeId] ?? 0) +
          r.regularHours + r.overtimeHours + (r.holidayHours ?? 0)
      }
    }

    const divisions = [...new Set(employees.map(e => e.division))]
    const metrics: DivisionMetrics[] = divisions.map(div => {
      const divEmps = employees.filter(e => e.division === div)
      const empIds  = new Set(divEmps.map(e => e.id))
      return buildMetrics(div, empIds, divEmps.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap)
    })

    // Sort: 52h risk count desc → avgOT desc
    metrics.sort((a, b) =>
      b.weeklyOver45 !== a.weeklyOver45
        ? b.weeklyOver45 - a.weeklyOver45
        : b.avgOtPerPerson - a.avgOtPerPerson,
    )

    const allIds = new Set(employees.map(e => e.id))
    const gt     = buildMetrics('전체', allIds, employees.length, processedRecords, approvedKeys, bizDays, weeklyHoursMap)
    const { division: _d, ...total } = gt

    return { metrics, bizDays, total, weeklyHoursMap }
  }, [processedRecords, employees, approvedKeys, fromDate, toDate])
}
