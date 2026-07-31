'use client'
import { useState, useMemo } from 'react'
import type { ProcessedRecord, Employee, RiskThresholds, EmployeeAttributeOverrides } from '@/types/tag'
import { HR_THRESHOLDS, FINAL_STATUS_CATEGORY } from '@/types/tag'
import { parseTimeToMins, compute4141BreakMins, computeVirtualInMins, isLeaderOnDate as isLeaderOnDateCore } from '@/utils/attendanceCalc'
import { sortByDivisionOrder } from '@/data/orgChart'

// ── Internal status ────────────────────────────────────────────────────────
type Status = 'N' | 'OT' | 'L' | 'A' | 'H' | 'APPROVED' | 'WEEKEND' | 'ABSENT'

// ── Sort direction ─────────────────────────────────────────────────────────
type SortDir = 'none' | 'asc' | 'desc'

// ── Column widths ──────────────────────────────────────────────────────────
const W_NAME    = 100  // +20 vs base 80 to fit the selection checkbox
const W_ORG     = 108   // merged 본부 + 팀/부서 into a single stacked cell
const W_TOTAL   = 72
const W_OT      = 48    // 분리됨
const W_NIGHT   = 48    // 추가됨
const W_HOLIDAY = 48    // 추가됨
const W_ANOMALY = 44
const W_CAT     = 66
const W_DATE    = 62

const L1        = 0
const L2        = W_NAME                                         // 소속      left = 80
const L3        = W_NAME + W_ORG                                 // 총 근로   left = 188
const L_OT      = L3 + W_TOTAL                                   // 연장      left = 260
const L_NIGHT   = L_OT + W_OT                                    // 야간      left = 308
const L_HOLIDAY = L_NIGHT + W_NIGHT                              // 휴일      left = 356
const L_ANOMALY = L_HOLIDAY + W_HOLIDAY                          // 이상      left = 404
const L4        = L_ANOMALY + W_ANOMALY                          // 구분      left = 448

const STICKY_SEP = '3px 0 6px -2px rgba(0,0,0,0.10)'

// ── Outline info-tags ──────────────────────────────────────────────────────
const TAG = {
  amLeave:   'border border-blue-200   bg-blue-50    text-blue-600',
  pmLeave:   'border border-blue-200   bg-blue-50    text-blue-600',
  dayLeave:  'border border-green-200  bg-green-50   text-green-700',
  holiday:   'border border-violet-200 bg-violet-50  text-violet-700',
  anomaly:   'border border-red-200    bg-red-50     text-red-600',
  bizTrip:   'border border-teal-200   bg-teal-50    text-teal-700',
  remote:    'border border-indigo-200 bg-indigo-50  text-indigo-700',
  late:      'border border-amber-200  bg-amber-50   text-amber-600',
  ot:        'border border-sky-200    bg-sky-50     text-sky-700',
  normal:    'border border-gray-200   bg-gray-50    text-gray-500',
}

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

// ── Helpers ────────────────────────────────────────────────────────────────
function getStatus(
  rec: ProcessedRecord | undefined,
  date: string,
  isApproved: boolean,
  companyHolSet: ReadonlySet<string> = new Set(),
): Status {
  if (!rec) {
    const dow = new Date(date + 'T12:00').getDay()
    if (dow === 0 || dow === 6) return 'WEEKEND'
    if (companyHolSet.has(date)) return 'WEEKEND'
    return 'ABSENT'
  }
  const cat = FINAL_STATUS_CATEGORY[rec.finalStatus]
  if (cat === 'NON_WORKING')  return 'WEEKEND'
  if (cat === 'HOLIDAY_WORK') return 'H'
  if (isApproved && cat === 'ANOMALY') return 'APPROVED'
  if (rec.finalStatus === '지각') return 'L'
  if (cat === 'ANOMALY')           return 'A'
  if ((rec.isLeader || rec.erpOtApplied) && (rec.overtimeHours > 0 || rec.finalStatus === '연장근로')) return 'OT'
  return 'N'
}

/** Exact display — floors to the nearest minute (no rounding). */
function fmt(h: number): string {
  if (h === 0) return '—'
  const totalMins = Math.floor(h * 60)
  const hh = Math.floor(totalMins / 60)
  const mm = totalMins % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

/** Floor a decimal-hour value down to the nearest 30-minute boundary. */
function floorTo30(h: number): number {
  return Math.floor(h * 2) / 2
}

/** Splits a day's individually-submitted leave codes into AM/PM display buckets.
 *  Codes with no 오전/오후 marker (e.g. a standalone '연차'/'반차' request) are
 *  ambiguous and shown in both buckets, matching the legacy single-code behavior. */
function splitComboLeaveCodes(codes: string[]): { am: string[]; pm: string[] } {
  const am: string[] = []
  const pm: string[] = []
  for (const c of codes) {
    const isAM = c.includes('오전')
    const isPM = c.includes('오후')
    if (isAM || (!isAM && !isPM)) am.push(c)
    if (isPM || (!isAM && !isPM)) pm.push(c)
  }
  return { am, pm }
}

// ── Statutory limit helpers ────────────────────────────────────────────────

/** Returns the statutory hour ceiling based on the date-range length. */
function getStatutoryLimit(selectedDays: number): number {
  return selectedDays <= 7 ? 52 : 209
}

function InfoTag({ cls, text, dashed }: { cls: string; text: string; dashed?: boolean }) {
  return (
    <span
      className={`inline-block text-[7px] font-semibold rounded px-1 py-px leading-none shrink-0 ${cls}${dashed ? ' opacity-70' : ''}`}
      style={dashed ? { borderStyle: 'dashed' } : undefined}
    >
      {text}
    </span>
  )
}

// ── Header icons — interactive ─────────────────────────────────────────────
function SortIcon({ dir }: { dir: SortDir }) {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
        d="M7 16V4m0 0L3 8m4-4l4 4"
        stroke={dir === 'asc' ? '#3b82f6' : '#d1d5db'} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
        d="M17 8v12m0 0l4-4m-4 4l-4-4"
        stroke={dir === 'desc' ? '#3b82f6' : '#d1d5db'} />
    </svg>
  )
}

