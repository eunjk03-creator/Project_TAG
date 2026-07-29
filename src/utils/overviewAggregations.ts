/**
 * /admin/overview 전용 집계 헬퍼 — 이상치/휴가사용/초과근무를 부서·개인·일자 단위로 묶는다.
 * 이상치 분류는 attendanceCalc.ts의 flagToAnomalyCategories()를 그대로 재사용(중복 정의 금지).
 */
import type { ProcessedRecord, Employee } from '@/types/tag'
import { flagToAnomalyCategories } from './attendanceCalc'

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

export interface AnomalyRow {
  key:      string   // division name or employeeId
  label:    string   // division name or employee name
  division?: string  // employee rows only
  late:     number
  shortage: number
  notag:    number
  total:    number
}

function emptyCounts() {
  return { late: 0, shortage: 0, notag: 0, total: 0 }
}

export function buildDivisionAnomalyRollup(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
): AnomalyRow[] {
  const map = new Map<string, AnomalyRow>()
  for (const r of records) {
    if (!r.flag) continue
    const div = empMap.get(r.employeeId)?.division ?? '—'
    if (!map.has(div)) map.set(div, { key: div, label: div, ...emptyCounts() })
    const row = map.get(div)!
    for (const cat of flagToAnomalyCategories(r.flag)) row[cat]++
    row.total++
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

export function buildEmployeeAnomalyRollup(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
): AnomalyRow[] {
  const map = new Map<string, AnomalyRow>()
  for (const r of records) {
    if (!r.flag) continue
    const emp  = empMap.get(r.employeeId)
    const div  = emp?.division ?? '—'
    const name = emp?.name ?? r.employeeId
    if (!map.has(r.employeeId)) map.set(r.employeeId, { key: r.employeeId, label: name, division: div, ...emptyCounts() })
    const row = map.get(r.employeeId)!
    for (const cat of flagToAnomalyCategories(r.flag)) row[cat]++
    row.total++
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

/** 기간 내 정상출근율 — 전일/반차 등 연차로 빠진 날은 분모에서 제외(출근 대상이 아니므로). */
export function computeNormalRate(records: ProcessedRecord[]): { normal: number; total: number; pct: number } {
  const target = records.filter(r => r.dayType === 'WEEKDAY' && r.finalStatus !== '연차')
  const total  = target.length
  const normal = target.filter(r => !r.flag).length
  return { normal, total, pct: total > 0 ? (normal / total) * 100 : 0 }
}

// ── 휴가 사용내역 ────────────────────────────────────────────────────────────

export interface LeaveUsageRow {
  key:      string
  label:    string
  division?: string
  days:     number   // 유급 연차/반차 등 사용 일수 합계 (erpLeaveAmount 합)
  count:    number    // 건수
}

function isPaidLeaveRecord(r: ProcessedRecord): boolean {
  return !!r.leaveType && !r.isUnpaidLeave && (r.erpLeaveAmount ?? 0) > 0
}

export function buildLeaveUsageRollup(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  groupBy: 'division' | 'employee',
): LeaveUsageRow[] {
  const map = new Map<string, LeaveUsageRow>()
  for (const r of records) {
    if (!isPaidLeaveRecord(r)) continue
    const emp = empMap.get(r.employeeId)
    const div = emp?.division ?? '—'
    const key   = groupBy === 'division' ? div : r.employeeId
    const label = groupBy === 'division' ? div : (emp?.name ?? r.employeeId)
    if (!map.has(key)) map.set(key, { key, label, division: div, days: 0, count: 0 })
    const row = map.get(key)!
    row.days  += r.erpLeaveAmount ?? 0
    row.count += 1
  }
  return [...map.values()].sort((a, b) => b.days - a.days)
}

export interface TodayLeaveEntry {
  employeeId: string
  name:       string
  division:   string
  leaveType:  string
}

export function buildTodayLeaveList(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  today:   string,
): TodayLeaveEntry[] {
  return records
    .filter(r => r.date === today && isPaidLeaveRecord(r))
    .map(r => {
      const emp = empMap.get(r.employeeId)
      return { employeeId: r.employeeId, name: emp?.name ?? r.employeeId, division: emp?.division ?? '—', leaveType: r.leaveType! }
    })
    .sort((a, b) => a.division.localeCompare(b.division, 'ko') || a.name.localeCompare(b.name, 'ko'))
}

// ── 초과근무(연장근로) 일자별 시리즈 ──────────────────────────────────────────

export interface DailyCount {
  date:  string
  label: string
  count: number
}

function eachDate(from: string, to: string): string[] {
  const dates: string[] = []
  const cur = new Date(from + 'T12:00')
  const end = new Date(to   + 'T12:00')
  while (cur <= end) {
    dates.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}(${DOW_KR[d.getDay()]})`
}

/** 일자별 "그날 연장근로가 발생한 인원 수" — 같은 사람이 여러 레코드면 1명으로 집계. */
export function buildDailyOvertimeSeries(records: ProcessedRecord[], from: string, to: string): DailyCount[] {
  const byDate = new Map<string, Set<string>>()
  for (const r of records) {
    if (r.overtimeHours <= 0) continue
    if (!byDate.has(r.date)) byDate.set(r.date, new Set())
    byDate.get(r.date)!.add(r.employeeId)
  }
  return eachDate(from, to).map(date => ({ date, label: dayLabel(date), count: byDate.get(date)?.size ?? 0 }))
}

export interface TodayOvertimeEntry {
  employeeId: string
  name:       string
  division:   string
  hours:      number
}

export function buildTodayOvertimeList(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  today:   string,
): TodayOvertimeEntry[] {
  return records
    .filter(r => r.date === today && r.overtimeHours > 0)
    .map(r => {
      const emp = empMap.get(r.employeeId)
      return { employeeId: r.employeeId, name: emp?.name ?? r.employeeId, division: emp?.division ?? '—', hours: r.overtimeHours }
    })
    .sort((a, b) => b.hours - a.hours)
}
