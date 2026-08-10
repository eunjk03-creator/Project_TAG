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

// ── 조직도 기준 출근율 ──────────────────────────────────────────────────────
// CAPS 레코드 정상/이상 비율이 아니라 "조직도(EmployeeMaster) 재직자 중 오늘 실제로 출근한
// 사람이 몇 명인가"를 보는 별도 지표. 기존 정상출근율(computeNormalRate)과는 계산 기준이
// 달라서 나란히 둔다 — 하나를 없애거나 대체하지 않음.
//
// 판정 규칙(2026-08-10 확정):
//  - 기준인원 = 조직도 마스터 재직자(status=ACTIVE) 전체. 계약직도 포함(퇴사자만 제외 대상 —
//    ACTIVE 필터가 이미 처리). 아르바이트는 현재 조직도에 실질적으로 없어 별도 처리 불필요.
//  - 연차(전일, erpLeaveAmount>=1)인 사람은 "원래 출근 안 하는 게 정상"이므로 기대출근에서 제외.
//  - 출근 여부는 clockIn/clockOut 중 "둘 다 없을 때만" 미출근으로 본다(하나라도 있으면 출근) —
//    이건 이 지표 전용 판단이고, 그리드/이상치 상세가 쓰는 기존 미태깅 판정 로직과는 별개.
//  - record.clockIn/clockOut은 관리자 수기수정(override) 병합이 이미 끝난 값이라 그대로 사용.
export interface OrgChartAttendanceRate {
  headcount: number  // 조직도 재직자 전체
  onLeave:   number  // 연차(1.0) 사용자 — 기대출근에서 제외됨
  expected:  number  // headcount - onLeave
  attended:  number  // 실제 출근(clockIn 또는 clockOut 존재)
  unmatched: number  // CAPS 레코드 자체가 없는 사람(참고용 — attended에는 포함 안 됨)
  rate:      number  // attended / expected, 0~100 (%, 소수 1자리)
}

export function computeOrgChartAttendanceRate(
  rosterActive: { rawId: string }[],
  rawIdToEmployeeId: Map<string, string>,
  records: ProcessedRecord[],
  date: string,
): OrgChartAttendanceRate {
  const recordByEmployeeId = new Map(
    records.filter(r => r.date === date).map(r => [r.employeeId, r]),
  )

  let onLeave = 0
  let attended = 0
  let unmatched = 0

  for (const person of rosterActive) {
    const employeeId = rawIdToEmployeeId.get(person.rawId)
    const record = employeeId ? recordByEmployeeId.get(employeeId) : undefined

    if ((record?.erpLeaveAmount ?? 0) >= 1) { onLeave++; continue }
    if (!record) { unmatched++; continue }
    if (record.clockIn || record.clockOut) attended++
  }

  const headcount = rosterActive.length
  const expected  = headcount - onLeave
  const rate      = expected > 0 ? Math.round((attended / expected) * 1000) / 10 : 0

  return { headcount, onLeave, expected, attended, unmatched, rate }
}

// ── 퇴사 처리 후보 ──────────────────────────────────────────────────────────
// 조직도 마스터(전체, 상태 무관)에도 없고 최근 CAPS 활동도 없지만, CAPS 업로드 이력에는
// 존재하는 사람 — 예전에 퇴사했는데 어디에도 반영이 안 된 케이스. exception_rules에 이미
// isResigned로 등록돼 있으면 그 날짜를 미리 채워서 보여주고(바로 "반영"만 하면 됨), 없으면
// 사용자가 직접 날짜를 입력해서 확정해야 한다.
export interface ResignationCandidate {
  rawId:        string
  name:         string
  division:     string
  inMaster:     boolean  // true=조직도엔 있는데 최근 CAPS만 없음 / false=조직도에도 없음
  resignedFrom?: string  // exception_rules 기반 — 있으면 미리 채워줌
}

export function buildResignationCandidates(
  historicalEmployees: { rawId?: string; name: string; division: string }[],
  allMasterRawIds:  Set<string>,
  recentActiveRawIds: Set<string>,
  resignedFromByRawId: Map<string, string>,
): ResignationCandidate[] {
  const out: ResignationCandidate[] = []
  const seen = new Set<string>()
  for (const e of historicalEmployees) {
    if (!e.rawId || seen.has(e.rawId)) continue
    seen.add(e.rawId)
    if (recentActiveRawIds.has(e.rawId)) continue  // 아직 활동 중
    out.push({
      rawId: e.rawId, name: e.name, division: e.division,
      inMaster: allMasterRawIds.has(e.rawId),
      resignedFrom: resignedFromByRawId.get(e.rawId),
    })
  }
  return out.sort((a, b) => a.division.localeCompare(b.division, 'ko') || a.name.localeCompare(b.name, 'ko'))
}
