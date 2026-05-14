'use client'
import { useState, useMemo } from 'react'
import type { ProcessedRecord, Employee, RiskThresholds } from '@/types/tag'
import { HR_THRESHOLDS, FINAL_STATUS_CATEGORY } from '@/types/tag'

// ── Internal status ────────────────────────────────────────────────────────
type Status = 'N' | 'OT' | 'L' | 'A' | 'H' | 'APPROVED' | 'WEEKEND' | 'ABSENT'

// ── Sort direction ─────────────────────────────────────────────────────────
type SortDir = 'none' | 'asc' | 'desc'

// ── Column widths ──────────────────────────────────────────────────────────
const W_NAME    = 80
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
  amLeave:  'border border-blue-200   bg-blue-50    text-blue-600',
  pmLeave:  'border border-blue-200   bg-blue-50    text-blue-600',
  dayLeave: 'border border-green-200  bg-green-50   text-green-700',
  holiday:  'border border-violet-200 bg-violet-50  text-violet-700',
  anomaly:  'border border-red-200    bg-red-50     text-red-600',
  bizTrip:  'border border-teal-200   bg-teal-50    text-teal-700',
  remote:   'border border-indigo-200 bg-indigo-50  text-indigo-700',
}

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

// ── Helpers ────────────────────────────────────────────────────────────────
function getStatus(
  rec: ProcessedRecord | undefined,
  date: string,
  isApproved: boolean,
): Status {
  if (!rec) {
    const dow = new Date(date + 'T12:00').getDay()
    return dow === 0 || dow === 6 ? 'WEEKEND' : 'ABSENT'
  }
  const cat = FINAL_STATUS_CATEGORY[rec.finalStatus]
  if (cat === 'NON_WORKING')  return 'WEEKEND'
  if (cat === 'HOLIDAY_WORK') return 'H'
  if (isApproved && cat === 'ANOMALY') return 'APPROVED'
  if (rec.finalStatus === '지각') return 'L'
  if (cat === 'ANOMALY')           return 'A'
  if (rec.overtimeHours > 0 || rec.finalStatus === '연장근로') return 'OT'
  return 'N'
}

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function fmtH(h: number): string {
  if (h === 0) return '—'
  return `${Math.round(h)}h`
}

// ── Statutory limit helpers ────────────────────────────────────────────────

/** Returns the statutory hour ceiling based on the date-range length. */
function getStatutoryLimit(selectedDays: number): number {
  return selectedDays <= 7 ? 52 : 209
}

function InfoTag({ cls, text }: { cls: string; text: string }) {
  return (
    <span className={`inline-block text-[7px] font-semibold rounded px-1 py-px leading-none shrink-0 ${cls}`}>
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
  employees:       Employee[]
  records:         ProcessedRecord[]
  dates:           string[]
  onNameClick:     (id: string) => void
  onCellClick:     (employeeId: string, date: string) => void
  approvedKeys:    Set<string>
  /** IDs of the top-3 risk employees — rendered with a red left border + badge */
  topRiskIds?:     ReadonlySet<string>
  /** When true: slice to 10 by default and show 더 보기 button */
  riskMode?:       boolean
  riskThresholds?: RiskThresholds
  /** When true: show raw (pre-truncation) hours; default = recognized (payroll) hours */
  showExactTime?:  boolean
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
  showExactTime = false,
}: Props) {
  // ── Inline sort / filter state ─────────────────────────────────────────
  const [sortDir,      setSortDir]      = useState<SortDir>('none')
  const [filterDiv,    setFilterDiv]    = useState<string | null>(null)
  const [filterTeam,   setFilterTeam]   = useState<string | null>(null)
  const [openDropdown, setOpenDropdown] = useState<'org' | null>(null)
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null)
  const [showAll,           setShowAll]           = useState(false)
  const [showOnlyOverLimit, setShowOnlyOverLimit] = useState(false)

  // Precompute the statutory ceiling once — used for filtering and bar rendering
  const maxLimit = getStatutoryLimit(dates.length)

  // ── Dropdown option lists ──────────────────────────────────────────────
  const divOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const e of employees) {
      if (e.division && !seen.has(e.division)) { seen.add(e.division); result.push(e.division) }
    }
    return result.sort((a, b) => a.localeCompare(b, 'ko'))
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
    if (sortDir !== 'none') {
      result = [...result].sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, 'ko')
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return result
  }, [employees, filterDiv, filterTeam, sortDir])

  // ── Existing data memos ────────────────────────────────────────────────
  const lookup = useMemo(() => {
    const map: Record<string, Record<string, ProcessedRecord>> = {}
    for (const r of records) {
      if (!map[r.employeeId]) map[r.employeeId] = {}
      map[r.employeeId][r.date] = r
    }
    return map
  }, [records])

