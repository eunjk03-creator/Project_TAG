'use client'
import { useState, useMemo, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { usePolicy } from '@/context/PolicyContext'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange } from '@/context/DateRangeContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import { DailyDetailModal } from '@/components/admin/DailyDetailModal'
import type { SavePayload } from '@/components/admin/DailyDetailModal'
import { AnomalyResolutionModal } from '@/components/admin/AnomalyResolutionModal'
import type { ResolutionTarget, TimeOverride } from '@/components/admin/AnomalyResolutionModal'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import type { ProcessedRecord, SieveFlag, EditHistoryEntry, Employee, ResolutionData } from '@/types/tag'

// ── Badge taxonomy — synced with dashboard design system ──────────────────
const FLAG_LABEL: Record<string, string> = {
  LATE:            '지각',
  NO_CLOCK_IN:     '출근 미태깅',
  NO_CLOCK_OUT:    '퇴근 미태깅',
  EARLY_DEPARTURE: '조기퇴근',
}

const FLAG_BADGE: Record<string, string> = {
  LATE:            'text-amber-700 bg-amber-50 border-amber-300',
  NO_CLOCK_IN:     'text-red-700 bg-red-50 border-red-300',
  NO_CLOCK_OUT:    'text-red-700 bg-red-50 border-red-300',
  EARLY_DEPARTURE: 'text-sky-700 bg-sky-50 border-sky-300',
}


const ALL_FLAGS: SieveFlag[] = ['LATE', 'NO_CLOCK_IN', 'NO_CLOCK_OUT', 'EARLY_DEPARTURE']

type SortField = 'date' | 'name'
type SortDir   = 'none' | 'asc' | 'desc'

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`
}

function recKey(employeeId: string, date: string) {
  return `${employeeId}_${date}`
}

// ── Sort / Filter icon sub-components ─────────────────────────────────────
function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  const upCls   = active && dir === 'asc'  ? 'text-blue-500' : 'text-gray-300 group-hover:text-gray-400'
  const downCls = active && dir === 'desc' ? 'text-blue-500' : 'text-gray-300 group-hover:text-gray-400'
  return (
    <span className="inline-flex flex-col items-center ml-1 translate-y-px gap-px">
      <svg className={`w-2 h-2 ${upCls}`}   viewBox="0 0 6 4" fill="currentColor"><path d="M3 0L6 4H0L3 0z"/></svg>
      <svg className={`w-2 h-2 ${downCls}`} viewBox="0 0 6 4" fill="currentColor"><path d="M3 4L0 0H6L3 4z"/></svg>
    </span>
  )
}

function FilterIcon({ active }: { active: boolean }) {
  return (
    <svg
      className={`inline w-3 h-3 ml-1 translate-y-px ${active ? 'text-blue-500' : 'text-gray-300 group-hover:text-gray-400'}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
    </svg>
  )
}

// ── "기록 시간" column ─────────────────────────────────────────────────────
function RecordedTime({ r }: { r: ProcessedRecord }): ReactNode {
  switch (r.flag) {
    case 'LATE':
      return (
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-mono font-semibold text-amber-600">{r.clockIn}</span>
          <span className="text-[10px] text-gray-400">출근</span>
        </div>
      )
    case 'NO_CLOCK_IN':
      return <span className="text-xs font-semibold text-red-500">출근 미기록</span>
    case 'NO_CLOCK_OUT':
      return (
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-mono text-gray-600">{r.clockIn}</span>
            <span className="text-[10px] text-gray-400">출근</span>
          </div>
          <p className="text-[10px] font-semibold text-red-500 mt-0.5">퇴근 미기록</p>
        </div>
      )
    case 'EARLY_DEPARTURE':
      return (
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-mono font-semibold text-sky-600">{r.clockOut}</span>
          <span className="text-[10px] text-gray-400">퇴근</span>
        </div>
      )
    default:
      return <span className="text-gray-300 text-xs">—</span>
  }
}

