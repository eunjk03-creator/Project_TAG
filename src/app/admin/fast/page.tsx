'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { processRecord } from '@/lib/processRecord'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { usePolicy } from '@/context/PolicyContext'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange, DEFAULT_RANGE } from '@/context/DateRangeContext'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useScopedProcessedRecords } from '@/hooks/useProcessedAttendance'
import { useSlack } from '@/context/SlackContext'
import { CsvUploader } from '@/components/admin/CsvUploader'
import { EmployeeCalendarGrid } from '@/components/admin/EmployeeCalendarGrid'
import { AttendanceResultTable } from '@/components/admin/AttendanceResultTable'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import { MetricDeepDive } from '@/components/admin/MetricDeepDive'
import type { Section } from '@/components/admin/MetricDeepDive'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'
import { HR_THRESHOLDS } from '@/types/tag'
import { sortByDivisionOrder } from '@/data/orgChart'
import { leaveTypeOverrideFields } from '@/utils/attendanceCalc'

const GRID_PAGE_SIZE = 40

const DAY_ALIASES: Record<string, string> = {
  '월요일': '월', '화요일': '화', '수요일': '수', '목요일': '목',
  '금요일': '금', '토요일': '토', '일요일': '일',
}

function detectMonthRange(records: { date: string }[]): { from: string; to: string } | null {
  if (!records.length) return null
  const counts: Record<string, number> = {}
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue
    const ym = r.date.slice(0, 7)
    counts[ym] = (counts[ym] ?? 0) + 1
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (!top) return null
  const [y, m] = top[0].split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${top[0]}-01`, to: `${top[0]}-${String(last).padStart(2, '0')}` }
}

function matchesStatus(r: ProcessedRecord, status: string): boolean {
  const flag = r.flag
  const isNormal = flag === null
  switch (status) {
    case '정상':      return isNormal
    case '비정상':    return !isNormal
    case '지각':      return flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY'
    case '근무시간 미달': return flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE'
    case '미태깅':    return flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT'
    case '연장근로':  return isNormal && r.overtimeHours > 0
    case '외근':      return r.finalStatus === '외근'
    default: return false
  }
}

type View = 'grid' | 'table'

export default function FastDashboard() {
  const { policy } = usePolicy()
  const { excludeFromOtIds, employeeAttrMap, exceptionRules } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const { recordOverrides } = useAttendanceData()
  const {
    employees: baseEmployees, rawRecords: baseRecords, isLiveData, isLoading,
    isProcessing: isServerProcessing, dataVersion,
    recomputeProcessed, dbSaveError: recomputeError,
  } = useAttendanceSource()
  const serverProcessed = useScopedProcessedRecords(dateRange.from, dateRange.to, dataVersion)
  const { slackNoteMap } = useSlack()

  const [view,              setView]             = useState<View>('table')
  const [search,            setSearch]           = useState('')
  const [selectedBUs,       setSelectedBUs]      = useState<string[]>([])
  const [selectedDivisions, setSelectedDivisions]= useState<string[]>([])
  const [selectedStatuses,  setSelectedStatuses] = useState<string[]>([])
  const [activeTab,         setActiveTab]        = useState<'all' | 'employee' | 'leader'>('all')
  const [gridPage,          setGridPage]         = useState(0)
  const [openSections, setOpenSections] = useState<Set<Section>>(new Set())
  function toggleSection(s: Section) {
    setOpenSections(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })
  }
  const [tableColVisibility] = useState<Record<string, boolean>>({
    normalTags: true, anomalyTags: true, leaveSource: true,
    stayH: true, realWorkH: true,
    approvedWorkRawH: true, approvedWorkPayH: true, paidRecognizedH: true,
    payOtherH: true, payOtH: true, payNightH: true, erpOtApplied: true,
  })

  // Reset grid page when filters change
  useEffect(() => { setGridPage(0) }, [search, selectedDivisions, selectedBUs, activeTab, dateRange])

  useEffect(() => {
    if (!isLiveData) { setDateRange(DEFAULT_RANGE); return }
    const detected = detectMonthRange(baseRecords)
    if (detected) setDateRange(detected)
  }, [isLiveData, baseRecords]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attr / exemption maps ────────────────────────────────────────────────
  const DEFAULT_GLOBAL_EXCLUSIONS = new Set(['E22100401','E22082202','E24010202','E23080702','E24031802','E22061503','E24031806','E24010203','E18090302','E24100705'])
  const DEFAULT_FIXED_A  = new Set(['E25122301'])
  const DEFAULT_FIXED_B  = new Set(['E26030501','E24011001'])
  const DEFAULT_PREGNANT = new Set(['E25060901','E22080101','E25060902'])

  const { finalAttrMap, remappedExcludeIds } = useMemo(() => {
    const normName = (s: string) => s.trim().replace(/\s+/g, '')
    const nameToId = new Map(baseEmployees.map(e => [normName(e.name), e.id]))
    const liveIds  = new Set(baseEmployees.map(e => e.id))
    const toLive   = new Map<string, string>()
    for (const rule of exceptionRules) {
      if (liveIds.has(rule.employeeId)) toLive.set(rule.employeeId, rule.employeeId)
      else { const l = nameToId.get(normName(rule.employeeName)); if (l) toLive.set(rule.employeeId, l) }
    }
    const result = new Map<string, EmployeeAttributeOverrides>()
    for (const emp of baseEmployees) {
      const rawId = emp.rawId ?? emp.id.split('_')[0]
      if (DEFAULT_GLOBAL_EXCLUSIONS.has(rawId))   result.set(emp.id, { isGlobalExclusion: true })
      else if (DEFAULT_FIXED_A.has(rawId))         result.set(emp.id, { isFixedScheduleA: true })
      else if (DEFAULT_FIXED_B.has(rawId))         result.set(emp.id, { isFixedScheduleB: true })
      else if (DEFAULT_PREGNANT.has(rawId))        result.set(emp.id, { isPregnantReduced: true })
    }
    for (const [staleId, attrs] of employeeAttrMap) {
      const liveId = toLive.get(staleId) ?? staleId
      result.set(liveId, { ...(result.get(liveId) ?? {}), ...attrs })
    }
    const remappedExclude = new Set<string>()
    for (const staleId of excludeFromOtIds) remappedExclude.add(toLive.get(staleId) ?? staleId)
    return { finalAttrMap: result, remappedExcludeIds: remappedExclude }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeAttrMap, excludeFromOtIds, exceptionRules, baseEmployees])

  const globalExclusionIds = useMemo(
    () => new Set([...finalAttrMap.entries()].filter(([, a]) => a.isGlobalExclusion).map(([id]) => id)),
    [finalAttrMap],
  )
  const otExemptIds = useMemo(() => new Set([
    ...remappedExcludeIds,
    ...baseEmployees.filter(e => e.isLeader).map(e => e.id),
  ]), [remappedExcludeIds, baseEmployees])

  // ── Processed records (server-computed or fallback) ──────────────────────
  const overriddenRawRecords = useMemo(() => {
    if (!Object.keys(recordOverrides).length) return baseRecords
    return baseRecords.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn,
        clockOut:     ov.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
        ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
      }
    })
  }, [recordOverrides, baseRecords])

  const { processed: clientProcessed } = useAttendanceLogic(
    serverProcessed ? [] : overriddenRawRecords,
    policy, dateRange.from, dateRange.to, otExemptIds, slackNoteMap, finalAttrMap,
  )

  // finalAttrMap에 항목이 있는 직원(퇴사자/직책자/단축근로 등 예외규칙 적용 대상)은 캐시된
  // serverProcessed가 그 규칙을 반영하기 전 상태일 수 있으므로 매번 재처리 대상에 포함한다 —
  // 그렇지 않으면 퇴사일/직책자 발령일 등을 바꿔도 "전체 재계산" 전까지 반영이 안 됨.
  const attrOverrideEmployeeIds = useMemo(() => new Set(finalAttrMap.keys()), [finalAttrMap])

  const allProcessed = useMemo<ProcessedRecord[]>(() => {
    if (!serverProcessed) return clientProcessed
    // 서버 조회 자체가 이미 [dateRange.from, dateRange.to]로 스코프돼 있어 재필터 불필요.
    const dateFiltered = serverProcessed
    if (!Object.keys(recordOverrides).length && attrOverrideEmployeeIds.size === 0) return dateFiltered
    return dateFiltered.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov && !attrOverrideEmployeeIds.has(r.employeeId)) return r
      return processRecord({
        ...r,
        ...(ov ? {
          clockIn:      ov.clockIn      ?? r.clockIn,
          clockOut:     ov.clockOut     ?? r.clockOut,
          erpOtApplied: ov.erpOtApplied !== null ? (ov.erpOtApplied as boolean) : r.erpOtApplied,
          ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
        } : {}),
      }, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId))
    })
  }, [serverProcessed, clientProcessed, dateRange.from, dateRange.to, recordOverrides, policy, otExemptIds, slackNoteMap, finalAttrMap, attrOverrideEmployeeIds])

  // ── Employees & filters ─────────────────────────────────────────────────
  const leaderIdSet = useMemo(() => new Set(
    baseEmployees.filter(e => finalAttrMap.get(e.id)?.isLeader || e.isLeader).map(e => e.id),
  ), [baseEmployees, finalAttrMap])

  const activeEmployees = useMemo<Employee[]>(() => {
    const base = activeTab === 'all' ? baseEmployees
      : activeTab === 'employee' ? baseEmployees.filter(e => !leaderIdSet.has(e.id))
      : baseEmployees.filter(e => leaderIdSet.has(e.id))
    return base.filter(e => !globalExclusionIds.has(e.id))
  }, [baseEmployees, activeTab, leaderIdSet, globalExclusionIds])

  const scopedRecords = useMemo(
    () => allProcessed.filter(r => !globalExclusionIds.has(r.employeeId)),
    [allProcessed, globalExclusionIds],
  )

  const approvedKeys = useMemo(() => new Set<string>(), [])

  const searchQuery = DAY_ALIASES[search.trim().toLowerCase()] ?? search.trim().toLowerCase()

  const empById = useMemo(() => new Map(baseEmployees.map(e => [e.id, e])), [baseEmployees])
  const empDivisionMap = useMemo(() => new Map(baseEmployees.map(e => [e.id, e.division.trim()])), [baseEmployees])

  const preStatusRecords = useMemo(() => scopedRecords.filter(r => {
    const emp   = empById.get(r.employeeId)
    const rawId = emp?.rawId ?? r.employeeId.split('_')[0]
    if (searchQuery) {
      const hit = (emp?.name ?? '').toLowerCase().includes(searchQuery) ||
        (emp?.division ?? '').toLowerCase().includes(searchQuery) || rawId.toLowerCase().includes(searchQuery)
      if (!hit) return false
    }
    if (selectedDivisions.length > 0 && !selectedDivisions.includes(emp?.division ?? '')) return false
    return true
  }), [scopedRecords, searchQuery, selectedDivisions, empById])

  const filteredRecords = useMemo(() =>
    selectedStatuses.length === 0 ? preStatusRecords :
    preStatusRecords.filter(r => selectedStatuses.some(s => matchesStatus(r, s))),
  [preStatusRecords, selectedStatuses])

  function applyTabBU(recs: ProcessedRecord[]): ProcessedRecord[] {
    const hasBU  = selectedBUs.length > 0
    const hasTab = activeTab !== 'all'
    if (!hasBU && !hasTab) return recs
    const tabIds = hasTab ? new Set(activeEmployees.map(e => e.id)) : null
    const buSet  = hasBU  ? new Set(selectedBUs.map(b => b.trim())) : null
    return recs.filter(r => {
      if (tabIds && !tabIds.has(r.employeeId)) return false
      if (buSet && !buSet.has(empDivisionMap.get(r.employeeId) ?? '')) return false
      return true
    })
  }

  const tabFilteredRecords = useMemo(() => applyTabBU(filteredRecords),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredRecords, activeTab, activeEmployees, selectedBUs, empDivisionMap])

  const searchFilteredEmployees = useMemo(() => {
    let result = activeEmployees
    if (selectedBUs.length > 0) {
      const buSet = new Set(selectedBUs.map(b => b.trim()))
      result = result.filter(e => buSet.has(e.division.trim()))
    }
    if (searchQuery) result = result.filter(e => {
      const rawId = e.rawId ?? e.id.split('_')[0]
      return e.name.toLowerCase().includes(searchQuery) || (e.division ?? '').toLowerCase().includes(searchQuery) || rawId.toLowerCase().includes(searchQuery)
    })
    if (selectedDivisions.length > 0) result = result.filter(e => selectedDivisions.includes(e.division ?? ''))
    return result
  }, [activeEmployees, selectedBUs, searchQuery, selectedDivisions])

  // ── Grid pagination ──────────────────────────────────────────────────────
  const gridTotalPages = Math.ceil(searchFilteredEmployees.length / GRID_PAGE_SIZE)
  const gridEmployees  = useMemo(
    () => searchFilteredEmployees.slice(gridPage * GRID_PAGE_SIZE, (gridPage + 1) * GRID_PAGE_SIZE),
    [searchFilteredEmployees, gridPage],
  )

  // ── Grid dates ───────────────────────────────────────────────────────────
  const gridDates = useMemo(() => {
    if (!dateRange.from || !dateRange.to) return []
    const dates: string[] = []
    const cur = new Date(dateRange.from + 'T12:00:00')
    const end = new Date(dateRange.to   + 'T12:00:00')
    while (cur <= end) {
      dates.push(`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`)
      cur.setDate(cur.getDate() + 1)
    }
    return dates
  }, [dateRange.from, dateRange.to])

  // ── Metrics ──────────────────────────────────────────────────────────────
  const { bizDays, metrics, total, employeeMetrics, employeeTotal, leaderMetrics, leaderTotal } =
    useManagementMetrics(scopedRecords, activeEmployees, approvedKeys, dateRange.from, dateRange.to, finalAttrMap)

  const activeMetrics = activeTab === 'all' ? metrics : activeTab === 'employee' ? employeeMetrics : leaderMetrics
  const activeTotal   = activeTab === 'all' ? total   : activeTab === 'employee' ? employeeTotal   : leaderTotal

  function fmt(h: number): string {
    if (h === 0) return '—'
    const m = Math.round(h * 60)
    return `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`
  }

  const deptLabel = selectedBUs.length === 1 ? selectedBUs[0] : selectedBUs.length > 1 ? `${selectedBUs.length}개 본부` : '전체'

  const cardStats = useMemo(() => {
    if (!activeMetrics.length) return null
    const n = activeTotal.headcount || 1
    const topTotal     = activeMetrics.reduce((a, b) => a.totalHours > b.totalHours ? a : b)
    const topOt        = activeMetrics.reduce((a, b) => a.otHours    > b.otHours    ? a : b)
    const topAnomalies = activeMetrics.reduce((a, b) => a.anomalies  > b.anomalies  ? a : b)
    return {
      avgTotal: activeTotal.totalHours / n,
      avgOt:    activeTotal.otHours    / n,
      otRatio:  activeTotal.totalHours > 0 ? (activeTotal.otHours / activeTotal.totalHours) * 100 : 0,
      topTotal, topOt, topAnomalies,
    }
  }, [activeMetrics, activeTotal])

  const divisionList = useMemo(
    () => sortByDivisionOrder([...new Set(baseEmployees.map(e => e.division).filter(Boolean))]),
    [baseEmployees],
  )

  const STATUS_OPTIONS = ['정상','비정상','지각','근무시간 미달','미태깅','연장근로','외근']
  const divDropRef    = useRef<HTMLDivElement>(null)
  const statusDropRef = useRef<HTMLDivElement>(null)
  const [divOpen,    setDivOpen]    = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)

  return (
    <div className="flex flex-col h-full">

      {/* ── CSV uploader ── */}
      <CsvUploader />

      {/* ── Recompute / header bar ── */}
      {isLiveData && (
        <div className="px-6 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-3 text-xs">
          <span className="text-gray-400">⚡ 빠른 보기 모드</span>
          {isServerProcessing ? (
            <span className="flex items-center gap-1.5 text-blue-500">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              재계산 중...
            </span>
          ) : (
            <button onClick={recomputeProcessed} className="text-gray-400 hover:text-gray-700 transition-colors">↻ 재계산</button>
          )}
          {!isServerProcessing && recomputeError && (
            <span className="text-xs text-red-600 font-medium" title={recomputeError}>⚠ {recomputeError}</span>
          )}
        </div>
      )}

      {/* ── 로딩 중 스피너 ── */}
      {(isLoading || (!serverProcessed && isLiveData)) && (
        <div className="shrink-0 px-6 py-4 bg-white border-b border-gray-100 flex items-center gap-2 text-sm text-gray-400">
          <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          데이터 로딩 중...
        </div>
      )}

      {/* ── KPI + Date + Tab ── */}
      {serverProcessed && (
      <div className="shrink-0 px-6 py-3 bg-white border-b border-gray-100 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <span className="text-xs text-gray-400">{bizDays}영업일</span>
        </div>

        {/* KPI 카드 3개 — 원본 admin과 동일 */}
        <div className="grid grid-cols-3 gap-4">

          {/* Card 1 — 총 근로시간 */}
          <div className={`bg-white rounded-xl border p-4 transition-colors ${openSections.has('total') ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-gray-500">총 근로시간</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium truncate max-w-[72px]">{deptLabel}</span>
            </div>
            <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{fmt(activeTotal.totalHours)}</p>
            <div className="mt-2 space-y-0.5">
              <p className="text-xs text-gray-400 flex items-center gap-1">
                1인 평균
                <span className={`font-medium tabular-nums ${cardStats && cardStats.avgTotal > HR_THRESHOLDS.totalAmberH ? 'text-amber-600' : 'text-gray-600'}`}>
                  {cardStats ? fmt(cardStats.avgTotal) : '—'}
                </span>
              </p>
              {cardStats && <p className="text-xs text-gray-400 truncate">최다 <span className="text-blue-600 font-medium">{cardStats.topTotal.division}</span></p>}
            </div>
            <button onClick={() => toggleSection('total')} className="mt-2.5 text-xs text-blue-500 hover:text-blue-700 font-medium transition-colors">
              📊 지표 분석 {openSections.has('total') ? '▴' : '▾'}
            </button>
          </div>

          {/* Card 2 — 연장근로 */}
          <div className={`bg-white rounded-xl border p-4 transition-colors ${openSections.has('overtime') ? 'border-amber-300 ring-1 ring-amber-200' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-gray-500">연장근로</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium truncate max-w-[72px]">{deptLabel}</span>
            </div>
            <p className="text-2xl font-bold text-amber-500 mt-1 tabular-nums">{fmt(activeTotal.otHours)}</p>
            <div className="mt-2 space-y-0.5">
              <p className="text-xs text-gray-400 flex items-center gap-1 flex-wrap">
                1인 평균
                <span className={`font-medium tabular-nums ${cardStats && cardStats.avgOt > HR_THRESHOLDS.otAmberH ? 'text-amber-600' : 'text-gray-600'}`}>
                  {cardStats ? fmt(cardStats.avgOt) : '—'}
                </span>
                <span className="text-gray-300">·</span>
                <span className="tabular-nums text-gray-400">{cardStats ? cardStats.otRatio.toFixed(1) : 0}%</span>
              </p>
              {cardStats && <p className="text-xs text-gray-400 truncate">최다 <span className="text-amber-600 font-medium">{cardStats.topOt.division}</span></p>}
            </div>
            <button onClick={() => toggleSection('overtime')} className="mt-2.5 text-xs text-amber-500 hover:text-amber-700 font-medium transition-colors">
              📊 지표 분석 {openSections.has('overtime') ? '▴' : '▾'}
            </button>
          </div>

          {/* Card 3 — 이상치 */}
          <div className={`rounded-xl border p-4 transition-colors ${
            activeTotal.anomalies > 0
              ? openSections.has('anomaly') ? 'bg-red-50 border-red-400 ring-1 ring-red-200' : 'bg-red-50 border-red-200'
              : openSections.has('anomaly') ? 'bg-white border-red-300 ring-1 ring-red-200' : 'bg-white border-gray-200'
          }`}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-gray-500">이상치</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium truncate max-w-[72px]">{deptLabel}</span>
            </div>
            <p className={`text-2xl font-bold mt-1 tabular-nums ${activeTotal.anomalies > 0 ? 'text-red-600' : 'text-gray-900'}`}>
              {activeTotal.anomalies}건
            </p>
            <div className="mt-2 space-y-0.5">
              <p className="text-xs text-gray-400">
                평균 <span className="text-gray-600 font-medium tabular-nums">
                  {activeTotal.headcount > 0 ? (activeTotal.anomalies / activeTotal.headcount).toFixed(1) : 0}건/인
                </span>
              </p>
              {cardStats && cardStats.topAnomalies.anomalies > 0
                ? <p className="text-xs text-gray-400 truncate">최다 <span className="text-red-600 font-medium">{cardStats.topAnomalies.division}</span></p>
                : <p className="text-xs text-gray-400">이상치 없음</p>
              }
            </div>
            <button onClick={() => toggleSection('anomaly')} className="mt-2.5 text-xs text-red-500 hover:text-red-700 font-medium transition-colors">
              📊 지표 분석 {openSections.has('anomaly') ? '▴' : '▾'}
            </button>
          </div>

        </div>

      </div>
      )}

      {/* ── MetricDeepDive 펼침 영역 ── */}
      {openSections.size > 0 && (
        <div className="shrink-0 px-6 pb-4">
          {selectedBUs.length >= 1 && (
            <div className="flex items-center gap-2 mb-3">
              <button onClick={() => setSelectedBUs([])}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 transition-colors">
                {selectedBUs.length === 1 ? `필터됨: ${selectedBUs[0]}` : `비교 중: ${selectedBUs.length}개 본부`}
                <span className="opacity-60">✕</span>
              </button>
            </div>
          )}
          <MetricDeepDive
            openSections={openSections}
            onToggle={toggleSection}
            metrics={activeMetrics}
            total={activeTotal}
            employeeMetrics={employeeMetrics}
            employeeTotal={employeeTotal}
            leaderMetrics={leaderMetrics}
            leaderTotal={leaderTotal}
            processedRecords={scopedRecords}
            employees={activeEmployees}
            approvedKeys={approvedKeys}
            riskThresholds={HR_THRESHOLDS}
            selectedBUs={selectedBUs}
            onBUsChange={setSelectedBUs}
            leaderIdSet={leaderIdSet}
          />
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="shrink-0 px-6 py-2.5 bg-white border-b border-gray-100">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit text-sm">
          {([
            { key: 'all'      as const, label: '전체',   count: total.headcount         },
            { key: 'employee' as const, label: '사원',   count: employeeTotal.headcount },
            { key: 'leader'   as const, label: '직책자', count: leaderTotal.headcount   },
          ]).map(({ key, label, count }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-3 py-1 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1 text-sm ${
                activeTab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {label}
              <span className={`text-[10px] px-1 rounded font-semibold ${activeTab === key ? 'bg-gray-100 text-gray-600' : 'bg-gray-200 text-gray-400'}`}>{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="shrink-0 px-6 py-2 bg-white border-b border-gray-100 flex items-center gap-2 flex-wrap text-xs">
        {/* View toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(['table','grid'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 font-medium transition-colors ${view === v ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
              {v === 'table' ? '테이블' : '캘린더'}
            </button>
          ))}
        </div>

        {/* Division filter */}
        <div className="relative" ref={divDropRef}>
          <button onClick={() => setDivOpen(o => !o)}
            className={`px-3 py-1.5 rounded-lg border transition-colors ${
              selectedDivisions.length > 0 ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}>
            본부 {selectedDivisions.length > 0 && `(${selectedDivisions.length})`}
          </button>
          {divOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-2 min-w-[140px]">
              {divisionList.map(d => (
                <label key={d} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-gray-700">
                  <input type="checkbox" checked={selectedDivisions.includes(d)}
                    onChange={() => setSelectedDivisions(p => p.includes(d) ? p.filter(x => x !== d) : [...p, d])}
                    className="accent-blue-500" />
                  {d}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Status filter (table only) */}
        {view === 'table' && (
          <div className="relative" ref={statusDropRef}>
            <button onClick={() => setStatusOpen(o => !o)}
              className={`px-3 py-1.5 rounded-lg border transition-colors ${
                selectedStatuses.length > 0 ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}>
              상태 {selectedStatuses.length > 0 && `(${selectedStatuses.length})`}
            </button>
            {statusOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-2 min-w-[140px]">
                {STATUS_OPTIONS.map(s => (
                  <label key={s} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-gray-700">
                    <input type="checkbox" checked={selectedStatuses.includes(s)}
                      onChange={() => setSelectedStatuses(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])}
                      className="accent-purple-500" />
                    {s}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="이름·부서 검색"
            className="pl-8 pr-3 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-300 w-40" />
        </div>

        <span className="text-gray-400 ml-auto">{tabFilteredRecords.length}건</span>
      </div>

      {/* ── Grid: employee pagination ── */}
      {view === 'grid' && (
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          {/* Pagination controls */}
          {gridTotalPages > 1 && (
            <div className="shrink-0 px-6 py-2 bg-white border-b border-gray-100 flex items-center gap-3 text-xs text-gray-500">
              <span>{gridPage * GRID_PAGE_SIZE + 1}–{Math.min((gridPage + 1) * GRID_PAGE_SIZE, searchFilteredEmployees.length)} / {searchFilteredEmployees.length}명</span>
              <div className="flex items-center gap-1 ml-auto">
                <button disabled={gridPage === 0}
                  onClick={() => setGridPage(p => p - 1)}
                  className="px-2.5 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">
                  ← 이전
                </button>
                {Array.from({ length: gridTotalPages }, (_, i) => (
                  <button key={i} onClick={() => setGridPage(i)}
                    className={`w-7 h-7 rounded text-center transition-colors ${gridPage === i ? 'bg-gray-900 text-white' : 'hover:bg-gray-100 text-gray-600'}`}>
                    {i + 1}
                  </button>
                ))}
                <button disabled={gridPage >= gridTotalPages - 1}
                  onClick={() => setGridPage(p => p + 1)}
                  className="px-2.5 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">
                  다음 →
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-auto px-6 pb-6 pt-3">
            <EmployeeCalendarGrid
              employees={gridEmployees}
              records={scopedRecords}
              dates={gridDates}
              onNameClick={() => {}}
              onCellClick={() => {}}
              approvedKeys={approvedKeys}
              topRiskIds={new Set()}
              riskMode={false}
              riskThresholds={HR_THRESHOLDS}
              timeMode="recognized"
              companyHolidays={policy.companyHolidays}
            />
          </div>
        </div>
      )}

      {/* ── Table view ── */}
      {view === 'table' && (
        <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 pt-3">
          <AttendanceResultTable
            records={tabFilteredRecords}
            employees={baseEmployees}
            employeeAttrMap={finalAttrMap}
            columnVisibility={tableColVisibility}
            onColumnVisibilityChange={() => {}}
            onRowClick={() => {}}
            onNameClick={() => {}}
            noteMap={new Map()}
            onNoteChange={() => {}}
            otExemptIds={otExemptIds}
          />
        </div>
      )}

    </div>
  )
}
