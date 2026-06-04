'use client'
import { useState, useMemo, useRef } from 'react'
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides, CompanyHoliday } from '@/types/tag'
import { HR_THRESHOLDS } from '@/types/tag'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { EmployeeCalendarGrid } from '@/components/admin/EmployeeCalendarGrid'
import { AttendanceResultTable } from '@/components/admin/AttendanceResultTable'
import { DeptComparisonChart } from '@/components/admin/DeptComparisonChart'
import { MetricDeepDive } from '@/components/admin/MetricDeepDive'
import type { Section } from '@/components/admin/MetricDeepDive'
import { sortByDivisionOrder } from '@/data/orgChart'
import {
  computeWorkA, computeWorkB, computeBreakH, computeFinalWork, computeStatusN,
} from '@/utils/attendanceCalc'

export interface SnapshotData {
  processed:           ProcessedRecord[]
  employees:           Employee[]
  leaderIds:           string[]
  globalExclusionIds:  string[]
  otExemptIds:         string[]
  companyHolidays:     CompanyHoliday[]
  createdAt:           string
  label?:              string | null
}

type PR = ProcessedRecord
type View = 'grid' | 'table'

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

function matchesStatus(r: PR, status: string): boolean {
  const flag = r.flag
  const anomalyTags: string[] = []
  if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') anomalyTags.push('미태깅')
  if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('지각')
  if (flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') anomalyTags.push('조기퇴근')
  if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('근무시간 미달')
  const isNormal = anomalyTags.length === 0
  const normalTags: string[] = []
  if (r.finalStatus === '외근') normalTags.push('외근')
  if (r.finalStatus === '휴일근무') normalTags.push('휴일근로')
  if (r.overtimeHours > 0) normalTags.push('연장근로')
  if (normalTags.length === 0 && anomalyTags.length === 0 && r.clockIn !== null && r.dayType === 'WEEKDAY') normalTags.push('일반')
  switch (status) {
    case '정상':          return isNormal
    case '비정상':        return !isNormal
    case '일반':          return isNormal && normalTags.includes('일반')
    case '연장근로':      return isNormal && normalTags.includes('연장근로')
    case '외근':          return isNormal && normalTags.includes('외근')
    case '휴일근로':      return isNormal && normalTags.includes('휴일근로')
    case '지각':          return anomalyTags.includes('지각')
    case '조기퇴근':      return anomalyTags.includes('조기퇴근')
    case '근무시간 미달': return anomalyTags.includes('근무시간 미달')
    case '미태깅':        return anomalyTags.includes('미태깅')
    default: return false
  }
}

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`
}

export function ShareDashboard({ snapshot }: { snapshot: SnapshotData }) {
  const { processed, employees, leaderIds, globalExclusionIds, otExemptIds, companyHolidays, createdAt, label } = snapshot

  const leaderSet    = useMemo(() => new Set(leaderIds),           [leaderIds])
  const exclusionSet = useMemo(() => new Set(globalExclusionIds),  [globalExclusionIds])
  const otExemptSet  = useMemo(() => new Set(otExemptIds),         [otExemptIds])

  const finalAttrMap = useMemo(() => {
    const m = new Map<string, EmployeeAttributeOverrides>()
    for (const id of leaderIds)           m.set(id, { ...(m.get(id) ?? {}), isLeader: true })
    for (const id of globalExclusionIds)  m.set(id, { ...(m.get(id) ?? {}), isGlobalExclusion: true })
    return m
  }, [leaderIds, globalExclusionIds])

  const defaultRange = useMemo(() => detectMonthRange(processed) ?? { from: '', to: '' }, [processed])
  const [dateRange,        setDateRange]        = useState(defaultRange)
  const [view,             setView]             = useState<View>('grid')
  const [search,           setSearch]           = useState('')
  const [selectedBUs,      setSelectedBUs]      = useState<string[]>([])
  const [selectedDivisions,setSelectedDivisions]= useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])
  const [divisionOpen,     setDivisionOpen]     = useState(false)
  const [statusOpen,       setStatusOpen]       = useState(false)
  const [activeTab,        setActiveTab]        = useState<'all' | 'employee' | 'leader'>('all')
  const [openSections,     setOpenSections]     = useState<Set<Section>>(new Set())
  const [chartExpanded,    setChartExpanded]    = useState(true)
  const [tableColVisibility] = useState<Record<string, boolean>>({
    normalTags: true, anomalyTags: true, leaveSource: true,
    gasWorkAMins: true, breakH: true, gasWorkBMins: true,
    payrollOtH: true, payrollNightH: true, erpOtApplied: true,
  })
  const divDropRef  = useRef<HTMLDivElement>(null)
  const statusDropRef = useRef<HTMLDivElement>(null)

  // ── Date range → grid columns ────────────────────────────────────────────
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

  // ── Filter processedRecords by date range ────────────────────────────────
  const allProcessed = useMemo(() =>
    processed.filter(r => r.date >= dateRange.from && r.date <= dateRange.to),
  [processed, dateRange.from, dateRange.to])

  const scopedRecords = useMemo(() =>
    allProcessed.filter(r => !exclusionSet.has(r.employeeId)),
  [allProcessed, exclusionSet])

  const activeEmployees = useMemo(() => {
    const base = employees.filter(e => !exclusionSet.has(e.id))
    if (activeTab === 'all')      return base
    if (activeTab === 'employee') return base.filter(e => !leaderSet.has(e.id))
    return base.filter(e => leaderSet.has(e.id))
  }, [employees, exclusionSet, leaderSet, activeTab])

  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees])
  const empDivisionMap = useMemo(() => new Map(employees.map(e => [e.id, e.division.trim()])), [employees])

  const searchQuery = DAY_ALIASES[search.trim().toLowerCase()] ?? search.trim().toLowerCase()

  const preStatusRecords = useMemo(() => scopedRecords.filter(r => {
    const emp   = empById.get(r.employeeId)
    const rawId = emp?.rawId ?? r.employeeId.split('_')[0]
    if (searchQuery) {
      const hit = (emp?.name ?? '').toLowerCase().includes(searchQuery) ||
        (emp?.division ?? '').toLowerCase().includes(searchQuery) ||
        (emp?.team ?? '').toLowerCase().includes(searchQuery) ||
        rawId.toLowerCase().includes(searchQuery) ||
        r.date.includes(searchQuery)
      if (!hit) return false
    }
    if (selectedDivisions.length > 0 && !selectedDivisions.includes(emp?.division ?? '')) return false
    return true
  }), [scopedRecords, searchQuery, selectedDivisions, empById])

  const filteredRecords = useMemo(() =>
    selectedStatuses.length === 0 ? preStatusRecords :
    preStatusRecords.filter(r => selectedStatuses.some(s => matchesStatus(r, s))),
  [preStatusRecords, selectedStatuses])

  const approvedKeys = useMemo(() => new Set<string>(), [])

  function applyTabBU(recs: PR[]): PR[] {
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

  const tabPreStatusRecords = useMemo(() => applyTabBU(preStatusRecords),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preStatusRecords, activeTab, activeEmployees, selectedBUs, empDivisionMap])

  const anomalyCounts = useMemo(() => {
    let normal = 0, abnormal = 0, overtime = 0, offsite = 0, holidayWork = 0, late = 0, early = 0, shortWork = 0, missing = 0
    for (const r of tabPreStatusRecords) {
      const flag = r.flag; const hasAnomaly = flag !== null
      if (hasAnomaly) {
        abnormal++
        if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') missing++
        if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') late++
        if (flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') early++
        if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY') shortWork++
      } else { normal++ }
      if (r.finalStatus === '외근')     offsite++
      if (r.finalStatus === '휴일근무') holidayWork++
      if (r.overtimeHours > 0)         overtime++
    }
    return { normal, abnormal, overtime, offsite, holidayWork, late, early, shortWork, missing }
  }, [tabPreStatusRecords])

  const filteredRankedEmployees = useMemo(() => {
    if (selectedBUs.length === 0) return activeEmployees
    const buSet = new Set(selectedBUs.map(b => b.trim()))
    return activeEmployees.filter(e => buSet.has(e.division.trim()))
  }, [activeEmployees, selectedBUs])

  const searchFilteredEmployees = useMemo(() => {
    let result = filteredRankedEmployees
    if (searchQuery) result = result.filter(e => {
      const rawId = e.rawId ?? e.id.split('_')[0]
      return e.name.toLowerCase().includes(searchQuery) ||
        (e.division ?? '').toLowerCase().includes(searchQuery) ||
        rawId.toLowerCase().includes(searchQuery)
    })
    if (selectedDivisions.length > 0) result = result.filter(e => selectedDivisions.includes(e.division ?? ''))
    return result
  }, [filteredRankedEmployees, searchQuery, selectedDivisions])

  const displayStatusMap = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const r of scopedRecords) {
      const leaveAmt   = r.erpLeaveAmount ?? 0
      const workA      = computeWorkA(r.effectiveClockIn ?? r.clockIn, r.clockOut)
      const workB      = computeWorkB(workA, leaveAmt, r.isUnpaidLeave ?? false)
      const breakH_    = computeBreakH(workB)
      const finalWorkH = computeFinalWork(workB, breakH_)
      const ds: string | null =
        r.finalStatus === '외근'     ? '외근'     :
        r.finalStatus === '휴일근무' ? '휴일근무' :
        computeStatusN({ finalWorkH, dayType: r.dayType, clockIn: r.clockIn ?? undefined, clockOut: r.clockOut ?? undefined, leaveType: r.leaveType ?? undefined, erpLeaveAmount: r.erpLeaveAmount, rawId: r.employeeId.split('_')[0] })
      m.set(`${r.employeeId}_${r.date}`, ds)
    }
    return m
  }, [scopedRecords])
  void displayStatusMap

  const { bizDays, metrics, total, employeeMetrics, employeeTotal, leaderMetrics, leaderTotal } =
    useManagementMetrics(scopedRecords, activeEmployees, approvedKeys, dateRange.from, dateRange.to, finalAttrMap)

  const activeMetrics = activeTab === 'all' ? metrics : activeTab === 'employee' ? employeeMetrics : leaderMetrics
  const activeTotal   = activeTab === 'all' ? total   : activeTab === 'employee' ? employeeTotal   : leaderTotal

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

  const divisionList = useMemo(() =>
    sortByDivisionOrder([...new Set(employees.map(e => e.division).filter(Boolean))]),
  [employees])

  const STATUS_OPTIONS = ['정상','비정상','일반','연장근로','외근','휴일근로','지각','조기퇴근','근무시간 미달','미태깅']

  const createdFmt = new Date(createdAt).toLocaleString('ko-KR', { month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' })

  return (
    <div className="flex flex-col h-screen bg-gray-50 overflow-hidden">

      {/* ── Header ── */}
      <div className="shrink-0 px-6 py-3 bg-white border-b border-gray-100 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-800">
            T.A.G. 근태 현황
          </span>
          {label && <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{label}</span>}
          <span className="flex items-center gap-1 text-[11px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full font-medium">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
            읽기 전용 스냅샷
          </span>
        </div>
        <span className="text-[11px] text-gray-400">{createdFmt} 기준</span>
      </div>

      {/* ── Date range + KPI bar ── */}
      <div className="shrink-0 px-6 py-3 bg-white border-b border-gray-100 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Date range */}
          <div className="flex items-center gap-2">
            <input type="date" value={dateRange.from} onChange={e => setDateRange(p => ({ ...p, from: e.target.value }))}
              className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300" />
            <span className="text-xs text-gray-400">–</span>
            <input type="date" value={dateRange.to} onChange={e => setDateRange(p => ({ ...p, to: e.target.value }))}
              className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300" />
          </div>
          <span className="text-[11px] text-gray-400">{bizDays}영업일</span>
        </div>

        {/* KPI cards */}
        {cardStats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: '인당 평균 근무', value: fmt(cardStats.avgTotal), sub: `최다: ${cardStats.topTotal.division}` },
              { label: '인당 평균 연장', value: fmt(cardStats.avgOt),    sub: `${cardStats.otRatio.toFixed(1)}% 비중` },
              { label: '이상치 최다',    value: cardStats.topAnomalies.division, sub: `${cardStats.topAnomalies.anomalies}건` },
              { label: '연장 최다',      value: cardStats.topOt.division, sub: fmt(cardStats.topOt.otHours) },
            ].map(c => (
              <div key={c.label} className="bg-gray-50 rounded-lg px-3 py-2">
                <div className="text-[10px] text-gray-400 mb-0.5">{c.label}</div>
                <div className="text-sm font-semibold text-gray-800 truncate">{c.value}</div>
                <div className="text-[10px] text-gray-400">{c.sub}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Tab bar ── */}
      <div className="shrink-0 px-6 py-2 bg-white border-b border-gray-100">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit text-sm">
          {([
            { key: 'all'      as const, label: '전체',  count: total.headcount         },
            { key: 'employee' as const, label: '사원',  count: employeeTotal.headcount },
            { key: 'leader'   as const, label: '직책자', count: leaderTotal.headcount  },
          ]).map(({ key, label: lbl, count }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-4 py-1.5 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1.5 text-sm ${
                activeTab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {lbl}
              <span className={`text-[10px] px-1 py-0.5 rounded font-semibold ${
                activeTab === key ? 'bg-gray-100 text-gray-600' : 'bg-gray-200 text-gray-400'
              }`}>{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Metrics deep-dive ── */}
      <div className="shrink-0 px-6 pt-3">
        <MetricDeepDive
          openSections={openSections}
          onToggle={s => setOpenSections(p => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })}
          metrics={activeMetrics}
          total={activeTotal}
          processedRecords={scopedRecords}
          employees={activeEmployees}
          approvedKeys={approvedKeys}
          riskThresholds={HR_THRESHOLDS}
          selectedBUs={selectedBUs}
          onBUsChange={setSelectedBUs}
        />
      </div>

      {/* ── View / Filter toolbar ── */}
      <div className="shrink-0 px-6 py-2 bg-white border-b border-gray-100 flex items-center gap-3 flex-wrap">
        {/* View toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {(['grid','table'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 font-medium transition-colors ${view === v ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
              {v === 'grid' ? '캘린더' : '테이블'}
            </button>
          ))}
        </div>

        {/* Division filter */}
        <div className="relative" ref={divDropRef}>
          <button onClick={() => setDivisionOpen(o => !o)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              selectedDivisions.length > 0 ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}>
            본부 {selectedDivisions.length > 0 && <span className="bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]">{selectedDivisions.length}</span>}
          </button>
          {divisionOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-2 min-w-[140px]">
              {divisionList.map(d => (
                <label key={d} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-xs text-gray-700">
                  <input type="checkbox" checked={selectedDivisions.includes(d)}
                    onChange={() => setSelectedDivisions(p => p.includes(d) ? p.filter(x => x !== d) : [...p, d])}
                    className="accent-blue-500" />
                  {d}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Status filter */}
        {view === 'table' && (
          <div className="relative" ref={statusDropRef}>
            <button onClick={() => setStatusOpen(o => !o)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                selectedStatuses.length > 0 ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}>
              상태 {selectedStatuses.length > 0 && <span className="bg-purple-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]">{selectedStatuses.length}</span>}
            </button>
            {statusOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-2 min-w-[160px]">
                {STATUS_OPTIONS.map(s => {
                  const cnt: number = (anomalyCounts as Record<string, number>)[s] ?? 0
                  return (
                    <label key={s} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-xs text-gray-700">
                      <span className="flex items-center gap-1.5">
                        <input type="checkbox" checked={selectedStatuses.includes(s)}
                          onChange={() => setSelectedStatuses(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])}
                          className="accent-purple-500" />
                        {s}
                      </span>
                      {cnt > 0 && <span className="text-[10px] text-gray-400">{cnt}</span>}
                    </label>
                  )
                })}
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
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="이름·부서·날짜 검색"
            className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-300 w-44" />
        </div>

        <span className="text-[11px] text-gray-400 ml-auto">{tabFilteredRecords.length}건</span>
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 min-h-0 overflow-auto">
        {view === 'grid' && (
          <div className="px-6 pb-6 pt-3">
            <EmployeeCalendarGrid
              employees={searchFilteredEmployees}
              records={scopedRecords}
              dates={gridDates}
              onNameClick={() => {}}
              onCellClick={() => {}}
              approvedKeys={approvedKeys}
              topRiskIds={new Set()}
              riskMode={false}
              riskThresholds={HR_THRESHOLDS}
              showExactTime={false}
              companyHolidays={companyHolidays}
            />
          </div>
        )}

        {view === 'table' && (
          <div className="px-6 pb-6 pt-3">
            <AttendanceResultTable
              records={tabFilteredRecords}
              employees={employees}
              columnVisibility={tableColVisibility}
              onColumnVisibilityChange={() => {}}
              onRowClick={() => {}}
              onNameClick={() => {}}
              noteMap={new Map()}
              onNoteChange={() => {}}
              otExemptIds={otExemptSet}
            />
          </div>
        )}
      </div>

      {/* ── Dept comparison floating chart ── */}
      <DeptComparisonChart
        metrics={activeMetrics}
        selectedBUs={selectedBUs}
        expanded={chartExpanded}
        onToggle={() => setChartExpanded(v => !v)}
        onClose={() => setSelectedBUs([])}
      />
    </div>
  )
}