const empStats = useMemo(() => {
  const stats: Record<string, {
    total: number; ot: number; rawOt: number; rawTotal: number
    night: number; holiday: number; anomalies: number
  }> = {}
  for (const emp of employees) {
    const recs = records.filter(r => r.employeeId === emp.id)
    const ot      = recs.reduce((s, r) => s + (r.overtimeHours || 0), 0)
    const rawOt   = recs.reduce((s, r) => s + (r.rawOvertimeMinutes ?? 0) / 60, 0)
    const reg     = recs.reduce((s, r) => s + (r.regularHours  || 0), 0)
    const night   = recs.reduce((s, r) => s + (r.nightHours    || 0), 0)
    const holiday = recs.reduce((s, r) => s + (r.holidayHours  || 0), 0)
    stats[emp.id] = {
      total:    reg + ot   + holiday,
      rawTotal: reg + rawOt + holiday,
      ot,
      rawOt,
      night,
      holiday,
      anomalies: recs.filter(
        r => FINAL_STATUS_CATEGORY[r.finalStatus] === 'ANOMALY' &&
             !approvedKeys.has(`${r.employeeId}_${r.date}`),
      ).length,
    }
  }
  return stats
}, [employees, records, approvedKeys])

  // Over-limit filter: only employees whose range total exceeds the statutory max
  const filteredEmployees = useMemo(() => {
    if (!showOnlyOverLimit) return displayEmployees
    return displayEmployees.filter(e => {
      const s = empStats[e.id]
      return (showExactTime ? (s?.rawTotal ?? 0) : (s?.total ?? 0)) > maxLimit
    })
  }, [displayEmployees, showOnlyOverLimit, empStats, maxLimit, showExactTime])

  // Slice to 10 when risk mode is active and the user hasn't expanded yet
  const visibleEmployees = riskMode && !showAll
    ? filteredEmployees.slice(0, 10)
    : filteredEmployees

  const isMultiMonth =
    dates.length > 1 &&
    dates[0].slice(0, 7) !== dates[dates.length - 1].slice(0, 7)

  const orgFilterActive = filterDiv !== null || filterTeam !== null

  // ── Dropdown handler ───────────────────────────────────────────────────
  function handleOrgBtnClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setDropdownRect(rect)
    setOpenDropdown(prev => prev === 'org' ? null : 'org')
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
              onClick={() => { setFilterDiv(null); setFilterTeam(null); setOpenDropdown(null) }}
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
                onClick={() => { setFilterDiv(div); setFilterTeam(null) }}
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
                    onClick={() => { setFilterTeam(team); setOpenDropdown(null) }}
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

        {/* ── Over-limit active filter banner ─────────────────────────────── */}
        {showOnlyOverLimit && (
          <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border-b border-red-100 shrink-0">
            <span className="text-[11px] font-semibold text-red-700">🚨 법정 한도 초과자만 표시 중</span>
            <span className="text-[11px] text-red-400 tabular-nums">
              ({filteredEmployees.length}명 / {maxLimit}h 초과)
            </span>
            <button
              onClick={() => setShowOnlyOverLimit(false)}
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
                    onClick={() => setSortDir(d => d === 'none' ? 'asc' : d === 'asc' ? 'desc' : 'none')}
                    className="flex items-center justify-between gap-1 w-full hover:text-gray-700 transition-colors"
                  >
                    <span className={sortDir !== 'none' ? 'text-blue-600' : ''}>이름</span>
                    <SortIcon dir={sortDir} />
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
                    onClick={() => setShowOnlyOverLimit(v => !v)}
                    className="flex items-center justify-center gap-1 w-full hover:text-gray-700 transition-colors"
                    title={showOnlyOverLimit ? '법정 한도 초과자 필터 해제' : `법정 한도(${maxLimit}h) 초과자만 보기`}
                  >
                    <span className={showOnlyOverLimit ? 'text-red-600' : ''}>총 근로</span>
                    <FilterIcon active={showOnlyOverLimit} danger />
                  </button>
                </th>

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-center text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L_OT, width: W_OT, minWidth: W_OT }}>
                  연장
                </th>

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-center text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L_NIGHT, width: W_NIGHT, minWidth: W_NIGHT }}>
                  야간
                </th>

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-center text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L_HOLIDAY, width: W_HOLIDAY, minWidth: W_HOLIDAY }}>
                  휴일
                </th>

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-center text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L_ANOMALY, width: W_ANOMALY, minWidth: W_ANOMALY }}>
                  이상
                </th>

                <th className="sticky z-50 bg-gray-50 px-2 py-3 text-left text-[11px] font-semibold text-gray-500 border-l border-gray-200"
                  style={{ top: 0, left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                  구분
                </th>

                {dates.map(date => {
                  const d = new Date(date + 'T12:00')
                  const dow = d.getDay()
                  const isWknd = dow === 0 || dow === 6
                  return (
                    <th key={date}
                      className={`sticky z-40 pt-2 pb-1.5 text-center border-l border-gray-100 whitespace-nowrap ${
                        isWknd ? 'bg-slate-50' : 'bg-gray-50'
                      }`}
                      style={{ top: 0, width: W_DATE, minWidth: W_DATE }}>
                      <div className={`text-[11px] font-bold leading-none ${isWknd ? 'text-slate-400' : 'text-gray-600'}`}>
                        {isMultiMonth ? `${d.getMonth() + 1}/${d.getDate()}` : d.getDate()}
                      </div>
                      <div className={`text-[9px] mt-0.5 leading-none font-medium ${isWknd ? 'text-slate-300' : 'text-gray-300'}`}>
                        {DOW_KR[dow]}
                      </div>
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
              const isEven    = rowIdx % 2 === 0
              const baseBg    = isEven ? 'bg-white' : 'bg-gray-50'

              const spanTd = `sticky z-30 border-b-2 border-gray-200 ${baseBg}`
              const catTd  = `sticky z-30 px-2 py-1.5 border-l border-gray-200 text-[9px] font-semibold text-gray-400 uppercase tracking-wide ${baseBg}`

              return (
                <tbody key={emp.id}>

                  {/* ── Row 1: 출근 ──────────────────────────────────────── */}
                  <tr>
                    {/* 이름 — rowSpan 3 */}
                    <td className={`${spanTd} pl-2 pr-2 py-3 ${isTopRisk ? 'border-l-4 border-l-red-400' : ''}`}
                      style={{ left: L1, width: W_NAME, minWidth: W_NAME }}
                      rowSpan={3}>
                      <button onClick={() => onNameClick(emp.id)} className="text-left block w-full">
                        <p className="text-[11px] font-semibold text-gray-800 hover:text-blue-600 transition-colors leading-tight truncate"
                          style={{ maxWidth: W_NAME - 20 }}>
                          {emp.name}
                        </p>
                        {emp.jobTitle && (
                          <p className="text-[9px] text-gray-400 mt-0.5 leading-tight truncate"
                            style={{ maxWidth: W_NAME - 20 }}>
                            {emp.jobTitle}
                          </p>
                        )}
                        {isTopRisk && (
                          <span className="inline-flex items-center gap-px text-[8px] font-bold text-red-500 mt-1 leading-none">
                            🚨 집중 관리
                          </span>
                        )}
                      </button>
                    </td>

                    {/* 소속 (본부 + 팀/부서 stacked) — rowSpan 3 */}
                    <td className={`${spanTd} border-l pl-3 pr-2 py-3`}
                      style={{ left: L2, width: W_ORG, minWidth: W_ORG }}
                      rowSpan={3}>
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

                    {/* 총 근로 — rowSpan 3 */}
                    <td className={`${spanTd} border-l px-1.5 py-2 text-center`}
                      style={{ left: L3, width: W_TOTAL, minWidth: W_TOTAL }}
                      rowSpan={3}>
                      {(() => {
                        const display = showExactTime ? s.rawTotal : s.total
                        return (
                          <>
                            <span className="text-[12px] font-bold text-gray-800 tabular-nums block leading-tight">
                              {fmtH(display)}
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
                              {display.toFixed(0)}h / {maxLimit}h{
                                display > maxLimit              ? ' 🚨'
                                : display > riskThresholds.totalAmberH ? ' ⚠️'
                                : ''
                              }
                            </span>
                          </>
                        )
                      })()}
                    </td>

                    {/* 연장 — rowSpan 3 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_OT, width: W_OT, minWidth: W_OT }}
                      rowSpan={3}>
                      {(() => {
                        const displayOt = showExactTime ? s.rawOt : s.ot
                        return (
                          <span className={`text-[12px] font-bold tabular-nums ${
                            displayOt > riskThresholds.otRedH   ? 'text-red-500'
                            : displayOt > riskThresholds.otAmberH ? 'text-amber-500'
                            : displayOt > 0                       ? 'text-amber-300'
                            : 'text-gray-300'
                          }`}>
                            {fmtH(displayOt)}
                          </span>
                        )
                      })()}
                    </td>

                    {/* 야간 — rowSpan 3 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_NIGHT, width: W_NIGHT, minWidth: W_NIGHT }}
                      rowSpan={3}>
                      <span className={`text-[12px] font-bold tabular-nums ${s.night > 0 ? 'text-blue-500' : 'text-gray-300'}`}>
                        {fmtH(s.night)}
                      </span>
                    </td>

                    {/* 휴일 — rowSpan 3 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_HOLIDAY, width: W_HOLIDAY, minWidth: W_HOLIDAY }}
                      rowSpan={3}>
                      <span className={`text-[12px] font-bold tabular-nums ${s.holiday > 0 ? 'text-violet-500' : 'text-gray-300'}`}>
                        {fmtH(s.holiday)}
                      </span>
                    </td>

                    {/* 이상 — rowSpan 3 */}
                    <td className={`${spanTd} border-l px-1 py-3 text-center`}
                      style={{ left: L_ANOMALY, width: W_ANOMALY, minWidth: W_ANOMALY }}
                      rowSpan={3}>
                      <span className={`text-[12px] font-bold tabular-nums ${s.anomalies > 0 ? 'text-red-500' : 'text-gray-300'}`}>
                        {s.anomalies > 0 ? `${s.anomalies}건` : '0'}
                      </span>
                    </td>

                    {/* 구분: 출근 */}
                    <td className={`${catTd} border-b border-gray-100`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      출근
                    </td>

                    {/* Date: clock-in + 오전반차 tag only */}
                    {dates.map(date => {
                      const rec = empRecs[date]
                      const isApproved = approvedKeys.has(`${emp.id}_${date}`)
                      const status = getStatus(rec, date, isApproved)
                      const isWknd = status === 'WEEKEND'
                      const showContent = !isWknd && status !== 'ABSENT'
                      const isLeaveDay = rec?.finalStatus === '연차'
                      const hasVacWrongDay = rec?.verificationNote?.includes('휴가 중 출근') ?? false

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b border-gray-100 whitespace-nowrap align-middle ${
                            isWknd ? 'bg-slate-50/60' : ''
                          }`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {showContent ? (
                            isLeaveDay && !hasVacWrongDay ? (
                              <span className="text-gray-200 text-[10px] select-none">—</span>
                            ) : (
                              <button
                                onClick={() => onCellClick(emp.id, date)}
                                className="w-full flex flex-col items-center gap-0.5 py-0.5"
                              >
                                <span className={`text-[9px] tabular-nums leading-none ${
                                  rec!.clockIn ? 'text-gray-700' : 'text-red-400'
                                }`}>
                                  {rec!.clockIn ?? '미태깅'}
                                </span>
                                {rec!.finalStatus === '오전반차' && <InfoTag cls={TAG.amLeave} text="오전반차" />}
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

                  {/* ── Row 2: 퇴근 ──────────────────────────────────────── */}
                  <tr>
                    {/* 구분: 퇴근 */}
                    <td className={`${catTd} border-b border-gray-100`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      퇴근
                    </td>

                    {/* Date: clock-out + 오후반차 tag only */}
                    {dates.map(date => {
                      const rec = empRecs[date]
                      const isApproved = approvedKeys.has(`${emp.id}_${date}`)
                      const status = getStatus(rec, date, isApproved)
                      const isWknd = status === 'WEEKEND'
                      const showContent = !isWknd && status !== 'ABSENT'
                      const isLeaveDay = rec?.finalStatus === '연차'

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b border-gray-100 whitespace-nowrap align-middle ${
                            isWknd ? 'bg-slate-50/60' : ''
                          }`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {showContent ? (
                            isLeaveDay ? (
                              <span className="text-gray-200 text-[10px] select-none">—</span>
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
                                {rec!.finalStatus === '오후반차' && <InfoTag cls={TAG.pmLeave} text="오후반차" />}
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

                  {/* ── Row 3: 초과근로 (last row — thick bottom border) ─── */}
                  <tr>
                    {/* 구분: 초과근로 */}
                    <td className={`${catTd} border-b-2 border-gray-200`}
                      style={{ left: L4, width: W_CAT, minWidth: W_CAT, boxShadow: STICKY_SEP }}>
                      초과근로
                    </td>

                    {/* Date: OT hours + single status badge (연차 / 휴일근무 / 근태이상) */}
                    {dates.map(date => {
                      const rec = empRecs[date]
                      const isApproved = approvedKeys.has(`${emp.id}_${date}`)
                      const status = getStatus(rec, date, isApproved)
                      const isWknd = status === 'WEEKEND'
                      const showContent = !isWknd && status !== 'ABSENT'

                      const fs            = rec?.finalStatus
                      const isLeaveDay    = fs === '연차'
                      const isHolidayWork = fs === '휴일근무'
                      const hasAnomaly    = !isApproved && !!fs && FINAL_STATUS_CATEGORY[fs] === 'ANOMALY'
                      const recOtH        = rec?.overtimeHours ?? 0
                      const rawOtH        = (rec?.rawOvertimeMinutes ?? 0) / 60
                      const overTimeHours = showExactTime ? rawOtH : recOtH
                      const totalHours    = (rec?.regularHours ?? 0) + (showExactTime ? rawOtH : recOtH) + (rec?.holidayHours ?? 0)
                      const hasHours      = totalHours > 0

                      return (
                        <td key={date}
                          className={`py-1 px-1 text-center border-l border-b-2 border-gray-200 whitespace-nowrap align-middle ${
                            isWknd ? 'bg-slate-50/60' : ''
                          }`}
                          style={{ width: W_DATE, minWidth: W_DATE }}>
                          {showContent || hasHours ? (
                            <button
                              onClick={() => onCellClick(emp.id, date)}
                              className="w-full flex flex-row items-center justify-center gap-0.5 py-0.5 flex-wrap"
                            >
                              {isLeaveDay ? (
                                <InfoTag cls={TAG.dayLeave} text="연차" />
                              ) : hasHours ? (
                                <>
                                  {fs === '출장'     && <InfoTag cls={TAG.bizTrip} text="출장" />}
                                  {fs === '재택근무' && <InfoTag cls={TAG.remote}  text="재택" />}
                                  {overTimeHours > 0 ? (
                                    <span className="text-[9px] tabular-nums text-amber-500 font-bold leading-none">
                                      {fmt(overTimeHours)}
                                    </span>
                                  ) : (
                                    <span className="text-[9px] tabular-nums text-gray-300 font-medium leading-none">
                                      —
                                    </span>
                                  )}
                                  {isHolidayWork && <InfoTag cls={TAG.holiday} text="휴일근무" />}
                                  {hasAnomaly    && <InfoTag cls={TAG.anomaly} text="근태이상" />}
                                </>
                              ) : (
                                <span className="text-gray-200 text-[10px] select-none">—</span>
                              )}
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
