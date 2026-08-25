/**
 * /admin/overview 전용 집계 헬퍼 — 이상치/휴가사용/초과근무/휴일근무를 부서·개인·일자 단위로 묶는다.
 * 이상치 분류는 attendanceCalc.ts의 flagToAnomalyCategories()를, 52h/209h 초과자 판정은
 * computeDailyRecognizedHours()를 그대로 재사용(중복 정의 금지 — EmployeeCalendarGrid.tsx의
 * 52h 초과 필터와 동일 공식·기준으로 계산됨을 보장).
 */
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'
import { flagToAnomalyCategories, computeDailyRecognizedHours, computeDailyRecognizedOtHours, isLeaderOnDate } from './attendanceCalc'
import { hireDateFromRawId } from './dataParser'

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

// 종합현황 Zone2 division 카드의 "휴가" 배지를 연차/반차/반반차로 쪼개 보여주기 위한 분류.
// isPaidLeaveRecord와 동일한 "휴가로 치는" 기준을 그대로 쓰고, 그 안에서 leaveType만 나눈다.
export interface DivisionLeaveBreakdown {
  division: string
  annual:   number  // 연차
  half:     number  // 오전반차/오후반차
  quarter:  number  // 오전반반차/오후반반차
  other:    number  // 그 외(출장/재택근무 등 erpLeaveAmount>0인 나머지)
}

