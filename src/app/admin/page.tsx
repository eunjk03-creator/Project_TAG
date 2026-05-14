'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { usePolicy } from '@/context/PolicyContext'
import { EmployeeCalendarGrid } from '@/components/admin/EmployeeCalendarGrid'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange, DEFAULT_RANGE } from '@/context/DateRangeContext'
import { exportCsv, exportGridCsv } from '@/utils/exportCsv'
import { DailyDetailModal } from '@/components/admin/DailyDetailModal'
import type { SavePayload } from '@/components/admin/DailyDetailModal'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import { MetricDeepDive } from '@/components/admin/MetricDeepDive'
import type { Section } from '@/components/admin/MetricDeepDive'
import { CsvUploader } from '@/components/admin/CsvUploader'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import type { Employee, ProcessedRecord } from '@/types/tag'
import { HR_THRESHOLDS, EXEC_THRESHOLDS } from '@/types/tag'
import type { RiskView } from '@/types/tag'

const FLAG_LABEL: Record<string, string> = {
  LATE: '지각',
  NO_CLOCK_OUT: '퇴근 미태깅',
  UNAPPROVED_OT: 'OT 미신청',
  EARLY_DEPARTURE: '조기퇴근',
}

const FLAG_COLOR: Record<string, string> = {
  LATE: 'text-amber-600 bg-amber-50 border-amber-200',
  NO_CLOCK_OUT: 'text-red-600 bg-red-50 border-red-200',
  UNAPPROVED_OT: 'text-orange-600 bg-orange-50 border-orange-200',
  EARLY_DEPARTURE: 'text-blue-600 bg-blue-50 border-blue-200',
}

const DAY_ALIASES: Record<string, string> = {
  '월요일': '월', '화요일': '화', '수요일': '수', '목요일': '목',
  '금요일': '금', '토요일': '토', '일요일': '일',
}

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function getOrgPath(emp: Employee): string {
  const parts = [emp.division, emp.team]
  if (emp.part) parts.push(emp.part)
  return parts.join(' / ')
}

/** Returns the full-month DateRange for the month that has the most records. */
function detectMonthRange(records: { date: string }[]): { from: string; to: string } | null {
  if (records.length === 0) return null
  const counts: Record<string, number> = {}
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue
    const ym = r.date.slice(0, 7)
    counts[ym] = (counts[ym] ?? 0) + 1
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (!top) return null
  const [y, m] = top[0].split('-').map(Number)
  const last   = new Date(y, m, 0).getDate()
  return { from: `${top[0]}-01`, to: `${top[0]}-${String(last).padStart(2, '0')}` }
}

type View = 'grid' | 'table'

