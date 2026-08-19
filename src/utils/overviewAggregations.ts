/**
 * /admin/overview 전용 집계 헬퍼 — 이상치/휴가사용/초과근무/휴일근무를 부서·개인·일자 단위로 묶는다.
 * 이상치 분류는 attendanceCalc.ts의 flagToAnomalyCategories()를, 52h/209h 초과자 판정은
 * computeDailyRecognizedHours()를 그대로 재사용(중복 정의 금지 — EmployeeCalendarGrid.tsx의
 * 52h 초과 필터와 동일 공식·기준으로 계산됨을 보장).
 */
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'
import { flagToAnomalyCategories, computeDailyRecognizedHours, isLeaderOnDate } from './attendanceCalc'

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

// ── 휴일근무 — 이상치/연장근로와 별개 카테고리 ────────────────────────────────

export interface HolidayWorkRow {
  key:      string
  label:    string
  division?: string
  hours:    number
  count:    number  // 휴일근무한 일수(레코드 수)
}

export function buildHolidayWorkRollup(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  groupBy: 'division' | 'employee',
): HolidayWorkRow[] {
  const map = new Map<string, HolidayWorkRow>()
  for (const r of records) {
    if (r.finalStatus !== '휴일근무') continue
    const emp = empMap.get(r.employeeId)
    const div = emp?.division ?? '—'
    const key   = groupBy === 'division' ? div : r.employeeId
    const label = groupBy === 'division' ? div : (emp?.name ?? r.employeeId)
    if (!map.has(key)) map.set(key, { key, label, division: div, hours: 0, count: 0 })
    const row = map.get(key)!
    row.hours += r.holidayHours ?? 0
    row.count += 1
  }
  return [...map.values()].sort((a, b) => b.hours - a.hours)
}

export interface TodayHolidayEntry {
  employeeId: string
  name:       string
  division:   string
  hours:      number
}

export function buildTodayHolidayList(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  today:   string,
): TodayHolidayEntry[] {
  return records
    .filter(r => r.date === today && r.finalStatus === '휴일근무')
    .map(r => {
      const emp = empMap.get(r.employeeId)
      return { employeeId: r.employeeId, name: emp?.name ?? r.employeeId, division: emp?.division ?? '—', hours: r.holidayHours ?? 0 }
    })
    .sort((a, b) => b.hours - a.hours)
}

// ── 법정 한도 초과자 (주 52h / 월 209h) ───────────────────────────────────────
// EmployeeCalendarGrid.tsx의 52h 초과 필터와 동일한 computeDailyRecognizedHours() 공식으로
// 기간 내 인정시간을 합산한다. Overview의 주/월 granularity는 usePeriodRange()가 정확히
// 월~일 한 주 / 1일~말일 한 달로 범위를 잡아주므로, 별도 주차 분할 없이 "선택된 기간 합계"가
// 곧 그 주/그 달의 총 인정시간이 된다.

export interface OverLimitRow {
  employeeId: string
  name:       string
  division:   string
  hours:      number
  overBy:     number  // hours - limit
}

export function computeOverLimitEmployees(
  records:      ProcessedRecord[],
  employees:    Employee[],
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
  limitHours:   number,
): OverLimitRow[] {
  const empMap = new Map(employees.map(e => [e.id, e]))
  const byEmp  = new Map<string, ProcessedRecord[]>()
  for (const r of records) {
    const bucket = byEmp.get(r.employeeId)
    if (bucket) bucket.push(r)
    else byEmp.set(r.employeeId, [r])
  }

  const rows: OverLimitRow[] = []
  for (const [employeeId, recs] of byEmp) {
    const emp   = empMap.get(employeeId)
    const attrs = finalAttrMap.get(employeeId)
    let hours = 0
    for (const r of recs) {
      hours += computeDailyRecognizedHours(r, isLeaderOnDate(attrs, emp, r.date))
    }
    if (hours >= limitHours) {
      rows.push({ employeeId, name: emp?.name ?? employeeId, division: emp?.division ?? '—', hours, overBy: hours - limitHours })
    }
  }
  return rows.sort((a, b) => b.hours - a.hours)
}

