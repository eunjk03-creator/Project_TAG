'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { usePolicy } from '@/context/PolicyContext'
import { EmployeeCalendarGrid } from '@/components/admin/EmployeeCalendarGrid'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange, DEFAULT_RANGE } from '@/context/DateRangeContext'
import { exportXlsx } from '@/utils/exportCsv'
import { DailyDetailModal } from '@/components/admin/DailyDetailModal'
import type { SavePayload } from '@/components/admin/DailyDetailModal'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import { MetricDeepDive } from '@/components/admin/MetricDeepDive'
import type { Section } from '@/components/admin/MetricDeepDive'
import { DeptComparisonChart } from '@/components/admin/DeptComparisonChart'
import { CsvUploader } from '@/components/admin/CsvUploader'
import { AttendanceResultTable } from '@/components/admin/AttendanceResultTable'
import {
  computeWorkA, computeWorkB, computeBreakH, computeFinalWork, computeStatusN,
} from '@/utils/attendanceCalc'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'
import { HR_THRESHOLDS, EXEC_THRESHOLDS } from '@/types/tag'
import type { RiskView, ProcessedRecord as PR } from '@/types/tag'

const ANOMALY_STATUSES = new Set(['지각', '조기퇴근', '지각+조기퇴근', '미태깅', '이상치'])

const ANOM_LABEL: Record<string, string> = {
  '지각':          '지각',
  '조기퇴근':      '조기퇴근',
  '지각+조기퇴근': '지각+조기퇴근',
  '미태깅':        '미태깅',
  '이상치':        '이상치',
  '근무시간 미달': '근무시간 미달',
}

const ANOM_COLOR: Record<string, string> = {
  '지각':          'text-amber-600  bg-amber-50  border-amber-200',
  '조기퇴근':      'text-blue-600   bg-blue-50   border-blue-200',
  '지각+조기퇴근': 'text-orange-600 bg-orange-50 border-orange-200',
  '미태깅':        'text-red-600    bg-red-50    border-red-200',
  '이상치':        'text-purple-600 bg-purple-50 border-purple-200',
  '근무시간 미달': 'text-red-600    bg-red-50    border-red-200',
}

const DAY_ALIASES: Record<string, string> = {
  '월요일': '월', '화요일': '화', '수요일': '수', '목요일': '목',
  '금요일': '금', '토요일': '토', '일요일': '일',
}


