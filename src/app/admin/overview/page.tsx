'use client'
import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { usePeriodRange } from '@/hooks/usePeriodRange'
import { PeriodSelector } from '@/components/admin/PeriodSelector'
import { AnomalyMetricBadges } from '@/components/admin/AnomalyMetricBadges'
import { KpiTile } from '@/components/admin/KpiTile'
import { DivisionTeamGrid } from '@/components/admin/DivisionTeamGrid'
import { KpiTileRow, type KpiTileVM } from '@/components/admin/overview/KpiTileRow'
import { DeptSection, type DeptSectionSummaryItem } from '@/components/admin/overview/DeptSection'
import type { DeptCardVM, DeptCardPersonRow } from '@/components/admin/overview/DeptCard'
import { LeaveTrendChart, type MonthlyLeavePoint } from '@/components/admin/overview/LeaveTrendChart'
import { useOrgMasterHeadcount } from '@/hooks/useOrgMasterHeadcount'
import { useMasterActiveRoster } from '@/hooks/useMasterActiveRoster'
import {
  buildDivisionAnomalyRollup, buildEmployeeAnomalyRollup, computeNormalRate,
  buildLeaveUsageRollup, buildTodayLeaveList,
  buildDailyOvertimeSeries, buildTodayOvertimeList,
  buildHolidayWorkRollup, buildTodayHolidayList, buildHolidayWorkDetails,
  buildOffsiteRollup, buildTodayOffsiteList,
  computeOverLimitEmployees, computeWeeklyRiskBuckets, buildEmployeeRecognizedHours, buildDivisionRecognizedOt,
  buildDivisionNormalRateRollup, buildDivisionRiskBands,
  buildEmployeeLeaveUsage, buildDivisionLeaveUsage,
  buildMasterDiscrepancyRollup,
  OVERVIEW_POLICY, LEAVE_BENCHMARK, MONTHLY_ALLOCATION,
} from '@/utils/overviewAggregations'
import { DIVISION_ORDER } from '@/data/orgChart'
import type { Employee } from '@/types/tag'

const BUSINESS_DIVISIONS = DIVISION_ORDER.slice(0, 5)
const SUPPORT_DIVISIONS  = DIVISION_ORDER.slice(5)

