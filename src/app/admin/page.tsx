'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { usePolicy } from '@/context/PolicyContext'
import { EmployeeCalendarGrid } from '@/components/admin/EmployeeCalendarGrid'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange, DEFAULT_RANGE } from '@/context/DateRangeContext'
import { exportXlsx, exportTableXlsx } from '@/utils/exportCsv'
import StatusExportButton from '@/components/admin/StatusExportButton'
import { DailyDetailModal } from '@/components/admin/DailyDetailModal'
import type { SavePayload } from '@/components/admin/DailyDetailModal'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import { MetricDeepDive } from '@/components/admin/MetricDeepDive'
import type { Section } from '@/components/admin/MetricDeepDive'
import { CsvUploader } from '@/components/admin/CsvUploader'
import { ManualEntryModal } from '@/components/admin/ManualEntryModal'
import type { ManualEntryPayload } from '@/components/admin/ManualEntryModal'
import { AttendanceResultTable } from '@/components/admin/AttendanceResultTable'
import { SlackReminderModal } from '@/components/admin/SlackReminderModal'
import { SummaryTab }            from '@/components/admin/SummaryTab'
import { AllowanceTab }          from '@/components/admin/AllowanceTab'
import {
  computeWorkA, computeStatusN,
  computeDisplayBreakMins, parseTimeToMins,
} from '@/utils/attendanceCalc'
import { getDayInfo } from '@/utils/dataParser'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import type { Employee, ProcessedRecord } from '@/types/tag'
import { HR_THRESHOLDS, EXEC_THRESHOLDS } from '@/types/tag'
import type { RiskView, ProcessedRecord as PR } from '@/types/tag'
import { sortByDivisionOrder } from '@/data/orgChart'

// 수기입력 모달에서 선택 가능한 연차 서브유형 — 저장된 override가 연차 계열인지 판별할 때 재사용
const LEAVE_SUBTYPES = new Set(['연차', '오전반차', '오후반차', '오전반반차', '오후반반차'])

// 3종 체계(지각/근무시간미달/미태깅) — 조기퇴근은 근무시간미달로 통합.
const ANOMALY_STATUSES = new Set(['지각', '미태깅', '이상치'])

const ANOM_LABEL: Record<string, string> = {
  '지각':          '지각',
  '미태깅':        '미태깅',
  '이상치':        '이상치',
  '근무시간 미달': '근무시간 미달',
}