export default function AnomaliesPage() {
  const { policy }                  = usePolicy()
  const { openDrawer, excludeFromOtIds, employeeAttrMap } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const { recordOverrides, setRecordOverrides, resolutions, setResolutions } = useAttendanceData()
  const { employees: liveEmployees, rawRecords: liveRecords } = useAttendanceSource()
  const { slackNoteMap } = useSlack()
  const EMPLOYEES = liveEmployees  // used by sort/lookup helpers below

  // ── Top toggle ────────────────────────────────────────────────────────────
  const [showResolved, setShowResolved] = useState(false)

  // ── Track 1: individual DailyDetailModal ─────────────────────────────────
  const [detailCell, setDetailCell] = useState<{ employeeId: string; date: string } | null>(null)

  // ── Track 2: bulk AnomalyResolutionModal (2+ items only) ─────────────────
  const [modalTargets, setModalTargets] = useState<ResolutionTarget[] | null>(null)

  // ── Selection & toast ─────────────────────────────────────────────────────
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [toast, setToast]               = useState<string | null>(null)

  // ── Inline sort ───────────────────────────────────────────────────────────
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDir, setSortDir]     = useState<SortDir>('none')

  // ── Inline filters ────────────────────────────────────────────────────────
  const [filterDiv, setFilterDiv]   = useState<string | null>(null)
  const [filterTeam, setFilterTeam] = useState<string | null>(null)
  const [filterFlag, setFilterFlag] = useState<SieveFlag | null>(null)

  // ── Dropdown overlay ──────────────────────────────────────────────────────
  const [openDropdown, setOpenDropdown] = useState<'org' | 'flag' | null>(null)
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null)

  const selectAllRef = useRef<HTMLInputElement>(null)

  // ── Auto-dismiss toast ────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(id)
  }, [toast])

  // ── Override-aware data pipeline ──────────────────────────────────────────
  const overriddenRawRecords = useMemo(() => {
    if (Object.keys(recordOverrides).length === 0) return liveRecords
    return liveRecords.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn,
        clockOut:     ov.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      }
    })
  }, [recordOverrides, liveRecords])

  const otExemptIds = useMemo(() => new Set([
    ...excludeFromOtIds,
    ...liveEmployees.filter(e => e.isLeader).map(e => e.id),
  ]), [excludeFromOtIds, liveEmployees])

  const ALL_DIVISIONS = useMemo(
    () => [...new Set(liveEmployees.map(e => e.division))],
    [liveEmployees],
  )

  const DIVISION_TEAMS = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const emp of liveEmployees) {
      if (!map[emp.division]) map[emp.division] = []
      if (!map[emp.division].includes(emp.team)) map[emp.division].push(emp.team)
    }
    return map
  }, [liveEmployees])

  const { processed } = useAttendanceLogic(
    overriddenRawRecords, policy, dateRange.from, dateRange.to, otExemptIds, slackNoteMap, employeeAttrMap,
  )

  const scopedEmployeeIds = useMemo(() => {
    let emps = liveEmployees
    if (filterDiv)  emps = emps.filter(e => e.division === filterDiv)
    if (filterTeam) emps = emps.filter(e => e.team === filterTeam)
    return new Set(emps.map(e => e.id))
  }, [filterDiv, filterTeam, liveEmployees])

  const teamOptions = useMemo(
    () => (filterDiv ? DIVISION_TEAMS[filterDiv] ?? [] : []),
    [filterDiv],
  )

  // Flag counts (unresolved only — for dropdown labels)
  const flagCounts = useMemo(() => {
    const counts: Partial<Record<string, number>> = {}
    for (const r of processed) {
      if (scopedEmployeeIds.has(r.employeeId) && r.flag && !(recKey(r.employeeId, r.date) in resolutions))
        counts[r.flag] = (counts[r.flag] ?? 0) + 1
    }
    return counts
  }, [processed, scopedEmployeeIds, resolutions])

  // All anomaly records — include resolved even if flag became null after a time fix
  const allFilteredRecords = useMemo(
    () =>
      processed.filter(r => {
        if (!scopedEmployeeIds.has(r.employeeId)) return false
        const key        = recKey(r.employeeId, r.date)
        const isAnomaly  = r.flag !== null
        const isResolved = key in resolutions
        if (!isAnomaly && !isResolved) return false
        if (filterFlag !== null && !isResolved && r.flag !== filterFlag) return false
        return true
      }),
    [processed, scopedEmployeeIds, filterFlag, resolutions],
  )

  const totalCount      = allFilteredRecords.length
  const resolvedCount   = useMemo(
    () => allFilteredRecords.filter(r => recKey(r.employeeId, r.date) in resolutions).length,
    [allFilteredRecords, resolutions],
  )
  const unresolvedCount = totalCount - resolvedCount

  const baseRecords = useMemo(
    () =>
      showResolved
        ? allFilteredRecords.filter(r =>  recKey(r.employeeId, r.date) in resolutions)
        : allFilteredRecords.filter(r => !(recKey(r.employeeId, r.date) in resolutions)),
    [allFilteredRecords, showResolved, resolutions],
  )

  const anomalyRecords = useMemo(() => {
    const rows = [...baseRecords]
    if (sortField === 'date' && sortDir !== 'none') {
      rows.sort((a, b) =>
        sortDir === 'asc'
          ? a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId)
          : b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId),
      )
    } else if (sortField === 'name' && sortDir !== 'none') {
      rows.sort((a, b) => {
        const na = EMPLOYEES.find(e => e.id === a.employeeId)?.name ?? a.employeeId
        const nb = EMPLOYEES.find(e => e.id === b.employeeId)?.name ?? b.employeeId
        const cmp = na.localeCompare(nb, 'ko')
        return sortDir === 'asc' ? cmp : -cmp
      })
    } else {
      rows.sort((a, b) => b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId))
    }
    return rows
  }, [baseRecords, sortField, sortDir])

  // ── Checkbox selection ────────────────────────────────────────────────────
  const selectableKeys = useMemo(
    () =>
      new Set(
        anomalyRecords
          .filter(r => !(recKey(r.employeeId, r.date) in resolutions))
          .map(r => recKey(r.employeeId, r.date)),
      ),
    [anomalyRecords, resolutions],
  )

  const activeSelected      = useMemo(
    () => [...selectedKeys].filter(k => selectableKeys.has(k)),
    [selectedKeys, selectableKeys],
  )
  const activeSelectedCount = activeSelected.length
  const allChecked          = selectableKeys.size > 0 && activeSelectedCount === selectableKeys.size
  const someChecked         = activeSelectedCount > 0 && !allChecked

  useEffect(() => {
    setSelectedKeys(prev => {
      const cleaned = new Set([...prev].filter(k => selectableKeys.has(k)))
      return cleaned.size === prev.size ? prev : cleaned
    })
  }, [selectableKeys])

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked
  }, [someChecked])

  // ── Derived state for DailyDetailModal ────────────────────────────────────
  const detailKey = detailCell ? recKey(detailCell.employeeId, detailCell.date) : null

  const detailEmployee = useMemo(
    () => (detailCell ? EMPLOYEES.find(e => e.id === detailCell.employeeId) ?? null : null),
    [detailCell],
  )

  const detailRecord = useMemo(
    () =>
      detailCell
        ? processed.find(r => r.employeeId === detailCell.employeeId && r.date === detailCell.date) ?? null
        : null,
    [detailCell, processed],
  )

  // ── Sort handler ──────────────────────────────────────────────────────────
  function handleSort(field: SortField) {
    if (sortField !== field) { setSortField(field); setSortDir('asc') }
    else if (sortDir === 'asc')  setSortDir('desc')
    else if (sortDir === 'desc') { setSortField(null); setSortDir('none') }
    else setSortDir('asc')
  }

  // ── Dropdown handlers ─────────────────────────────────────────────────────
  function handleOrgBtnClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setDropdownRect(rect); setOpenDropdown(prev => (prev === 'org' ? null : 'org'))
  }
  function handleFlagBtnClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setDropdownRect(rect); setOpenDropdown(prev => (prev === 'flag' ? null : 'flag'))
  }
  function closeDropdown() { setOpenDropdown(null); setDropdownRect(null) }

  // ── Toggle ────────────────────────────────────────────────────────────────
  function handleToggle(value: boolean) { setShowResolved(value); setSelectedKeys(new Set()) }

  // ── Track 1: DailyDetailModal callback ───────────────────────────────────
  function handleDetailSave(payload: SavePayload) {
    if (!detailCell) return
    const key = recKey(detailCell.employeeId, detailCell.date)

    if (payload.finalStatus === '소명완료') {
      setResolutions(prev => ({
        ...prev,
        [key]: { reasonLabel: '소명완료', memo: payload.finalReason },
      }))
    }

    setRecordOverrides(prev => {
      const existing = prev[key]
      return {
        ...prev,
        [key]: {
          clockIn:      payload.newClockIn,
          clockOut:     payload.newClockOut,
          erpOtApplied: payload.newErpOtApplied !== null ? payload.newErpOtApplied : (existing?.erpOtApplied ?? null),
          erpLeaveType: payload.newErpLeaveType !== null ? payload.newErpLeaveType : (existing?.erpLeaveType ?? '없음'),
          editHistory:  existing
            ? [...existing.editHistory, payload.auditEntry]
            : [payload.auditEntry],
        },
      }
    })

    setToast('처리가 완료되었습니다')
    setDetailCell(null)
  }

  // ── Track 2: bulk modal open ──────────────────────────────────────────────
  function openBulkModal() {
    const targets: ResolutionTarget[] = activeSelected.map(key => {
      const sep    = key.indexOf('_')
      const empId  = key.slice(0, sep)
      const date   = key.slice(sep + 1)
      const record = processed.find(r => r.employeeId === empId && r.date === date)!
      return { record, employee: EMPLOYEES.find(e => e.id === empId) }
    })
    setModalTargets(targets)
  }

  // ── Track 2: bulk save ────────────────────────────────────────────────────
  function handleBulkSave(data: ResolutionData, timeOverrides: Record<string, TimeOverride>) {
    if (!modalTargets) return
    const now = new Date().toISOString()

    setResolutions(prev => {
      const next = { ...prev }
      for (const { record } of modalTargets)
        next[recKey(record.employeeId, record.date)] = data
      return next
    })

    setRecordOverrides(prev => {
      const next = { ...prev }
      for (const { record } of modalTargets) {
        const key    = recKey(record.employeeId, record.date)
        const timeOv = timeOverrides[key]
        const newIn  = timeOv ? timeOv.clockIn  : record.clockIn
        const newOut = timeOv ? timeOv.clockOut : record.clockOut

        const entry: EditHistoryEntry = {
          timestamp: now,
          adminName: 'HR Admin',
          oldValue:  { clockIn: record.clockIn,  clockOut: record.clockOut },
          newValue:  { clockIn: newIn,            clockOut: newOut },
          reason:    `[일괄처리] ${data.reasonLabel}`,
        }

        const existing = next[key]
        next[key] = {
          clockIn:      newIn,
          clockOut:     newOut,
          erpOtApplied: existing?.erpOtApplied ?? null,
          erpLeaveType: existing?.erpLeaveType ?? '없음',
          editHistory:  existing ? [...existing.editHistory, entry] : [entry],
        }
      }
      return next
    })

    setSelectedKeys(prev => {
      const next = new Set(prev)
      for (const { record } of modalTargets) next.delete(recKey(record.employeeId, record.date))
      return next
    })

    setToast(`${modalTargets.length}건이 성공적으로 처리되었습니다`)
    setModalTargets(null)
  }

  // ── Misc handlers ─────────────────────────────────────────────────────────
  function handleUnresolve(key: string) {
    setResolutions(prev => { const next = { ...prev }; delete next[key]; return next })
  }
  function toggleKey(key: string) {
    setSelectedKeys(prev => {
      const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next
    })
  }
  function toggleAll() { setSelectedKeys(allChecked ? new Set() : new Set(selectableKeys)) }

  const orgFilterActive  = filterDiv !== null || filterTeam !== null
  const flagFilterActive = filterFlag !== null

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Dropdown backdrop */}
      {openDropdown && <div className="fixed inset-0 z-[45]" onClick={closeDropdown} />}

      {/* Org filter dropdown */}
      {openDropdown === 'org' && dropdownRect && (
        <div
          className="fixed z-[50] bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 w-52 text-xs"
          style={{ top: dropdownRect.bottom + 4, left: dropdownRect.left }}
        >
          <button
            onClick={() => { setFilterDiv(null); setFilterTeam(null); closeDropdown() }}
            className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center justify-between ${!filterDiv ? 'text-blue-600 font-semibold' : 'text-gray-700'}`}
          >
            전체 소속 {!filterDiv && <span className="text-blue-400 text-[10px]">✓</span>}
          </button>
          <div className="h-px bg-gray-100 my-1" />
          <p className="px-3 pt-0.5 pb-1 text-[10px] text-gray-400 font-semibold tracking-wide uppercase">본부</p>
          {ALL_DIVISIONS.map(d => (
            <button key={d}
              onClick={() => { setFilterDiv(d); setFilterTeam(null) }}
              className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center justify-between ${filterDiv === d && !filterTeam ? 'text-blue-600 font-semibold' : 'text-gray-700'}`}
            >
              {d} {filterDiv === d && !filterTeam && <span className="text-blue-400 text-[10px]">✓</span>}
            </button>
          ))}
          {filterDiv && teamOptions.length > 0 && (
            <>
              <div className="h-px bg-gray-100 my-1" />
              <p className="px-3 pt-0.5 pb-1 text-[10px] text-gray-400 font-semibold tracking-wide uppercase">팀/부서</p>
              {teamOptions.map(t => (
                <button key={t}
                  onClick={() => { setFilterTeam(t); closeDropdown() }}
                  className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center justify-between ${filterTeam === t ? 'text-blue-600 font-semibold' : 'text-gray-700'}`}
                >
                  {t} {filterTeam === t && <span className="text-blue-400 text-[10px]">✓</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* Flag filter dropdown */}
      {openDropdown === 'flag' && dropdownRect && (
        <div
          className="fixed z-[50] bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 w-44 text-xs"
          style={{ top: dropdownRect.bottom + 4, left: dropdownRect.left }}
        >
          <button
            onClick={() => { setFilterFlag(null); closeDropdown() }}
            className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center justify-between ${filterFlag === null ? 'text-blue-600 font-semibold' : 'text-gray-700'}`}
          >
            전체 유형 {filterFlag === null && <span className="text-blue-400 text-[10px]">✓</span>}
          </button>
          <div className="h-px bg-gray-100 my-1" />
          {ALL_FLAGS.map(flag => (
            <button key={flag}
              onClick={() => { setFilterFlag(flag); closeDropdown() }}
              className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center justify-between ${filterFlag === flag ? 'text-blue-600 font-semibold' : 'text-gray-700'}`}
            >
              <span>{FLAG_LABEL[flag!]}</span>
              <span className={`text-[10px] font-medium ${filterFlag === flag ? 'text-blue-400' : 'text-gray-400'}`}>
                {flagCounts[flag!] ?? 0}건
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 min-w-0 flex flex-col">

        {/* ── Title bar ── */}
        <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 shrink-0">
          <div className="shrink-0">
            <h1 className="text-base font-bold text-gray-900">이상치 관리</h1>
            <p className="text-xs text-gray-400">
              미처리 {unresolvedCount}건 · 소명완료 {resolvedCount}건
            </p>
          </div>
        </div>

        {/* ── Filter bar ── */}
        <div className="flex items-center gap-3 px-6 py-2.5 bg-white border-b border-gray-100 shrink-0 flex-wrap">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <div className="w-px h-4 bg-gray-200 shrink-0" />

          {/* 미처리 / 완료 toggle */}
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-xs font-medium shrink-0">
            <button
              onClick={() => handleToggle(false)}
              className={`px-3 py-1.5 rounded-md transition-colors ${!showResolved ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              미처리
            </button>
            <button
              onClick={() => handleToggle(true)}
              className={`px-3 py-1.5 rounded-md transition-colors ${showResolved ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              완료
            </button>
          </div>

          {/* Active filter chips */}
          {(orgFilterActive || flagFilterActive) && (
            <>
              <div className="w-px h-4 bg-gray-200 shrink-0" />
              <div className="flex items-center gap-1.5 flex-wrap">
                {(filterTeam ?? filterDiv) && (
                  <span className="flex items-center gap-1 text-[11px] text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
                    {filterTeam ?? filterDiv}
                    <button onClick={() => { setFilterDiv(null); setFilterTeam(null) }} className="text-blue-400 hover:text-blue-600 ml-0.5 leading-none">✕</button>
                  </span>
                )}
                {filterFlag && (
                  <span className="flex items-center gap-1 text-[11px] text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
                    {FLAG_LABEL[filterFlag]}
                    <button onClick={() => setFilterFlag(null)} className="text-blue-400 hover:text-blue-600 ml-0.5 leading-none">✕</button>
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Table ── */}
        <div className="flex-1 overflow-auto p-6 pb-24">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">

            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">
                이상치 목록
                <span className="ml-2 text-xs font-normal text-gray-400">
                  {showResolved ? `소명완료 ${anomalyRecords.length}건` : `미처리 ${anomalyRecords.length}건`}
                </span>
              </h2>
              {!showResolved && resolvedCount > 0 && (
                <span className="text-[11px] text-teal-600 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-full font-medium">
                  소명완료 {resolvedCount}건 숨김
                </span>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 border-b border-gray-200">
                    <th className="px-4 py-3 w-10 shrink-0">
                      {!showResolved && (
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          checked={allChecked}
                          onChange={toggleAll}
                          disabled={selectableKeys.size === 0}
                          className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        />
                      )}
                    </th>
                    <th className="px-4 py-3 text-left font-semibold whitespace-nowrap">
                      <button onClick={() => handleSort('date')} className="group flex items-center hover:text-gray-700 transition-colors">
                        일자<SortIcon active={sortField === 'date'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold whitespace-nowrap">
                      <button onClick={() => handleSort('name')} className="group flex items-center hover:text-gray-700 transition-colors">
                        이름<SortIcon active={sortField === 'name'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold whitespace-nowrap">
                      <button onClick={handleOrgBtnClick} className="group flex items-center hover:text-gray-700 transition-colors">
                        소속<FilterIcon active={orgFilterActive} />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold whitespace-nowrap">
                      <button onClick={handleFlagBtnClick} className="group flex items-center hover:text-gray-700 transition-colors">
                        이상 유형<FilterIcon active={flagFilterActive} />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold whitespace-nowrap">기록 시간</th>
                    <th className="px-4 py-3 text-left font-semibold whitespace-nowrap min-w-[220px]">처리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {anomalyRecords.map((r, i) => {
                    const emp        = EMPLOYEES.find(e => e.id === r.employeeId)
                    const key        = recKey(r.employeeId, r.date)
                    const resolution = resolutions[key]
                    const isResolved = resolution !== undefined
                    const isSelected = selectedKeys.has(key)

                    const rowBg = isSelected ? 'bg-blue-50' : isResolved ? 'bg-teal-50/30' : 'bg-white'

                    return (
                      <tr key={i} className={`${rowBg} hover:bg-gray-50/60 transition-colors`}>

                        <td className="px-4 py-3 w-10">
                          {!isResolved && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleKey(key)}
                              className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            />
                          )}
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap">
                          <p className="font-semibold text-gray-800">{r.date}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{r.dayLabel ?? '—'}</p>
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap">
                          <button onClick={() => openDrawer(r.employeeId)} className="text-left">
                            <p className="font-semibold text-gray-800 hover:text-blue-600 transition-colors">
                              {emp?.name ?? r.employeeId}
                            </p>
                            {emp?.jobTitle && <p className="text-[10px] text-gray-400 mt-0.5">{emp.jobTitle}</p>}
                          </button>
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap">
                          <p className="text-gray-700">{emp?.division ?? '—'}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{emp?.team ?? ''}</p>
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap">
                          {isResolved ? (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-semibold text-teal-700 bg-teal-50 border-teal-200">
                              ✓ 소명완료
                            </span>
                          ) : r.flag ? (
                            <span className={`inline-block text-xs px-2 py-0.5 rounded-full border font-semibold ${FLAG_BADGE[r.flag]}`}>
                              {FLAG_LABEL[r.flag]}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap">
                          <RecordedTime r={r} />
                        </td>

                        {/* ── 처리 column — two-track routing ── */}
                        <td className="px-4 py-3 min-w-[220px]">
                          {isResolved ? (
                            <div className="flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] text-teal-700 font-semibold leading-tight truncate">{resolution.reasonLabel}</p>
                                {resolution.memo && (
                                  <p className="text-[10px] text-gray-400 mt-0.5 leading-tight truncate">{resolution.memo}</p>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {/* "수정" opens DailyDetailModal (Track 1) */}
                                <button
                                  onClick={() => setDetailCell({ employeeId: r.employeeId, date: r.date })}
                                  className="text-[10px] text-gray-400 hover:text-blue-600 transition-colors hover:underline underline-offset-2"
                                >
                                  상세
                                </button>
                                <span className="text-gray-200">·</span>
                                <button
                                  onClick={() => handleUnresolve(key)}
                                  className="text-[10px] text-gray-400 hover:text-red-500 transition-colors hover:underline underline-offset-2"
                                >
                                  취소
                                </button>
                              </div>
                            </div>
                          ) : (
                            /* "처리" always opens DailyDetailModal (Track 1) */
                            <button
                              onClick={() => setDetailCell({ employeeId: r.employeeId, date: r.date })}
                              className="text-xs px-3 py-1.5 rounded-lg border bg-white text-gray-600 border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-colors font-medium whitespace-nowrap"
                            >
                              처리
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}

                  {anomalyRecords.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-14 text-center text-gray-400">
                        {showResolved
                          ? resolvedCount > 0
                            ? '선택된 필터 조건에 소명완료 기록이 없습니다'
                            : '아직 소명완료 처리된 기록이 없습니다'
                          : resolvedCount > 0
                          ? `미처리 이상치가 없습니다 — ${resolvedCount}건이 소명완료 상태입니다`
                          : '선택된 기간 · 범위에 이상치가 없습니다'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Floating bulk action bar — Track 2, shown only for 2+ selections ── */}
        {activeSelectedCount >= 2 && !showResolved && (
          <div className="fixed bottom-6 left-52 right-0 flex justify-center pointer-events-none z-30">
            <div className="pointer-events-auto flex items-center gap-4 bg-gray-900 text-white rounded-2xl px-6 py-3.5 shadow-2xl shadow-black/25">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-500 text-[11px] font-bold shrink-0">
                  {activeSelectedCount}
                </span>
                <span className="text-sm font-medium">{activeSelectedCount}건 선택됨</span>
              </div>
              <div className="w-px h-4 bg-white/20 shrink-0" />
              <button
                onClick={openBulkModal}
                className="flex items-center gap-1.5 text-sm font-semibold text-blue-300 hover:text-blue-200 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                선택 항목 일괄 처리
              </button>
              <button
                onClick={() => setSelectedKeys(new Set())}
                className="text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                선택 해제
              </button>
            </div>
          </div>
        )}

        {/* ── Toast notification ── */}
        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
            <div className="flex items-center gap-2.5 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-2xl shadow-2xl shadow-black/30">
              <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              {toast}
            </div>
          </div>
        )}

        {/* ── Track 1: DailyDetailModal — individual review & approval ── */}
        {detailCell && detailEmployee && detailRecord && (
          <DailyDetailModal
            employee={detailEmployee}
            record={detailRecord}
            policy={policy}
            initialEditHistory={recordOverrides[detailKey!]?.editHistory}
            initialApproved={detailKey! in resolutions}
            initialErpLeaveType={recordOverrides[detailKey!]?.erpLeaveType}
            onClose={() => setDetailCell(null)}
            onSave={handleDetailSave}
          />
        )}

        {/* ── Track 2: AnomalyResolutionModal — bulk common-reason resolve ── */}
        {modalTargets && (
          <AnomalyResolutionModal
            targets={modalTargets}
            onClose={() => setModalTargets(null)}
            onSave={handleBulkSave}
          />
        )}
      </div>
    </>
  )
}