function todayStrFrom(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayStr(): string {
  return todayStrFrom(new Date())
}

const PIE_COLORS = ['#3b82f6', '#e5e7eb'] // 정상(blue) / 이상(gray)

// Zone1/Zone2 레이아웃 재설계 범위에서 "조직 정합성(마스터 정원 대비 CAPS 대조)"은 아직
// 고려 대상이 아니라고 명시적으로 합의됨 — 계산 로직은 그대로 두고 노출만 끈다.
// 이후 이 섹션을 다시 다룰 때 이 상수만 true로 되돌리면 됨.
const SHOW_ORG_INTEGRITY = false

type SectionKey = 'anomaly' | 'holiday' | 'ot' | 'leave' | 'orgIntegrity'

// ── Small shared UI bits ────────────────────────────────────────────────────

function Box({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`bg-gray-50 rounded-xl px-5 py-4 ${className}`}>{children}</div>
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-400 text-center py-6">{text}</p>
}

/** 접이식 상세 섹션 — 탭 없이 필요한 것만 펼쳐서 스크롤 부담을 줄인다. */
function AccordionSection({
  innerRef, icon, title, subtitle, isOpen, onToggle, children,
}: {
  innerRef: (el: HTMLDivElement | null) => void
  icon: string; title: string; subtitle: string
  isOpen: boolean; onToggle: () => void; children: ReactNode
}) {
  return (
    <section ref={innerRef} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50/60 transition-colors"
      >
        <span className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-sm shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
          <p className="text-[11px] text-gray-400 truncate">{subtitle}</p>
        </div>
        <svg
          className={`w-4 h-4 text-gray-300 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && <div className="px-5 pb-5 pt-1 space-y-4 border-t border-gray-50">{children}</div>}
    </section>
  )
}

/**
 * 본부별 비교 — 항목마다 단위가 달라(건/명/일) 한 차트에 섞지 않고 항목별로 따로 보여준다.
 * 각 상세 아코디언 안에서 그래프→상세 순서로 함께 표시된다(별도 탭·섹션으로 안 뺌).
 * compact: 이상치처럼 한 섹션에 3개를 나란히 놓을 때 쓰는 좁은 버전.
 */
function DivisionCompareChart({
  title, color, data, unit, compact,
}: { title: string; color: string; data: { label: string; value: number }[]; unit: string; compact?: boolean }) {
  return (
    <div className={compact ? 'bg-gray-50 rounded-xl p-3' : 'bg-white rounded-2xl border border-gray-100 shadow-sm p-5'}>
      <p className={`font-semibold text-gray-500 mb-2 flex items-center gap-1.5 ${compact ? 'text-[10.5px]' : 'text-[11px] mb-3'}`}>
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
        {title}
      </p>
      {data.length === 0 ? <p className="text-[11px] text-gray-300 text-center py-6">데이터가 없습니다.</p> : (
        <div className={compact ? 'h-28' : 'h-36'}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 16 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
              <XAxis dataKey="label" tick={{ fontSize: compact ? 8.5 : 9 }} interval={0}
                angle={data.length > (compact ? 3 : 6) ? -35 : 0} textAnchor={data.length > (compact ? 3 : 6) ? 'end' : 'middle'}
                height={data.length > (compact ? 3 : 6) ? 36 : 20} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={24} />
              <Tooltip formatter={(v: unknown) => [`${Number(v ?? 0)}${unit}`, title]} />
              <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const { isLiveData } = useAttendanceSource()
  const { resolutions } = useAttendanceData()
  const period = usePeriodRange()

  const { records, employees, finalAttrMap, globalExclusionIds } =
    useProcessedAttendance(period.from, period.to)

  const visibleEmployees = useMemo(
    () => employees.filter(e => !globalExclusionIds.has(e.id)),
    [employees, globalExclusionIds],
  )

  // ── 본부 필터 — 선택하면 아래 요약/비교/상세가 전부 그 본부 기준으로 다시 계산된다 ──────
  const [selectedDivision, setSelectedDivision] = useState<string | null>(null)
  const divisionOptions = useMemo(
    () => DIVISION_ORDER.filter(d => visibleEmployees.some(e => e.division === d)),
    [visibleEmployees],
  )
  const scopedEmployees = useMemo(
    () => selectedDivision ? visibleEmployees.filter(e => e.division === selectedDivision) : visibleEmployees,
    [visibleEmployees, selectedDivision],
  )
  const scopedIds = useMemo(() => new Set(scopedEmployees.map(e => e.id)), [scopedEmployees])
  const scopedRecords = useMemo(
    () => records.filter(r => scopedIds.has(r.employeeId)),
    [records, scopedIds],
  )
  const empMap = useMemo(
    () => new Map<string, Employee>(scopedEmployees.map(e => [e.id, e])),
    [scopedEmployees],
  )

  const approvedKeys = useMemo(() => new Set(Object.keys(resolutions)), [resolutions])
  const masterHeadcountByDivision = useOrgMasterHeadcount()
  const { metrics, total } = useManagementMetrics(
    scopedRecords, scopedEmployees, approvedKeys, period.from, period.to, finalAttrMap,
    masterHeadcountByDivision,
  )

  const today = todayStr()

  // ── 조직 정합성: 인력 마스터(조직도 시트) vs 그때그때의 CAPS 업로드 대조 ────────────
  // 본부 필터와 무관하게 항상 전체 기준으로 본다 — 마스터 데이터가 아직 비어있으면(연동
  // 전) 두 목록 다 0건으로 자연히 비어서 화면에 아무 영향이 없다.
  const masterActive = useMasterActiveRoster()
  const recentActiveRawIds = useMemo(() => {
    const empByCompositeId = new Map(employees.map(e => [e.id, e.rawId ?? e.id.split('_')[0]]))
    const cutoff = new Date(today + 'T00:00')
    cutoff.setDate(cutoff.getDate() - 7)
    const cutoffStr = todayStrFrom(cutoff)
    const set = new Set<string>()
    for (const r of records) {
      if (r.date < cutoffStr) continue
      const rawId = empByCompositeId.get(r.employeeId)
      if (rawId) set.add(rawId)
    }
    return set
  }, [records, employees])
  const masterDiscrepancies = useMemo(
    () => buildMasterDiscrepancyRollup(masterActive, recentActiveRawIds, employees),
    [masterActive, recentActiveRawIds, employees],
  )

  // 일 단위로 볼 땐 prev/next로 실제 "오늘"이 아닌 다른 날짜를 탐색할 수 있는데, records 자체가
  // 이미 period.from~to로만 좁혀져 있어서 today(실제 달력상 오늘)로 필터링하면 그 날짜의
  // 레코드가 아예 없어 "오늘 X" 위젯이 전부 0으로 비어버렸다 — KPI 타일/명단이 실제로는 있는
  // 데이터인데도 안 뜨는 것처럼 보였던 원인. 일 단위에선 "보고 있는 날"을 기준으로 삼는다.
  // 주/월 단위의 "오늘 X" 위젯은 원래 의도대로 실제 오늘 기준을 유지한다.
  const todayForView = period.granularity === 'day' ? period.from : today

  // ── 이상치 ──────────────────────────────────────────────────────────────
  const empAnomaly = useMemo(() => buildEmployeeAnomalyRollup(scopedRecords, empMap), [scopedRecords, empMap])
  const divAnomaly = useMemo(() => buildDivisionAnomalyRollup(scopedRecords, empMap), [scopedRecords, empMap])
  const normalRate = useMemo(() => computeNormalRate(scopedRecords), [scopedRecords])
  const anomalyTotals = useMemo(
    () => divAnomaly.reduce((s, r) => ({ late: s.late + r.late, shortage: s.shortage + r.shortage, notag: s.notag + r.notag, total: s.total + r.total }),
      { late: 0, shortage: 0, notag: 0, total: 0 }),
    [divAnomaly],
  )

  // ── 휴일근무 ────────────────────────────────────────────────────────────
  const empHoliday = useMemo(() => buildHolidayWorkRollup(scopedRecords, empMap, 'employee'), [scopedRecords, empMap])
  const divHoliday = useMemo(() => buildHolidayWorkRollup(scopedRecords, empMap, 'division'), [scopedRecords, empMap])
  const todayHoliday = useMemo(() => buildTodayHolidayList(scopedRecords, empMap, todayForView), [scopedRecords, empMap, todayForView])
  const totalHolidayH = useMemo(() => divHoliday.reduce((s, r) => s + r.hours, 0), [divHoliday])

  // ── 휴가 사용 ────────────────────────────────────────────────────────────
  const divLeave  = useMemo(() => buildLeaveUsageRollup(scopedRecords, empMap, 'division'), [scopedRecords, empMap])
  const empLeave  = useMemo(() => buildLeaveUsageRollup(scopedRecords, empMap, 'employee'),  [scopedRecords, empMap])
  const todayLeave = useMemo(() => buildTodayLeaveList(scopedRecords, empMap, todayForView), [scopedRecords, empMap, todayForView])
  const totalLeaveDays = useMemo(() => divLeave.reduce((s, r) => s + r.days, 0), [divLeave])
  const divOffsite = useMemo(() => buildOffsiteRollup(scopedRecords, empMap, 'division'), [scopedRecords, empMap])

  // ── 초과근무 — 일=오늘 진행/발생 인원, 주=52h 초과자, 월=209h 초과자 ──────────
  const dailyOt = useMemo(() => buildDailyOvertimeSeries(scopedRecords, period.from, period.to), [scopedRecords, period.from, period.to])
  const todayOt = useMemo(() => buildTodayOvertimeList(scopedRecords, empMap, todayForView), [scopedRecords, empMap, todayForView])
  const totalOtH = total.otHours
  const overLimitHours = period.granularity === 'month' ? 209 : 52
  const overLimitRows = useMemo(
    () => period.granularity === 'day' ? [] : computeOverLimitEmployees(scopedRecords, scopedEmployees, finalAttrMap, overLimitHours),
    [scopedRecords, scopedEmployees, finalAttrMap, overLimitHours, period.granularity],
  )
  const overLimitByDivision = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of overLimitRows) m.set(r.division, (m.get(r.division) ?? 0) + 1)
    return m
  }, [overLimitRows])
  const otTileLabel = period.granularity === 'day' ? '오늘 초과근무'
    : period.granularity === 'week' ? '주 52시간 초과자' : '월 209시간 초과자'

  // 일 단위 볼 때는 그날이 실제 휴일/주말일 때만 휴일근무 타일을 보여준다 — 평일엔 항상
  // 0명이라 자리만 차지하므로 숨김. records(division 필터 전)에서 판별해 필터와 무관하게 유지.
  const isHolidayToday = useMemo(() => {
    const rec = records.find(r => r.date === period.from)
    const dayType = rec?.dayType ?? (
      [0, 6].includes(new Date(period.from + 'T12:00').getDay()) ? 'WEEKEND' : 'WEEKDAY'
    )
    return dayType !== 'WEEKDAY'
  }, [records, period.from])

  // ── 상세 아코디언 열림 상태 + 타일 클릭 시 스크롤 ─────────────────────────
  const [openSection, setOpenSection] = useState<SectionKey | null>(null)
  const sectionRefs = useRef<Partial<Record<SectionKey, HTMLDivElement | null>>>({})
  function openAndScroll(key: SectionKey) {
    setOpenSection(key)
    requestAnimationFrame(() => {
      sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
  function toggleSection(key: SectionKey) {
    setOpenSection(prev => (prev === key ? null : key))
  }

  // ── 본부별 비교 데이터 — 각 상세 아코디언 안에 그래프→상세 순으로 함께 넣는다 ───────
  // 이상치는 지각/근무시간미달/미태깅을 하나로 합친 총건수가 아니라, 카테고리별로 각각
  // 본부 비교 그래프 3개를 보여준다(요약 타일이 이미 3종을 나눠 보여주는 것과 동일한 구조).
  const compareLate = useMemo(
    () => divAnomaly.map(r => ({ label: r.label, value: r.late })).filter(r => r.value > 0).sort((a, b) => b.value - a.value),
    [divAnomaly],
  )
  const compareShortage = useMemo(
    () => divAnomaly.map(r => ({ label: r.label, value: r.shortage })).filter(r => r.value > 0).sort((a, b) => b.value - a.value),
    [divAnomaly],
  )
  const compareNotag = useMemo(
    () => divAnomaly.map(r => ({ label: r.label, value: r.notag })).filter(r => r.value > 0).sort((a, b) => b.value - a.value),
    [divAnomaly],
  )
  const compareOt = useMemo(
    () => [...overLimitByDivision.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    [overLimitByDivision],
  )

  // ── 외근 — Zone1 슬롯4(부재현황)용. 휴가와 별개로 집계. ─────────────────────
  const todayOffsite = useMemo(() => buildTodayOffsiteList(scopedRecords, empMap, todayForView), [scopedRecords, empMap, todayForView])
  const empOffsite = useMemo(() => buildOffsiteRollup(scopedRecords, empMap, 'employee'), [scopedRecords, empMap])
  const totalOffsiteCount = useMemo(() => empOffsite.reduce((s, r) => s + r.count, 0), [empOffsite])

  // ── 주 52시간 위험군 — Zone1 슬롯1(주간뷰) + Zone2 주간 랭킹용 ────────────────
  const weeklyRisk = useMemo(
    () => period.granularity === 'week' ? computeWeeklyRiskBuckets(scopedRecords, scopedEmployees, finalAttrMap) : { caution: 0, warning: 0, danger: 0, rows: [] },
    [scopedRecords, scopedEmployees, finalAttrMap, period.granularity],
  )
  // ── 본부별 정상출근율 — day 카드 심각도 판정(출근율 기준) + 구획 헤더 요약에 쓰임. ────
  const divNormalRate = useMemo(
    () => buildDivisionNormalRateRollup(scopedRecords, empMap),
    [scopedRecords, empMap],
  )

  // ── division별 "정산용" 연장근로시간(§4 확정 공식, 30분 절삭+ERP 가드 포함) — 주간
  // KPI/카드의 "연장근로" 표시는 반드시 이걸 써야 한다. useManagementMetrics의 otHours는
  // 별개(구식) 계산이라 여기 쓰면 안 됨(정산 결과와 어긋남).
  const divisionRecognizedOt = useMemo(
    () => period.granularity === 'week' ? buildDivisionRecognizedOt(scopedRecords, scopedEmployees, finalAttrMap) : [],
    [scopedRecords, scopedEmployees, finalAttrMap, period.granularity],
  )
  const otByDivision = useMemo(() => new Map(divisionRecognizedOt.map(d => [d.division, d])), [divisionRecognizedOt])

  // ── 이상치 카드 그리드의 "인원 목록" 근로시간 컬럼용 — computeOverLimitEmployees와
  // 동일한 인정시간 공식(§4)을 한도초과 여부와 무관하게 전원에게 적용. ─────────────────
  const employeeHoursMap = useMemo(
    () => buildEmployeeRecognizedHours(scopedRecords, scopedEmployees, finalAttrMap),
    [scopedRecords, scopedEmployees, finalAttrMap],
  )

  // ── Zone2 뷰 토글 — 이상치(기본) / 조직도. ──────────────────────────────────
  const [viewMode, setViewMode] = useState<'chart' | 'anomaly'>('anomaly')
  // v9 핸드오프 — 주간 하위탭(연장/휴일), 월간 하위탭(누적/단월). KPI 3열은 이 탭들을
  // 바꿔도 그대로 고정되고(핵심 규칙), 부서 카드·차트만 바뀐다.
  const [weekTab, setWeekTab] = useState<'overtime' | 'holiday'>('overtime')
  const [monthBasis, setMonthBasis] = useState<'cumulative' | 'single'>('cumulative')

  const monthLabel = `${new Date(period.from + 'T12:00').getMonth() + 1}월`
  const totalDivisionsCount = metrics.length

  // ── 연차 누적 사용률용 연간(1/1~기준일) 데이터 — usePeriodRange가 잡아주는 단일 월
  // 범위만으로는 "올해 들어 지금까지 쓴 비율"을 계산할 수 없어서 별도로 더 넓게 fetch한다.
  // month가 아닐 땐 어차피 안 쓰이므로 범위를 period와 동일하게 둬서 낭비하지 않는다.
  const yearStart = `${period.to.slice(0, 4)}-01-01`
  const ytdFrom = period.granularity === 'month' ? yearStart : period.from
  const { records: ytdRawRecords, employees: ytdRawEmployees, globalExclusionIds: ytdGlobalExclusionIds } =
    useProcessedAttendance(ytdFrom, period.to)
  const ytdVisibleEmployees = useMemo(
    () => ytdRawEmployees.filter(e => !ytdGlobalExclusionIds.has(e.id)),
    [ytdRawEmployees, ytdGlobalExclusionIds],
  )
  const ytdScopedEmployees = useMemo(
    () => selectedDivision ? ytdVisibleEmployees.filter(e => e.division === selectedDivision) : ytdVisibleEmployees,
    [ytdVisibleEmployees, selectedDivision],
  )
  const ytdScopedIds = useMemo(() => new Set(ytdScopedEmployees.map(e => e.id)), [ytdScopedEmployees])
  const ytdScopedRecords = useMemo(
    () => ytdRawRecords.filter(r => ytdScopedIds.has(r.employeeId)),
    [ytdRawRecords, ytdScopedIds],
  )

  // ── 연차 발생일수(부여일수) 기반 사용률 — 누적(1/1~기준일) / 단월(선택된 달) 두 기준.
  // ⚠️ 발생일수는 근로기준법 제60조 법정 최소 기준 근사치다(overviewAggregations.computeGrantedDays
  // 주석 참고) — 회사 실제 연차 규정과 다를 수 있어 확정 필요.
  const employeeLeaveCumulative = useMemo(
    () => period.granularity === 'month' ? buildEmployeeLeaveUsage(ytdScopedRecords, ytdScopedEmployees, period.to) : [],
    [period.granularity, ytdScopedRecords, ytdScopedEmployees, period.to],
  )
  const employeeLeaveSingle = useMemo(
    () => period.granularity === 'month' ? buildEmployeeLeaveUsage(scopedRecords, scopedEmployees, period.to) : [],
    [period.granularity, scopedRecords, scopedEmployees, period.to],
  )
  const divisionLeaveCumulative = useMemo(() => buildDivisionLeaveUsage(employeeLeaveCumulative), [employeeLeaveCumulative])
  const divisionLeaveSingle = useMemo(() => buildDivisionLeaveUsage(employeeLeaveSingle), [employeeLeaveSingle])

  const currentMonthNum = Number(period.to.slice(5, 7))
  const cumulativeBenchmarkPct = LEAVE_BENCHMARK[currentMonthNum - 1] ?? 100

  const leaveTotals = useMemo(() => {
    const cg = employeeLeaveCumulative.reduce((s, r) => s + r.grantedDays, 0)
    const cu = employeeLeaveCumulative.reduce((s, r) => s + r.usedDays, 0)
    const sg = employeeLeaveSingle.reduce((s, r) => s + r.grantedDays, 0)
    const su = employeeLeaveSingle.reduce((s, r) => s + r.usedDays, 0)
    return {
      cumulativePct: cg > 0 ? (cu / cg) * 100 : 0,
      singlePct: sg > 0 ? (su / sg) * 100 : 0,
      singleUsedDays: su,
      usersWithSingleUsage: employeeLeaveSingle.filter(r => r.usedDays > 0).length,
    }
  }, [employeeLeaveCumulative, employeeLeaveSingle])

  // ── 연차 추이 차트용 월별(1~12월) 포인트 — ytdScopedRecords가 이미 1/1~기준일 전체를
  // 갖고 있으므로 추가 fetch 없이 달마다 슬라이스해서 누적/단월 비율을 계산한다. ────────
  const monthlyLeavePoints = useMemo<MonthlyLeavePoint[]>(() => {
    if (period.granularity !== 'month') return []
    const year = period.to.slice(0, 4)
    const points: MonthlyLeavePoint[] = []
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0')
      const lastDay = new Date(Number(year), m, 0).getDate()
      const from = `${year}-${mm}-01`
      const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`
      let cumulativePct: number | null = null
      let singlePct: number | null = null
      if (m <= currentMonthNum) {
        const cumUsage = buildEmployeeLeaveUsage(ytdScopedRecords.filter(r => r.date <= to), ytdScopedEmployees, to)
        const cg = cumUsage.reduce((s, r) => s + r.grantedDays, 0)
        const cu = cumUsage.reduce((s, r) => s + r.usedDays, 0)
        cumulativePct = cg > 0 ? (cu / cg) * 100 : 0

        const singleUsage = buildEmployeeLeaveUsage(ytdScopedRecords.filter(r => r.date >= from && r.date <= to), ytdScopedEmployees, to)
        const sg = singleUsage.reduce((s, r) => s + r.grantedDays, 0)
        const su = singleUsage.reduce((s, r) => s + r.usedDays, 0)
        singlePct = sg > 0 ? (su / sg) * 100 : 0
      }
      points.push({ month: m, label: `${m}월`, cumulativePct, singlePct, benchmarkPct: LEAVE_BENCHMARK[m - 1] })
    }
    return points
  }, [period.granularity, period.to, ytdScopedRecords, ytdScopedEmployees, currentMonthNum])

  // ── 주 52h 위험군 — division 단위 밴드(주의/경고/초과) 롤업. ─────────────────────
  const headcountByDivision = useMemo(() => new Map(metrics.map(m => [m.division, m.headcount])), [metrics])
  const divisionRiskBands = useMemo(
    () => period.granularity === 'week' ? buildDivisionRiskBands(weeklyRisk.rows, headcountByDivision) : [],
    [period.granularity, weeklyRisk, headcountByDivision],
  )

  // ── 휴일근로 사원별 날짜 상세 — 주·휴일 탭 카드 목록용. ─────────────────────────
  const holidayWorkDetails = useMemo(
    () => period.granularity === 'week' ? buildHolidayWorkDetails(scopedRecords, empMap) : [],
    [period.granularity, scopedRecords, empMap],
  )

  // ── 고정 3열 KPI(v9 핵심 규칙: 탭을 바꿔도 이 3칸의 틀은 그대로) ──────────────────
  const kpiTiles = useMemo<KpiTileVM[]>(() => {
    if (period.granularity === 'day') {
      const delta = normalRate.pct - OVERVIEW_POLICY.attendanceTargetPct
      const divsWithAnomaly = divAnomaly.filter(d => d.total > 0).length
      return [
        {
          key: 'main', label: '출근율', isMain: true, value: normalRate.pct.toFixed(1), unit: '%',
          subRows: [
            { key: '기준 대비', value: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%p`, tone: delta >= 0 ? 'positive' : 'negative' },
            { key: '정상출근', value: `${normalRate.normal}명` },
            { key: '이상치 발생 부문', value: `${divsWithAnomaly} / ${totalDivisionsCount}개` },
          ],
          onClick: () => openAndScroll('anomaly'),
        },
        {
          key: 'urgent', label: '당일 긴급 이상치', value: `${anomalyTotals.total}`, unit: '건',
          breakdown3: [
            { label: '지각', value: `${anomalyTotals.late}`, color: '#d97706' },
            { label: '근무미달', value: `${anomalyTotals.shortage}`, color: '#dc2626' },
            { label: '미태깅', value: `${anomalyTotals.notag}`, color: '#7c3aed' },
          ],
          onClick: () => openAndScroll('anomaly'),
        },
        {
          key: 'absence', label: '당일 현장 부재', value: `${todayLeave.length + todayOffsite.length}`, unit: '명',
          subRows: [
            { key: '휴가', value: `${todayLeave.length}명` },
            { key: '외근', value: `${todayOffsite.length}명` },
          ],
          onClick: () => openAndScroll('leave'),
        },
      ]
    }
    if (period.granularity === 'week') {
      const divsWithRisk = divisionRiskBands.filter(b => b.caution + b.warning + b.danger > 0).length
      const totalRecognizedOt = divisionRecognizedOt.reduce((s, d) => s + d.otHours, 0)
      const otEligible = divisionRecognizedOt.reduce((s, d) => s + d.eligible, 0)
      const totalHolidayCount = divHoliday.reduce((s, r) => s + r.count, 0)
      const divsWithHoliday = divHoliday.filter(d => d.count > 0).length
      return [
        {
          key: 'main', label: '주 52시간 초과 위험군', isMain: true, value: `${weeklyRisk.danger}`, unit: '명',
          subRows: [
            { key: '주의 45–50h', value: `${weeklyRisk.caution}명` },
            { key: '경고 50–52h', value: `${weeklyRisk.warning}명` },
            { key: '발생 부문', value: `${divsWithRisk} / ${totalDivisionsCount}개` },
          ],
          onClick: () => openAndScroll('ot'),
        },
        {
          key: 'overtime', label: '연장근로', value: fmtH(total.headcount > 0 ? totalRecognizedOt / total.headcount : 0),
          footnote: '주당 평균',
          subRows: [
            { key: '총 연장', value: fmtH(totalRecognizedOt) },
            { key: '대상 인원', value: `${otEligible}명` },
          ],
          onClick: () => openAndScroll('ot'),
        },
        {
          key: 'holiday', label: '휴일근로', value: `${totalHolidayCount}`, unit: '건',
          subRows: [
            { key: '총 시간', value: fmtH(totalHolidayH) },
            { key: '1건 평균', value: totalHolidayCount > 0 ? fmtH(totalHolidayH / totalHolidayCount) : '0h' },
            { key: '발생 부문', value: `${divsWithHoliday} / ${totalDivisionsCount}개` },
          ],
          onClick: () => openAndScroll('holiday'),
        },
      ]
    }
    // month
    const belowTargetDivCount = divisionLeaveCumulative.filter(d => d.ratePct < cumulativeBenchmarkPct).length
    if (monthBasis === 'cumulative') {
      const delta = leaveTotals.cumulativePct - cumulativeBenchmarkPct
      return [
        {
          key: 'main', label: '월간 전사 연차 사용률 (누적)', isMain: true, value: leaveTotals.cumulativePct.toFixed(1), unit: '%',
          subRows: [
            { key: '목표 대비', value: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%p`, tone: delta >= 0 ? 'positive' : 'negative' },
            { key: '단독 사용', value: `${leaveTotals.singlePct.toFixed(1)}%` },
            { key: '기준 미달 부문', value: `${belowTargetDivCount} / ${totalDivisionsCount}개` },
          ],
          onClick: () => openAndScroll('leave'),
        },
        {
          // ⚠️ 급여 시급 데이터 소스가 없어 금액을 지어내지 않음 — 값 자체를 "준비중"으로 표시.
          key: 'allowance', label: '연말 예상 연차 수당 (현금 지출)', value: '준비중',
          footnote: '급여 시급 데이터 연동 필요',
          onClick: () => openAndScroll('leave'),
        },
        {
          key: 'over209', label: '월간 209시간 초과 인원', value: `${overLimitRows.length}`, unit: '명',
          subRows: [
            { key: '사업부', value: `${overLimitRows.filter(r => (BUSINESS_DIVISIONS as string[]).includes(r.division)).length}명` },
            { key: '지원부', value: `${overLimitRows.filter(r => (SUPPORT_DIVISIONS as string[]).includes(r.division)).length}명` },
          ],
          onClick: () => openAndScroll('ot'),
        },
      ]
    }
    const deltaAlloc = leaveTotals.singlePct - MONTHLY_ALLOCATION
    return [
      {
        key: 'main', label: `${monthLabel} 단독 연차 사용률`, isMain: true, value: leaveTotals.singlePct.toFixed(1), unit: '%',
        subRows: [
          { key: '배분 대비', value: `${deltaAlloc >= 0 ? '+' : ''}${deltaAlloc.toFixed(1)}%p`, tone: deltaAlloc >= 0 ? 'positive' : 'negative' },
          { key: '누적 사용률', value: `${leaveTotals.cumulativePct.toFixed(1)}%` },
        ],
        onClick: () => openAndScroll('leave'),
      },
      {
        key: 'users', label: `${monthLabel} 연차 사용 인원`, value: `${leaveTotals.usersWithSingleUsage}`, unit: '명',
        subRows: [
          { key: '1인 평균', value: `${fmtDays(leaveTotals.usersWithSingleUsage > 0 ? leaveTotals.singleUsedDays / leaveTotals.usersWithSingleUsage : 0)}일` },
          { key: '미사용', value: `${employeeLeaveSingle.filter(r => r.usedDays === 0).length}명` },
        ],
        onClick: () => openAndScroll('leave'),
      },
      {
        key: 'allowance', label: '연말 예상 연차 수당 (현금 지출)', value: '준비중',
        footnote: '급여 시급 데이터 연동 필요',
        subRows: [{ key: '209h 초과', value: `${overLimitRows.length}명` }],
        onClick: () => openAndScroll('leave'),
      },
    ]
  }, [
    period.granularity, monthBasis, normalRate, divAnomaly, anomalyTotals, todayLeave, todayOffsite,
    weeklyRisk, divisionRiskBands, metrics, divHoliday, totalHolidayH, total, totalDivisionsCount,
    divisionLeaveCumulative, cumulativeBenchmarkPct, leaveTotals, overLimitRows, employeeLeaveSingle, monthLabel,
  ])

  // ── 부서 카드(division → DeptCardVM) — 상태(일/주연장/주휴일/월누적/월단월)별로 콘텐츠가
  // 완전히 다르다. 심각도 임계값은 전부 OVERVIEW_POLICY 상수 참조(하드코딩 매직넘버 금지). ──
  function buildDayCard(m: (typeof metrics)[number]): DeptCardVM {
    const anomaly = divAnomaly.find(a => a.label === m.division) ?? { late: 0, shortage: 0, notag: 0, total: 0 }
    const rate = divNormalRate.find(r => r.division === m.division)?.pct ?? 0
    const delta = rate - OVERVIEW_POLICY.attendanceTargetPct
    const severity = delta >= 0 ? 'normal' : delta >= OVERVIEW_POLICY.attendanceWarnDeltaPp ? 'warning' : 'action'
    const divOtCount = todayOt.filter(e => e.division === m.division).length
    const leaveCount = divLeave.find(l => l.label === m.division)?.count ?? 0
    const offsiteCount = divOffsite.find(o => o.label === m.division)?.count ?? 0

    const people = empAnomaly.filter(r => r.division === m.division)
    let budget = anomaly.total
    const rows: DeptCardPersonRow[] = []
    for (const p of people) {
      if (budget <= 0) break
      rows.push({ key: p.key, name: p.label, cols: [p.late || '—', p.shortage || '—', p.notag || '—'] })
      budget -= p.total
    }

    return {
      division: m.division, headcount: m.headcount, severity,
      mainValue: rate.toFixed(1), mainUnit: '%',
      progressPct: rate, progressMarkerPct: OVERVIEW_POLICY.attendanceTargetPct,
      captionLeft: `초과 인원 ${divOtCount}명`, captionRight: `기준 ${OVERVIEW_POLICY.attendanceTargetPct}%`,
      cells: [
        { label: '지각', value: anomaly.late ? `${anomaly.late}` : '—', color: '#d97706' },
        { label: '미달', value: anomaly.shortage ? `${anomaly.shortage}` : '—', color: '#dc2626' },
        { label: '미태깅', value: anomaly.notag ? `${anomaly.notag}` : '—', color: '#7c3aed' },
      ],
      listHeaderLabel: `이상치 사원 ${rows.length}명`, listSortLabel: '건수 많은 순',
      listColumnHeaders: ['사원', '지각', '미달', '미태'],
      rows,
      footerLabel: '현장 부재', footerValue: `${leaveCount + offsiteCount}명`,
    }
  }

  function buildWeekOvertimeCard(m: (typeof metrics)[number]): DeptCardVM {
    const band = divisionRiskBands.find(b => b.division === m.division) ?? { caution: 0, warning: 0, danger: 0, avgHours: 0 }
    const weeklyOtAvg = m.headcount > 0 ? (otByDivision.get(m.division)?.otHours ?? 0) / m.headcount : 0
    const riskCount = band.caution + band.warning + band.danger
    const severity =
      band.danger > 0 || weeklyOtAvg >= OVERVIEW_POLICY.weeklyOtActionH ? 'action'
      : band.caution + band.warning > 0 || weeklyOtAvg >= OVERVIEW_POLICY.weeklyOtWarningH ? 'warning' : 'normal'

    const people = weeklyRisk.rows.filter(r => r.division === m.division).sort((a, b) => b.hours - a.hours)
    const rows: DeptCardPersonRow[] = people.slice(0, 6).map(p => ({
      key: p.employeeId, name: p.name,
      tag: p.bucket === 'danger' ? { text: '초과', bg: '#fee2e2', fg: '#991b1b' }
        : p.bucket === 'warning' ? { text: '경고', bg: '#fef2f2', fg: '#b91c1c' }
        : { text: '주의', bg: '#fffbeb', fg: '#b45309' },
      value: fmtH(p.hours), valueRed: p.hours >= 50,
    }))

    return {
      division: m.division, headcount: m.headcount, severity,
      mainValue: `${riskCount}`, mainUnit: '명',
      progressPct: (weeklyOtAvg / 20) * 100, progressMarkerPct: (OVERVIEW_POLICY.weeklyOtActionH / 20) * 100,
      captionLeft: `주당 평균 ${fmtH(weeklyOtAvg)}`, captionRight: `기준 ${OVERVIEW_POLICY.weeklyOtActionH}h`,
      cells: [
        { label: '주의 45-50h', value: band.caution ? `${band.caution}` : '—' },
        { label: '경고 50-52h', value: band.warning ? `${band.warning}` : '—' },
        { label: '초과 52h+', value: band.danger ? `${band.danger}` : '—', color: '#dc2626' },
      ],
      listHeaderLabel: `위험군 사원 ${rows.length}명`, listSortLabel: '근로시간 많은 순',
      rows,
      footerLabel: '부서 평균 연장', footerValue: fmtH(weeklyOtAvg),
    }
  }

  function buildWeekHolidayCard(m: (typeof metrics)[number]): DeptCardVM {
    const row = divHoliday.find(h => h.label === m.division) ?? { count: 0, hours: 0 }
    const severity =
      row.count >= OVERVIEW_POLICY.holidayActionCount ? 'action'
      : row.count >= OVERVIEW_POLICY.holidayWarningCount ? 'warning' : 'normal'
    const details = holidayWorkDetails.filter(d => d.division === m.division).sort((a, b) => b.hours - a.hours)
    const rows: DeptCardPersonRow[] = details.slice(0, 6).map(d => ({
      key: `${d.employeeId}_${d.date}`, name: d.name,
      tag: { text: d.date.slice(5).replace('-', '/'), bg: '#f5f7ff', fg: '#2563eb' },
      value: fmtH(d.hours), valueRed: d.hours >= 6,
    }))
    return {
      division: m.division, headcount: m.headcount, severity,
      mainValue: `${row.count}`, mainUnit: '건',
      progressPct: (row.count / 5) * 100,
      captionLeft: `총 ${fmtH(row.hours)}`, captionRight: '전사 평균 참고',
      cells: [
        { label: '건수', value: `${row.count}`, color: '#1d4ed8' },
        { label: '시간', value: row.hours ? fmtH(row.hours) : '—' },
      ],
      listHeaderLabel: `휴일근로 ${rows.length}건`, listSortLabel: '시간 많은 순',
      rows,
      footerLabel: '부서 휴일근로', footerValue: `${row.count}건 · ${fmtH(row.hours)}`,
    }
  }

  function buildMonthCumulativeCard(m: (typeof metrics)[number]): DeptCardVM {
    const row = divisionLeaveCumulative.find(d => d.division === m.division) ?? { ratePct: 0, usedDays: 0, grantedDays: 0, headcount: m.headcount, division: m.division }
    const delta = row.ratePct - cumulativeBenchmarkPct
    const severity = delta >= 0 ? 'normal' : delta >= OVERVIEW_POLICY.leaveTargetWarnDeltaPp ? 'warning' : 'action'
    const remain = Math.max(0, row.grantedDays - row.usedDays)
    const people = employeeLeaveCumulative.filter(r => r.division === m.division)
    const rows: DeptCardPersonRow[] = people.slice(0, 6).map(p => ({
      key: p.employeeId, name: p.name,
      tag: { text: `${p.hireYear ?? '—'}년 입사 · ${p.grantedDays}일`, bg: '#f1f5f9', fg: '#475569' },
      value: `${fmtDays(p.usedDays)}/${p.grantedDays}일 · ${p.ratePct.toFixed(0)}%`,
      valueRed: p.ratePct < 45,
    }))
    return {
      division: m.division, headcount: m.headcount, severity,
      mainValue: row.ratePct.toFixed(1), mainUnit: '%',
      progressPct: row.ratePct, progressMarkerPct: cumulativeBenchmarkPct,
      captionLeft: `사용 ${fmtDays(row.usedDays)}일`, captionRight: `목표 ${cumulativeBenchmarkPct}%`,
      cells: [
        { label: '사용', value: `${fmtDays(row.usedDays)}일` },
        { label: '잔여', value: `${fmtDays(remain)}일`, color: remain > 8 ? '#dc2626' : undefined },
      ],
      listHeaderLabel: `사원 ${rows.length}명`, listSortLabel: '사용률 낮은 순',
      rows,
      footerLabel: '209h 초과', footerValue: `${overLimitByDivision.get(m.division) ?? 0}명`,
    }
  }

  function buildMonthSingleCard(m: (typeof metrics)[number]): DeptCardVM {
    const row = divisionLeaveSingle.find(d => d.division === m.division) ?? { ratePct: 0, usedDays: 0, grantedDays: 0 }
    const cumRow = divisionLeaveCumulative.find(d => d.division === m.division)
    const delta = row.ratePct - MONTHLY_ALLOCATION
    const severity = delta >= 0 ? 'normal' : delta >= OVERVIEW_POLICY.monthlyAllocationWarnDeltaPp ? 'warning' : 'action'
    const people = employeeLeaveSingle.filter(r => r.division === m.division && r.usedDays > 0).sort((a, b) => b.usedDays - a.usedDays)
    const rows: DeptCardPersonRow[] = people.slice(0, 6).map(p => ({
      key: p.employeeId, name: p.name,
      value: `${fmtDays(p.usedDays)}일 · ${p.grantedDays > 0 ? ((p.usedDays / p.grantedDays) * 100).toFixed(1) : '0'}%`,
    }))
    return {
      division: m.division, headcount: m.headcount, severity,
      mainValue: row.ratePct.toFixed(1), mainUnit: '%',
      progressPct: (row.ratePct / 15) * 100, progressMarkerPct: (MONTHLY_ALLOCATION / 15) * 100,
      captionLeft: `${monthLabel} 사용 ${fmtDays(row.usedDays)}일`, captionRight: `배분 ${MONTHLY_ALLOCATION.toFixed(1)}%`,
      cells: [
        { label: `${monthLabel} 사용`, value: `${fmtDays(row.usedDays)}일` },
        { label: '잔여', value: cumRow ? `${fmtDays(Math.max(0, cumRow.grantedDays - cumRow.usedDays))}일` : '—' },
      ],
      listHeaderLabel: `사용 인원 ${rows.length}명`, listSortLabel: '사용일수 많은 순',
      rows,
      footerLabel: '누적 목표차', footerValue: `${cumRow ? (cumRow.ratePct - cumulativeBenchmarkPct).toFixed(1) : '0.0'}%p`,
    }
  }

  const cardBuilder =
    period.granularity === 'day' ? buildDayCard
    : period.granularity === 'week' ? (weekTab === 'overtime' ? buildWeekOvertimeCard : buildWeekHolidayCard)
    : (monthBasis === 'cumulative' ? buildMonthCumulativeCard : buildMonthSingleCard)
  const metricsByDivision = new Map(metrics.map(m => [m.division, m]))
  const businessCards = BUSINESS_DIVISIONS.map(d => metricsByDivision.get(d)).filter((m): m is (typeof metrics)[number] => !!m).map(cardBuilder)
  const supportCards  = SUPPORT_DIVISIONS.map(d => metricsByDivision.get(d)).filter((m): m is (typeof metrics)[number] => !!m).map(cardBuilder)

  /** 구획(사업부/지원부) 헤더 우측 요약 3항목 — 카드 그리드와 같은 소스에서 그 구획 divisions만 다시 롤업. */
  function summaryForGroup(divisions: readonly string[]): DeptSectionSummaryItem[] {
    if (period.granularity === 'day') {
      const rateRows = divNormalRate.filter(r => divisions.includes(r.division))
      const normalSum = rateRows.reduce((s, r) => s + r.normal, 0)
      const totalSum = rateRows.reduce((s, r) => s + r.total, 0)
      const pct = totalSum > 0 ? (normalSum / totalSum) * 100 : 0
      const anomalyTotal = divAnomaly.filter(a => divisions.includes(a.label)).reduce((s, a) => s + a.total, 0)
      const absence = divisions.reduce((s, d) => s + (divLeave.find(l => l.label === d)?.count ?? 0) + (divOffsite.find(o => o.label === d)?.count ?? 0), 0)
      return [{ label: '출근율', value: `${pct.toFixed(1)}%` }, { label: '이상치', value: `${anomalyTotal}건` }, { label: '부재', value: `${absence}명` }]
    }
    if (period.granularity === 'week') {
      const groupMetrics = metrics.filter(m => divisions.includes(m.division))
      const groupHeadcount = groupMetrics.reduce((s, m) => s + m.headcount, 0)
      if (weekTab === 'overtime') {
        const riskCount = divisionRiskBands.filter(b => divisions.includes(b.division)).reduce((s, b) => s + b.caution + b.warning + b.danger, 0)
        const groupOtRows = divisionRecognizedOt.filter(d => divisions.includes(d.division))
        const groupOt = groupOtRows.reduce((s, d) => s + d.otHours, 0)
        const groupOtEligible = groupOtRows.reduce((s, d) => s + d.eligible, 0)
        const avgOt = groupHeadcount > 0 ? groupOt / groupHeadcount : 0
        return [{ label: '위험군', value: `${riskCount}명` }, { label: '주당 평균 연장', value: fmtH(avgOt) }, { label: '대상 인원', value: `${groupOtEligible}명` }]
      }
      const groupHoliday = divHoliday.filter(h => divisions.includes(h.label))
      const count = groupHoliday.reduce((s, h) => s + h.count, 0)
      const hours = groupHoliday.reduce((s, h) => s + h.hours, 0)
      return [{ label: '휴일근로', value: `${count}건` }, { label: '시간', value: fmtH(hours) }, { label: '발생 부문', value: `${groupHoliday.filter(h => h.count > 0).length} / ${divisions.length}개` }]
    }
    const groupLeave = (monthBasis === 'cumulative' ? divisionLeaveCumulative : divisionLeaveSingle).filter(d => divisions.includes(d.division))
    const g = groupLeave.reduce((s, d) => s + d.grantedDays, 0)
    const u = groupLeave.reduce((s, d) => s + d.usedDays, 0)
    const pct = g > 0 ? (u / g) * 100 : 0
    if (monthBasis === 'cumulative') {
      const over209 = overLimitRows.filter(r => divisions.includes(r.division)).length
      return [{ label: '연차 사용률', value: `${pct.toFixed(1)}%` }, { label: '목표차', value: `${(pct - cumulativeBenchmarkPct).toFixed(1)}%p` }, { label: '209h 초과', value: `${over209}명` }]
    }
    return [{ label: `${monthLabel} 단독 사용률`, value: `${pct.toFixed(1)}%` }, { label: '배분 대비', value: `${(pct - MONTHLY_ALLOCATION).toFixed(1)}%p` }, { label: `${monthLabel} 사용`, value: `${fmtDays(u)}일` }]
  }
  const businessSummary = summaryForGroup(BUSINESS_DIVISIONS)
  const supportSummary  = summaryForGroup(SUPPORT_DIVISIONS)

  const deptSectionSubtitle =
    period.granularity === 'day' ? '사업부 5개 → 지원부 5개 지정 순서 · 상세는 사원별 지각·미달·미태깅'
    : period.granularity === 'week' ? (weekTab === 'overtime' ? '연장근로만 표시 · 초과·위험 사원의 주 근로시간' : '휴일근로만 표시 · 근로일자·시간')
    : monthBasis === 'cumulative' ? `누적 기준 · 회계연도 발생 연차 대비 지금까지 쓴 비율 · 목표 ${cumulativeBenchmarkPct}%`
    : `단월 기준 · ${monthLabel}에 새로 쓴 연차만 · 월 배분 ${MONTHLY_ALLOCATION.toFixed(1)}% 대비`

  const overallSeverity: 'action' | 'warning' | 'normal' =
    [...businessCards, ...supportCards].some(c => c.severity === 'action') ? 'action'
    : [...businessCards, ...supportCards].some(c => c.severity === 'warning') ? 'warning' : 'normal'
  const headerSubtitle =
    period.granularity === 'day' ? '하루 단위에서는 누가 제자리에 있었는가가 핵심입니다'
    : period.granularity === 'week' ? '주 단위에서는 52시간 한도와 연장수당 / 휴일근로와 휴일수당이 핵심입니다'
    : '월 단위에서는 연차가 계획대로 소진되는가가 핵심입니다'

  if (!isLiveData) {
    return (
      <div className="p-8">
        <EmptyNote text="데이터를 먼저 업로드해주세요." />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* ── 헤더: 기간 선택 ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">종합 현황</h1>
          <p className="text-xs text-gray-400 mt-0.5">이상치 · 휴일근무 · 초과근무 · 휴가를 한눈에</p>
        </div>
        <PeriodSelector period={period} />
      </div>

      {/* ── 본부 필터 ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold text-gray-400 mr-0.5">본부</span>
        <button
          onClick={() => setSelectedDivision(null)}
          className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
            selectedDivision === null ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-blue-300'
          }`}
        >
          전체
        </button>
        {divisionOptions.map(d => (
          <button
            key={d}
            onClick={() => setSelectedDivision(prev => (prev === d ? null : d))}
            className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
              selectedDivision === d ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-blue-300'
            }`}
          >
            {d}
          </button>
        ))}
        <span className="text-[10.5px] text-gray-300 ml-1">선택한 본부 기준으로 아래 숫자·그래프가 전부 바뀝니다</span>
      </div>

      {/* ── v9 디자인 핸드오프: 근태 이상치 헤더 + (이상치/조직도 상위 탭은 기존 그대로 유지) ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[19px] font-extrabold text-gray-900 tracking-tight">근태 이상치</h2>
            <span
              className="text-[11.5px] font-extrabold text-white px-[11px] py-1 rounded-[7px]"
              style={{ background: overallSeverity === 'action' ? '#dc2626' : overallSeverity === 'warning' ? '#f59e0b' : '#16a34a' }}
            >
              {overallSeverity === 'action' ? '비정상' : overallSeverity === 'warning' ? '주의' : '정상'}
            </span>
          </div>
          <p className="text-[11.5px] text-gray-400">{headerSubtitle}</p>
          <span className="flex-1" />
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('anomaly')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'anomaly' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              이상치
            </button>
            <button
              onClick={() => setViewMode('chart')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'chart' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              조직도
            </button>
          </div>
        </div>

        {viewMode === 'chart' ? (
          <DivisionTeamGrid />
        ) : (
          <div className="space-y-3">
            {/* 1. 고정 3열 KPI — 탭을 바꿔도 이 틀은 그대로(v9 핵심 규칙) */}
            <KpiTileRow tiles={kpiTiles} />

            {/* 2. 연차 추이 차트 — 월 단위에서만 */}
            {period.granularity === 'month' && (
              <LeaveTrendChart
                mode={monthBasis} onModeChange={setMonthBasis}
                points={monthlyLeavePoints}
                legend={monthBasis === 'cumulative' ? [
                  { label: `${monthLabel} 누적 목표`, value: `${cumulativeBenchmarkPct}%` },
                  { label: `${monthLabel} 누적 실적`, value: `${leaveTotals.cumulativePct.toFixed(1)}%` },
                  { label: '격차', value: `${(leaveTotals.cumulativePct - cumulativeBenchmarkPct).toFixed(1)}%p` },
                  { label: '연말 예상 수당', value: '준비중' },
                ] : [
                  { label: '월 배분 목표', value: `${MONTHLY_ALLOCATION.toFixed(1)}%` },
                  { label: `${monthLabel} 단독 실적`, value: `${leaveTotals.singlePct.toFixed(1)}%` },
                  { label: '배분 대비', value: `${(leaveTotals.singlePct - MONTHLY_ALLOCATION).toFixed(1)}%p` },
                  { label: '누적 사용률', value: `${leaveTotals.cumulativePct.toFixed(1)}%` },
                ]}
                footnote={monthBasis === 'cumulative'
                  ? '누적 기준은 회계연도 발생 연차 대비 지금까지 쓴 비율을 그 달의 누적 목표와 비교합니다.'
                  : '단월 기준은 그 달에 새로 쓴 연차만 월 배분 목표와 비교합니다.'}
                stripTitle={monthBasis === 'cumulative' ? `${monthLabel} 한 달만 보면` : '누적으로 보면'}
                stripItems={monthBasis === 'cumulative' ? [
                  { label: `${monthLabel} 단독 사용률`, value: `${leaveTotals.singlePct.toFixed(1)}%` },
                  { label: '배분 대비', value: `${(leaveTotals.singlePct - MONTHLY_ALLOCATION).toFixed(1)}%p` },
                  { label: '209h 초과', value: `${overLimitRows.length}명` },
                ] : [
                  { label: `${monthLabel} 누적 사용률`, value: `${leaveTotals.cumulativePct.toFixed(1)}%` },
                  { label: '누적 목표', value: `${cumulativeBenchmarkPct}%` },
                  { label: '목표 대비', value: `${(leaveTotals.cumulativePct - cumulativeBenchmarkPct).toFixed(1)}%p` },
                ]}
              />
            )}

            {/* 3. 부서별 현황 — 사업부/지원부 두 구획, 주간에는 연장/휴일 하위탭 추가 */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <p className="text-[14.5px] font-bold text-gray-800">부서별 현황</p>
                <p className="text-[11px] text-gray-400">{deptSectionSubtitle}</p>
              </div>
              {period.granularity === 'week' && (
                <div className="flex bg-gray-100 rounded-lg p-0.5">
                  <button
                    onClick={() => setWeekTab('overtime')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${weekTab === 'overtime' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
                  >
                    연장근로
                  </button>
                  <button
                    onClick={() => setWeekTab('holiday')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${weekTab === 'holiday' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
                  >
                    휴일근로
                  </button>
                </div>
              )}
            </div>

            <DeptSection label="사업부" accent="#dc2626" cards={businessCards} summary={businessSummary} />
            <DeptSection label="지원부" accent="#2563eb" cards={supportCards} summary={supportSummary} />
          </div>
        )}
      </div>

      {/* ── 조직 정합성: 인력 마스터가 아직 연동 전이면(재직자 0명) 자동으로 숨김 + 지금은 SHOW_ORG_INTEGRITY로 전체 비활성 ── */}
      {SHOW_ORG_INTEGRITY && masterActive.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <KpiTile label="마스터 정원" value={masterActive.length} unit="명" color="#0f766e"
            sub="조직도 시트 기준 재직자 수"
            onClick={() => openAndScroll('orgIntegrity')} />
          <KpiTile label="조직 정합성 확인필요" value={masterDiscrepancies.length} unit="건" color="#c4291f"
            sub={masterDiscrepancies.length === 0 ? '마스터-CAPS 불일치 없음' : '눌러서 명단 보기'}
            onClick={() => openAndScroll('orgIntegrity')} />
        </div>
      )}

      {/* ── 상세 아코디언 (기본 접힘 — 타일 클릭 시 해당 항목만 펼쳐짐) ── */}
      {/* 본부별 비교 그래프는 각 섹션 안에 그래프→상세 순서로 함께 들어있다 (탭 분리 없음) */}
      <div className="space-y-3">
        <AccordionSection
          innerRef={el => { sectionRefs.current.anomaly = el }}
          icon="⚠️" title="근태 이상치 상세" subtitle="지각 · 근무시간 미달 · 미태깅"
          isOpen={openSection === 'anomaly'} onToggle={() => toggleSection('anomaly')}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Box className="!bg-blue-600 !text-white flex items-center gap-4">
              <div className="w-16 h-16 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[{ value: normalRate.normal }, { value: Math.max(0, normalRate.total - normalRate.normal) }]}
                      dataKey="value" innerRadius={22} outerRadius={32} startAngle={90} endAngle={-270} stroke="none"
                    >
                      {PIE_COLORS.map((c, i) => <Cell key={i} fill={i === 0 ? '#ffffff' : 'rgba(255,255,255,0.25)'} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div>
                <p className="text-[11px] opacity-80">정상 출근율</p>
                <p className="text-2xl font-bold tabular-nums">{normalRate.pct.toFixed(1)}%</p>
                <p className="text-[11px] opacity-70 tabular-nums">({normalRate.normal}/{normalRate.total})</p>
              </div>
            </Box>
            <Box className="flex flex-col justify-center gap-2">
              <p className="text-[11px] text-gray-400 uppercase tracking-wide">이상 건수 합계</p>
              <AnomalyMetricBadges m={{ ...anomalyTotals, leave: 0 }} size="lg" />
            </Box>
            <Box>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">부서별 TOP3</p>
              {divAnomaly.length === 0 ? <p className="text-xs text-gray-300">이상 없음</p> : (
                <ul className="space-y-1">
                  {divAnomaly.slice(0, 3).map(r => (
                    <li key={r.key} className="flex items-center justify-between text-xs">
                      <span className="text-gray-600 truncate">{r.label}</span>
                      <span className="font-semibold text-gray-800 tabular-nums">{r.total}건</span>
                    </li>
                  ))}
                </ul>
              )}
            </Box>
          </div>

          {period.granularity !== 'day' && (
            <div>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">본부별 비교</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <DivisionCompareChart title="지각" color="#b4650a" unit="건" data={compareLate} compact />
                <DivisionCompareChart title="근무시간 미달" color="#c4291f" unit="건" data={compareShortage} compact />
                <DivisionCompareChart title="미태깅" color="#c4291f" unit="건" data={compareNotag} compact />
              </div>
            </div>
          )}

          {empAnomaly.length === 0 ? <EmptyNote text="이 기간엔 이상치가 없습니다." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="text-left py-2 font-medium">부서</th>
                    <th className="text-left py-2 font-medium">이름</th>
                    <th className="text-right py-2 font-medium">지각</th>
                    <th className="text-right py-2 font-medium">근무시간 미달</th>
                    <th className="text-right py-2 font-medium">미태깅</th>
                    <th className="text-right py-2 font-medium">총합계</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {empAnomaly.map(r => (
                    <tr key={r.key} className="hover:bg-gray-50/70">
                      <td className="py-1.5 text-gray-500">{r.division}</td>
                      <td className="py-1.5 font-medium text-gray-800">{r.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.late || '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.shortage || '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.notag || '—'}</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AccordionSection>

        <AccordionSection
          innerRef={el => { sectionRefs.current.holiday = el }}
          icon="☀️" title="휴일근무 상세" subtitle="휴일 실근무 시간 · 인원"
          isOpen={openSection === 'holiday'} onToggle={() => toggleSection('holiday')}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Box className="md:col-span-2">
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">
                부서별 휴일근무 시간 (합계 {fmtH(totalHolidayH)})
              </p>
              {divHoliday.length === 0 ? <p className="text-xs text-gray-300">휴일근무 내역 없음</p> : (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={divHoliday} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f3f4f6" />
                      <XAxis type="number" tick={{ fontSize: 10 }} />
                      <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v: unknown) => [fmtH(Number(v ?? 0)), '휴일근무']} />
                      <Bar dataKey="hours" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Box>
            <Box>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">오늘 휴일근무</p>
              {todayHoliday.length === 0 ? <p className="text-xs text-gray-300 py-4 text-center">오늘은 휴일근무 인원이 없습니다.</p> : (
                <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                  {todayHoliday.map(e => (
                    <li key={e.employeeId} className="flex items-center justify-between text-xs">
                      <span className="text-gray-700">{e.name} <span className="text-gray-300 text-[10px]">{e.division}</span></span>
                      <span className="text-purple-600 font-semibold tabular-nums">{fmtH(e.hours)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Box>
          </div>

          {empHoliday.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="text-left py-2 font-medium">부서</th>
                    <th className="text-left py-2 font-medium">이름</th>
                    <th className="text-right py-2 font-medium">휴일근무 시간</th>
                    <th className="text-right py-2 font-medium">일수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {empHoliday.map(r => (
                    <tr key={r.key} className="hover:bg-gray-50/70">
                      <td className="py-1.5 text-gray-500">{r.division}</td>
                      <td className="py-1.5 font-medium text-gray-800">{r.label}</td>
                      <td className="py-1.5 text-right tabular-nums font-semibold">{fmtH(r.hours)}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AccordionSection>

        <AccordionSection
          innerRef={el => { sectionRefs.current.ot = el }}
          icon="⏱️" title="연장근로 상세"
          subtitle={period.granularity === 'day' ? '오늘 초과근무 발생 인원' : `${otTileLabel} — 법정 ${overLimitHours}시간 관리 대상`}
          isOpen={openSection === 'ot'} onToggle={() => toggleSection('ot')}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Box className="md:col-span-2">
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">
                일자별 초과근무 인원 (기간 합계 {fmtH(totalOtH)})
              </p>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyOt} margin={{ top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                    <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} angle={dailyOt.length > 10 ? -45 : 0} textAnchor={dailyOt.length > 10 ? 'end' : 'middle'} height={dailyOt.length > 10 ? 40 : 20} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v: unknown) => [`${Number(v ?? 0)}명`, '초과근무']} />
                    <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Box>
            <Box>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">오늘 초과근무</p>
              {todayOt.length === 0 ? <p className="text-xs text-gray-300 py-4 text-center">배정된 초과근무가 없습니다.</p> : (
                <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                  {todayOt.map(e => (
                    <li key={e.employeeId} className="flex items-center justify-between text-xs">
                      <span className="text-gray-700">{e.name} <span className="text-gray-300 text-[10px]">{e.division}</span></span>
                      <span className="text-blue-600 font-semibold tabular-nums">{fmtH(e.hours)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Box>
          </div>

          {period.granularity !== 'day' && (
            <DivisionCompareChart title={`본부별 ${otTileLabel}`} color="#2f6fed" unit="명" data={compareOt} />
          )}

          {period.granularity !== 'day' && (
            <div>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">
                {otTileLabel} ({overLimitRows.length}명) — 기준 {overLimitHours}h 초과분만 표시
              </p>
              {overLimitRows.length === 0 ? <EmptyNote text={`기준(${overLimitHours}h) 초과 인원이 없습니다.`} /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 text-gray-400">
                        <th className="text-left py-2 font-medium">부서</th>
                        <th className="text-left py-2 font-medium">이름</th>
                        <th className="text-right py-2 font-medium">{period.granularity === 'week' ? '주간' : '월간'} 총 근로시간</th>
                        <th className="text-right py-2 font-medium">초과분</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {overLimitRows.map(r => (
                        <tr key={r.employeeId} className="hover:bg-gray-50/70">
                          <td className="py-1.5 text-gray-500">{r.division}</td>
                          <td className="py-1.5 font-medium text-gray-800">{r.name}</td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">{fmtH(r.hours)}</td>
                          <td className="py-1.5 text-right tabular-nums text-red-600 font-semibold">+{fmtH(r.overBy)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-gray-400">
                  <th className="text-left py-2 font-medium">부서</th>
                  <th className="text-right py-2 font-medium">인원</th>
                  <th className="text-right py-2 font-medium">연장/야간/휴일 합계</th>
                  {period.granularity !== 'day' && <th className="text-right py-2 font-medium">{overLimitHours}h 초과</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {metrics.map(m => (
                  <tr key={m.division} className="hover:bg-gray-50/70">
                    <td className="py-1.5 text-gray-700 font-medium">{m.division}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.headcount}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtH(m.otHours)}</td>
                    {period.granularity !== 'day' && (
                      <td className="py-1.5 text-right tabular-nums">
                        {(overLimitByDivision.get(m.division) ?? 0) > 0 ? `${overLimitByDivision.get(m.division)}명` : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AccordionSection>

        <AccordionSection
          innerRef={el => { sectionRefs.current.leave = el }}
          icon="🏖️" title="휴가 사용 상세" subtitle="부서 · 인원별 사용 현황"
          isOpen={openSection === 'leave'} onToggle={() => toggleSection('leave')}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Box className="md:col-span-2">
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">
                부서별 사용일수 (합계 {fmtDays(totalLeaveDays)}일)
              </p>
              {divLeave.length === 0 ? <p className="text-xs text-gray-300">사용 내역 없음</p> : (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={divLeave} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f3f4f6" />
                      <XAxis type="number" tick={{ fontSize: 10 }} />
                      <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v: unknown) => [`${fmtDays(Number(v ?? 0))}일`, '사용일수']} />
                      <Bar dataKey="days" fill="#10b981" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Box>
            <Box>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">오늘 휴가 중</p>
              {todayLeave.length === 0 ? <p className="text-xs text-gray-300 py-4 text-center">오늘은 휴가 인원이 없습니다.</p> : (
                <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                  {todayLeave.map(e => (
                    <li key={e.employeeId} className="flex items-center justify-between text-xs">
                      <span className="text-gray-700">{e.name} <span className="text-gray-300 text-[10px]">{e.division}</span></span>
                      <span className="text-emerald-600 font-medium">{e.leaveType}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Box>
          </div>

          {empLeave.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="text-left py-2 font-medium">부서</th>
                    <th className="text-left py-2 font-medium">이름</th>
                    <th className="text-right py-2 font-medium">사용일수</th>
                    <th className="text-right py-2 font-medium">건수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {empLeave.map(r => (
                    <tr key={r.key} className="hover:bg-gray-50/70">
                      <td className="py-1.5 text-gray-500">{r.division}</td>
                      <td className="py-1.5 font-medium text-gray-800">{r.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtDays(r.days)}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AccordionSection>

        {SHOW_ORG_INTEGRITY && masterActive.length > 0 && (
          <AccordionSection
            innerRef={el => { sectionRefs.current.orgIntegrity = el }}
            icon="🗂️" title="조직 정합성" subtitle="조직도 시트 인력 마스터 vs CAPS 업로드 대조"
            isOpen={openSection === 'orgIntegrity'} onToggle={() => toggleSection('orgIntegrity')}
          >
            {masterDiscrepancies.length === 0 ? (
              <EmptyNote text="마스터와 CAPS 데이터가 모두 일치합니다." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 text-gray-400">
                      <th className="text-left py-2 font-medium">구분</th>
                      <th className="text-left py-2 font-medium">이름</th>
                      <th className="text-left py-2 font-medium">부서</th>
                      <th className="text-left py-2 font-medium">사원번호</th>
                      <th className="text-left py-2 font-medium">내용</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {masterDiscrepancies.map(d => (
                      <tr key={`${d.type}_${d.rawId}`} className="hover:bg-gray-50/70">
                        <td className="py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            d.type === 'MASTER_ACTIVE_NOT_IN_CAPS' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'
                          }`}>
                            {d.type === 'MASTER_ACTIVE_NOT_IN_CAPS' ? '마스터→CAPS 미확인' : 'CAPS→마스터 미등록'}
                          </span>
                        </td>
                        <td className="py-1.5 font-medium text-gray-800">{d.name}</td>
                        <td className="py-1.5 text-gray-500">{d.division}</td>
                        <td className="py-1.5 text-gray-400 tabular-nums">{d.rawId}</td>
                        <td className="py-1.5 text-gray-500">{d.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AccordionSection>
        )}
      </div>
    </div>
  )
}

// 연차/반차/반반차 = 1/0.5/0.25일 단위 — toFixed(1)을 쓰면 0.25→"0.3", 0.75→"0.8"로
// 반올림돼 반반차가 반차처럼 보이는 표시 버그가 생긴다. 2자리까지 보여주되 불필요한
// 후행 0은 잘라낸다 (0.25일/0.5일/0.75일/1일).
function fmtDays(days: number): string {
  return (Math.round(days * 100) / 100).toString()
}

function fmtH(hours: number): string {
  if (!hours) return '0h'
  const m = Math.round(hours * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}