// ── 인력 마스터 정합성 ───────────────────────────────────────────────────────
// 조직도 시트 기반 EmployeeMaster와 그때그때의 CAPS 업로드 결과(Employee[])를 대조한다.
// 둘 다 "정답"이 아니라 서로 다른 시점/소스의 데이터라서, 어긋남 자체가 확인이 필요한
// 신호다(마스터 갱신 지연, 퇴사처리 누락, 시트 매칭 실패 등) — 그래서 자동 정정하지 않고
// 목록으로만 노출한다.

export interface MasterDiscrepancy {
  type: 'MASTER_ACTIVE_NOT_IN_CAPS' | 'CAPS_NOT_IN_MASTER'
  rawId: string
  name: string
  division: string
  detail: string
}

// ── 주 52h 위험군 버킷 (45~50h 주의 / 50~52h 경고 / 52h+ 위험) ────────────────
// computeOverLimitEmployees와 동일한 인정시간 합산(computeDailyRecognizedHours)을 쓰되,
// 단일 한도 초과자 목록이 아니라 3개 구간으로 나눠 인원수를 센다. 종합현황 Zone1의
// 주간 뷰 1번 슬롯 전용.

export type RiskBucket = 'caution' | 'warning' | 'danger'

export interface RiskBucketRow {
  employeeId: string
  name:       string
  division:   string
  hours:      number
  bucket:     RiskBucket
}

export interface WeeklyRiskBuckets {
  caution: number  // 45~50h
  warning: number  // 50~52h
  danger:  number  // 52h 이상
  rows:    RiskBucketRow[]
}

export function computeWeeklyRiskBuckets(
  records:      ProcessedRecord[],
  employees:    Employee[],
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
): WeeklyRiskBuckets {
  const empMap = new Map(employees.map(e => [e.id, e]))
  const byEmp  = new Map<string, ProcessedRecord[]>()
  for (const r of records) {
    const bucket = byEmp.get(r.employeeId)
    if (bucket) bucket.push(r)
    else byEmp.set(r.employeeId, [r])
  }

  const rows: RiskBucketRow[] = []
  let caution = 0, warning = 0, danger = 0
  for (const [employeeId, recs] of byEmp) {
    const emp   = empMap.get(employeeId)
    const attrs = finalAttrMap.get(employeeId)
    let hours = 0
    for (const r of recs) hours += computeDailyRecognizedHours(r, isLeaderOnDate(attrs, emp, r.date))

    let bucket: RiskBucket | null = null
    if (hours >= 52) bucket = 'danger'
    else if (hours >= 50) bucket = 'warning'
    else if (hours >= 45) bucket = 'caution'
    if (!bucket) continue

    if (bucket === 'danger') danger++
    else if (bucket === 'warning') warning++
    else caution++
    rows.push({ employeeId, name: emp?.name ?? employeeId, division: emp?.division ?? '—', hours, bucket })
  }
  return { caution, warning, danger, rows: rows.sort((a, b) => b.hours - a.hours) }
}

// ── 외근 ─────────────────────────────────────────────────────────────────
// buildLeaveUsageRollup/buildTodayLeaveList와 동일한 패턴, finalStatus === '외근' 기준.

export interface OffsiteRow {
  key:      string
  label:    string
  division?: string
  count:    number  // 외근 일수(레코드 수)
}