export default function AdminDashboard() {
  const { policy } = usePolicy()
  const { openDrawer, exceptions, excludeFromOtIds, employeeAttrMap } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const { recordOverrides, setRecordOverrides, resolutions, setResolutions } = useAttendanceData()
  const { employees: baseEmployees, rawRecords: baseRecords, isLiveData } = useAttendanceSource()
  const { slackNoteMap } = useSlack()

  const [view,                setView]                = useState<View>('grid')
  const [search,              setSearch]              = useState('')
  const [modalCell,           setModalCell]           = useState<{ employeeId: string; date: string } | null>(null)
  const [openSections,        setOpenSections]        = useState<Set<Section>>(new Set())
  const [selectedBUs,         setSelectedBUs]         = useState<string[]>([])
  const [selectedRank,        setSelectedRank]        = useState<string | null>(null)
  const [gridFading,  setGridFading]  = useState(false)
  const [riskView,    setRiskView]    = useState<RiskView>('hr')
  const [showExactTime, setShowExactTime] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  const riskThresholds = riskView === 'hr' ? HR_THRESHOLDS : EXEC_THRESHOLDS

  // Clear rank when no single BU is selected
  useEffect(() => {
    if (selectedBUs.length !== 1) setSelectedRank(null)
  }, [selectedBUs])

  // Fade animation on filter change
  useEffect(() => {
    setGridFading(true)
    const t = setTimeout(() => setGridFading(false), 60)
    return () => clearTimeout(t)
  }, [selectedBUs, selectedRank])

  // Scroll to grid on single-BU drill-down
  useEffect(() => {
    if (selectedBUs.length === 1 && gridRef.current) {
      gridRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selectedBUs])

  // Auto-sync dateRange to the dominant month in the active data source.
  // Runs when live data is loaded (isLiveData → true) or cleared (→ false).
  useEffect(() => {
    if (!isLiveData) {
      setDateRange(DEFAULT_RANGE)
      return
    }
    const detected = detectMonthRange(baseRecords)
    if (detected) setDateRange(detected)
  }, [isLiveData, baseRecords]) // setDateRange is a stable context setter

  const scopedEmployees = baseEmployees

  const scopedEmployeeIds = useMemo(
    () => new Set(scopedEmployees.map(e => e.id)),
    [scopedEmployees],
  )

  // ── Date range → grid column list ───────────────────────────────────────
  const gridDates = useMemo(() => {
    const dates: string[] = []
    const cur = new Date(dateRange.from + 'T12:00:00')
    const end = new Date(dateRange.to   + 'T12:00:00')
    while (cur <= end) {
      dates.push(
        cur.getFullYear() + '-' +
        String(cur.getMonth() + 1).padStart(2, '0') + '-' +
        String(cur.getDate()).padStart(2, '0'),
      )
      cur.setDate(cur.getDate() + 1)
    }
    return dates
  }, [dateRange.from, dateRange.to])

  // ── Data pipeline ─────────────────────────────────────────────────────────
  const overriddenRawRecords = useMemo(() => {
    if (Object.keys(recordOverrides).length === 0) return baseRecords
    return baseRecords.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn,
        clockOut:     ov.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      }
    })
  }, [recordOverrides, baseRecords])

  // Merge user-defined OT exemptions + auto-detected leaders from CSV
  const otExemptIds = useMemo(() => new Set([
    ...excludeFromOtIds,
    ...baseEmployees.filter(e => e.isLeader).map(e => e.id),
  ]), [excludeFromOtIds, baseEmployees])

  const { processed: allProcessed, flagCounts } = useAttendanceLogic(
    overriddenRawRecords, policy, dateRange.from, dateRange.to, otExemptIds, slackNoteMap, employeeAttrMap,
  )

  const scopedRecords = useMemo(
    () => allProcessed.filter(r => scopedEmployeeIds.has(r.employeeId)),
    [allProcessed, scopedEmployeeIds],
  )

  const approvedKeys = useMemo(
    () => new Set(Object.keys(resolutions)),
    [resolutions],
  )

  // ── Risk-ranked employees (drill-down only when exactly 1 BU selected) ───
  const filteredRankedEmployees = useMemo(() => {
    const activeBU = selectedBUs.length === 1 ? selectedBUs[0] : null
    if (!activeBU) return scopedEmployees

    const recsByEmp = new Map<string, ProcessedRecord[]>()
    for (const r of scopedRecords) {
      const bucket = recsByEmp.get(r.employeeId)
      if (bucket) bucket.push(r)
      else recsByEmp.set(r.employeeId, [r])
    }

    const buKey   = activeBU.trim()
    const rankKey = selectedRank?.trim() ?? null
    let base = scopedEmployees.filter(e => e.division.trim() === buKey)
    if (rankKey) base = base.filter(e => e.jobTitle?.trim() === rankKey)

    return base
      .map(emp => {
        const recs      = recsByEmp.get(emp.id) ?? []
        const ot        = recs.reduce((s, r) => s + r.overtimeHours, 0)
        const night     = recs.reduce((s, r) => s + r.nightHours, 0)
        const anomalies = recs.filter(
          r => r.flag !== null && !approvedKeys.has(`${r.employeeId}_${r.date}`),
        ).length
        return { ...emp, riskScore: ot * 1.5 + night * 2.5 + anomalies * 10 }
      })
      .sort((a, b) => b.riskScore - a.riskScore)
  }, [scopedEmployees, selectedBUs, selectedRank, scopedRecords, approvedKeys])

  const topRiskIds = useMemo(
    () => new Set(selectedBUs.length === 1 ? filteredRankedEmployees.slice(0, 3).map(e => e.id) : []),
    [selectedBUs, filteredRankedEmployees],
  )

  const stats = useMemo(() => {
    const regH   = scopedRecords.reduce((s, r) => s + r.regularHours, 0)
    const otH    = scopedRecords.reduce((s, r) => s + r.overtimeHours, 0)
    const rawOtH = scopedRecords.reduce((s, r) => s + (r.rawOvertimeMinutes ?? 0) / 60, 0)
    const ngH    = scopedRecords.reduce((s, r) => s + r.nightHours, 0)
    return {
      totalHours:       regH + otH,
      rawTotalHours:    regH + rawOtH,
      overtimeHours:    otH,
      rawOvertimeHours: rawOtH,
      nightHours:       ngH,
      anomalies:        scopedRecords.filter(
        r => r.flag !== null && !approvedKeys.has(`${r.employeeId}_${r.date}`)
      ).length,
    }
  }, [scopedRecords, approvedKeys])

  // ── Table search ──────────────────────────────────────────────────────────
  const searchQuery = DAY_ALIASES[search.trim().toLowerCase()] ?? search.trim().toLowerCase()

  const filteredRecords = useMemo(() => {
    if (!searchQuery) return scopedRecords
    return scopedRecords.filter(r => {
      const emp = baseEmployees.find(e => e.id === r.employeeId)
      return (
        emp?.name.toLowerCase().includes(searchQuery) ||
        r.employeeId.toLowerCase().includes(searchQuery) ||
        r.dayLabel?.toLowerCase().includes(searchQuery) ||
        r.date.includes(searchQuery)
      )
    })
  }, [scopedRecords, searchQuery])

  const tableRows = useMemo(
    () =>
      [...filteredRecords]
        .sort((a, b) => b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId))
        .slice(0, 500),
    [filteredRecords],
  )

  // ── Modal helpers ─────────────────────────────────────────────────────────
  const modalEmployee = useMemo(
    () => (modalCell ? baseEmployees.find(e => e.id === modalCell.employeeId) ?? null : null),
    [modalCell, baseEmployees],
  )
  const modalRecord = useMemo(
    () =>
      modalCell
        ? scopedRecords.find(r => r.employeeId === modalCell.employeeId && r.date === modalCell.date) ?? null
        : null,
    [modalCell, scopedRecords],
  )

  function handleCellClick(employeeId: string, date: string) {
    setModalCell({ employeeId, date })
  }

  function handleModalSave(payload: SavePayload) {
    if (!modalCell) return
    const key = `${modalCell.employeeId}_${modalCell.date}`
    setResolutions(prev => ({
      ...prev,
      [key]: { reasonLabel: payload.finalStatus, memo: payload.finalReason },
    }))
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
    setModalCell(null)
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function handleExport() {
    if (view === 'grid') {
      exportGridCsv(scopedEmployees, scopedRecords, gridDates, `근태그리드_${dateRange.from}~${dateRange.to}.csv`)
    } else {
      exportCsv(scopedRecords, baseEmployees, `근태기록_${dateRange.from}~${dateRange.to}.csv`)
    }
  }

  function toggleSection(s: Section) {
    setOpenSections(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  // ── Management metrics ────────────────────────────────────────────────────
  const { metrics: divMetrics, bizDays, total: metricTotal } = useManagementMetrics(
    scopedRecords, scopedEmployees, approvedKeys, dateRange.from, dateRange.to,
  )

  const totalFlags = Object.values(flagCounts).reduce((a, b) => a + b, 0)

  // ── KPI card derived values ───────────────────────────────────────────────
  const deptLabel = selectedBUs.length === 1
    ? selectedBUs[0]
    : selectedBUs.length > 1
      ? `${selectedBUs.length}개 본부`
      : '전체'

  const cardStats = useMemo(() => {
    if (divMetrics.length === 0) return null
    const n      = scopedEmployees.length || 1
    const totalH = showExactTime ? stats.rawTotalHours    : stats.totalHours
    const otH    = showExactTime ? stats.rawOvertimeHours : stats.overtimeHours
    const topTotal     = divMetrics.reduce((a, b) => a.totalHours > b.totalHours ? a : b)
    const topOt        = divMetrics.reduce((a, b) => a.otHours    > b.otHours    ? a : b)
    const topAnomalies = divMetrics.reduce((a, b) => a.anomalies  > b.anomalies  ? a : b)
    return {
      avgTotal: totalH / n,
      avgOt:    otH    / n,
      otRatio:  totalH > 0 ? (otH / totalH) * 100 : 0,
      topTotal, topOt, topAnomalies,
    }
  }, [divMetrics, stats, scopedEmployees.length, showExactTime])

  return (
    <div className="min-w-0 flex flex-col">

      {/* ── Top bar ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3 shrink-0">
        <div className="shrink-0">
          <h1 className="text-base font-bold text-gray-900">근태 현황</h1>
          <p className="text-xs text-gray-400">전체 · {scopedEmployees.length}명</p>
        </div>

        {view === 'table' && (
          <div className="flex-1 relative max-w-xs ml-2">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="이름, 사번, 요일 검색..."
              className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-300"
            />
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 text-xs">
                ✕
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-xs font-medium">
            <button onClick={() => setView('grid')}
              className={`px-3 py-1.5 rounded-md transition-colors ${view === 'grid' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
              그리드
            </button>
            <button onClick={() => setView('table')}
              className={`px-3 py-1.5 rounded-md transition-colors ${view === 'table' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
              테이블
            </button>
          </div>
          <button onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 active:scale-95 transition-all">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            내보내기
          </button>
        </div>
      </div>

      {/* ── Date range filter + risk view toggle ── */}
      <div className="flex items-center gap-3 px-6 py-2.5 bg-white border-b border-gray-100 shrink-0">
        <DateRangePicker value={dateRange} onChange={setDateRange} />

        <div className="ml-auto flex items-center gap-3 shrink-0">

          {/* Time view mode toggle */}
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="text-gray-400 whitespace-nowrap">시간 기준</span>
            <div className="flex items-center bg-gray-100 rounded-lg p-0.5 font-medium">
              <button
                onClick={() => setShowExactTime(false)}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  !showExactTime ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                }`}
                title="급여 계산 기준 시간 (30분 단위 절사)"
              >
                인정 시간
              </button>
              <button
                onClick={() => setShowExactTime(true)}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  showExactTime ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                }`}
                title="태그 기록 기준 실제 근무 시간 (절사 없음)"
              >
                실제 값
              </button>
            </div>
          </div>

          <div className="w-px h-4 bg-gray-200 shrink-0" />

          <span className="text-[11px] text-gray-400 whitespace-nowrap">리스크 기준</span>
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-[11px] font-medium">
            <button
              onClick={() => setRiskView('hr')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                riskView === 'hr'
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              HR
            </button>
            <button
              onClick={() => setRiskView('exec')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                riskView === 'exec'
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              경영진
            </button>
          </div>
          {/* Threshold hint */}
          <span className="text-[10px] text-gray-400 whitespace-nowrap">
            {riskView === 'hr'
              ? `총 >${riskThresholds.totalAmberH}h · OT >${riskThresholds.dailyOtWarnH}h`
              : `총 >${riskThresholds.totalAmberH}h`
            }
          </span>
        </div>
      </div>

      {/* ── CSV / Excel uploader ── */}
      <CsvUploader />

      {/* ── Main content ── */}
      <div className="min-w-0 flex flex-col">

        {/* KPI Cards */}
        <div className="px-6 pt-5 pb-4 shrink-0">
          <div className="grid grid-cols-3 gap-4">

            {/* Card 1 — 총 근로시간 */}
            <div className={`bg-white rounded-xl border p-4 transition-colors ${openSections.has('total') ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'}`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-gray-500">총 근로시간</p>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium truncate max-w-[72px]">{deptLabel}</span>
              </div>
              <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{fmt(showExactTime ? stats.rawTotalHours : stats.totalHours)}</p>
              <div className="mt-2 space-y-0.5">
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  1인 평균
                  <span className={`font-medium tabular-nums ${
                    cardStats && cardStats.avgTotal > riskThresholds.totalAmberH
                      ? 'text-amber-600'
                      : 'text-gray-600'
                  }`}>
                    {cardStats ? fmt(cardStats.avgTotal) : '—'}
                  </span>
                  {cardStats && cardStats.avgTotal > riskThresholds.totalAmberH && (
                    <span className="text-[9px] px-1 py-px rounded bg-amber-100 text-amber-700 font-semibold">
                      {riskView === 'hr' ? 'HR기준 초과' : '주의'}
                    </span>
                  )}
                </p>
                {cardStats && (
                  <p className="text-xs text-gray-400 truncate">
                    최다 <span className="text-blue-600 font-medium">{cardStats.topTotal.division}</span>
                  </p>
                )}
              </div>
              <button onClick={() => toggleSection('total')}
                className="mt-2.5 text-xs text-blue-500 hover:text-blue-700 font-medium transition-colors">
                📊 지표 분석 {openSections.has('total') ? '▴' : '▾'}
              </button>
            </div>

            {/* Card 2 — 연장근로 */}
            <div className={`bg-white rounded-xl border p-4 transition-colors ${openSections.has('overtime') ? 'border-amber-300 ring-1 ring-amber-200' : 'border-gray-200'}`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-gray-500">연장근로</p>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium truncate max-w-[72px]">{deptLabel}</span>
              </div>
              <p className="text-2xl font-bold text-amber-500 mt-1 tabular-nums">{fmt(showExactTime ? stats.rawOvertimeHours : stats.overtimeHours)}</p>
              <div className="mt-2 space-y-0.5">
                <p className="text-xs text-gray-400 flex items-center gap-1 flex-wrap">
                  1인 평균
                  <span className={`font-medium tabular-nums ${
                    cardStats && cardStats.avgOt > riskThresholds.otAmberH
                      ? 'text-amber-600'
                      : 'text-gray-600'
                  }`}>
                    {cardStats ? fmt(cardStats.avgOt) : '—'}
                  </span>
                  <span className="text-gray-300">·</span>
                  <span className="tabular-nums text-gray-400">{cardStats ? cardStats.otRatio.toFixed(1) : 0}%</span>
                  {cardStats && cardStats.avgOt > riskThresholds.otAmberH && (
                    <span className="text-[9px] px-1 py-px rounded bg-amber-100 text-amber-700 font-semibold">
                      {riskView === 'hr' ? 'HR기준 초과' : '주의'}
                    </span>
                  )}
                </p>
                {cardStats && (
                  <p className="text-xs text-gray-400 truncate">
                    최다 <span className="text-amber-600 font-medium">{cardStats.topOt.division}</span>
                  </p>
                )}
              </div>
              <button onClick={() => toggleSection('overtime')}
                className="mt-2.5 text-xs text-amber-500 hover:text-amber-700 font-medium transition-colors">
                📊 지표 분석 {openSections.has('overtime') ? '▴' : '▾'}
              </button>
            </div>

            {/* Card 3 — 이상치 */}
            <div className={`rounded-xl border p-4 transition-colors ${
              stats.anomalies > 0
                ? openSections.has('anomaly') ? 'bg-red-50 border-red-400 ring-1 ring-red-200' : 'bg-red-50 border-red-200'
                : openSections.has('anomaly') ? 'bg-white border-red-300 ring-1 ring-red-200' : 'bg-white border-gray-200'
            }`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-gray-500">이상치</p>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium truncate max-w-[72px]">{deptLabel}</span>
              </div>
              <p className={`text-2xl font-bold mt-1 tabular-nums ${stats.anomalies > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {stats.anomalies}건
              </p>
              <div className="mt-2 space-y-0.5">
                <p className="text-xs text-gray-400">
                  평균 <span className="text-gray-600 font-medium tabular-nums">
                    {scopedEmployees.length > 0 ? (stats.anomalies / scopedEmployees.length).toFixed(1) : 0}건/인
                  </span>
                </p>
                {cardStats && cardStats.topAnomalies.anomalies > 0 ? (
                  <p className="text-xs text-gray-400 truncate">
                    최다 <span className="text-red-600 font-medium">{cardStats.topAnomalies.division}</span>
                  </p>
                ) : (
                  <p className="text-xs text-gray-400">이상치 없음</p>
                )}
              </div>
              <button onClick={() => toggleSection('anomaly')}
                className="mt-2.5 text-xs text-red-500 hover:text-red-700 font-medium transition-colors">
                📊 지표 분석 {openSections.has('anomaly') ? '▴' : '▾'}
              </button>
            </div>

          </div>
        </div>

        {/* ── Section Deep Dives ── */}
        {openSections.size > 0 && (
          <div className="px-6 pb-4 shrink-0">
            {selectedBUs.length >= 1 && (
              <div className="flex items-center gap-2 mb-3">
                {selectedBUs.length === 1 && (
                  <button onClick={() => setSelectedBUs([])}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 transition-colors">
                    필터됨: {selectedBUs[0]}
                    <span className="opacity-60">✕</span>
                  </button>
                )}
                {selectedBUs.length >= 2 && (
                  <button onClick={() => setSelectedBUs([])}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 transition-colors">
                    비교 중: {selectedBUs.length}개 본부
                    <span className="opacity-60">✕</span>
                  </button>
                )}
              </div>
            )}
            <MetricDeepDive
              openSections={openSections}
              onToggle={toggleSection}
              metrics={divMetrics}
              total={metricTotal}
              processedRecords={scopedRecords}
              employees={scopedEmployees}
              approvedKeys={approvedKeys}
              riskThresholds={riskThresholds}
              selectedBUs={selectedBUs}
              onBUsChange={setSelectedBUs}
            />
          </div>
        )}

        {/* ── Grid view ── */}
        {view === 'grid' && (
          <div
            ref={gridRef}
            className={`shrink-0 max-w-full flex flex-col px-6 pb-6 transition-opacity duration-300 ease-in-out ${gridFading ? 'opacity-0' : 'opacity-100'}`}
            style={{ minHeight: 'calc(100vh - 340px)' }}
          >
            <EmployeeCalendarGrid
              key={selectedBUs.join(',')}
              employees={filteredRankedEmployees}
              records={scopedRecords}
              dates={gridDates}
              onNameClick={openDrawer}
              onCellClick={handleCellClick}
              approvedKeys={approvedKeys}
              topRiskIds={topRiskIds}
              riskMode={selectedBUs.length === 1}
              riskThresholds={riskThresholds}
              showExactTime={showExactTime}
            />
          </div>
        )}

        {/* ── Table view ── */}
        {view === 'table' && (
          <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-700">상세 근태 기록</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {filteredRecords.length}건
                    {search && ` · 검색: "${search}"`}
                    {tableRows.length < filteredRecords.length && ` · 최신 ${tableRows.length}건 표시`}
                  </p>
                </div>
                {search && (
                  <button onClick={() => setSearch('')} className="text-xs text-blue-600 hover:underline">
                    검색 초기화
                  </button>
                )}
              </div>

              {/* REQ 3: overflow-x-auto wrapper + sticky columns */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs whitespace-nowrap">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 border-b border-gray-200">
                      {/* Sticky-left: Name */}
                      <th className="sticky left-0 z-20 bg-gray-50 px-3 py-3 text-left font-medium border-r border-gray-200 shadow-[2px_0_5px_-3px_rgba(0,0,0,0.08)]">
                        이름
                      </th>
                      <th className="px-3 py-3 text-left   font-medium">조직경로</th>
                      <th className="px-3 py-3 text-left   font-medium">사번</th>
                      <th className="px-3 py-3 text-center font-medium">근무일자</th>
                      <th className="px-3 py-3 text-center font-medium">근무일명칭</th>
                      <th className="px-3 py-3 text-center font-medium">출근</th>
                      <th className="px-3 py-3 text-center font-medium">퇴근</th>
                      <th className="px-3 py-3 text-center font-medium">기본</th>
                      {/* REQ 3: OT column — amber label, turns red in body when over threshold */}
                      <th className="px-3 py-3 text-center font-medium text-amber-600">연장</th>
                      <th className="px-3 py-3 text-center font-medium text-indigo-600">야간</th>
                      <th className="px-3 py-3 text-center font-medium">총합</th>
                      {/* Sticky-right: flag/status */}
                      <th className="sticky right-0 z-20 bg-gray-50 px-3 py-3 text-left font-medium border-l border-gray-200 shadow-[-2px_0_5px_-3px_rgba(0,0,0,0.08)]">
                        인정
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {tableRows.map((r, i) => {
                      const emp        = baseEmployees.find(e => e.id === r.employeeId)
                      const isHoliday  = r.dayType !== 'WEEKDAY'
                      const totalHours = r.regularHours + r.overtimeHours
                      const otOver     = r.overtimeHours >= riskThresholds.dailyOtWarnH

                      // Solid bg variants needed for sticky cells (no transparency)
                      const rowBg = r.flag === 'NO_CLOCK_OUT'
                        ? 'bg-red-50'
                        : r.flag
                        ? 'bg-amber-50/40'
                        : isHoliday ? 'bg-gray-50/50' : ''
                      const stickyBg = r.flag === 'NO_CLOCK_OUT'
                        ? 'bg-red-50'
                        : r.flag ? 'bg-amber-50'
                        : isHoliday ? 'bg-gray-50' : 'bg-white'

                      return (
                        <tr key={i} className={`${rowBg} hover:bg-blue-50/20 transition-colors`}>

                          {/* Sticky-left: 이름 */}
                          <td className={`sticky left-0 z-10 px-3 py-2.5 border-r border-gray-100 shadow-[2px_0_5px_-3px_rgba(0,0,0,0.08)] ${stickyBg}`}>
                            <button
                              onClick={() => openDrawer(r.employeeId)}
                              className="font-medium text-gray-800 hover:text-blue-600 hover:underline underline-offset-2 transition-colors text-left"
                            >
                              {emp?.name ?? r.employeeId}
                            </button>
                            {exceptions[r.employeeId] &&
                              (exceptions[r.employeeId].bypassOtLimits || exceptions[r.employeeId].flexibleCoreTime) && (
                                <span className="ml-1.5 text-xs text-blue-500">•</span>
                              )}
                          </td>

                          <td className="px-3 py-2.5 text-gray-400 max-w-[160px] truncate">
                            {emp ? getOrgPath(emp) : r.employeeId}
                          </td>
                          <td className="px-3 py-2.5 text-gray-400 font-mono tracking-tight">
                            {r.employeeId}
                          </td>
                          <td className={`px-3 py-2.5 text-center ${isHoliday ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
                            {r.date}
                          </td>
                          <td className={`px-3 py-2.5 text-center ${isHoliday ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
                            {r.dayLabel ?? '—'}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-600">
                            {r.clockIn  !== null ? r.clockIn  : <span className="text-red-400">미태깅</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-600">
                            {r.clockOut !== null ? r.clockOut : <span className="text-red-400">미태깅</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-600">
                            {fmt(r.regularHours)}
                          </td>

                          {/* REQ 3: OT conditional formatting */}
                          <td className="px-3 py-2.5 text-center">
                            {otOver ? (
                              <span className="inline-flex items-center gap-0.5 text-red-600 font-bold"
                                title={`일 ${riskThresholds.dailyOtWarnH}h 이상 연장근로`}>
                                {fmt(r.overtimeHours)}
                                <span aria-label="초과 경고">⚠️</span>
                              </span>
                            ) : r.overtimeHours > 0 ? (
                              <span className="text-amber-600 font-semibold">{fmt(r.overtimeHours)}</span>
                            ) : (
                              <span className="text-gray-200">—</span>
                            )}
                          </td>

                          <td className="px-3 py-2.5 text-center">
                            {r.nightHours > 0
                              ? <span className="text-indigo-500">{fmt(r.nightHours)}</span>
                              : <span className="text-gray-200">—</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center font-medium text-gray-700">
                            {fmt(totalHours)}
                          </td>

                          {/* Sticky-right: flag */}
                          <td className={`sticky right-0 z-10 px-3 py-2.5 border-l border-gray-100 shadow-[-2px_0_5px_-3px_rgba(0,0,0,0.08)] ${stickyBg}`}>
                            {r.flag !== null ? (
                              <span className={`inline-block text-xs px-1.5 py-0.5 rounded border font-medium ${FLAG_COLOR[r.flag]}`}>
                                {FLAG_LABEL[r.flag]}
                              </span>
                            ) : r.erpOtApplied && r.overtimeHours > 0 ? (
                              <span className="text-xs text-green-600 font-medium">인정</span>
                            ) : (
                              <span className="text-gray-200">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {tableRows.length === 0 && (
                      <tr>
                        <td colSpan={12} className="px-4 py-10 text-center text-gray-400">
                          조건에 맞는 데이터가 없습니다
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {totalFlags > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-3">전체 이상치 현황</h2>
                <div className="flex flex-wrap gap-3">
                  {(Object.entries(flagCounts) as [string, number][]).map(([flag, count]) => (
                    <div key={flag}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${FLAG_COLOR[flag]}`}>
                      {FLAG_LABEL[flag]}
                      <span className="font-bold">{count}건</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>

      {/* ── Daily Detail Modal ── */}
      {modalCell && modalEmployee && modalRecord && (
        <DailyDetailModal
          employee={modalEmployee}
          record={modalRecord}
          policy={policy}
          initialEditHistory={recordOverrides[`${modalCell.employeeId}_${modalCell.date}`]?.editHistory}
          initialErpLeaveType={recordOverrides[`${modalCell.employeeId}_${modalCell.date}`]?.erpLeaveType}
          showExactTime={showExactTime}
          onClose={() => setModalCell(null)}
          onSave={handleModalSave}
        />
      )}

    </div>
  )
}