export function buildDivisionLeaveBreakdown(
  records: ProcessedRecord[],
  empMap:  Map<string, Employee>,
): DivisionLeaveBreakdown[] {
  const map = new Map<string, DivisionLeaveBreakdown>()
  for (const r of records) {
    if (!isPaidLeaveRecord(r)) continue
    const div = empMap.get(r.employeeId)?.division ?? '—'
    const row = map.get(div) ?? { division: div, annual: 0, half: 0, quarter: 0, other: 0 }
    if (r.leaveType === '연차') row.annual++
    else if (r.leaveType === '오전반차' || r.leaveType === '오후반차') row.half++
    else if (r.leaveType === '오전반반차' || r.leaveType === '오후반반차') row.quarter++
    else row.other++
    map.set(div, row)
  }
  return [...map.values()]
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

// ── 인원별 기간 인정근로시간 (division 카드의 "이상치 인원 목록" 근로시간 컬럼용) ─────
// computeOverLimitEmployees/computeWeeklyRiskBuckets와 동일한 computeDailyRecognizedHours
// 합산 공식 — 한도초과 여부와 무관하게 전원의 기간 내 인정시간을 반환한다.

export function buildEmployeeRecognizedHours(
  records:      ProcessedRecord[],
  employees:    Employee[],
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
): Map<string, number> {
  const empMap = new Map(employees.map(e => [e.id, e]))
  const byEmp  = new Map<string, ProcessedRecord[]>()
  for (const r of records) {
    const bucket = byEmp.get(r.employeeId)
    if (bucket) bucket.push(r)
    else byEmp.set(r.employeeId, [r])
  }
  const hours = new Map<string, number>()
  for (const [employeeId, recs] of byEmp) {
    const emp   = empMap.get(employeeId)
    const attrs = finalAttrMap.get(employeeId)
    let h = 0
    for (const r of recs) h += computeDailyRecognizedHours(r, isLeaderOnDate(attrs, emp, r.date))
    hours.set(employeeId, h)
  }
  return hours
}

// ── division별 "정산용" 연장근로시간 — §4 확정 공식(computeDailyRecognizedHours)에서
// 8h 표준분을 뺀 순수 초과분(computeDailyRecognizedOtHours)만 합산한다. useManagementMetrics
// 의 otHours는 30분 절삭·ERP 승인게이트가 없는 별개(구식) 계산이라 종합현황 이상치 탭의
// "연장근로" 표시엔 쓰면 안 됨 — 반드시 이 함수를 통해서만 집계한다.
export interface DivisionRecognizedOt {
  division:  string
  otHours:   number  // division 합계
  eligible:  number  // 연장 발생(otHours>0) 인원 수
}

export function buildDivisionRecognizedOt(
  records:      ProcessedRecord[],
  employees:    Employee[],
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
): DivisionRecognizedOt[] {
  const empMap = new Map(employees.map(e => [e.id, e]))
  const byEmp  = new Map<string, ProcessedRecord[]>()
  for (const r of records) {
    const bucket = byEmp.get(r.employeeId)
    if (bucket) bucket.push(r)
    else byEmp.set(r.employeeId, [r])
  }
  const byDivision = new Map<string, { otHours: number; eligible: number }>()
  for (const [employeeId, recs] of byEmp) {
    const emp   = empMap.get(employeeId)
    const attrs = finalAttrMap.get(employeeId)
    const div   = emp?.division ?? '—'
    let h = 0
    for (const r of recs) h += computeDailyRecognizedOtHours(r, isLeaderOnDate(attrs, emp, r.date))
    const row = byDivision.get(div) ?? { otHours: 0, eligible: 0 }
    row.otHours += h
    if (h > 0) row.eligible++
    byDivision.set(div, row)
  }
  return [...byDivision.entries()].map(([division, row]) => ({ division, ...row }))
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

// ══════════════════════════════════════════════════════════════════════════
// v9 디자인 핸드오프 — 종합현황 "이상치" 탭 재설계 전용 집계.
// 일=출근율 / 주(연장·휴일)=52h위험군+연장근로+휴일근로 / 월(누적·단월)=연차사용률.
// ══════════════════════════════════════════════════════════════════════════

/** 확정 전 정책 임계값 — README가 "설정값으로 빼는 걸 권장"한 대로 한곳에 모아둠.
 *  나중에 PolicyContext로 옮길 때 이 객체만 그쪽 값으로 바꿔치면 된다. */
export const OVERVIEW_POLICY = {
  attendanceTargetPct:         85,   // 일간 출근율 기준
  attendanceWarnDeltaPp:       -4,   // 기준 대비 -4%p까지 주의, 그 아래는 조치 필요
  weeklyOtActionH:             12,   // 주당 평균 연장 12h 이상 → 조치 필요
  weeklyOtWarningH:            9,    // 9h 이상 → 주의
  holidayActionCount:          3,    // 부서 휴일근로 3건 이상 → 조치 필요
  holidayWarningCount:         1,    // 1건 이상 → 주의
  leaveTargetWarnDeltaPp:      -10,  // 누적 목표 대비 -10%p까지 주의
  monthlyAllocationWarnDeltaPp: -1.5, // 단월 배분(8.3%) 대비 -1.5%p까지 주의
} as const

/** 1~12월 누적 연차 사용 목표(%) — 회계연도 균등 배분 가정. */
export const LEAVE_BENCHMARK = [8, 17, 25, 33, 42, 50, 58, 67, 75, 83, 92, 100]
export const MONTHLY_ALLOCATION = 100 / 12 // ≈ 8.33%

// ── 연차 발생일수(부여일수) ──────────────────────────────────────────────────
// ⚠️ 근로기준법 제60조 "법정 최소 연차" 공식의 근사치다. 회사의 실제 연차 규정(회계연도
// 기준 발생, 입사 첫해 특례 등)과 다를 수 있음 — 실제 HR 규정 확인 후 교체 필요.
// 사원번호(rawId)에 인코딩된 입사일(dataParser.hireDateFromRawId)로 근속월수를 구한다.

function monthsBetween(fromDate: string, toDate: string): number {
  const f = new Date(fromDate + 'T00:00')
  const t = new Date(toDate + 'T00:00')
  let months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth())
  if (t.getDate() < f.getDate()) months--
  return Math.max(0, months)
}

export function computeGrantedDays(hireDate: string, asOfDate: string): number {
  const months = monthsBetween(hireDate, asOfDate)
  if (months < 12) return Math.min(11, months) // 1년 미만: 매월 개근 1일, 최대 11일
  const years = Math.floor(months / 12)
  if (years < 3) return 15
  return Math.min(25, 15 + Math.floor((years - 1) / 2)) // 3년차부터 매 2년 +1일, 최대 25일
}

/** employee.rawId(없으면 id 앞부분)에서 입사일을 유도. 형식이 안 맞으면 null. */
export function resolveHireDate(emp: Employee): string | null {
  const rawId = emp.rawId ?? emp.id.split('_')[0]
  return hireDateFromRawId(rawId)
}

// ── 인원별 연차 사용률 ───────────────────────────────────────────────────────

export interface EmployeeLeaveUsage {
  employeeId:  string
  name:        string
  division:    string
  hireYear:    number | null
  grantedDays: number
  usedDays:    number
  ratePct:     number
}

function sumUsedLeaveDays(records: ProcessedRecord[]): number {
  let days = 0
  for (const r of records) if (isPaidLeaveRecord(r)) days += r.erpLeaveAmount ?? 0
  return days
}

/**
 * @param scopedRecords 집계 대상 기간 레코드 — basis='cumulative'면 "올해 1/1~기준일"
 *   범위로 미리 넓혀서 넘겨야 하고(overview 페이지가 이 함수 호출 전에 별도로 그 범위를
 *   fetch해서 넘긴다), basis='single'이면 선택된 한 달 레코드 그대로 넘긴다.
 */
export function buildEmployeeLeaveUsage(
  scopedRecords: ProcessedRecord[],
  employees:     Employee[],
  asOfDate:      string,
): EmployeeLeaveUsage[] {
  const byEmp = new Map<string, ProcessedRecord[]>()
  for (const r of scopedRecords) {
    const list = byEmp.get(r.employeeId) ?? []
    list.push(r)
    byEmp.set(r.employeeId, list)
  }
  return employees.map(emp => {
    const usedDays   = sumUsedLeaveDays(byEmp.get(emp.id) ?? [])
    const hireDate   = resolveHireDate(emp)
    const grantedDays = hireDate ? computeGrantedDays(hireDate, asOfDate) : 15 // rawId 유도 실패 시 15일(1~2년차 기본값) 근사
    return {
      employeeId: emp.id, name: emp.name, division: emp.division,
      hireYear: hireDate ? Number(hireDate.slice(0, 4)) : null,
      grantedDays, usedDays,
      ratePct: grantedDays > 0 ? (usedDays / grantedDays) * 100 : 0,
    }
  }).sort((a, b) => a.ratePct - b.ratePct) // 사용률 낮은(문제 큰) 순
}

export interface DivisionLeaveUsage {
  division:    string
  headcount:   number
  grantedDays: number
  usedDays:    number
  ratePct:     number
}

export function buildDivisionLeaveUsage(employeeRows: EmployeeLeaveUsage[]): DivisionLeaveUsage[] {
  const map = new Map<string, DivisionLeaveUsage>()
  for (const r of employeeRows) {
    const row = map.get(r.division) ?? { division: r.division, headcount: 0, grantedDays: 0, usedDays: 0, ratePct: 0 }
    row.headcount++
    row.grantedDays += r.grantedDays
    row.usedDays += r.usedDays
    map.set(r.division, row)
  }
  return [...map.values()].map(row => ({ ...row, ratePct: row.grantedDays > 0 ? (row.usedDays / row.grantedDays) * 100 : 0 }))
}

// ── 주 52h 위험군 — division 단위 밴드 카운트 (computeWeeklyRiskBuckets의 division 롤업) ──

export interface DivisionRiskBand {
  division: string
  caution:  number  // 45~50h
  warning:  number  // 50~52h
  danger:   number  // 52h+
  avgHours: number  // division 평균 인정근로시간(주당 연장근로 카드 메인 숫자용은 overtime 별도 계산)
}

export function buildDivisionRiskBands(riskRows: RiskBucketRow[], headcountByDivision: Map<string, number>): DivisionRiskBand[] {
  const map = new Map<string, { caution: number; warning: number; danger: number; sumHours: number; n: number }>()
  for (const r of riskRows) {
    const row = map.get(r.division) ?? { caution: 0, warning: 0, danger: 0, sumHours: 0, n: 0 }
    if (r.bucket === 'caution') row.caution++
    else if (r.bucket === 'warning') row.warning++
    else row.danger++
    row.sumHours += r.hours
    row.n++
    map.set(r.division, row)
  }
  const out: DivisionRiskBand[] = []
  for (const [division] of headcountByDivision) {
    const row = map.get(division)
    out.push({
      division,
      caution: row?.caution ?? 0, warning: row?.warning ?? 0, danger: row?.danger ?? 0,
      avgHours: row && row.n > 0 ? row.sumHours / row.n : 0,
    })
  }
  return out
}

// ── 휴일근로 사원별 상세 (날짜별) — buildHolidayWorkRollup은 인원 합계만 주므로, 카드
// 목록에 필요한 "날짜별 근무" 행 단위 상세를 별도로 뽑는다. ──────────────────────────

export interface HolidayWorkDetail {
  employeeId: string
  name:       string
  division:   string
  date:       string
  hours:      number
}

export function buildHolidayWorkDetails(records: ProcessedRecord[], empMap: Map<string, Employee>): HolidayWorkDetail[] {
  return records
    .filter(r => r.finalStatus === '휴일근무')
    .map(r => {
      const emp = empMap.get(r.employeeId)
      return { employeeId: r.employeeId, name: emp?.name ?? r.employeeId, division: emp?.division ?? '—', date: r.date, hours: r.holidayHours ?? 0 }
    })
    .sort((a, b) => b.hours - a.hours)
}
