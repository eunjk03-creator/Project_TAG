'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { processRecord } from '@/lib/processRecord'
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
import { CsvUploader } from '@/components/admin/CsvUploader'
import { ManualEntryModal } from '@/components/admin/ManualEntryModal'
import type { ManualEntryPayload } from '@/components/admin/ManualEntryModal'
import { AttendanceResultTable } from '@/components/admin/AttendanceResultTable'
import { SummaryTab }            from '@/components/admin/SummaryTab'
import { AllowanceTab }          from '@/components/admin/AllowanceTab'
import {
  computeWorkA, computeWorkB, computeBreakH, computeFinalWork, computeStatusN,
} from '@/utils/attendanceCalc'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'
import { HR_THRESHOLDS, EXEC_THRESHOLDS } from '@/types/tag'
import type { RiskView, ProcessedRecord as PR } from '@/types/tag'
import { sortByDivisionOrder } from '@/data/orgChart'

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

type View = 'grid' | 'table' | 'summary' | 'allowance'

export default function AdminDashboard() {
  const { policy } = usePolicy()
  const { openDrawer, exceptions, excludeFromOtIds, employeeAttrMap, exceptionRules } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const { recordOverrides, setRecordOverrides, resolutions, setResolutions, saveOverride, deletedKeys, deleteRecord } = useAttendanceData()
  const {
    employees: baseEmployees, rawRecords: baseRecords, isLiveData,
    processedRecords: serverProcessed, isProcessing: isServerProcessing,
    recomputeProcessed,
  } = useAttendanceSource()
  const { slackNoteMap } = useSlack()

  const [isMounted,             setIsMounted]             = useState(false)
  const [manualCell,            setManualCell]            = useState<{ employeeId: string; date: string } | null>(null)
  const [tableSelectedKeys,     setTableSelectedKeys]     = useState<Set<string>>(new Set())
  const [tableViewSelected,     setTableViewSelected]     = useState(false)
  const [noteMap,             setNoteMap]             = useState<Map<string, string>>(new Map())
  const [view,                setView]                = useState<View>('grid')
  const [search,              setSearch]              = useState('')
  const [modalCell,           setModalCell]           = useState<{ employeeId: string; date: string } | null>(null)
  const [openSections,        setOpenSections]        = useState<Set<Section>>(new Set())
  const [selectedBUs,         setSelectedBUs]         = useState<string[]>([])
  const [selectedRank,        setSelectedRank]        = useState<string | null>(null)
  const [gridFading,  setGridFading]  = useState(false)
  const [gridPage,    setGridPage]    = useState(0)
  const GRID_PAGE_SIZE = 40
  const [riskView,    setRiskView]    = useState<RiskView>('hr')
  const [activeTab,     setActiveTab]     = useState<'all' | 'employee' | 'leader'>('all')
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
  const [selectedStatuses,   setSelectedStatuses]   = useState<string[]>([])
  const [gridFilterTeam,     setGridFilterTeam]     = useState<string | null>(null)
  const [gridHoursFilter,    setGridHoursFilter]    = useState<'all' | 'over52' | 'over209'>('all')
  const [gridSortKey,        setGridSortKey]        = useState<'name' | 'ot' | 'night' | 'holiday' | 'anomaly'>('name')
  const [gridSortDir,        setGridSortDir]        = useState<'asc' | 'desc' | 'none'>('none')
  const [divisionOpen,       setDivisionOpen]       = useState(false)
  const [statusOpen,         setStatusOpen]         = useState(false)
  const gridRef        = useRef<HTMLDivElement>(null)
  const divDropRef     = useRef<HTMLDivElement>(null)
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

  // Reset grid page when filters change
  useEffect(() => { setGridPage(0) }, [search, selectedDivisions, gridFilterTeam, selectedBUs, activeTab, dateRange, gridSortKey, gridSortDir])

  // Close multi-select dropdowns on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (divisionOpen && divDropRef.current && !divDropRef.current.contains(e.target as Node))
        setDivisionOpen(false)
      if (statusOpen && statusDropRef.current && !statusDropRef.current.contains(e.target as Node))
        setStatusOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [divisionOpen, statusOpen])

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
    const mapped = baseRecords.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn,
        clockOut:     ov.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      }
    })

    // Add synthetic records for manual entries (overrides with no base CAPS record)
    const baseKeys = new Set(baseRecords.map(r => `${r.employeeId}_${r.date}`))
    for (const [key, ov] of Object.entries(recordOverrides)) {
      if (baseKeys.has(key) || (!ov.clockIn && !ov.clockOut)) continue
      // key = "${employeeId}_${date}", date is always 10 chars (YYYY-MM-DD)
      const date  = key.slice(-10)
      const empId = key.slice(0, -(10 + 1))
      const dow   = new Date(date + 'T12:00').getDay()
      const isHol = (policy.companyHolidays ?? []).some(h => h.date === date)
      const dayType = isHol ? 'HOLIDAY' as const : (dow === 0 || dow === 6) ? 'WEEKEND' as const : 'WEEKDAY' as const
      const leaveTypeMap: Record<string, import('@/types/tag').ErpLeaveType> = {
        '재택근무': '재택근무', '출장': '출장',
      }
      mapped.push({
        employeeId:        empId,
        date,
        dayType,
        dayLabel:          '수기',
        clockIn:           ov.clockIn  ?? null,
        clockOut:          ov.clockOut ?? null,
        erpOtApplied:      false,
        leaveType:         ov.erpLeaveType ? (leaveTypeMap[ov.erpLeaveType] ?? null) : null,
        verificationNote:  [ov.memo ? `수기 입력: ${ov.memo}` : '수기 입력'],
      })
    }
    return mapped
  }, [recordOverrides, baseRecords, policy.companyHolidays])

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

  // 전체제외 직원 ID 집합 — 그리드·테이블에서 숨김
  const globalExclusionIds = useMemo(
    () => new Set(
      [...finalAttrMap.entries()]
        .filter(([, attrs]) => attrs.isGlobalExclusion)
        .map(([id]) => id)
    ),
    [finalAttrMap],
  )

  // Merge user-defined OT exemptions + auto-detected leaders from CSV
  const otExemptIds = useMemo(() => new Set([
    ...remappedExcludeIds,
    ...baseEmployees.filter(e => e.isLeader).map(e => e.id),
  ]), [remappedExcludeIds, baseEmployees])

  // ── Fallback: full client-side computation (used when server result not yet available) ──
  const { processed: clientProcessed } = useAttendanceLogic(
    serverProcessed ? [] : overriddenRawRecords,
    policy, dateRange.from, dateRange.to, otExemptIds, slackNoteMap, finalAttrMap,
  )

  // ── Main processed records: server-computed when available, client fallback otherwise ──
  const allProcessed = useMemo<ProcessedRecord[]>(() => {
    if (!serverProcessed) return clientProcessed

    // Fast path: date-range filter only (O(n) scan, no heavy computation)
    const dateFiltered = serverProcessed.filter(
      r => r.date >= dateRange.from && r.date <= dateRange.to,
    )

    // Apply admin overrides locally — only re-process changed records (O(k), k << n)
    if (Object.keys(recordOverrides).length === 0) return dateFiltered
    return dateFiltered.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov) return r
      return processRecord(
        {
          ...r,
          clockIn:      ov.clockIn      ?? r.clockIn,
          clockOut:     ov.clockOut     ?? r.clockOut,
          erpOtApplied: ov.erpOtApplied !== null ? (ov.erpOtApplied as boolean) : r.erpOtApplied,
        },
        policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId),
      )
    })
  }, [serverProcessed, clientProcessed, dateRange.from, dateRange.to, recordOverrides, policy, otExemptIds, slackNoteMap, finalAttrMap])

  // Build hire-date map from employee rawId (format E{YY}{MM}{DD}{SEQ} → 20YY-MM-DD).
  // Used to exclude records before an employee's hire date even when cached data predates this fix.
  const hireDateMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of baseEmployees) {
      if (!e.rawId) continue
      const m = e.rawId.match(/^E(\d{2})(\d{2})(\d{2})\d+$/)
      if (m) map.set(e.id, `20${m[1]}-${m[2]}-${m[3]}`)
    }
    return map
  }, [baseEmployees])

  const scopedRecords = useMemo(
    () => allProcessed.filter(r => {
      if (!scopedEmployeeIds.has(r.employeeId)) return false
      if (deletedKeys.has(`${r.employeeId}_${r.date}`)) return false
      const hd = hireDateMap.get(r.employeeId)
      if (hd && r.date < hd) return false
      return true
    }),
    [allProcessed, scopedEmployeeIds, deletedKeys, hireDateMap],
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

  const activeEmployees = useMemo(() => {
    const base =
      activeTab === 'all'      ? scopedEmployees :
      activeTab === 'employee' ? scopedEmployees.filter(e => !leaderIdSet.has(e.id)) :
                                 scopedEmployees.filter(e => leaderIdSet.has(e.id))
    return base.filter(e => !globalExclusionIds.has(e.id))
  }, [activeTab, scopedEmployees, leaderIdSet, globalExclusionIds])

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
    () => sortByDivisionOrder([...new Set(baseEmployees.map(e => e.division).filter(Boolean))]),
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

  // ── Filters ───────────────────────────────────────────────────────────────
  const searchQuery = DAY_ALIASES[search.trim().toLowerCase()] ?? search.trim().toLowerCase()

  const isAnyFilterActive = !!search || selectedDivisions.length > 0 || selectedStatuses.length > 0 || selectedBUs.length > 0

  function clearAllFilters() {
    setSearch('')
    setSelectedDivisions([])
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
    if (normalTags.length === 0 && anomalyTags.length === 0 && r.clockIn !== null && r.dayType === 'WEEKDAY') normalTags.push('일반')

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

  // pre-status: search + division only (status 필터 제외) → anomalyCounts 카운팅용
  const preStatusRecords = useMemo(() => {
    return scopedRecords.filter(r => {
      if (globalExclusionIds.has(r.employeeId)) return false
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
      if (selectedDivisions.length > 0 && !selectedDivisions.includes(emp?.division ?? '')) return false
      return true
    })
  }, [scopedRecords, searchQuery, selectedDivisions, baseEmployees, globalExclusionIds])

  const filteredRecords = useMemo(() => {
    if (selectedStatuses.length === 0) return preStatusRecords
    return preStatusRecords.filter(r =>
      selectedStatuses.some(s => matchesStatus(r, s))
    )
  }, [preStatusRecords, selectedStatuses])

  // Direct employeeId → division.trim() map used to filter individual attendance rows.
  const empDivisionMap = useMemo(
    () => new Map<string, string>(baseEmployees.map(e => [e.id, e.division.trim()])),
    [baseEmployees],
  )

  // Tab + BU 게이트 적용 함수 (status 포함/제외 양쪽에서 재사용)
  function applyTabBU(recs: PR[]): PR[] {
    const hasBUFilter  = selectedBUs.length > 0
    const hasTabFilter = activeTab !== 'all'
    if (!hasBUFilter && !hasTabFilter) return recs
    const tabEmpIds    = hasTabFilter ? new Set(activeEmployees.map(e => e.id)) : null
    const selectedBUSet = hasBUFilter ? new Set(selectedBUs.map(b => b.trim())) : null
    return recs.filter(r => {
      if (tabEmpIds && !tabEmpIds.has(r.employeeId)) return false
      if (selectedBUSet) {
        const div = empDivisionMap.get(r.employeeId) ?? ''
        if (!selectedBUSet.has(div)) return false
      }
      return true
    })
  }

  // status 제외 탭+BU 필터 → anomalyCounts 카운팅 전용
  const tabPreStatusRecords = useMemo(
    () => applyTabBU(preStatusRecords),
    [preStatusRecords, activeTab, activeEmployees, selectedBUs, empDivisionMap], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // 전체 필터 적용 (status 포함) → 테이블 표시용
  const tabFilteredRecords = useMemo(
    () => applyTabBU(filteredRecords),
    [filteredRecords, activeTab, activeEmployees, selectedBUs, empDivisionMap], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Per-status counts for dropdown badges (status 필터 제외, 나머지 필터 반영)
  const anomalyCounts = useMemo(() => {
    let normal = 0, abnormal = 0
    let regular = 0, overtime = 0, offsite = 0, holidayWork = 0
    let late = 0, early = 0, shortWork = 0, missing = 0

    for (const r of tabPreStatusRecords) {
      if (approvedKeys.has(`${r.employeeId}_${r.date}`)) continue

      const flag = r.flag
      const hasAnomaly = flag !== null

      // 정상/비정상: 요일 구분 없이 모든 레코드 집계 (테이블 근태상태 열과 동일 기준)
      if (hasAnomaly) {
        abnormal++
        if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') missing++
        if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') late++
        if (flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') early++
        if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY') shortWork++
      } else {
        normal++
      }

      if (r.finalStatus === '외근')     offsite++
      if (r.finalStatus === '휴일근무') holidayWork++
      if (r.overtimeHours > 0)         overtime++
      // 일반: WEEKDAY만 (테이블 normalTags 로직과 동일)
      if (!hasAnomaly && r.clockIn !== null && !r.finalStatus?.match(/외근|휴일근무/) && r.overtimeHours === 0 && r.dayType === 'WEEKDAY') regular++
    }
    return { normal, abnormal, regular, overtime, offsite, holidayWork, late, early, shortWork, missing }
  }, [tabPreStatusRecords, approvedKeys])

  // Grid-view: filter displayed employees by search + division + team
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
    if (gridFilterTeam) {
      result = result.filter(e => e.team === gridFilterTeam)
    }
    return result
  }, [filteredRankedEmployees, searchQuery, selectedDivisions, gridFilterTeam])

  // ── Grid: parent-level sort (applied before pagination so order is correct across pages) ──
  const gridEmpStats = useMemo(() => {
    const s: Record<string, { ot: number; night: number; holiday: number; anomalies: number }> = {}
    for (const r of allProcessed) {
      if (!s[r.employeeId]) s[r.employeeId] = { ot: 0, night: 0, holiday: 0, anomalies: 0 }
      s[r.employeeId].ot       += r.overtimeHours
      s[r.employeeId].night    += r.nightHours
      s[r.employeeId].holiday  += r.dayType !== 'WEEKDAY' ? (r.holidayHours ?? 0) : 0
      if (r.flag !== null && !approvedKeys.has(`${r.employeeId}_${r.date}`)) s[r.employeeId].anomalies++
    }
    return s
  }, [allProcessed, approvedKeys])

  const sortedFilteredEmployees = useMemo(() => {
    if (gridSortDir === 'none') return searchFilteredEmployees
    return [...searchFilteredEmployees].sort((a, b) => {
      let cmp = 0
      if (gridSortKey === 'name') {
        cmp = a.name.localeCompare(b.name, 'ko')
      } else {
        const sa = gridEmpStats[a.id] ?? { ot: 0, night: 0, holiday: 0, anomalies: 0 }
        const sb = gridEmpStats[b.id] ?? { ot: 0, night: 0, holiday: 0, anomalies: 0 }
        const field = gridSortKey === 'anomaly' ? 'anomalies' : gridSortKey
        cmp = (sa[field as keyof typeof sa] as number) - (sb[field as keyof typeof sb] as number)
      }
      return gridSortDir === 'asc' ? cmp : -cmp
    })
  }, [searchFilteredEmployees, gridSortKey, gridSortDir, gridEmpStats])

  // ── Grid pagination ──────────────────────────────────────────────────────
  // 52h/209h 필터 활성 시 전체 직원을 그리드에 전달 (필터 후 내부 페이지네이션)
  const gridTotalPages = gridHoursFilter === 'all'
    ? Math.ceil(sortedFilteredEmployees.length / GRID_PAGE_SIZE) : 1
  const gridEmployees  = useMemo(
    () => gridHoursFilter === 'all'
      ? sortedFilteredEmployees.slice(gridPage * GRID_PAGE_SIZE, (gridPage + 1) * GRID_PAGE_SIZE)
      : sortedFilteredEmployees,
    [sortedFilteredEmployees, gridPage, GRID_PAGE_SIZE, gridHoursFilter],
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

  function handleManualSave(payload: ManualEntryPayload) {
    if (!manualCell) return
    const { employeeId, date } = manualCell
    const key = `${employeeId}_${date}`
    const next = {
      ...recordOverrides,
      [key]: {
        clockIn:      payload.clockIn,
        clockOut:     payload.clockOut,
        erpOtApplied: null,
        erpLeaveType: payload.attendanceType === '재택근무' ? '재택근무'
                    : payload.attendanceType === '출장'    ? '출장'
                    : null,
        memo:         payload.memo || undefined,
        editHistory:  [],
        reasonLabel:  `수기 입력 (${payload.attendanceType})`,
      },
    }
    setRecordOverrides(next as typeof recordOverrides)
    saveOverride(employeeId, date)
    setManualCell(null)
  }

  function handleDeleteRecord(employeeId: string, date: string) {
    deleteRecord(employeeId, date)
    // override/resolution 클라이언트 state도 정리
    const key = `${employeeId}_${date}`
    setRecordOverrides(prev => { const n = { ...prev }; delete n[key]; return n })
    setResolutions(prev => { const n = { ...prev }; delete n[key]; return n })
    setModalCell(null)
    setManualCell(null)
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
            {view === 'allowance' ? '수당 집계' : activeTab === 'all' ? '전체' : activeTab === 'employee' ? '사원' : '직책자'}{view !== 'allowance' ? ` · ${activeTotal.headcount}명` : ''}
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
            <button onClick={() => setView('summary')}
              className={`px-3 py-1.5 rounded-md transition-colors ${view === 'summary' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
              현황
            </button>
            <button onClick={() => setView('allowance')}
              className={`px-3 py-1.5 rounded-md transition-colors ${view === 'allowance' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
              수당집계
            </button>
          </div>
        </div>
      </div>

      {/* ── Date range filter + risk view toggle ── */}
      <div className="flex items-center gap-3 px-6 py-2.5 bg-white border-b border-gray-100 shrink-0">
        <DateRangePicker value={dateRange} onChange={setDateRange} />

        <div className="ml-auto flex items-center gap-3 shrink-0">

        </div>
      </div>

      {/* ── CSV / Excel uploader ── */}
      <CsvUploader />

      {/* ── Server computation status / manual recompute / snapshot ── */}
      {isLiveData && (
        <div className="px-6 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-4 text-sm">
          {isServerProcessing ? (
            <span className="flex items-center gap-2 text-blue-600">
              <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              서버 재계산 중...
            </span>
          ) : (
            <button
              onClick={recomputeProcessed}
              className="flex items-center gap-1.5 text-gray-500 hover:text-gray-800 transition-colors"
              title="예외규칙·Slack·정책 변경 후 수동 재계산"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              데이터 재계산
            </button>
          )}

        </div>
      )}

      {/* ── All / Employee / Leader tab bar (hidden on allowance view) ── */}
      {view !== 'allowance' && <div className="px-6 py-2.5 bg-white border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit text-sm">
          {([
            { key: 'all'      as const, label: '전체 근태 현황',   count: total.headcount         as number | null },
            { key: 'employee' as const, label: '사원 근태 현황',   count: employeeTotal.headcount as number | null },
            { key: 'leader'   as const, label: '직책자 근태 현황', count: leaderTotal.headcount   as number | null },
          ]).map(({ key, label, count }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-4 py-1.5 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}>
              {label}
              {count !== null && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                  activeTab === key ? 'bg-blue-50 text-blue-600' : 'bg-gray-200 text-gray-500'
                }`}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>}

      {/* ── Main content ── */}
      <div className="min-w-0 flex flex-col">

        {/* ── Allowance view ── */}
        {view === 'allowance' && (
          <div className="flex-1 overflow-auto p-6">
            <AllowanceTab />
          </div>
        )}

        {view !== 'allowance' && (
        <>
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

            <div className="ml-auto" />
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
          <div className="px-6 pt-1 pb-2 shrink-0 flex items-center gap-3">
            <div className="relative max-w-sm flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
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

            {/* 시간 기준 토글 — 그리드 전용 */}
            <div className="flex items-center gap-1.5 text-[11px] shrink-0">
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
        )}
        {view === 'grid' && (
          <div
            ref={gridRef}
            className={`shrink-0 max-w-full flex flex-col transition-opacity duration-300 ease-in-out ${gridFading ? 'opacity-0' : 'opacity-100'}`}
            style={{ minHeight: 'calc(100vh - 340px)' }}
          >
            {/* 페이지네이션 컨트롤 */}
            {gridTotalPages > 1 && (
              <div className="px-6 py-2 border-b border-gray-100 flex items-center gap-3 text-xs text-gray-500 bg-white shrink-0">
                <span>{gridPage * GRID_PAGE_SIZE + 1}–{Math.min((gridPage + 1) * GRID_PAGE_SIZE, searchFilteredEmployees.length)} / {searchFilteredEmployees.length}명</span>
                <div className="flex items-center gap-1 ml-auto">
                  <button disabled={gridPage === 0} onClick={() => setGridPage(p => p - 1)}
                    className="px-2.5 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">← 이전</button>
                  {Array.from({ length: gridTotalPages }, (_, i) => (
                    <button key={i} onClick={() => setGridPage(i)}
                      className={`w-7 h-7 rounded text-center transition-colors ${gridPage === i ? 'bg-gray-900 text-white' : 'hover:bg-gray-100 text-gray-600'}`}>
                      {i + 1}
                    </button>
                  ))}
                  <button disabled={gridPage >= gridTotalPages - 1} onClick={() => setGridPage(p => p + 1)}
                    className="px-2.5 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">다음 →</button>
                </div>
              </div>
            )}
            <div className="px-6 pb-6 pt-3">
              <EmployeeCalendarGrid
                key={selectedBUs.join(',')}
                employees={gridEmployees}
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
                onOrgFilterChange={(div, team) => {
                  setSelectedDivisions(div ? [div] : [])
                  setGridFilterTeam(team)
                }}
                onEmptyCellClick={(empId, date) => setManualCell({ employeeId: empId, date })}
                onHoursFilterChange={f => { setGridHoursFilter(f); setGridPage(0) }}
                onSortChange={(key, dir) => { setGridSortKey(key); setGridSortDir(dir); setGridPage(0) }}
              />
            </div>
          </div>
        )}

        {/* ── Summary view ── */}
        {view === 'summary' && (
          <div className="flex-1 min-h-0 overflow-auto">
            <SummaryTab
              records={scopedRecords}
              employees={scopedEmployees}
              dateFrom={dateRange.from}
              dateTo={dateRange.to}
            />
          </div>
        )}

        {/* ── Table view ── */}
        {view === 'table' && (
          <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 space-y-4">

            {/* Selection action bar */}
            {tableSelectedKeys.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
                <span className="text-blue-700 font-medium tabular-nums">선택 {tableSelectedKeys.size}건</span>
                <div className="flex items-center gap-2 ml-auto">
                  <button
                    onClick={() => setTableViewSelected(v => !v)}
                    className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                      tableViewSelected
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-blue-700 border-blue-300 hover:bg-blue-50'
                    }`}
                  >
                    {tableViewSelected ? '전체 보기' : '선택만 보기'}
                  </button>
                  <button
                    onClick={() => {
                      for (const key of tableSelectedKeys) {
                        const [empId, date] = key.split('_')
                        handleDeleteRecord(empId, date)
                      }
                      setTableSelectedKeys(new Set())
                      setTableViewSelected(false)
                    }}
                    className="px-3 py-1 rounded-md text-xs font-medium border border-red-300 bg-white text-red-600 hover:bg-red-50 transition-colors"
                  >
                    삭제
                  </button>
                  <button
                    onClick={() => { setTableSelectedKeys(new Set()); setTableViewSelected(false) }}
                    className="px-3 py-1 rounded-md text-xs font-medium border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    선택 해제
                  </button>
                </div>
              </div>
            )}

            <AttendanceResultTable
              records={tableViewSelected
                ? tabFilteredRecords.filter(r => tableSelectedKeys.has(`${r.employeeId}_${r.date}`))
                : tabFilteredRecords}
              employees={baseEmployees}
              columnVisibility={tableColVisibility}
              onColumnVisibilityChange={setTableColVisibility}
              onRowClick={handleCellClick}
              onNameClick={openDrawer}
              noteMap={noteMap}
              onNoteChange={handleNoteChange}
              otExemptIds={otExemptIds}
              selectedKeys={tableSelectedKeys}
              onSelectionChange={setTableSelectedKeys}
              onExport={filtered => {
                const fmt6 = (d: string) => d.replace(/-/g, '').slice(2)
                const filename = `근태결과_${fmt6(dateRange.from)}-${fmt6(dateRange.to)}.xlsx`
                const ALL_DETAIL_IDS = [
                  'division','empId','name','date','clockIn','clockOut',
                  'leaveAmt','leaveType','leaveSource','breakH',
                  'finalWorkH','attendanceStatus','normalTags','anomalyTags','systemOtH',
                  'payrollOtH','payrollNightH','erpOtApplied',
                ]
                const visibleColIds = new Set(ALL_DETAIL_IDS.filter(id => tableColVisibility[id] !== false))
                exportXlsx(filtered, baseEmployees, filename, visibleColIds)
              }}
            />

          </div>
        )}

        </>
        )} {/* end view !== 'allowance' */}

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
          onDelete={() => handleDeleteRecord(modalCell.employeeId, modalCell.date)}
        />
      )}

      {/* ── Manual Entry Modal ── */}
      {manualCell && (() => {
        const emp = baseEmployees.find(e => e.id === manualCell.employeeId) ?? null
        if (!emp) return null
        const ov = recordOverrides[`${manualCell.employeeId}_${manualCell.date}`]
        return (
          <ManualEntryModal
            employee={emp}
            date={manualCell.date}
            initial={ov ? {
              clockIn:        ov.clockIn  ?? undefined,
              clockOut:       ov.clockOut ?? undefined,
              attendanceType: ov.reasonLabel?.replace('수기 입력 (', '').replace(')', '') ?? '기타',
              memo:           ov.memo,
            } : undefined}
            onClose={() => setManualCell(null)}
            onSave={handleManualSave}
            onDelete={() => handleDeleteRecord(manualCell.employeeId, manualCell.date)}
          />
        )
      })()}

    </div>
  )
}