const ANOM_COLOR: Record<string, string> = {
  '지각':          'text-amber-600  bg-amber-50  border-amber-200',
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

function toDS(d: Date): string {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
}
function addDays(s: string, n: number): string {
  const d = new Date(s + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return toDS(d)
}

/** Returns the latest-7-days window within the data (earliest record date if the data spans
 *  less than a week). 업로드 직후 min~max(보통 1월~오늘) 전체를 자동으로 띄우면 그리드/집계 렌더링이
 *  무거워져서 기본값을 최근 1주일로 좁힘 — 더 넓은 기간은 DateRangePicker로 수동 선택. */
function detectMonthRange(records: { date: string }[]): { from: string; to: string } | null {
  let min: string | null = null
  let max: string | null = null
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue
    if (!min || r.date < min) min = r.date
    if (!max || r.date > max) max = r.date
  }
  if (!min || !max) return null
  const weekAgo = addDays(max, -6)
  return { from: weekAgo > min ? weekAgo : min, to: max }
}

type View = 'grid' | 'table' | 'summary' | 'allowance'

export default function AdminDashboard() {
  const { policy } = usePolicy()
  const { openDrawer, exceptions } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const { recordOverrides, setRecordOverrides, resolutions, setResolutions, saveOverride, deletedKeys, deleteRecord } = useAttendanceData()
  const {
    employees: baseEmployees, rawRecords: baseRecords, isLiveData,
    processedRecords: serverProcessed, isProcessing: isServerProcessing,
    recomputeProcessed, dbSaveError: recomputeError,
  } = useAttendanceSource()
  const { config: slackConfig } = useSlack()
  const [showSlackReminder, setShowSlackReminder] = useState(false)

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
  const [timeMode, setTimeMode] = useState<'recognized' | 'exact'>('recognized')
  const [gridCreditsOn, setGridCreditsOn] = useState(true)
  // 그리드 인원 체크박스로 고른 사람만 조회 — 선택은 유지한 채 필터만 켜고 끌 수 있음
  const [selectedGridEmployeeIds, setSelectedGridEmployeeIds] = useState<Set<string>>(new Set())
  const [showOnlySelectedInGrid,  setShowOnlySelectedInGrid]  = useState(false)
  const toggleGridEmployeeSelection = (id: string) => {
    setSelectedGridEmployeeIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const [tableColVisibility, setTableColVisibility] = useState<Record<string, boolean>>({
    normalTags:    true,
    anomalyTags:   true,
    leaveSource:   true,
    gasWorkAMins:  true,
    breakH:        true,
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
  // 그리드/테이블/현황/수당집계와 Overview 페이지가 공유하는 파이프라인(override 병합,
  // 수기입력 합성, 예외규칙/하드코딩 기본값 병합, hire-date/삭제 필터)은
  // useProcessedAttendance 훅으로 추출됨 — 로직은 그 훅 하나에만 존재.
  const { records: scopedRecords, finalAttrMap, otExemptIds, globalExclusionIds } =
    useProcessedAttendance(dateRange.from, dateRange.to)

  // 회사 지정 공휴일 맵 — 수기입력 synthetic record의 dayType/dayLabel 산정에 재사용
  const companyHolsMap = useMemo(
    () => new Map((policy.companyHolidays ?? []).map(h => [h.date, h.label])),
    [policy.companyHolidays],
  )

  // Build hire-date map from employee rawId (format E{YY}{MM}{DD}{SEQ} → 20YY-MM-DD).
  // metricsEmployees(재직기간 필터)에서만 별도로 필요 — useProcessedAttendance 내부에도
  // 동일 계산이 있지만 hireDateMap 자체는 baseEmployees만의 순수 함수라 여기 따로 둬도 저렴함.
  const hireDateMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of baseEmployees) {
      if (!e.rawId) continue
      const m = e.rawId.match(/^E(\d{2})(\d{2})(\d{2})\d+$/)
      if (m) map.set(e.id, `20${m[1]}-${m[2]}-${m[3]}`)
    }
    return map
  }, [baseEmployees])

  const approvedKeys = useMemo(
    () => new Set(Object.keys(resolutions)),
    [resolutions],
  )

  // 기간 내 재직 중인 직원만 headcount 산정에 포함
  // - 퇴사자: resignedFrom 미설정 시 무조건 제외, 설정돼 있으면 기간 시작 이전일 때만 제외 (기간 중 퇴사는 포함)
  // - 미입사자: 입사일이 기간 종료 이후이면 제외
  const metricsEmployees = useMemo(
    () => scopedEmployees.filter(e => {
      const attrs = finalAttrMap.get(e.id)
      if (attrs?.isResigned && (!attrs.resignedFrom || attrs.resignedFrom < dateRange.from)) return false
      const hd = hireDateMap.get(e.id)
      if (hd && hd > dateRange.to) return false
      return true
    }),
    [scopedEmployees, finalAttrMap, hireDateMap, dateRange.from, dateRange.to],
  )

  // ── Management metrics ────────────────────────────────────────────────────
  const {
    bizDays,
    metrics, total,
    employeeMetrics, employeeTotal,
    leaderMetrics,   leaderTotal,
  } = useManagementMetrics(
    scopedRecords, metricsEmployees, approvedKeys,
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
      const wAMins     = Math.round(workA * 60)
      const effIn      = r.effectiveClockIn ?? r.clockIn
      const ci         = effIn      ? parseTimeToMins(effIn)      : null
      const co         = r.clockOut ? parseTimeToMins(r.clockOut) : null
      const breakMins  = computeDisplayBreakMins(wAMins, ci, co, r.leaveType)
      const leaveCredit = (r.isUnpaidLeave ? 0 : leaveAmt) * 8
      const finalWorkH = Math.max(0, wAMins - breakMins) / 60 + leaveCredit
      const ds: string | null =
        r.finalStatus === '외근'     ? '외근'     :
        r.finalStatus === '휴일근무' ? '휴일근무' :
        computeStatusN({
          dayType: r.dayType, clockIn: r.clockIn, clockOut: r.clockOut,
          leaveType: r.leaveType ?? null, erpLeaveAmount: r.erpLeaveAmount,
          finalWorkH, isTenAMStarter: finalAttrMap.get(r.employeeId)?.isTenAMStarter ?? false,
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
      const wAMins     = Math.round(workA * 60)
      const effIn      = r.effectiveClockIn ?? r.clockIn
      const ci         = effIn      ? parseTimeToMins(effIn)      : null
      const co         = r.clockOut ? parseTimeToMins(r.clockOut) : null
      const breakMins  = computeDisplayBreakMins(wAMins, ci, co, r.leaveType)
      const leaveCredit = (r.isUnpaidLeave ? 0 : leaveAmt) * 8
      const finalWorkH = Math.max(0, wAMins - breakMins) / 60 + leaveCredit
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

  // ── Filters ───────────────────────────────────────────────────────────────
  const searchQuery = (() => {
    const raw = search.trim().toLowerCase()
    if (DAY_ALIASES[raw]) return DAY_ALIASES[raw]
    return raw.normalize('NFC').replace(/\s+/g, '')  // NFC + 공백 제거 → Employee.name과 동일 정규화
  })()

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
    if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') anomalyTags.push('근무시간 미달')
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
    let late = 0, shortWork = 0, missing = 0

    for (const r of tabPreStatusRecords) {
      if (approvedKeys.has(`${r.employeeId}_${r.date}`)) continue

      const flag = r.flag
      const hasAnomaly = flag !== null

      // 정상/비정상: 요일 구분 없이 모든 레코드 집계 (테이블 근태상태 열과 동일 기준)
      if (hasAnomaly) {
        abnormal++
        if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') missing++
        if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') late++
        // 3종 체계: 조기퇴근(레거시 캐시 포함)은 근무시간미달로 통합
        if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') shortWork++
      } else {
        normal++
      }

      if (r.finalStatus === '외근')     offsite++
      if (r.finalStatus === '휴일근무') holidayWork++
      if (r.overtimeHours > 0)         overtime++
      // 일반: WEEKDAY만 (테이블 normalTags 로직과 동일)
      if (!hasAnomaly && r.clockIn !== null && !r.finalStatus?.match(/외근|휴일근무/) && r.overtimeHours === 0 && r.dayType === 'WEEKDAY') regular++
    }
    return { normal, abnormal, regular, overtime, offsite, holidayWork, late, shortWork, missing }
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
    if (showOnlySelectedInGrid && selectedGridEmployeeIds.size > 0) {
      result = result.filter(e => selectedGridEmployeeIds.has(e.id))
    }
    return result
  }, [filteredRankedEmployees, searchQuery, selectedDivisions, gridFilterTeam, showOnlySelectedInGrid, selectedGridEmployeeIds])

  // ── Grid: parent-level sort (applied before pagination so order is correct across pages) ──
  const gridEmpStats = useMemo(() => {
    const s: Record<string, { ot: number; night: number; holiday: number; anomalies: number }> = {}
    for (const r of scopedRecords) {
      if (!s[r.employeeId]) s[r.employeeId] = { ot: 0, night: 0, holiday: 0, anomalies: 0 }
      s[r.employeeId].ot       += r.overtimeHours
      s[r.employeeId].night    += r.nightHours
      s[r.employeeId].holiday  += r.dayType !== 'WEEKDAY' ? (r.holidayHours ?? 0) : 0
      if (r.flag !== null && !approvedKeys.has(`${r.employeeId}_${r.date}`)) s[r.employeeId].anomalies++
    }
    return s
  }, [scopedRecords, approvedKeys])

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
    // 연차(및 서브유형)는 payload.leaveType으로 전달됨 — 그 외 재택근무/출장은 기존처럼 erpLeaveType에 직접 매핑.
    // 둘 다 동일한 erpLeaveType override 파이프라인(leaveTypeOverrideFields → processRecord)을 탄다.
    const erpLeaveType = payload.leaveType
      ?? (payload.attendanceType === '재택근무' ? '재택근무'
        : payload.attendanceType === '출장'    ? '출장'
        : null)
    const displayLabel = payload.leaveType ?? payload.attendanceType
    const next = {
      ...recordOverrides,
      [key]: {
        clockIn:      payload.clockIn,
        clockOut:     payload.clockOut,
        erpOtApplied: null,
        erpLeaveType,
        memo:         payload.memo || undefined,
        editHistory:  [],
        reasonLabel:  `수기 입력 (${displayLabel})`,
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
    // resolution은 소명완료 처리 시에만 세팅, 나머지는 기존 값 유지
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
          erpLeaveType: payload.newErpLeaveType !== null ? payload.newErpLeaveType : (existing?.erpLeaveType ?? null),
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
      'payrollOtH', 'payrollNightH', 'payrollHolidayH', 'erpOtApplied',
    ]
    const visibleColIds = new Set(ALL_DETAIL_IDS.filter(id => tableColVisibility[id] !== false))

    exportXlsx(tabFilteredRecords, baseEmployees, filename, visibleColIds, finalAttrMap)
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
    const en = employeeTotal.headcount || 1
    const ln = leaderTotal.headcount   || 1
    return {
      avgTotal: totalH / n,
      avgOt:    otH    / n,
      otRatio:  totalH > 0 ? (otH / totalH) * 100 : 0,
      topTotal, topOt, topAnomalies,
      empAvgTotal: employeeTotal.totalHours / en,
      ldAvgTotal:  leaderTotal.totalHours   / ln,
      empAvgOt:    employeeTotal.otHours    / en,
      ldAvgOt:     leaderTotal.otHours      / ln,
      empAnomalyRate: employeeTotal.anomalies / en,
      ldAnomalyRate:  leaderTotal.anomalies   / ln,
    }
  }, [activeMetrics, activeTotal, employeeTotal, leaderTotal])

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
          <StatusExportButton dateRange={dateRange} divisions={[...new Set(baseEmployees.map(e => e.division).filter(Boolean))]} />
        </div>
      </div>

      {/* ── CSV / Excel uploader ── */}
      <CsvUploader />

      {/* ── 전체 재계산 (단일 진입점) ── */}
      {isLiveData && (
        <div className="px-6 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-3 text-sm">
          {isServerProcessing ? (
            <span className="flex items-center gap-2 text-blue-600 font-medium">
              <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              전체 재계산 중...
            </span>
          ) : (
            <button
              onClick={recomputeProcessed}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors text-xs font-medium"
              title="예외규칙·Slack·정책 변경 사항을 반영해 전체 근태 데이터를 서버에서 다시 계산합니다"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              전체 재계산
            </button>
          )}
          {!isServerProcessing && recomputeError && (
            <span className="text-xs text-red-600 font-medium" title={recomputeError}>
              ⚠ {recomputeError}
            </span>
          )}
        </div>
      )}

      {/* ── All / Employee / Leader tab bar (hidden on allowance/analytics view) ── */}
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
          <div className="grid grid-cols-4 gap-4">

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
                  <p className="text-xs flex items-center gap-1">
                    <button onClick={() => setActiveTab('employee')} className={`font-medium tabular-nums transition-colors ${activeTab === 'employee' ? 'text-blue-600 underline' : 'text-gray-400 hover:text-blue-500'}`}>사원 {fmt(cardStats.empAvgTotal)}</button>
                    <span className="text-gray-300">·</span>
                    <button onClick={() => setActiveTab('leader')} className={`font-medium tabular-nums transition-colors ${activeTab === 'leader' ? 'text-violet-600 underline' : 'text-gray-400 hover:text-violet-500'}`}>직책자 {fmt(cardStats.ldAvgTotal)}</button>
                  </p>
                )}
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
                  <p className="text-xs flex items-center gap-1">
                    <button onClick={() => setActiveTab('employee')} className={`font-medium tabular-nums transition-colors ${activeTab === 'employee' ? 'text-blue-600 underline' : 'text-gray-400 hover:text-blue-500'}`}>사원 {fmt(cardStats.empAvgOt)}</button>
                    <span className="text-gray-300">·</span>
                    <button onClick={() => setActiveTab('leader')} className={`font-medium tabular-nums transition-colors ${activeTab === 'leader' ? 'text-violet-600 underline' : 'text-gray-400 hover:text-violet-500'}`}>직책자 {fmt(cardStats.ldAvgOt)}</button>
                  </p>
                )}
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
                {cardStats && (
                  <p className="text-xs flex items-center gap-1">
                    <button onClick={() => setActiveTab('employee')} className={`font-medium tabular-nums transition-colors ${activeTab === 'employee' ? 'text-blue-600 underline' : 'text-gray-400 hover:text-blue-500'}`}>사원 {cardStats.empAnomalyRate.toFixed(1)}건/인</button>
                    <span className="text-gray-300">·</span>
                    <button onClick={() => setActiveTab('leader')} className={`font-medium tabular-nums transition-colors ${activeTab === 'leader' ? 'text-violet-600 underline' : 'text-gray-400 hover:text-violet-500'}`}>직책자 {cardStats.ldAnomalyRate.toFixed(1)}건/인</button>
                  </p>
                )}
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
              employeeMetrics={employeeMetrics}
              employeeTotal={employeeTotal}
              leaderMetrics={leaderMetrics}
              leaderTotal={leaderTotal}
              processedRecords={scopedRecords}
              employees={scopedEmployees}
              approvedKeys={approvedKeys}
              riskThresholds={riskThresholds}
              selectedBUs={selectedBUs}
              onBUsChange={setSelectedBUs}
              leaderIdSet={leaderIdSet}
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

            {/* 인원 선택 필터 — 이름 옆 체크박스로 고른 사람만 조회 */}
            {selectedGridEmployeeIds.size > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                <span className="text-gray-400 whitespace-nowrap">{selectedGridEmployeeIds.size}명 선택</span>
                <button
                  onClick={() => setShowOnlySelectedInGrid(v => !v)}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors border ${
                    showOnlySelectedInGrid
                      ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                      : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                  }`}
                  title="체크한 인원만 그리드에 표시"
                >
                  선택 인원만 보기 {showOnlySelectedInGrid ? 'ON' : 'OFF'}
                </button>
                <button
                  onClick={() => { setSelectedGridEmployeeIds(new Set()); setShowOnlySelectedInGrid(false) }}
                  className="px-2 py-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  선택 해제
                </button>
              </div>
            )}

            {/* 시간 기준 토글 — 그리드 전용 */}
            <div className="flex flex-col gap-1 shrink-0">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-gray-400 whitespace-nowrap">시간 기준</span>
                <div className="flex items-center bg-gray-100 rounded-lg p-0.5 font-medium">
                  <button
                    onClick={() => setTimeMode('recognized')}
                    className={`px-2.5 py-1 rounded-md transition-all ${
                      timeMode === 'recognized' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                    }`}
                    title="급여 계산 기준 시간 (ERP 인정 OT + 30분 절사)"
                  >
                    인정 시간
                  </button>
                  <button
                    onClick={() => setTimeMode('exact')}
                    className={`px-2.5 py-1 rounded-md transition-all ${
                      timeMode === 'exact' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                    }`}
                    title="태그 기록 기준 실제 근무 시간 (절사 없음)"
                  >
                    실제 값
                  </button>
                </div>
              </div>
              {timeMode === 'recognized' && (
                <button
                  onClick={() => setGridCreditsOn(v => !v)}
                  className={`w-fit text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors ${
                    gridCreditsOn
                      ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  크레딧 {gridCreditsOn ? 'ON' : 'OFF'}
                </button>
              )}
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
                timeMode={timeMode}
                creditsOn={gridCreditsOn}
                companyHolidays={policy.companyHolidays}
                onOrgFilterChange={(div, team) => {
                  setSelectedDivisions(div ? [div] : [])
                  setGridFilterTeam(team)
                }}
                onEmptyCellClick={(empId, date) => setManualCell({ employeeId: empId, date })}
                onHoursFilterChange={f => { setGridHoursFilter(f); setGridPage(0) }}
                onSortChange={(key, dir) => { setGridSortKey(key); setGridSortDir(dir); setGridPage(0) }}
                leaderIdSet={leaderIdSet}
                attrMap={finalAttrMap}
                selectedIds={selectedGridEmployeeIds}
                onToggleSelect={toggleGridEmployeeSelection}
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
              leaderIdSet={leaderIdSet}
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
                    onClick={() => setShowSlackReminder(true)}
                    className="px-3 py-1 rounded-md text-xs font-medium border border-blue-300 bg-white text-blue-700 hover:bg-blue-50 transition-colors"
                  >
                    미상신 연차 알림 발송
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
              employeeAttrMap={finalAttrMap}
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
                  'payrollOtH','payrollNightH','payrollHolidayH','erpOtApplied',
                ]
                const visibleColIds = new Set(ALL_DETAIL_IDS.filter(id => tableColVisibility[id] !== false))
                exportTableXlsx(filtered, baseEmployees, filename, visibleColIds)
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
          showExactTime={timeMode === 'exact'}
          onClose={() => setModalCell(null)}
          onSave={handleModalSave}
          onDelete={() => handleDeleteRecord(modalCell.employeeId, modalCell.date)}
        />
      )}

      {showSlackReminder && (
        <SlackReminderModal
          records={tabFilteredRecords.filter(r => tableSelectedKeys.has(`${r.employeeId}_${r.date}`))}
          slackToken={slackConfig.token}
          onClose={() => setShowSlackReminder(false)}
        />
      )}

      {/* ── Manual Entry Modal ── */}
      {manualCell && (() => {
        const emp = baseEmployees.find(e => e.id === manualCell.employeeId) ?? null
        if (!emp) return null
        const ov = recordOverrides[`${manualCell.employeeId}_${manualCell.date}`]
        const isLeaveOv = !!(ov && ov.erpLeaveType && LEAVE_SUBTYPES.has(ov.erpLeaveType))
        const { dayType } = getDayInfo(manualCell.date, companyHolsMap)
        return (
          <ManualEntryModal
            employee={emp}
            date={manualCell.date}
            dayType={dayType}
            initial={ov ? {
              clockIn:        ov.clockIn  ?? undefined,
              clockOut:       ov.clockOut ?? undefined,
              attendanceType: isLeaveOv ? '연차' : (ov.reasonLabel?.replace('수기 입력 (', '').replace(')', '') ?? '기타'),
              leaveType:      isLeaveOv ? ov.erpLeaveType : null,
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