export function buildOffsiteRollup(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  groupBy: 'division' | 'employee',
): OffsiteRow[] {
  const map = new Map<string, OffsiteRow>()
  for (const r of records) {
    if (r.finalStatus !== '외근') continue
    const emp = empMap.get(r.employeeId)
    const div = emp?.division ?? '—'
    const key   = groupBy === 'division' ? div : r.employeeId
    const label = groupBy === 'division' ? div : (emp?.name ?? r.employeeId)
    if (!map.has(key)) map.set(key, { key, label, division: div, count: 0 })
    map.get(key)!.count += 1
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

export interface TodayOffsiteEntry {
  employeeId: string
  name:       string
  division:   string
}

export function buildTodayOffsiteList(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
  today:   string,
): TodayOffsiteEntry[] {
  return records
    .filter(r => r.date === today && r.finalStatus === '외근')
    .map(r => {
      const emp = empMap.get(r.employeeId)
      return { employeeId: r.employeeId, name: emp?.name ?? r.employeeId, division: emp?.division ?? '—' }
    })
    .sort((a, b) => a.division.localeCompare(b.division, 'ko') || a.name.localeCompare(b.name, 'ko'))
}

// ── 부서별 정상출근율 (월간 Zone2 정합성표용) ─────────────────────────────────
// computeNormalRate와 동일 필터(WEEKDAY && 연차 아님)를 division 단위로 그룹핑.
// 정상출근율이 낮은(문제가 큰) 부서가 위로 오도록 오름차순 정렬.

export interface DivisionNormalRateRow {
  division: string
  normal:   number
  total:    number
  pct:      number
}

export function buildDivisionNormalRateRollup(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
): DivisionNormalRateRow[] {
  const map = new Map<string, { normal: number; total: number }>()
  for (const r of records) {
    if (r.dayType !== 'WEEKDAY' || r.finalStatus === '연차') continue
    const div = empMap.get(r.employeeId)?.division ?? '—'
    const row = map.get(div) ?? { normal: 0, total: 0 }
    row.total++
    if (!r.flag) row.normal++
    map.set(div, row)
  }
  return [...map.entries()]
    .map(([division, { normal, total }]) => ({ division, normal, total, pct: total > 0 ? (normal / total) * 100 : 0 }))
    .sort((a, b) => a.pct - b.pct)
}

// ── 주차별(1~5주차) 이상치 추이 (월간 Zone2 차트용) ───────────────────────────
// buildDailyOvertimeSeries와 같은 형태의 시리즈이나, 일자 단위가 아니라 월 내
// 주차(월요일 시작) 단위로 flagToAnomalyCategories 합계를 묶는다.

function mondayBasedDow(d: Date): number {
  const dow = d.getDay() // 0 = Sun
  return dow === 0 ? 6 : dow - 1
}

function weekOfMonth(dateStr: string): number {
  const d = new Date(dateStr + 'T12:00')
  const day1 = new Date(d.getFullYear(), d.getMonth(), 1)
  return Math.ceil((d.getDate() + mondayBasedDow(day1)) / 7)
}

export interface WeeklyAnomalyPoint {
  week:     number   // 1-based 월 내 주차
  label:    string   // "1주차" 등
  late:     number
  shortage: number
  notag:    number
  total:    number
}

export function buildWeeklyAnomalySeries(records: ProcessedRecord[], from: string, to: string): WeeklyAnomalyPoint[] {
  const byWeek = new Map<number, { late: number; shortage: number; notag: number; total: number }>()
  for (const r of records) {
    if (!r.flag) continue
    if (r.date < from || r.date > to) continue
    const week = weekOfMonth(r.date)
    const row = byWeek.get(week) ?? { late: 0, shortage: 0, notag: 0, total: 0 }
    for (const cat of flagToAnomalyCategories(r.flag)) row[cat]++
    row.total++
    byWeek.set(week, row)
  }
  const maxWeek = Math.max(1, ...[...byWeek.keys()])
  const points: WeeklyAnomalyPoint[] = []
  for (let w = 1; w <= maxWeek; w++) {
    const row = byWeek.get(w) ?? { late: 0, shortage: 0, notag: 0, total: 0 }
    points.push({ week: w, label: `${w}주차`, ...row })
  }
  return points
}

export function buildMasterDiscrepancyRollup(
  masterActive: { rawId: string; name: string; division: string }[],
  /** 최근 N일 CAPS 레코드에 등장한 사원번호 집합 — 비어있으면 "미태깅" 판정을 안 한다 */
  recentActiveRawIds: Set<string>,
  csvEmployees: { rawId?: string; name: string; division: string }[],
): MasterDiscrepancy[] {
  const out: MasterDiscrepancy[] = []

  for (const m of masterActive) {
    if (!recentActiveRawIds.has(m.rawId)) {
      out.push({
        type: 'MASTER_ACTIVE_NOT_IN_CAPS',
        rawId: m.rawId, name: m.name, division: m.division,
        detail: '마스터엔 재직중인데 최근 CAPS 태깅 기록 없음',
      })
    }
  }

  const masterRawIds = new Set(masterActive.map(m => m.rawId))
  const seenCsvRawIds = new Set<string>()
  for (const e of csvEmployees) {
    if (!e.rawId || seenCsvRawIds.has(e.rawId)) continue
    seenCsvRawIds.add(e.rawId)
    if (!masterRawIds.has(e.rawId)) {
      out.push({
        type: 'CAPS_NOT_IN_MASTER',
        rawId: e.rawId, name: e.name, division: e.division,
        detail: 'CAPS엔 있는데 조직도 마스터엔 미등록',
      })
    }
  }

  return out
}