function FilterIcon({ active, danger }: { active: boolean; danger?: boolean }) {
  return (
    <svg className={`w-3 h-3 shrink-0 ${active ? (danger ? 'text-red-500' : 'text-blue-500') : 'text-gray-300'}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
    </svg>
  )
}

// ── Props ──────────────────────────────────────────────────────────────────
type Props = {
  employees:        Employee[]
  records:          ProcessedRecord[]
  dates:            string[]
  onNameClick:      (id: string) => void
  onCellClick:      (employeeId: string, date: string) => void
  approvedKeys:     Set<string>
  /** IDs of the top-3 risk employees — rendered with a red left border + badge */
  topRiskIds?:      ReadonlySet<string>
  /** When true: slice to 10 by default and show 더 보기 button */
  riskMode?:        boolean
  riskThresholds?:  RiskThresholds
  /** Display time basis — recognized (payroll) or exact (raw) */
  timeMode?:        'recognized' | 'exact'
  /** 인정시간 모드에서 연차 크레딧 포함 여부 */
  creditsOn?:       boolean
  /** Company-wide holiday dates — shown with teal header; no-record cells treated as non-working */
  companyHolidays?: { date: string; label: string }[]
  /** Called when the user changes the org filter — lets the parent sync pagination */
  onOrgFilterChange?: (div: string | null, team: string | null) => void
  /** Called when user clicks an empty cell (no record) or weekend cell to manually add attendance */
  onEmptyCellClick?: (employeeId: string, date: string) => void
  /** Called when the hours compliance filter changes, so the parent can adjust pagination */
  onHoursFilterChange?: (filter: 'all' | 'over52' | 'over209') => void
  /** Called when sort changes — parent should re-sort all employees before slicing to page */
  onSortChange?: (key: 'name' | 'ot' | 'night' | 'holiday' | 'anomaly', dir: 'asc' | 'desc' | 'none') => void
  /** DB 예외규칙 포함 직책자 ID set — emp.isLeader(직급명 자동감지)와 통합하여 isLeader 판별 */
  leaderIdSet?: ReadonlySet<string>
  /** 직원별 속성 오버라이드 맵 (발령일/해임일 포함) — page.tsx의 finalAttrMap 전달 */
  attrMap?: ReadonlyMap<string, EmployeeAttributeOverrides>
  /** 이름 옆 체크박스로 선택된 직원 ID 집합 (다중 선택) — page.tsx에서 상태 관리 */
  selectedIds?: ReadonlySet<string>
  /** 체크박스 클릭 시 호출 — 해당 직원의 선택 여부를 토글 */
  onToggleSelect?: (employeeId: string) => void
}

// ── Component ─────────────────────────────────────────────────────────────
export function EmployeeCalendarGrid({
  employees,
  records,
  dates,
  onNameClick,
  onCellClick,
  approvedKeys,
  topRiskIds,
  riskMode,
  riskThresholds = HR_THRESHOLDS,
  timeMode = 'recognized' as const,
  creditsOn = true,
  companyHolidays = [],
  onOrgFilterChange,
  onEmptyCellClick,
  onHoursFilterChange,
  onSortChange,
  leaderIdSet,
  attrMap,
  selectedIds,
  onToggleSelect,
}: Props) {
  const companyHolSet   = useMemo(() => new Set(companyHolidays.map(h => h.date)), [companyHolidays])
  const companyHolLabel = useMemo(() => new Map(companyHolidays.map(h => [h.date, h.label])), [companyHolidays])

  // 직원별 날짜 기준 직책자 판별 헬퍼 — attendanceCalc.ts의 공유 함수 재사용
  const makeIsLeaderOnDate = (empId: string): ((date: string) => boolean) => {
    const attrs = attrMap?.get(empId)
    const emp   = employees.find(e => e.id === empId)
    return (date: string) => isLeaderOnDateCore(attrs, emp, date)
  }

  // ── Inline sort / filter state ─────────────────────────────────────────
  type SortKey = 'name' | 'ot' | 'night' | 'holiday' | 'anomaly'
  const [sortKey,      setSortKey]      = useState<SortKey>('name')
  const [sortDir,      setSortDir]      = useState<SortDir>('none')
  const [filterDiv,    setFilterDiv]    = useState<string | null>(null)
  const [filterTeam,   setFilterTeam]   = useState<string | null>(null)

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      const nextDir: SortDir = sortDir === 'none' ? (key === 'name' ? 'asc' : 'desc') : sortDir === 'asc' ? 'desc' : 'asc'
      setSortDir(nextDir)
      onSortChange?.(key, nextDir)
    } else {
      const nextDir: SortDir = key === 'name' ? 'asc' : 'desc'
      setSortKey(key)
      setSortDir(nextDir)
      onSortChange?.(key, nextDir)
    }
  }
  const [openDropdown, setOpenDropdown] = useState<'org' | 'total' | null>(null)
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null)
  const [showAll,      setShowAll]      = useState(false)
  const [hoursFilter,  setHoursFilter]  = useState<'all' | 'over52' | 'over209'>('all')

  // Precompute the statutory ceiling once — used for filtering and bar rendering
  const maxLimit = getStatutoryLimit(dates.length)

  // ── Dropdown option lists ──────────────────────────────────────────────
  const divOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const e of employees) { if (e.division) seen.add(e.division) }
    return sortByDivisionOrder([...seen])
  }, [employees])

  const teamOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    const source = filterDiv ? employees.filter(e => e.division === filterDiv) : employees
    for (const e of source) {
      if (e.team && !seen.has(e.team)) { seen.add(e.team); result.push(e.team) }
    }
    return result.sort((a, b) => a.localeCompare(b, 'ko'))
  }, [employees, filterDiv])

  // ── Derived display list: filter → sort ───────────────────────────────
  // employees is pre-filtered and risk-ranked by the parent when riskMode is on.
  // The inline dropdown applies as an additional sub-filter; name-sort overrides
  // the risk order only when the user explicitly activates it.
  const displayEmployees = useMemo(() => {
    let result = employees
    if (filterDiv)  result = result.filter(e => e.division === filterDiv)
    if (filterTeam) result = result.filter(e => e.team === filterTeam)
    return result
  }, [employees, filterDiv, filterTeam])

  // ── Existing data memos ────────────────────────────────────────────────
  const lookup = useMemo(() => {
    const map: Record<string, Record<string, ProcessedRecord>> = {}
    for (const r of records) {
      if (!map[r.employeeId]) map[r.employeeId] = {}
      map[r.employeeId][r.date] = r
    }
    return map
  }, [records])

const dateSet = useMemo(() => new Set(dates), [dates])

const empStats = useMemo(() => {
  const stats: Record<string, {
    total: number; nocreditTotal: number; rawTotal: number
    ot: number; rawOt: number
    night: number; rawNight: number
    holiday: number; rawHoliday: number
    anomalies: number
  }> = {}

  for (const emp of employees) {
    const recs     = records.filter(r => r.employeeId === emp.id && dateSet.has(r.date))
    // DB 예외규칙(leaderIdSet) OR 직급명 자동감지(emp.isLeader) 둘 다 인정 — 날짜 기준 판별
    const isLeaderOnDate = makeIsLeaderOnDate(emp.id)

    let exactOt = 0, roundedOt = 0
    let exactTotal = 0, roundedTotal = 0, nocreditTotal = 0
    let exactNight = 0, roundedNight = 0

    for (const r of recs) {
      const leaveAmt       = r.erpLeaveAmount ?? 0
      const isSlackInj     = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
      const isErpApproved  = r.leaveType ? !isSlackInj : true
      // r.effectiveClockIn(엔진이 계산한 값)을 그대로 사용 — 외근 09:00 동결 등 leaveType
      // 기반 재계산(computeEffClockIn)이 모르는 보정까지 반영됨.
      const effIn          = r.effectiveClockIn ?? r.clockIn
      const ciRec          = effIn     ? parseTimeToMins(effIn)     : null
      const ciExact     = r.clockIn ? parseTimeToMins(r.clockIn) : null
      const co          = r.clockOut ? parseTimeToMins(r.clockOut) : null
      const elRec       = (ciRec   !== null && co !== null) ? Math.max(0, co - ciRec)   : 0
      const elExact     = (ciExact !== null && co !== null) ? Math.max(0, co - ciExact) : 0
      const netRecMins  = Math.max(0, elRec   - compute4141BreakMins(elRec))
      const netExactMins= Math.max(0, elExact - compute4141BreakMins(elExact))
      const credit      = (!r.isUnpaidLeave && !isSlackInj) ? leaveAmt * 8 : 0
      const netRecH     = netRecMins / 60

      if (r.dayType === 'WEEKDAY') {
        exactTotal += netExactMins / 60
        // Button 3: virtualIn + 10h 기준 (ERP 가드·절삭 없음, 실제 출근 기준)
        const viExact    = ciExact !== null ? computeVirtualInMins(ciExact, r.leaveType, isErpApproved) : 0
        exactOt += (ciExact !== null && co !== null) ? Math.max(0, co - (viExact + 600)) / 60 : 0
        exactNight    += r.nightHours ?? 0

        if (isLeaderOnDate(r.date)) {
          // 직책자: virtualIn + 10h 기준, 30분 절삭 없음
          const vi         = ciRec !== null ? computeVirtualInMins(ciRec, r.leaveType, isErpApproved) : 0
          const leaderOtH  = (ciRec !== null && co !== null) ? Math.max(0, co - (vi + 600)) / 60 : 0
          roundedOt    += leaderOtH
          roundedNight += r.nightHours ?? 0
          roundedTotal  += netRecH + credit
          nocreditTotal += netRecH
        } else {
          const approvedOt = r.erpOtApplied ? (r.overtimeHours ?? 0) : 0
          const stdH       = Math.min(netRecH, 8)
          // 연장근로 발생일: 급여용 연장(approvedOt)이 이미 backtrack(반차보정)을 흡수했으므로
          // credit을 별도로 더하면 이중계상됨 → 8h 고정 + approvedOt만 사용
          const dayTotal    = approvedOt > 0 ? (8 + approvedOt) : (stdH + credit)
          const dayNoCredit = approvedOt > 0 ? (8 + approvedOt) : stdH
          roundedOt    += approvedOt
          roundedNight += r.erpOtApplied ? floorTo30(r.nightHours ?? 0) : 0
          roundedTotal  += dayTotal
          nocreditTotal += dayNoCredit
        }
      } else if (r.finalStatus === '휴일근무') {
        const holH    = r.holidayHours ?? 0
        exactTotal   += holH
        roundedTotal += floorTo30(holH)
        nocreditTotal += floorTo30(holH)
      } else {
        const holH = r.holidayHours ?? 0
        exactTotal   += holH
        roundedTotal += floorTo30(holH)
        nocreditTotal += floorTo30(holH)
      }
    }

    const rawHoliday = recs.reduce(
      (s, r) => s + (r.dayType !== 'WEEKDAY' ? (r.holidayHours ?? 0) : 0), 0)
    const roundedHoliday = recs.reduce((s, r) => {
      if (r.dayType === 'WEEKDAY') return s
      return s + floorTo30(r.holidayHours ?? 0)
    }, 0)
    stats[emp.id] = {
      total:      roundedTotal,
      nocreditTotal,
      rawTotal:   exactTotal,
      ot:         roundedOt,
      rawOt:      exactOt,
      night:      roundedNight,
      rawNight:   exactNight,
      holiday:    roundedHoliday,
      rawHoliday,
      anomalies: recs.filter(
        r => FINAL_STATUS_CATEGORY[r.finalStatus] === 'ANOMALY' &&
             !approvedKeys.has(`${r.employeeId}_${r.date}`),
      ).length,
    }
  }
  return stats
}, [employees, records, approvedKeys, leaderIdSet, dateSet])

  // Hours compliance filter
  // - 52h: 주간 단위로 나눠서 어느 주든 52h 초과하면 표시 (주 52시간 법정 한도)
  // - 209h: 기간 전체 합계가 209h 이상이면 표시 (월 209h 한도)
  const filteredEmployees = useMemo(() => {
    if (hoursFilter === 'all') return displayEmployees

    if (hoursFilter === 'over209') {
      return displayEmployees.filter(e => {
        const s = empStats[e.id]
        const v = timeMode === 'exact'
          ? (s?.rawTotal ?? 0)
          : creditsOn ? (s?.total ?? 0) : (s?.nocreditTotal ?? 0)
        return v >= 209
      })
    }

    // over52: 주별 집계 — 어느 한 주라도 52h 초과 시 표시
    const recsByEmp = new Map<string, ProcessedRecord[]>()
    for (const r of records) {
      if (!dateSet.has(r.date)) continue
      const bucket = recsByEmp.get(r.employeeId)
      if (bucket) bucket.push(r)
      else recsByEmp.set(r.employeeId, [r])
    }

    function weekKey(dateStr: string): string {
      const d = new Date(dateStr + 'T12:00')
      const dow  = d.getDay()
      const back = dow === 0 ? 6 : dow - 1
      d.setDate(d.getDate() - back)
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    }

    return displayEmployees.filter(e => {
      const empRecs = recsByEmp.get(e.id) ?? []
      const weekTotals: Record<string, number> = {}
      const isLeaderOnDate = makeIsLeaderOnDate(e.id)
      for (const r of empRecs) {
        // empStats.roundedTotal 과 동일 기준 (크레딧 ON, 직책자/비직책자 구분)
        const isSlackInj    = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
        const isErpApproved = r.leaveType ? !isSlackInj : true
        const credit        = (isErpApproved && !r.isUnpaidLeave && r.erpLeaveAmount)
          ? r.erpLeaveAmount * 8 : 0
        let addH: number
        if (r.dayType !== 'WEEKDAY') {
          // 휴일근무: 직책자/비직책자 모두 30분 절삭
          addH = r.finalStatus === '휴일근무' ? floorTo30(r.holidayHours ?? 0) : 0
        } else {
          const effClockInStr = r.effectiveClockIn ?? r.clockIn
          const ciEff = effClockInStr ? parseTimeToMins(effClockInStr) : null
          const co    = r.clockOut ? parseTimeToMins(r.clockOut) : null
          if (ciEff === null || co === null) {
            addH = credit
          } else {
            const elapsed = Math.max(0, co - ciEff)
            const netRecH = Math.max(0, elapsed - compute4141BreakMins(elapsed)) / 60
            if (isLeaderOnDate(r.date)) {
              addH = netRecH + credit
            } else {
              const approvedOt = r.erpOtApplied ? (r.overtimeHours ?? 0) : 0
              // empStats.roundedTotal과 동일 기준: 연장근로 발생일은 credit 별도가산 없이 8h+approvedOt
              addH = approvedOt > 0 ? (8 + approvedOt) : (Math.min(netRecH, 8) + credit)
            }
          }
        }
        const wk = weekKey(r.date)
        weekTotals[wk] = (weekTotals[wk] ?? 0) + addH
      }
      return Object.values(weekTotals).some(h => h >= 52)
    })
  }, [displayEmployees, hoursFilter, empStats, timeMode, creditsOn, records, dateSet])

  // Sort after stats are available
  const sortedEmployees = useMemo(() => {
    if (sortDir === 'none') return filteredEmployees
    return [...filteredEmployees].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name, 'ko')
      } else {
        const sa = empStats[a.id] ?? { ot: 0, night: 0, holiday: 0, anomalies: 0 }
        const sb = empStats[b.id] ?? { ot: 0, night: 0, holiday: 0, anomalies: 0 }
        const field = sortKey === 'ot' ? 'ot' : sortKey === 'night' ? 'night' : sortKey === 'holiday' ? 'holiday' : 'anomalies'
        const prefix = timeMode === 'exact' ? 'raw' : ''
        const cap = field.charAt(0).toUpperCase() + field.slice(1)
        const getV = (s: Record<string, number>) =>
          prefix ? (s[prefix + cap] ?? s[field]) : s[field]
        cmp = getV(sa as Record<string, number>) - getV(sb as Record<string, number>)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredEmployees, sortKey, sortDir, empStats, timeMode])

  // Slice to 10 when risk mode is active and the user hasn't expanded yet
  const visibleEmployees = riskMode && !showAll
    ? sortedEmployees.slice(0, 10)
    : sortedEmployees

  const isMultiMonth =
    dates.length > 1 &&
    dates[0].slice(0, 7) !== dates[dates.length - 1].slice(0, 7)

  const orgFilterActive = filterDiv !== null || filterTeam !== null

  // ── Dropdown handlers ─────────────────────────────────────────────────
  function handleOrgBtnClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setDropdownRect(rect)
    setOpenDropdown(prev => prev === 'org' ? null : 'org')
  }

  function handleTotalBtnClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setDropdownRect(rect)
    setOpenDropdown(prev => prev === 'total' ? null : 'total')
  }

  if (employees.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-400">
        조건에 맞는 직원이 없습니다
      </div>
    )
  }

  return (
    <>
      {/* ── Fixed-position dropdown overlay ─────────────────────────────── */}
      {/* ── Hours compliance filter dropdown ────────────────────────────── */}
      {openDropdown === 'total' && dropdownRect !== null && (
        <>
          <div className="fixed inset-0 z-[45]" onClick={() => setOpenDropdown(null)} />
          <div
            className="fixed z-[50] bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden py-1.5 w-40 text-[11px]"
            style={{ top: dropdownRect.bottom + 4, left: dropdownRect.left }}
          >
            <p className="px-3 pt-0.5 pb-1 text-[9px] text-gray-400 font-semibold tracking-wider uppercase">근로시간 필터</p>
            <div className="h-px bg-gray-100 mx-2 mb-1" />
            {([
              { key: 'all',     label: '전체',      sub: '필터 없음' },
              { key: 'over52',  label: '52h 초과',  sub: '주 52h 법정 한도' },
              { key: 'over209', label: '209h 초과', sub: '월 209h 법정 한도' },
            ] as const).map(({ key, label, sub }) => (
              <button
                key={key}
                className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-gray-50 transition-colors ${
                  hoursFilter === key ? 'text-red-600 font-semibold bg-red-50/60' : 'text-gray-600'
                }`}
                onClick={() => { setHoursFilter(key); onHoursFilterChange?.(key); setOpenDropdown(null) }}
              >
                <span className="flex flex-col gap-px">
                  <span>{label}</span>
                  <span className="text-[9px] text-gray-400 font-normal">{sub}</span>
                </span>
                {hoursFilter === key && <span className="text-red-400 text-[9px] shrink-0">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {openDropdown === 'org' && dropdownRect !== null && (
        <>
          {/* Transparent backdrop — click-outside to close */}
          <div className="fixed inset-0 z-[45]" onClick={() => setOpenDropdown(null)} />

          {/* Hierarchical org dropdown panel */}
          <div
            className="fixed z-[50] bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden py-1.5 w-48 text-[11px]"
            style={{ top: dropdownRect.bottom + 4, left: dropdownRect.left }}
          >
            {/* Clear selection */}
            <button
              className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-gray-50 transition-colors ${!filterDiv ? 'text-blue-600 font-semibold' : 'text-gray-600'}`}
              onClick={() => { setFilterDiv(null); setFilterTeam(null); setOpenDropdown(null); onOrgFilterChange?.(null, null) }}
            >
              전체 소속
              {!filterDiv && <span className="text-blue-400 text-[9px]">✓</span>}
            </button>

            <div className="h-px bg-gray-100 mx-2 my-1" />
            <p className="px-3 pt-0.5 pb-1 text-[9px] text-gray-400 font-semibold tracking-wider uppercase">본부</p>

            {divOptions.map(div => (
              <button
                key={div}
                className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-gray-50 transition-colors ${filterDiv === div && !filterTeam ? 'text-blue-600 font-semibold bg-blue-50/60' : 'text-gray-600'}`}
                onClick={() => { setFilterDiv(div); setFilterTeam(null); onOrgFilterChange?.(div, null) }}
              >
                {div}
                {filterDiv === div && !filterTeam && <span className="text-blue-400 text-[9px]">✓</span>}
              </button>
            ))}

            {/* Team section — only when a division is selected */}
            {filterDiv && teamOptions.length > 0 && (
              <>
                <div className="h-px bg-gray-100 mx-2 my-1" />
                <p className="px-3 pt-0.5 pb-1 text-[9px] text-gray-400 font-semibold tracking-wider uppercase">팀/부서</p>
                {teamOptions.map(team => (
                  <button
                    key={team}
                    className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-gray-50 transition-colors ${filterTeam === team ? 'text-blue-600 font-semibold bg-blue-50/60' : 'text-gray-600'}`}
                    onClick={() => { setFilterTeam(team); setOpenDropdown(null); onOrgFilterChange?.(filterDiv, team) }}
                  >
                    {team}
                    {filterTeam === team && <span className="text-blue-400 text-[9px]">✓</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}

      <div className="bg-white rounded-xl border border-gray-200 flex flex-col min-w-0 h-[calc(100vh-250px)]">

        {/* ── Active compliance filter banner ──────────────────────────────── */}
        {hoursFilter !== 'all' && (
          <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border-b border-red-100 shrink-0">
            <span className="text-[11px] font-semibold text-red-700">
              🚨 {hoursFilter === 'over52' ? '52h' : '209h'} 초과자만 표시 중
            </span>
            <span className="text-[11px] text-red-400 tabular-nums">
              ({filteredEmployees.length}명)
            </span>
            <button
              onClick={() => { setHoursFilter('all'); onHoursFilterChange?.('all') }}
              className="ml-auto text-[11px] text-red-400 hover:text-red-600 font-medium transition-colors"
            >
              필터 해제 ✕
            </button>
          </div>
        )}

        {/*
          Z-index stacking
            z-50  corner <th>  — sticky top + left (highest: sits above all)
            z-40  date <th>    — sticky top only (above body sticky cells when scrolling down)
            z-30  body left <td> — sticky left only (above data cells when scrolling right)
            auto  date body <td> — not sticky
          All sticky cells MUST have solid (non-alpha) backgrounds.
          rowSpan=3 cells carry border-b-2 which renders at their visual bottom
          (after Row 3), matching the border-b-2 on Row 3's other cells.
        */}
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="table-fixed min-w-max border-collapse text-xs">

            {/* ════════════════ HEADER ════════════════════════════════════════ */}
            <thead>
              <tr className="border-b-2 border-gray-200">

                {/* 이름 — clickable sort toggle */}
                <th className="sticky z-50 bg-gray-50 pl-3 pr-2 py-3 text-left text-[11px] font-semibold text-gray-500"
                  style={{ top: 0, left: L1, width: W_NAME, minWidth: W_NAME }}>
                  <button
                    onClick={() => handleSort('name')}
                    className="flex items-center justify-between gap-1 w-full hover:text-gray-700 transition-colors"
                  >
                    <span className={sortKey === 'name' && sortDir !== 'none' ? 'text-blue-600' : ''}>이름</span>
                    <SortIcon dir={sortKey === 'name' ? sortDir : 'none'} />
                  </button>
                </th>

                {/* 소속 — hierarchical dropdown filter (본부 + 팀/부서) */}
                <th className="sticky z-50 bg-gray-50 pl-3 pr-2 py-3 text-left text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L2, width: W_ORG, minWidth: W_ORG }}>
                  <button
                    onClick={handleOrgBtnClick}
                    className="flex items-center justify-between gap-1 w-full hover:text-gray-700 transition-colors"
                  >
                    <span className={orgFilterActive ? 'text-blue-600' : ''}>소속</span>
                    <FilterIcon active={orgFilterActive} />
                  </button>
                </th>

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-center text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L3, width: W_TOTAL, minWidth: W_TOTAL }}>
                  <button
                    onClick={handleTotalBtnClick}
                    className="flex items-center justify-center gap-1 w-full hover:text-gray-700 transition-colors"
                    title="총 근로시간 기준 필터"
                  >
                    <span className={hoursFilter !== 'all' ? 'text-red-600' : ''}>총 근로</span>
                    <FilterIcon active={hoursFilter !== 'all'} danger />
                  </button>
                </th>

                {([
                  { key: 'ot',      label: '연장', left: L_OT,      w: W_OT      },
                  { key: 'night',   label: '야간', left: L_NIGHT,   w: W_NIGHT   },
                  { key: 'holiday', label: '휴일', left: L_HOLIDAY, w: W_HOLIDAY },
                  { key: 'anomaly', label: '이상', left: L_ANOMALY, w: W_ANOMALY },
                ] as const).map(({ key, label, left, w }) => (
                  <th key={key}
                    className="sticky z-50 bg-gray-50 px-2 py-3 text-center text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                    style={{ top: 0, left, width: w, minWidth: w }}>
                    <button
                      onClick={() => handleSort(key)}
                      className="flex items-center justify-center gap-0.5 w-full hover:text-gray-700 transition-colors"
                    >
                      <span className={sortKey === key && sortDir !== 'none' ? 'text-blue-600' : ''}>{label}</span>
                      <SortIcon dir={sortKey === key ? sortDir : 'none'} />
                    </button>
                  </th>
                ))}

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-left text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                  구분
                </th>

                {dates.map(date => {
                  const d = new Date(date + 'T12:00')
                  const dow = d.getDay()
                  const isWknd    = dow === 0 || dow === 6
                  const isCmpHol  = companyHolSet.has(date)
                  const holLabel  = companyHolLabel.get(date)
                  const bgCls     = isCmpHol ? 'bg-teal-50' : isWknd ? 'bg-slate-50' : 'bg-gray-50'
                  const numCls    = isCmpHol ? 'text-teal-600' : isWknd ? 'text-slate-400' : 'text-gray-600'
                  const dowCls    = isCmpHol ? 'text-teal-400' : isWknd ? 'text-slate-300' : 'text-gray-300'
                  return (
                    <th key={date}
                      className={`sticky z-40 pt-2 pb-1.5 text-center border-l border-gray-100 whitespace-nowrap ${bgCls}`}
                      style={{ top: 0, width: W_DATE, minWidth: W_DATE }}>
                      <div className={`text-[11px] font-bold leading-none ${numCls}`}>
                        {isMultiMonth ? `${d.getMonth() + 1}/${d.getDate()}` : d.getDate()}
                      </div>
                      <div className={`text-[9px] mt-0.5 leading-none font-medium ${dowCls}`}>
                        {DOW_KR[dow]}
                      </div>
                      {isCmpHol && holLabel && (
                        <div className="text-[8px] mt-0.5 leading-none font-semibold text-teal-500 truncate px-0.5">
                          {holLabel}
                        </div>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>

            {/* ════════════════ BODY ══════════════════════════════════════════
                One <tbody> per employee → 3 <tr>:
                  Row 1  출근     clock-in  + 지각/오전반차 tag
                  Row 2  퇴근     clock-out + 조기/연장/오후반차 tag
                  Row 3  초과근로  overtime + 연차/휴일근무 badge / ⚠ warning
            ══════════════════════════════════════════════════════════════════ */}
            {visibleEmployees.map((emp, rowIdx) => {
              const empRecs   = lookup[emp.id] ?? {}
              const s         = empStats[emp.id] ?? { total: 0, ot: 0, night: 0, holiday: 0, anomalies: 0 }
              const isTopRisk = topRiskIds?.has(emp.id) ?? false
              const isLeaderOnDate = makeIsLeaderOnDate(emp.id)
              // 뱃지: 표시 기간 내 어느 날이라도 직책자면 표시
              const isLeader = dates.some(d => isLeaderOnDate(d))
              const isEven    = rowIdx % 2 === 0
              const baseBg    = isEven ? 'bg-white' : 'bg-gray-50'

              const spanTd = `sticky z-30 border-b-2 border-gray-200 ${baseBg}`
              const catTd  = `sticky z-30 px-2 py-1.5 border-l border-gray-200 text-[9px] font-semibold text-gray-400 uppercase tracking-wide ${baseBg}`

              return (
                <tbody key={emp.id}>

                  {/* ── Row 1: 출근 ──────────────────────────────────────── */}
                  <tr>
                    {/* 이름 — rowSpan 4 */}
                    <td className={`${spanTd} pl-2 pr-2 py-3 ${isTopRisk ? 'border-l-4 border-l-red-400' : ''}`}
                      style={{ left: L1, width: W_NAME, minWidth: W_NAME }}
                      rowSpan={4}>
                      <div className="flex items-start gap-1">
                        {onToggleSelect && (
                          <input
                            type="checkbox"
                            checked={selectedIds?.has(emp.id) ?? false}
                            onChange={() => onToggleSelect(emp.id)}
                            className="mt-0.5 shrink-0 w-3 h-3 accent-blue-600 cursor-pointer"
                            title={`${emp.name} 선택`}
                          />
                        )}
                        <button onClick={() => onNameClick(emp.id)} className="text-left block w-full min-w-0">
                          <div className="flex items-center gap-1 min-w-0" style={{ maxWidth: W_NAME - 40 }}>
                            <span className="text-[11px] font-semibold text-gray-800 hover:text-blue-600 transition-colors leading-tight truncate">
                              {emp.name}
                            </span>
                            {isLeader && (
                              <span className="shrink-0 text-[8px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-px leading-tight">
                                직책
                              </span>
                            )}
                          </div>
                          {emp.jobTitle && (
                            <p className="text-[9px] text-gray-400 mt-0.5 leading-tight truncate"
                              style={{ maxWidth: W_NAME - 40 }}>
                              {emp.jobTitle}
                            </p>
                          )}
                          {isTopRisk && (
                            <span className="inline-flex items-center gap-px text-[8px] font-bold text-red-500 mt-1 leading-none">
                              🚨 집중 관리
                            </span>
                          )}
                        </button>
                      </div>
                    </td>

                    {/* 소속 (본부 + 팀/부서 stacked) — rowSpan 4 */}
                    <td className={`${spanTd} border-l pl-3 pr-2 py-3`}
                      style={{ left: L2, width: W_ORG, minWidth: W_ORG }}
                      rowSpan={4}>
                      <p className="text-[10px] font-medium text-gray-700 leading-tight truncate"
                        style={{ maxWidth: W_ORG - 16 }}>
                        {emp.division}
                      </p>
                      <p className="text-[9px] text-gray-400 mt-0.5 leading-tight truncate"
                        style={{ maxWidth: W_ORG - 16 }}>
                        {emp.team}
                      </p>
                      {emp.part && (
                        <p className="text-[9px] text-gray-400 mt-0.5 leading-tight truncate"
                          style={{ maxWidth: W_ORG - 16 }}>
                          {emp.part}
                        </p>
                      )}
                    </td>

                    {/* 총 근로 — rowSpan 4 */}
                    <td className={`${spanTd} border-l px-1.5 py-2 text-center`}
                      style={{ left: L3, width: W_TOTAL, minWidth: W_TOTAL }}
                      rowSpan={4}>
                      {(() => {
                        const display = timeMode === 'exact' ? s.rawTotal : creditsOn ? s.total : s.nocreditTotal
                        return (
                          <>
                            <span className="text-[12px] font-bold text-gray-800 tabular-nums block leading-tight">
                              {fmt(display)}
                            </span>
                            <div className="w-full mt-1 h-1 rounded-full bg-gray-100 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  display > maxLimit              ? 'bg-red-500'
                                  : display > riskThresholds.totalAmberH ? 'bg-amber-400'
                                  : 'bg-green-500'
                                }`}
                                style={{ width: `${Math.min((display / maxLimit) * 100, 100)}%` }}
                              />
                            </div>
                            <span className={`text-[8px] mt-0.5 block tabular-nums leading-none ${
                              display > maxLimit              ? 'text-red-600 font-bold'
                              : display > riskThresholds.totalAmberH ? 'text-amber-600 font-semibold'
                              : 'text-emerald-600'
                            }`}>
                              {fmt(display)} / {maxLimit}h{
                                display > maxLimit              ? ' 🚨'
                                : display > riskThresholds.totalAmberH ? ' ⚠️'
                                : ''
                              }
                            </span>
                          </>
                        )
                      })()}
                    </td>

                    {/* 연장 — rowSpan 4 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_OT, width: W_OT, minWidth: W_OT }}
                      rowSpan={4}>
                      {(() => {
                        const displayOt = timeMode === 'exact' ? s.rawOt : s.ot
                        return (
                          <span className={`text-[12px] font-bold tabular-nums ${
                            displayOt > riskThresholds.otRedH   ? 'text-red-500'
                            : displayOt > riskThresholds.otAmberH ? 'text-amber-500'
                            : displayOt > 0                       ? 'text-amber-300'
                            : 'text-gray-300'
                          }`}>
                            {fmt(displayOt)}
                          </span>
                        )
                      })()}
                    </td>

                    {/* 야간 — rowSpan 4 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_NIGHT, width: W_NIGHT, minWidth: W_NIGHT }}
                      rowSpan={4}>
                      {(() => {
                        const displayNight = timeMode === 'exact' ? s.rawNight : s.night
                        return (
                          <span className={`text-[12px] font-bold tabular-nums ${displayNight > 0 ? 'text-blue-500' : 'text-gray-300'}`}>
                            {fmt(displayNight)}
                          </span>
                        )
                      })()}
                    </td>

                    {/* 휴일 — rowSpan 4 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_HOLIDAY, width: W_HOLIDAY, minWidth: W_HOLIDAY }}
                      rowSpan={4}>
                      {(() => {
                        const displayHoliday = timeMode === 'exact' ? s.rawHoliday : s.holiday
                        return (
                          <span className={`text-[12px] font-bold tabular-nums ${displayHoliday > 0 ? 'text-violet-500' : 'text-gray-300'}`}>
                            {fmt(displayHoliday)}
                          </span>
                        )
                      })()}
                    </td>

                    {/* 이상 — rowSpan 4 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_ANOMALY, width: W_ANOMALY, minWidth: W_ANOMALY }}
                      rowSpan={4}>
                      <span className={`text-[12px] font-bold tabular-nums ${s.anomalies > 0 ? 'text-red-500' : 'text-gray-300'}`}>
                        {s.anomalies > 0 ? `${s.anomalies}건` : '0'}
                      </span>
                    </td>

                    {/* 구분: 출근 */}
                    <td className={`${catTd} border-b border-gray-100`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      출근
                    </td>

                    {/* Date: clock-in + any AM leave badge */}
                    {dates.map(date => {
                      const rec = empRecs[date]
                      const isApproved = approvedKeys.has(`${emp.id}_${date}`)
                      const status = getStatus(rec, date, isApproved, companyHolSet)
                      const isWknd = status === 'WEEKEND'
                      const showContent = !isWknd && status !== 'ABSENT'
                      const isLeaveDay = rec?.finalStatus === '연차'
                      const hasVacWrongDay = rec?.verificationNote?.includes('휴가 중 출근') ?? false
                      // 하루에 ERP 신청 2건 이상(예: 오전반차+오후반차=연차)이면 합산 라벨 대신 실제 신청 코드를 보여줌
                      const comboCodes = (rec?.leaveCodesDetail?.length ?? 0) >= 2 ? rec!.leaveCodesDetail! : null
                      const amCombo    = comboCodes ? splitComboLeaveCodes(comboCodes).am : []
                      const isSlackInjAM = (rec?.verificationNote ?? []).some(n => n.includes('ERP 미신청'))

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b border-gray-100 whitespace-nowrap align-middle ${
                            isWknd ? 'bg-slate-50/60' : ''
                          }`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {showContent ? (
                            isLeaveDay && !hasVacWrongDay ? (
                              amCombo.length > 0 ? (
                                <div className="w-full flex flex-col items-center gap-0.5 py-0.5">
                                  <span className="text-gray-200 text-[10px] select-none">—</span>
                                  <InfoTag cls={TAG.amLeave} text={amCombo.join('+')} />
                                </div>
                              ) : (
                                <span className="text-gray-200 text-[10px] select-none">—</span>
                              )
                            ) : (
                              <button
                                onClick={() => onCellClick(emp.id, date)}
                                className="w-full flex flex-col items-center gap-0.5 py-0.5"
                              >
                                {(() => {
                                  const disp = rec!.effectiveClockIn ?? rec!.clockIn
                                  const wasClamped = rec!.effectiveClockIn && rec!.clockIn &&
                                    rec!.effectiveClockIn !== rec!.clockIn
                                  return (
                                    <>
                                      <span className={`text-[9px] tabular-nums leading-none ${
                                        disp ? 'text-gray-700' : 'text-red-400'
                                      }`}>
                                        {disp ?? '미태깅'}
                                      </span>
                                      {wasClamped && (
                                        <span className="text-[8px] text-gray-400 line-through tabular-nums leading-none">
                                          {rec!.clockIn}
                                        </span>
                                      )}
                                    </>
                                  )
                                })()}
                                {(rec?.flag ?? '').includes('LATE') && <InfoTag cls={TAG.late} text="지각" />}
                                {amCombo.length > 0 ? (
                                  <InfoTag cls={TAG.amLeave} text={amCombo.join('+')} dashed={isSlackInjAM} />
                                ) : rec?.leaveType && (rec.leaveType === '반차' || !rec.leaveType.includes('오후')) && (
                                  <InfoTag cls={TAG.amLeave} text={rec.leaveType} dashed={isSlackInjAM} />
                                )}
                              </button>
                            )
                          ) : isWknd ? (
                            onEmptyCellClick ? (
                              <button onClick={() => onEmptyCellClick(emp.id, date)}
                                className="w-full h-5 flex items-center justify-center group">
                                <span className="text-slate-200 text-[10px] group-hover:hidden select-none">·</span>
                                <span className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-500 text-[10px] font-bold">+</span>
                              </button>
                            ) : <span className="text-slate-200 text-[10px] select-none">·</span>
                          ) : (
                            onEmptyCellClick ? (
                              <button onClick={() => onEmptyCellClick(emp.id, date)}
                                className="w-full h-5 flex items-center justify-center group">
                                <span className="text-gray-200 text-[10px] group-hover:hidden select-none">—</span>
                                <span className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-500 text-[10px] font-bold">+</span>
                              </button>
                            ) : <span className="text-gray-200 text-[10px] select-none">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>

                  {/* ── Row 2: 퇴근 ──────────────────────────────────────── */}
                  <tr>
                    {/* 구분: 퇴근 */}
                    <td className={`${catTd} border-b border-gray-100`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      퇴근
                    </td>

                    {/* Date: clock-out + any PM leave badge */}
                    {dates.map(date => {
                      const rec = empRecs[date]
                      const isApproved = approvedKeys.has(`${emp.id}_${date}`)
                      const status = getStatus(rec, date, isApproved, companyHolSet)
                      const isWknd = status === 'WEEKEND'
                      const showContent = !isWknd && status !== 'ABSENT'
                      const isLeaveDay = rec?.finalStatus === '연차'
                      const comboCodes = (rec?.leaveCodesDetail?.length ?? 0) >= 2 ? rec!.leaveCodesDetail! : null
                      const pmCombo    = comboCodes ? splitComboLeaveCodes(comboCodes).pm : []
                      const isSlackInjPM = (rec?.verificationNote ?? []).some(n => n.includes('ERP 미신청'))

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b border-gray-100 whitespace-nowrap align-middle ${
                            isWknd ? 'bg-slate-50/60' : ''
                          }`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {showContent ? (
                            isLeaveDay ? (
                              pmCombo.length > 0 ? (
                                <div className="w-full flex flex-col items-center gap-0.5 py-0.5">
                                  <span className="text-gray-200 text-[10px] select-none">—</span>
                                  <InfoTag cls={TAG.pmLeave} text={pmCombo.join('+')} dashed={isSlackInjPM} />
                                </div>
                              ) : (
                                <span className="text-gray-200 text-[10px] select-none">—</span>
                              )
                            ) : (
                              <button
                                onClick={() => onCellClick(emp.id, date)}
                                className="w-full flex flex-col items-center gap-0.5 py-0.5"
                              >
                                <span className={`text-[9px] tabular-nums leading-none ${
                                  rec!.clockOut ? 'text-gray-500' : 'text-red-400'
                                }`}>
                                  {rec!.clockOut ?? '미태깅'}
                                </span>
                                {pmCombo.length > 0 ? (
                                  <InfoTag cls={TAG.pmLeave} text={pmCombo.join('+')} dashed={isSlackInjPM} />
                                ) : rec?.leaveType && (rec.leaveType === '반차' || rec.leaveType.includes('오후')) && (
                                  <InfoTag cls={TAG.pmLeave} text={rec.leaveType} dashed={isSlackInjPM} />
                                )}
                              </button>
                            )
                          ) : isWknd ? (
                            <span className="text-slate-200 text-[10px] select-none">·</span>
                          ) : (
                            <span className="text-gray-200 text-[10px] select-none">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>

                  {/* ── Row 3: 초과근로 ──────────────────────────────────── */}
                  <tr>
                    <td className={`${catTd} border-b border-gray-100`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      초과근로
                    </td>
                    {dates.map(date => {
                      const rec    = empRecs[date]
                      const status = getStatus(rec, date, approvedKeys.has(`${emp.id}_${date}`), companyHolSet)
                      const isWknd = status === 'WEEKEND'

                      let otH = 0
                      if (rec && rec.dayType === 'WEEKDAY') {
                        const isSlack   = (rec.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
                        const isERP     = rec.leaveType ? !isSlack : true
                        const ciRawCell = rec.clockIn  ? parseTimeToMins(rec.clockIn)  : null
                        const effClockInStr = rec.effectiveClockIn ?? rec.clockIn
                        const coMins    = rec.clockOut ? parseTimeToMins(rec.clockOut) : null
                        if (ciRawCell !== null && coMins !== null) {
                          // OT = virtualIn + 10h 기준 — 크레딧 toggle과 무관하게 고정.
                          // 인정시간은 rec.effectiveClockIn(엔진 계산값, 외근 09:00 동결 등 반영)을 사용 —
                          // 원본 clockIn을 leaveType만으로 재계산(computeEffInMins)하면 이런 보정을 놓침.
                          const effInMins  = timeMode === 'exact'
                            ? ciRawCell
                            : (effClockInStr ? parseTimeToMins(effClockInStr) : ciRawCell)
                          const virtualIn  = computeVirtualInMins(effInMins, rec.leaveType, isERP)
                          const rawOtMins  = Math.max(0, coMins - (virtualIn + 600))
                          if (timeMode === 'exact') {
                            otH = rawOtMins / 60                              // 실제값: ERP 가드 없음, 절삭 없음
                          } else if (isLeaderOnDate(date)) {
                            otH = rawOtMins / 60                              // 직책자: 30분 절삭 없음
                          } else {
                            otH = rec.erpOtApplied ? Math.floor(rawOtMins / 30) * 30 / 60 : 0  // 비직책자: ERP 승인 + 30분 절삭
                          }
                        }
                      }

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b border-gray-100 whitespace-nowrap align-middle ${isWknd ? 'bg-slate-50/60' : ''}`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {!isWknd && status !== 'ABSENT' ? (
                            <button onClick={() => onCellClick(emp.id, date)}
                              className="w-full flex items-center justify-center py-0.5">
                              {otH > 0
                                ? <span className="text-[9px] tabular-nums font-bold text-amber-500 leading-none">{fmt(otH)}</span>
                                : <span className="text-gray-200 text-[10px] select-none">—</span>}
                            </button>
                          ) : isWknd ? (
                            <span className="text-slate-200 text-[10px] select-none">·</span>
                          ) : (
                            <span className="text-gray-200 text-[10px] select-none">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>

                  {/* ── Row 4: 근태상태 (last row — thick bottom border) ──── */}
                  <tr>
                    <td className={`${catTd} border-b-2 border-gray-200`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      근태상태
                    </td>
                    {dates.map(date => {
                      const rec    = empRecs[date]
                      const status = getStatus(rec, date, approvedKeys.has(`${emp.id}_${date}`), companyHolSet)
                      const isWknd = status === 'WEEKEND'
                      const fs     = rec?.finalStatus
                      const flag   = rec?.flag

                      // 연차가 ERP 미신청·Slack 공유만으로 확정된 경우 — 반차/반반차 콤보 뱃지와
                      // 동일하게 점선 처리해서 "ERP 승인건과 다르다"는 걸 구분되게 함.
                      const isSlackLeaveInj = (rec?.verificationNote ?? []).some(n => n.includes('ERP 미신청'))

                      const tags: { cls: string; text: string; dashed?: boolean }[] = []
                      if (fs === '연차')      tags.push({ cls: TAG.dayLeave,  text: '연차', dashed: isSlackLeaveInj })
                      if (fs === '외근')      tags.push({ cls: TAG.bizTrip,   text: '외근'       })
                      if (fs === '휴일근무')  tags.push({ cls: TAG.holiday,   text: '휴일근로'   })
                      if (fs === '출퇴근누락') tags.push({ cls: TAG.anomaly,  text: '출퇴근누락' })
                      // 3종 체계 — EARLY_DEPARTURE/LATE_AND_EARLY_DEPARTURE는 재계산 전 캐시된 레코드 하위호환
                      if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' ||
                          flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE')
                                             tags.push({ cls: TAG.anomaly,   text: '근무시간 미달' })
                      if ((rec?.overtimeHours ?? 0) > 0 && !flag && (rec?.isLeader || rec?.erpOtApplied))
                                             tags.push({ cls: TAG.ot,        text: '연장근로'    })

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b-2 border-gray-200 whitespace-nowrap align-middle ${isWknd ? 'bg-slate-50/60' : ''}`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {!isWknd && status !== 'ABSENT' ? (
                            <button onClick={() => onCellClick(emp.id, date)}
                              className="w-full flex flex-col items-center gap-0.5 py-0.5">
                              {tags.length > 0
                                ? tags.map(t => <InfoTag key={t.text} cls={t.cls} text={t.text} dashed={t.dashed} />)
                                : <span className="text-gray-300 text-[10px] select-none">—</span>}
                            </button>
                          ) : isWknd ? (
                            <span className="text-slate-200 text-[10px] select-none">·</span>
                          ) : (
                            <span className="text-gray-200 text-[10px] select-none">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>

                </tbody>
              )
            })}

          </table>
        </div>

        {/* ── 더 보기 ──────────────────────────────────────────────────── */}
        {riskMode && !showAll && displayEmployees.length > 10 && (
          <div className="flex items-center justify-center gap-3 py-3 border-t border-gray-100 shrink-0">
            <span className="text-[11px] text-gray-400">
              상위 10명 표시 중 · 전체 <span className="font-semibold text-gray-600">{displayEmployees.length}명</span>
            </span>
            <button
              onClick={() => setShowAll(true)}
              className="px-3 py-1 text-[11px] font-semibold rounded-full border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
            >
              더 보기 ({displayEmployees.length - 10}명 더)
            </button>
          </div>
        )}
      </div>
    </>
  )
}