// ── Cell badge styles ─────────────────────────────────────────────────────
const BADGE = {
  blue:   'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50   text-blue-700   border border-blue-200',
  amber:  'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50  text-amber-700  border border-amber-200',
  orange: 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200',
  red:    'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-50    text-red-700    border border-red-200',
  purple: 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200',
  green:  'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-50  text-green-700  border border-green-200',
} as const

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
  const { openDrawer, exceptions, excludeFromOtIds, employeeAttrMap, exceptionRules } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const { recordOverrides, setRecordOverrides, resolutions, setResolutions, saveOverride } = useAttendanceData()
  const { employees: baseEmployees, rawRecords: baseRecords, isLiveData } = useAttendanceSource()
  const { slackNoteMap } = useSlack()

  const [isMounted,           setIsMounted]           = useState(false)
  const [noteMap,             setNoteMap]             = useState<Map<string, string>>(new Map())
  const [view,                setView]                = useState<View>('grid')
  const [search,              setSearch]              = useState('')
  const [modalCell,           setModalCell]           = useState<{ employeeId: string; date: string } | null>(null)
  const [openSections,        setOpenSections]        = useState<Set<Section>>(new Set())
  const [selectedBUs,         setSelectedBUs]         = useState<string[]>([])
  const [selectedRank,        setSelectedRank]        = useState<string | null>(null)
  const [gridFading,  setGridFading]  = useState(false)
  const [riskView,    setRiskView]    = useState<RiskView>('hr')
  const [activeTab,     setActiveTab]     = useState<'all' | 'employee' | 'leader'>('all')
  const [chartExpanded, setChartExpanded] = useState(true)
  const [showExactTime, setShowExactTime] = useState(false)
  const [tableColVisibility, setTableColVisibility] = useState<Record<string, boolean>>({
    normalTags:    true,
    anomalyTags:   true,
    leaveSource:   true,
    gasWorkAMins:  true,
    breakH:        true,
    gasWorkBMins:  true,
    payrollOtH:    true,
    payrollNightH: true,
    erpOtApplied:  true,
  })
  const [selectedDivisions,  setSelectedDivisions]  = useState<string[]>([])
  const [selectedTeams,      setSelectedTeams]      = useState<string[]>([])
  const [selectedStatuses,   setSelectedStatuses]   = useState<string[]>([])
  const [divisionOpen,       setDivisionOpen]       = useState(false)
  const [teamOpen,           setTeamOpen]           = useState(false)
  const [statusOpen,         setStatusOpen]         = useState(false)
  const gridRef        = useRef<HTMLDivElement>(null)
  const divDropRef     = useRef<HTMLDivElement>(null)
  const teamDropRef    = useRef<HTMLDivElement>(null)
  const statusDropRef  = useRef<HTMLDivElement>(null)

  const riskThresholds = riskView === 'hr' ? HR_THRESHOLDS : EXEC_THRESHOLDS

  useEffect(() => { setIsMounted(true) }, [])

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

  // Close multi-select dropdowns on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (divisionOpen && divDropRef.current && !divDropRef.current.contains(e.target as Node))
        setDivisionOpen(false)
      if (teamOpen && teamDropRef.current && !teamDropRef.current.contains(e.target as Node))
        setTeamOpen(false)
      if (statusOpen && statusDropRef.current && !statusDropRef.current.contains(e.target as Node))
        setStatusOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [divisionOpen, teamOpen, statusOpen])

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

  // ── Hardcoded defaults — applied by raw masked employee ID ──────────────
  // These are always active regardless of what's configured in Settings > 예외 규칙.
  // User-configured rules take precedence (merged OVER these defaults).
  const DEFAULT_GLOBAL_EXCLUSIONS = new Set([
    'E22100401','E22082202','E24010202','E23080702','E24031802',
    'E22061503','E24031806','E24010203','E18090302','E24111802','E24100705',
  ])
  const DEFAULT_FIXED_A  = new Set(['E25122301'])
  const DEFAULT_FIXED_B  = new Set(['E26030501','E24011001'])
  const DEFAULT_PREGNANT = new Set(['E25060901','E22080101','E25060902'])
  // Late grace extended to 10:00 — "지각" only triggers after 10:00 for these employees
  const DEFAULT_TEN_AM_STARTERS = new Set([
    'E25081103','E25120104','E26010511','E25021702',
    'E25011501','E22121901','E25110301',
  ])

  // Remap exception-rule keys from stale/mock IDs to current live composite keys.
  // Rules added before a CSV upload store mock IDs (e.g. "E1111111"); this bridges
  // them to the actual composite keys used by rawRecords (e.g. "E250**1501_김희").
  const { finalAttrMap, remappedExcludeIds } = useMemo(() => {
    const normName = (s: string) => s.trim().replace(/\s+/g, '')
    const nameToId = new Map(baseEmployees.map(e => [normName(e.name), e.id]))
    const liveIds  = new Set(baseEmployees.map(e => e.id))

    // Build staleId → liveId mapping via name fallback
    const toLive = new Map<string, string>()
    for (const rule of exceptionRules) {
      if (liveIds.has(rule.employeeId)) {
        toLive.set(rule.employeeId, rule.employeeId)
      } else {
        const liveId = nameToId.get(normName(rule.employeeName))
        if (liveId) toLive.set(rule.employeeId, liveId)
      }
    }

    const remappedAttr = new Map<string, EmployeeAttributeOverrides>()

    // 1. Apply hardcoded defaults first (lowest priority)
    for (const emp of baseEmployees) {
      const rawId = emp.rawId ?? emp.id.split('_')[0]
      let def: EmployeeAttributeOverrides | null = null
      if (DEFAULT_GLOBAL_EXCLUSIONS.has(rawId))   def = { isGlobalExclusion: true }
      else if (DEFAULT_FIXED_A.has(rawId))         def = { isFixedScheduleA: true }
      else if (DEFAULT_FIXED_B.has(rawId))         def = { isFixedScheduleB: true }
      else if (DEFAULT_PREGNANT.has(rawId))        def = { isPregnantReduced: true }
      else if (DEFAULT_TEN_AM_STARTERS.has(rawId)) def = { isTenAMStarter: true }
      if (def) remappedAttr.set(emp.id, def)
    }

    // 2. Merge user-configured rules on top (higher priority — overrides defaults)
    for (const [staleId, attrs] of employeeAttrMap) {
      const liveId = toLive.get(staleId) ?? staleId
      remappedAttr.set(liveId, { ...(remappedAttr.get(liveId) ?? {}), ...attrs })
    }

    const remappedExclude = new Set<string>()
    for (const staleId of excludeFromOtIds) {
      remappedExclude.add(toLive.get(staleId) ?? staleId)
    }

    return { finalAttrMap: remappedAttr, remappedExcludeIds: remappedExclude }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeAttrMap, excludeFromOtIds, exceptionRules, baseEmployees])

  // Merge user-defined OT exemptions + auto-detected leaders from CSV
  const otExemptIds = useMemo(() => new Set([
    ...remappedExcludeIds,
    ...baseEmployees.filter(e => e.isLeader).map(e => e.id),
  ]), [remappedExcludeIds, baseEmployees])

  const { processed: allProcessed } = useAttendanceLogic(
    overriddenRawRecords, policy, dateRange.from, dateRange.to, otExemptIds, slackNoteMap, finalAttrMap,
  )

  const scopedRecords = useMemo(
    () => allProcessed.filter(r => scopedEmployeeIds.has(r.employeeId)),
    [allProcessed, scopedEmployeeIds],
  )

  const approvedKeys = useMemo(
    () => new Set(Object.keys(resolutions)),
    [resolutions],
  )

  // ── Management metrics ────────────────────────────────────────────────────
  const {
    bizDays,
    metrics, total,
    employeeMetrics, employeeTotal,
    leaderMetrics,   leaderTotal,
  } = useManagementMetrics(
    scopedRecords, scopedEmployees, approvedKeys,
    dateRange.from, dateRange.to, finalAttrMap,
  )

  const leaderIdSet = useMemo(() => new Set<string>(
    scopedEmployees
      .filter(e => (finalAttrMap.get(e.id)?.isLeader === true) || (e.isLeader === true))
      .map(e => e.id),
  ), [scopedEmployees, finalAttrMap])

  const activeEmployees = useMemo(() =>
    activeTab === 'all'      ? scopedEmployees :
    activeTab === 'employee' ? scopedEmployees.filter(e => !leaderIdSet.has(e.id)) :
                               scopedEmployees.filter(e => leaderIdSet.has(e.id)),
  [activeTab, scopedEmployees, leaderIdSet])

  const activeMetrics =
    activeTab === 'all'      ? metrics        :
    activeTab === 'employee' ? employeeMetrics : leaderMetrics
  const activeTotal =
    activeTab === 'all'      ? total        :
    activeTab === 'employee' ? employeeTotal : leaderTotal

  // ── Division-filtered + risk-ranked employees ────────────────────────────
  // 0 BUs → all active employees (no filter)
  // 1 BU  → that BU's employees, sorted by risk score (drill-down mode)
  // 2+ BUs → union of all selected BUs' employees, original order (comparison mode)
  const filteredRankedEmployees = useMemo(() => {
    if (selectedBUs.length === 0) return activeEmployees

    const buSet   = new Set(selectedBUs.map(b => b.trim()))
    const rankKey = selectedRank?.trim() ?? null
    let base = activeEmployees.filter(e => buSet.has(e.division.trim()))
    if (rankKey) base = base.filter(e => e.jobTitle?.trim() === rankKey)

    if (selectedBUs.length === 1) {
      // Single BU: risk-rank for drill-down
      const recsByEmp = new Map<string, ProcessedRecord[]>()
      for (const r of scopedRecords) {
        const bucket = recsByEmp.get(r.employeeId)
        if (bucket) bucket.push(r)
        else recsByEmp.set(r.employeeId, [r])
      }
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
    }

    // Multiple BUs: filter only, no risk ranking
    return base
  }, [activeEmployees, selectedBUs, selectedRank, scopedRecords, approvedKeys])

  const topRiskIds = useMemo(
    () => new Set(selectedBUs.length === 1 ? filteredRankedEmployees.slice(0, 3).map(e => e.id) : []),
    [selectedBUs, filteredRankedEmployees],
  )

  const divisionList = useMemo(
    () => [...new Set(baseEmployees.map(e => e.division).filter(Boolean))].sort(),
    [baseEmployees],
  )

  const teamList = useMemo(() => {
    const src = selectedDivisions.length > 0
      ? baseEmployees.filter(e => selectedDivisions.includes(e.division))
      : baseEmployees
    return [...new Set(src.map(e => e.team).filter(Boolean))].sort()
  }, [baseEmployees, selectedDivisions])

  const displayStatusMap = useMemo(() => {
    const m = new Map<string, string | null>()
    const empById = new Map(baseEmployees.map(e => [e.id, e]))
    for (const r of scopedRecords) {
      const emp        = empById.get(r.employeeId)
      const rawId      = emp?.rawId ?? r.employeeId.split('_')[0]
      const leaveAmt   = r.erpLeaveAmount ?? 0
      const workA      = computeWorkA(r.effectiveClockIn ?? r.clockIn, r.clockOut)
      const workB      = computeWorkB(workA, leaveAmt, r.isUnpaidLeave ?? false)
      const breakH_    = computeBreakH(workB)
      const finalWorkH = computeFinalWork(workB, breakH_)
      const ds: string | null =
        r.finalStatus === '외근'     ? '외근'     :
        r.finalStatus === '휴일근무' ? '휴일근무' :
        computeStatusN({
          dayType: r.dayType, clockIn: r.clockIn, clockOut: r.clockOut,
          leaveType: r.leaveType ?? null, erpLeaveAmount: r.erpLeaveAmount,
          finalWorkH, rawId,
        })
      m.set(`${r.employeeId}_${r.date}`, ds)
    }
    return m
  }, [scopedRecords, baseEmployees])

  const stats = useMemo(() => {
    let totalH = 0, otH = 0
    const ngH = scopedRecords.reduce((s, r) => s + r.nightHours, 0)
    for (const r of scopedRecords) {
      if (r.dayType !== 'WEEKDAY') continue
      const leaveAmt   = r.erpLeaveAmount ?? 0
      const workA      = computeWorkA(r.effectiveClockIn ?? r.clockIn, r.clockOut)
      const workB      = computeWorkB(workA, leaveAmt, r.isUnpaidLeave ?? false)
      const breakH_    = computeBreakH(workB)
      const finalWorkH = computeFinalWork(workB, breakH_)
      totalH += finalWorkH
      otH    += Math.max(0, finalWorkH - 8.0)
    }
    return {
      totalHours:       totalH,
      rawTotalHours:    totalH,   // new formula has no 30-min truncation
      overtimeHours:    otH,
      rawOvertimeHours: otH,
      nightHours:       ngH,
      anomalies:        scopedRecords.filter(r => {
        if (approvedKeys.has(`${r.employeeId}_${r.date}`)) return false
        const flag = r.flag
        return flag !== null && flag !== undefined
      }).length,
    }
  }, [scopedRecords, approvedKeys, displayStatusMap])

  // 복합 플래그(중복) 건수: LATE_AND_EARLY_DEPARTURE, LATE_AND_ANOMALY
  const compoundAnomalyCount = useMemo(() => {
    return scopedRecords.filter(r => {
      if (approvedKeys.has(`${r.employeeId}_${r.date}`)) return false
      return r.flag === 'LATE_AND_EARLY_DEPARTURE' || r.flag === 'LATE_AND_ANOMALY'
    }).length
  }, [scopedRecords, approvedKeys])

  // Per-status counts for dropdown badges
  const anomalyCounts = useMemo(() => {
    let normal = 0, abnormal = 0
    let regular = 0, overtime = 0, offsite = 0, holidayWork = 0
    let late = 0, early = 0, shortWork = 0, missing = 0

    for (const r of scopedRecords) {
      if (approvedKeys.has(`${r.employeeId}_${r.date}`)) continue
      if (r.dayType !== 'WEEKDAY' && r.finalStatus !== '휴일근무') continue  // 주말/공휴일 집계 제외

      const flag = r.flag

      // 비정상 태그
      const hasAnomaly = flag !== null
      if (hasAnomaly) {
        abnormal++
        if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') missing++
        if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') late++
        if (flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') early++
        if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY') shortWork++
      } else {
        normal++
      }

      // 정상 태그 (비정상 여부와 무관하게 집계)
      if (r.finalStatus === '외근')     offsite++
      if (r.finalStatus === '휴일근무') holidayWork++
      if (r.overtimeHours > 0)         overtime++
      const isLeaveDay = !!(r.leaveType && ['연차','오전반차','오후반차','오전반반차','오후반반차','출장','재택근무'].includes(r.leaveType))
      if (!r.finalStatus?.match(/외근|휴일근무/) && r.overtimeHours === 0 && !isLeaveDay && !hasAnomaly) regular++
    }
    return { normal, abnormal, regular, overtime, offsite, holidayWork, late, early, shortWork, missing }
  }, [scopedRecords, approvedKeys])

  // ── Filters ───────────────────────────────────────────────────────────────
  const searchQuery = DAY_ALIASES[search.trim().toLowerCase()] ?? search.trim().toLowerCase()

  const isAnyFilterActive = !!search || selectedDivisions.length > 0 || selectedTeams.length > 0 || selectedStatuses.length > 0 || selectedBUs.length > 0

  function clearAllFilters() {
    setSearch('')
    setSelectedDivisions([])
    setSelectedTeams([])
    setSelectedStatuses([])
  }

  function matchesStatus(r: PR, status: string): boolean {
    // 비정상 태그 계산
    const flag = r.flag
    const anomalyTags: string[] = []
    if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') anomalyTags.push('미태깅')
    if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('지각')
    if (flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') anomalyTags.push('조기퇴근')
    if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('근무시간 미달')
    const isNormal = anomalyTags.length === 0

    // 정상 태그 계산
    const normalTags: string[] = []
    if (r.finalStatus === '외근') normalTags.push('외근')
    if (r.finalStatus === '휴일근무') normalTags.push('휴일근로')
    if (r.overtimeHours > 0) normalTags.push('연장근로')
    const isLeaveDay = !!(r.leaveType && ['연차','오전반차','오후반차','오전반반차','오후반반차','출장','재택근무'].includes(r.leaveType))
    if (normalTags.length === 0 && !isLeaveDay && r.dayType === 'WEEKDAY') normalTags.push('일반')

    switch (status) {
      case '정상':         return isNormal
      case '비정상':       return !isNormal
      case '일반':         return isNormal && normalTags.includes('일반')
      case '연장근로':     return isNormal && normalTags.includes('연장근로')
      case '외근':         return isNormal && normalTags.includes('외근')
      case '휴일근로':     return isNormal && normalTags.includes('휴일근로')
      case '지각':         return anomalyTags.includes('지각')
      case '조기퇴근':     return anomalyTags.includes('조기퇴근')
      case '근무시간 미달': return anomalyTags.includes('근무시간 미달')
      case '미태깅':       return anomalyTags.includes('미태깅')
      // 레거시 지원
      case '연차':
        if (r.erpLeaveAmount != null && r.erpLeaveAmount > 0) return r.erpLeaveAmount >= 1.0
        return r.leaveType === '연차' || r.finalStatus === '연차'
      case '반차':
        if (r.erpLeaveAmount != null && r.erpLeaveAmount > 0) return r.erpLeaveAmount > 0.25 && r.erpLeaveAmount < 1.0
        return ['오전반차', '오후반차'].includes(r.finalStatus) || (r.leaveType?.includes('반차') && !r.leaveType.includes('반반차')) === true
      case '반반차':
        if (r.erpLeaveAmount != null && r.erpLeaveAmount > 0) return r.erpLeaveAmount <= 0.25
        return ['오전반반차', '오후반반차'].includes(r.leaveType ?? '')
      default: return false
    }
  }

  const filteredRecords = useMemo(() => {
    return scopedRecords.filter(r => {
      const emp   = baseEmployees.find(e => e.id === r.employeeId)
      const rawId = emp?.rawId ?? r.employeeId.split('_')[0]

      if (searchQuery) {
        const hit = (
          (emp?.name     ?? '').toLowerCase().includes(searchQuery) ||
          (emp?.division ?? '').toLowerCase().includes(searchQuery) ||
          (emp?.team     ?? '').toLowerCase().includes(searchQuery) ||
          rawId.toLowerCase().includes(searchQuery) ||
          (r.dayLabel    ?? '').toLowerCase().includes(searchQuery) ||
          r.date.includes(searchQuery)
        )
        if (!hit) return false
      }

      // Division: OR within category
      if (selectedDivisions.length > 0 && !selectedDivisions.includes(emp?.division ?? '')) return false
      // Team: OR within category
      if (selectedTeams.length > 0 && !selectedTeams.includes(emp?.team ?? '')) return false

      // Status/anomaly: OR within category
      if (selectedStatuses.length > 0 && !selectedStatuses.some(s => matchesStatus(r, s))) return false

      return true
    })
  }, [scopedRecords, searchQuery, selectedDivisions, selectedStatuses, baseEmployees])

  // Direct employeeId → division.trim() map used to filter individual attendance rows.
  const empDivisionMap = useMemo(
    () => new Map<string, string>(baseEmployees.map(e => [e.id, e.division.trim()])),
    [baseEmployees],
  )

  // Tab-scoped + chart-BU-scoped records.
  // Records are filtered twice — once by the active tab (employee/leader/all)
  // and once directly by comparing each row's employee division to selectedBUs.
  const tabFilteredRecords = useMemo(() => {
    const hasBUFilter  = selectedBUs.length > 0
    const hasTabFilter = activeTab !== 'all'

    if (!hasBUFilter && !hasTabFilter) return filteredRecords

    const tabEmpIds = hasTabFilter
      ? new Set(activeEmployees.map(e => e.id))
      : null

    const selectedBUSet = hasBUFilter
      ? new Set(selectedBUs.map(b => b.trim()))
      : null

    return filteredRecords.filter(r => {
      // Tab gate
      if (tabEmpIds && !tabEmpIds.has(r.employeeId)) return false
      // Division gate — look up this record's employee division directly
      if (selectedBUSet) {
        const div = empDivisionMap.get(r.employeeId) ?? ''
        if (!selectedBUSet.has(div)) return false
      }
      return true
    })
  }, [filteredRecords, activeTab, activeEmployees, selectedBUs, empDivisionMap])

  // Grid-view: filter displayed employees by search + division
  const searchFilteredEmployees = useMemo(() => {
    let result = filteredRankedEmployees
    if (searchQuery) {
      result = result.filter(e => {
        const rawId = e.rawId ?? e.id.split('_')[0]
        return (
          e.name.toLowerCase().includes(searchQuery) ||
          (e.division ?? '').toLowerCase().includes(searchQuery) ||
          (e.team     ?? '').toLowerCase().includes(searchQuery) ||
          rawId.toLowerCase().includes(searchQuery)
        )
      })
    }
    if (selectedDivisions.length > 0) {
      result = result.filter(e => selectedDivisions.includes(e.division ?? ''))
    }
    return result
  }, [filteredRankedEmployees, searchQuery, selectedDivisions])

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
    // DB에 영구 저장 (새로고침 후에도 유지)
    saveOverride(modalCell.employeeId, modalCell.date)
    setModalCell(null)
  }

  // ── Notes: load & save ────────────────────────────────────────────────────
  // 메모 전체 로드 (마운트 시 1회 + 데이터 소스 변경 시)
  useEffect(() => {
    fetch('/api/attendance-notes')
      .then(res => res.json())
      .then((rows: { employeeId: string; workDate: string; note: string }[]) => {
        const next = new Map<string, string>()
        for (const { employeeId, workDate, note } of rows) {
          next.set(`${employeeId}_${workDate}`, note)
        }
        setNoteMap(next)
      })
      .catch(() => {})
  }, [isLiveData])

  function handleNoteChange(employeeId: string, date: string, note: string) {
    const key = `${employeeId}_${date}`
    setNoteMap(prev => new Map(prev).set(key, note))
    fetch('/api/attendance-notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, workDate: date, note }),
    }).catch(() => {})
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function handleExport() {
    const fmt6 = (d: string) => d.replace(/-/g, '').slice(2)  // "2026-05-11" → "260511"
    const filename = `근태결과_${fmt6(dateRange.from)}-${fmt6(dateRange.to)}.xlsx`

    // Mirror exactly what the table shows: false = hidden, absent = visible
    const ALL_DETAIL_IDS = [
      'division', 'empId', 'name', 'date', 'clockIn', 'clockOut',
      'leaveAmt', 'leaveType', 'leaveSource', 'breakH',
      'finalWorkH', 'attendanceStatus', 'normalTags', 'anomalyTags', 'systemOtH',
      'payrollOtH', 'payrollNightH', 'erpOtApplied',
    ]
    const visibleColIds = new Set(ALL_DETAIL_IDS.filter(id => tableColVisibility[id] !== false))

    exportXlsx(tabFilteredRecords, baseEmployees, filename, visibleColIds)
  }

  function toggleSection(s: Section) {
    setOpenSections(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  // ── KPI card derived values ───────────────────────────────────────────────
  const deptLabel = selectedBUs.length === 1
    ? selectedBUs[0]
    : selectedBUs.length > 1
      ? `${selectedBUs.length}개 본부`
      : '전체'

  const cardStats = useMemo(() => {
    if (activeMetrics.length === 0) return null
    const n      = activeTotal.headcount || 1
    const totalH = activeTotal.totalHours
    const otH    = activeTotal.otHours
    const topTotal     = activeMetrics.reduce((a, b) => a.totalHours > b.totalHours ? a : b)
    const topOt        = activeMetrics.reduce((a, b) => a.otHours    > b.otHours    ? a : b)
    const topAnomalies = activeMetrics.reduce((a, b) => a.anomalies  > b.anomalies  ? a : b)
    return {
      avgTotal: totalH / n,
      avgOt:    otH    / n,
      otRatio:  totalH > 0 ? (otH / totalH) * 100 : 0,
      topTotal, topOt, topAnomalies,
    }
  }, [activeMetrics, activeTotal])

  if (!isMounted) return null

  return (
    <div className="min-w-0 flex flex-col">

      {/* ── Top bar ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3 shrink-0">
        <div className="shrink-0">
          <h1 className="text-base font-bold text-gray-900">근태 현황</h1>
          <p className="text-xs text-gray-400">
            {activeTab === 'all' ? '전체' : activeTab === 'employee' ? '사원' : '직책자'} · {activeTotal.headcount}명
          </p>
        </div>

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

        </div>
      </div>

      {/* ── CSV / Excel uploader ── */}
      <CsvUploader />

      {/* ── All / Employee / Leader 3-way tab bar ── */}
      <div className="px-6 py-2.5 bg-white border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit text-sm">
          {([
            { key: 'all'      as const, label: '전체 근태 현황',   count: total.headcount         },
            { key: 'employee' as const, label: '사원 근태 현황',   count: employeeTotal.headcount },
            { key: 'leader'   as const, label: '직책자 근태 현황', count: leaderTotal.headcount   },
          ]).map(({ key, label, count }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-4 py-1.5 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}>
              {label}
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                activeTab === key ? 'bg-blue-50 text-blue-600' : 'bg-gray-200 text-gray-500'
              }`}>
                {count}
              </span>
            </button>
          ))}
        </div>
      </div>

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
              <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{fmt(activeTotal.totalHours)}</p>
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
              <p className="text-2xl font-bold text-amber-500 mt-1 tabular-nums">{fmt(activeTotal.otHours)}</p>
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
                  {compoundAnomalyCount > 0 && (
                    <span className="ml-1.5 text-orange-500 font-medium tabular-nums">
                      · 중복 {compoundAnomalyCount}건
                    </span>
                  )}
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

        {/* ── 통합검색 ── */}
        <div className="px-6 pb-3 shrink-0">
          <div className="relative max-w-sm">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="사번 또는 이름으로 검색..."
              className="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg bg-white
                focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400
                placeholder-gray-300 shadow-sm transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center
                  text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-full transition-colors text-xs">
                ✕
              </button>
            )}
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
              metrics={activeMetrics}
              total={activeTotal}
              processedRecords={scopedRecords}
              employees={scopedEmployees}
              approvedKeys={approvedKeys}
              riskThresholds={riskThresholds}
              selectedBUs={selectedBUs}
              onBUsChange={setSelectedBUs}
            />
          </div>
        )}

        {/* ── Table-only filters ── */}
        {view === 'table' && <>

        {/* ── Search + multi-select filters ── */}
        <div className="px-6 pb-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">

            {/* Search */}
            <div className="relative w-52">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="이름, 소속, 사번..."
                className="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg bg-white
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400
                  placeholder-gray-300 shadow-sm transition-colors"
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center
                    text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-full transition-colors text-xs">
                  ✕
                </button>
              )}
            </div>

            {/* Division multi-select */}
            <div className="relative" ref={divDropRef}>
              <button
                onClick={() => { setDivisionOpen(p => !p); setStatusOpen(false) }}
                className={`flex items-center gap-1.5 py-2 pl-3 pr-2.5 text-sm border rounded-lg bg-white
                  shadow-sm transition-colors cursor-pointer focus:outline-none
                  ${selectedDivisions.length > 0 ? 'border-blue-400 text-blue-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'}`}
              >
                <span>
                  {selectedDivisions.length === 0 ? '본부 전체'
                    : selectedDivisions.length === 1 ? selectedDivisions[0]
                    : `${selectedDivisions[0]} 외 ${selectedDivisions.length - 1}`}
                </span>
                {selectedDivisions.length > 0 && (
                  <span className="ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center
                    text-[10px] font-bold bg-blue-600 text-white rounded-full px-1">
                    {selectedDivisions.length}
                  </span>
                )}
                <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${divisionOpen ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {divisionOpen && (
                <div className="absolute top-full mt-1 left-0 z-30 bg-white border border-gray-200
                  rounded-lg shadow-lg py-1 min-w-[160px] max-h-[260px] overflow-y-auto">
                  {divisionList.map(d => (
                    <label key={d}
                      className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox"
                        checked={selectedDivisions.includes(d)}
                        onChange={() => setSelectedDivisions(prev =>
                          prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
                        )}
                        className="accent-blue-600 w-3.5 h-3.5 shrink-0 cursor-pointer"
                      />
                      <span className="text-sm text-gray-700">{d}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Team multi-select */}
            <div className="relative" ref={teamDropRef}>
              <button
                onClick={() => { setTeamOpen(p => !p); setDivisionOpen(false); setStatusOpen(false) }}
                className={`flex items-center gap-1.5 py-2 pl-3 pr-2.5 text-sm border rounded-lg bg-white
                  shadow-sm transition-colors cursor-pointer focus:outline-none
                  ${selectedTeams.length > 0 ? 'border-blue-400 text-blue-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'}`}
              >
                <span>
                  {selectedTeams.length === 0 ? '팀 전체'
                    : selectedTeams.length === 1 ? selectedTeams[0]
                    : `${selectedTeams[0]} 외 ${selectedTeams.length - 1}`}
                </span>
                {selectedTeams.length > 0 && (
                  <span className="ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center
                    text-[10px] font-bold bg-blue-600 text-white rounded-full px-1">
                    {selectedTeams.length}
                  </span>
                )}
                <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${teamOpen ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {teamOpen && (
                <div className="absolute top-full mt-1 left-0 z-30 bg-white border border-gray-200
                  rounded-lg shadow-lg py-1 min-w-[160px] max-h-[260px] overflow-y-auto">
                  {teamList.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400">본부를 먼저 선택하세요</p>
                  ) : teamList.map(t => (
                    <label key={t}
                      className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox"
                        checked={selectedTeams.includes(t)}
                        onChange={() => setSelectedTeams(prev =>
                          prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]
                        )}
                        className="accent-blue-600 w-3.5 h-3.5 shrink-0 cursor-pointer"
                      />
                      <span className="text-sm text-gray-700">{t}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Status + anomaly multi-select */}
            <div className="relative" ref={statusDropRef}>
              <button
                onClick={() => { setStatusOpen(p => !p); setDivisionOpen(false) }}
                className={`flex items-center gap-1.5 py-2 pl-3 pr-2.5 text-sm border rounded-lg bg-white
                  shadow-sm transition-colors cursor-pointer focus:outline-none
                  ${selectedStatuses.length > 0 ? 'border-blue-400 text-blue-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'}`}
              >
                <span>
                  {selectedStatuses.length === 0 ? '상태 전체'
                    : selectedStatuses.length === 1 ? selectedStatuses[0]
                    : `${selectedStatuses[0]} 외 ${selectedStatuses.length - 1}`}
                </span>
                {selectedStatuses.length > 0 && (
                  <span className="ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center
                    text-[10px] font-bold bg-blue-600 text-white rounded-full px-1">
                    {selectedStatuses.length}
                  </span>
                )}
                <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${statusOpen ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {statusOpen && (
                <div className="absolute top-full mt-1 left-0 z-30 bg-white border border-gray-200
                  rounded-lg shadow-lg py-1 min-w-[180px]">
                  {/* 정상/비정상 그룹 */}
                  <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                    근태상태
                  </p>
                  {([
                    { value: '정상',  count: anomalyCounts.normal   },
                    { value: '비정상', count: anomalyCounts.abnormal },
                  ] as { value: string; count: number }[]).map(({ value, count }) => (
                    <label key={value}
                      className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox"
                        checked={selectedStatuses.includes(value)}
                        onChange={() => setSelectedStatuses(prev =>
                          prev.includes(value) ? prev.filter(x => x !== value) : [...prev, value]
                        )}
                        className="accent-blue-600 w-3.5 h-3.5 shrink-0 cursor-pointer"
                      />
                      <span className="text-sm text-gray-700 flex-1">{value}</span>
                      {count > 0 && (
                        <span className="text-[11px] font-semibold text-gray-400 tabular-nums">({count})</span>
                      )}
                    </label>
                  ))}
                  {/* 정상 태그 그룹 */}
                  <div className="border-t border-gray-100 mt-1">
                    <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                      정상 정보
                    </p>
                    {([
                      { value: '일반',   count: anomalyCounts.regular     },
                      { value: '연장근로', count: anomalyCounts.overtime   },
                      { value: '외근',   count: anomalyCounts.offsite     },
                      { value: '휴일근로', count: anomalyCounts.holidayWork },
                    ] as { value: string; count: number }[]).map(({ value, count }) => (
                      <label key={value}
                        className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                        <input type="checkbox"
                          checked={selectedStatuses.includes(value)}
                          onChange={() => setSelectedStatuses(prev =>
                            prev.includes(value) ? prev.filter(x => x !== value) : [...prev, value]
                          )}
                          className="accent-blue-600 w-3.5 h-3.5 shrink-0 cursor-pointer"
                        />
                        <span className="text-sm text-gray-700 flex-1">{value}</span>
                        {count > 0 && (
                          <span className="text-[11px] font-semibold text-blue-500 tabular-nums">({count})</span>
                        )}
                      </label>
                    ))}
                  </div>
                  {/* 비정상 태그 그룹 */}
                  <div className="border-t border-gray-100 mt-1">
                    <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                      비정상 정보
                    </p>
                    {([
                      { value: '지각',          count: anomalyCounts.late      },
                      { value: '조기퇴근',      count: anomalyCounts.early     },
                      { value: '근무시간 미달', count: anomalyCounts.shortWork  },
                      { value: '미태깅',        count: anomalyCounts.missing    },
                    ] as { value: string; count: number }[]).map(({ value, count }) => (
                      <label key={value}
                        className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                        <input type="checkbox"
                          checked={selectedStatuses.includes(value)}
                          onChange={() => setSelectedStatuses(prev =>
                            prev.includes(value) ? prev.filter(x => x !== value) : [...prev, value]
                          )}
                          className="accent-blue-600 w-3.5 h-3.5 shrink-0 cursor-pointer"
                        />
                        <span className="text-sm text-gray-700 flex-1">{value}</span>
                        {count > 0 && (
                          <span className="text-[11px] font-semibold text-red-500 tabular-nums">
                            ({count})
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Reset all */}
            {isAnyFilterActive && (
              <button onClick={clearAllFilters}
                className="flex items-center gap-1 px-3 py-2 text-xs text-gray-500 border border-gray-200
                  rounded-lg bg-white hover:bg-gray-50 hover:text-gray-700 shadow-sm transition-colors">
                <span>↺</span> 초기화
              </button>
            )}

            {/* Export — pushed to far right */}
            <button onClick={handleExport}
              className="ml-auto flex items-center gap-1.5 px-3 py-2 text-xs font-medium
                text-blue-600 border border-blue-300 rounded-lg bg-white
                hover:bg-blue-50 active:scale-95 transition-all shadow-sm">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              엑셀 내보내기
              {isAnyFilterActive && (
                <span className="ml-1 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold text-[10px]">
                  {tabFilteredRecords.length}건
                </span>
              )}
            </button>
          </div>

          {isAnyFilterActive && (
            <p className="mt-1.5 text-[11px] text-gray-400">
              {tabFilteredRecords.length}건 표시
            </p>
          )}
        </div>

        </>} {/* end table-only filters */}

        {/* ── Grid view ── */}
        {view === 'grid' && (
          <div
            ref={gridRef}
            className={`shrink-0 max-w-full flex flex-col px-6 pb-6 transition-opacity duration-300 ease-in-out ${gridFading ? 'opacity-0' : 'opacity-100'}`}
            style={{ minHeight: 'calc(100vh - 340px)' }}
          >
            <EmployeeCalendarGrid
              key={selectedBUs.join(',')}
              employees={searchFilteredEmployees}
              records={scopedRecords}
              dates={gridDates}
              onNameClick={openDrawer}
              onCellClick={handleCellClick}
              approvedKeys={approvedKeys}
              topRiskIds={topRiskIds}
              riskMode={selectedBUs.length === 1}
              riskThresholds={riskThresholds}
              showExactTime={showExactTime}
              companyHolidays={policy.companyHolidays}
            />
          </div>
        )}

        {/* ── Table view ── */}
        {view === 'table' && (
          <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 space-y-4">
            <AttendanceResultTable
              records={tabFilteredRecords}
              employees={baseEmployees}
              columnVisibility={tableColVisibility}
              onColumnVisibilityChange={setTableColVisibility}
              onRowClick={handleCellClick}
              onNameClick={openDrawer}
              noteMap={noteMap}
              onNoteChange={handleNoteChange}
              otExemptIds={otExemptIds}
            />

            {stats.anomalies > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-3">전체 이상치 현황</h2>
                <div className="flex flex-wrap gap-3">
                  {([
                    { key: '지각',          count: anomalyCounts.late      },
                    { key: '조기퇴근',      count: anomalyCounts.early     },
                    { key: '근무시간 미달', count: anomalyCounts.shortWork  },
                    { key: '미태깅',        count: anomalyCounts.missing   },
                  ] as { key: string; count: number }[]).filter(({ count }) => count > 0).map(({ key, count }) => (
                    <div key={key}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${ANOM_COLOR[key]}`}>
                      {ANOM_LABEL[key]}
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
          initialDecision={resolutions[`${modalCell.employeeId}_${modalCell.date}`]?.reasonLabel}
          initialErpLeaveType={
            recordOverrides[`${modalCell.employeeId}_${modalCell.date}`]?.erpLeaveType
            ?? (
              // Only expose leaveType to the ERP section when ERP actually filed it.
              // If notes contain 'ERP 미신청', leaveType was inferred from Slack — show nothing.
              modalRecord.verificationNote?.some(n => n.includes('ERP 미신청'))
                ? undefined
                : modalRecord.leaveType ?? undefined
            )
          }
          showExactTime={showExactTime}
          onClose={() => setModalCell(null)}
          onSave={handleModalSave}
        />
      )}

      {/* ── Floating multi-BU comparison panel (≥ 2 selected) ── */}
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
