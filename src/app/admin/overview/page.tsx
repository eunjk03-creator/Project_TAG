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
import { DivisionSummaryCardGrid } from '@/components/admin/DivisionSummaryCardGrid'
import { AnomalyPersonTable } from '@/components/admin/AnomalyPersonTable'
import { useOrgMasterHeadcount } from '@/hooks/useOrgMasterHeadcount'
import { useMasterActiveRoster } from '@/hooks/useMasterActiveRoster'
import {
  buildDivisionAnomalyRollup, buildEmployeeAnomalyRollup, computeNormalRate,
  buildLeaveUsageRollup, buildTodayLeaveList,
  buildDailyOvertimeSeries, buildTodayOvertimeList,
  buildHolidayWorkRollup, buildTodayHolidayList,
  buildOffsiteRollup, buildTodayOffsiteList,
  computeOverLimitEmployees, computeWeeklyRiskBuckets,
  buildDivisionNormalRateRollup, buildWeeklyAnomalySeries,
  buildMasterDiscrepancyRollup,
} from '@/utils/overviewAggregations'
import { DIVISION_ORDER } from '@/data/orgChart'
import type { Employee } from '@/types/tag'

function todayStrFrom(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayStr(): string {
  return todayStrFrom(new Date())
}

const PIE_COLORS = ['#3b82f6', '#e5e7eb'] // 정상(blue) / 이상(gray)

type SectionKey = 'anomaly' | 'holiday' | 'ot' | 'leave' | 'orgIntegrity'

// ── Small shared UI bits ────────────────────────────────────────────────────

function Box({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`bg-gray-50 rounded-xl px-5 py-4 ${className}`}>{children}</div>
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-400 text-center py-6">{text}</p>
}

/** Zone1 슬롯2 전용 — 일/주/월 공통으로 쓰는 이상치 미니 카드(sm 뱃지). */
function AnomalySlotCard({
  late, shortage, notag, sub, onClick,
}: { late: number; shortage: number; notag: number; sub?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-white border border-gray-100 rounded-xl px-4 py-3.5 shadow-sm hover:shadow hover:-translate-y-px transition-all"
    >
      <p className="text-xs font-semibold text-gray-400 mb-2">근태 이상치</p>
      <AnomalyMetricBadges m={{ late, shortage, notag, leave: 0 }} />
      {sub && <p className="text-[11px] text-gray-400 mt-2 truncate">{sub}</p>}
    </button>
  )
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
  const weeklyRiskByDivision = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of weeklyRisk.rows) m.set(r.division, (m.get(r.division) ?? 0) + 1)
    return [...m.entries()].map(([division, count]) => ({ division, count })).sort((a, b) => b.count - a.count)
  }, [weeklyRisk])

  // ── 월간 Zone2 전용 — 본부별 정상출근율 정합성표 + 주차별 이상치 추이 ────────────
  const divNormalRate = useMemo(
    () => period.granularity === 'month' ? buildDivisionNormalRateRollup(scopedRecords, empMap) : [],
    [scopedRecords, empMap, period.granularity],
  )
  const weeklyAnomalySeries = useMemo(
    () => period.granularity === 'month' ? buildWeeklyAnomalySeries(scopedRecords, period.from, period.to) : [],
    [scopedRecords, period.from, period.to, period.granularity],
  )

  // ── Zone2 뷰 토글 — 🏢 조직도 카드 / 📋 이상치 목록 ──────────────────────────
  const [viewMode, setViewMode] = useState<'chart' | 'anomaly'>('chart')

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

      {/* ── Zone1: 일/주/월 전환해도 슬롯 4개의 틀은 고정, 슬롯 안의 지표만 바뀐다 ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* 슬롯1 — 출근율/위험군/초과자 */}
        {period.granularity === 'day' && (
          <KpiTile label="오늘 정상출근율" value={normalRate.pct.toFixed(1)} unit="%" color="#2f6fed"
            sub={`(${normalRate.normal}/${normalRate.total})`}
            onClick={() => openAndScroll('anomaly')} />
        )}
        {period.granularity === 'week' && (
          <KpiTile label="주 52시간 위험군" value={weeklyRisk.danger} unit="명" color="#c4291f"
            sub={`주의 ${weeklyRisk.caution} · 경고 ${weeklyRisk.warning} · 위험 ${weeklyRisk.danger}`}
            onClick={() => openAndScroll('ot')} />
        )}
        {period.granularity === 'month' && (
          <KpiTile label="월 209시간 초과자" value={overLimitRows.length} unit="명" color="#c4291f"
            sub={`기준 ${overLimitHours}h`}
            onClick={() => openAndScroll('ot')} />
        )}

        {/* 슬롯2 — 이상치(지각/미달/미태깅), 일/주/월 공통 형태 */}
        <AnomalySlotCard
          late={anomalyTotals.late} shortage={anomalyTotals.shortage} notag={anomalyTotals.notag}
          sub={period.granularity === 'month' && divAnomaly[0] ? `최다발생 ${divAnomaly[0].label}` : undefined}
          onClick={() => openAndScroll('anomaly')}
        />

        {/* 슬롯3 — 근무시간/수당 */}
        {period.granularity === 'day' && (
          <KpiTile label="오늘 초과근무" value={todayOt.length} unit="명" color="#2f6fed"
            sub={`기간 합계 ${fmtH(totalOtH)}`}
            onClick={() => openAndScroll('ot')} />
        )}
        {period.granularity === 'week' && (
          <KpiTile label="주간 평균 실근무시간" value={fmtH(total.headcount > 0 ? total.totalHours / total.headcount : 0)} color="#2f6fed"
            sub={`전체 ${total.headcount}명 기준`}
            onClick={() => openAndScroll('ot')} />
        )}
        {period.granularity === 'month' && (
          <KpiTile label="월간 총 초과근로시간" value={fmtH(totalOtH)} color="#2f6fed"
            sub="전사 누적 합계"
            onClick={() => openAndScroll('ot')} />
        )}

        {/* 슬롯4 — 부재/휴가 (월간 "소진율"은 부여일수 데이터가 없어 1차는 누적사용일수만 표시) */}
        {period.granularity === 'day' && (
          <KpiTile label="오늘의 부재현황" value={todayLeave.length + todayOffsite.length} unit="명" color="#6d3fd1"
            sub={`휴가 ${todayLeave.length} · 외근 ${todayOffsite.length}`}
            onClick={() => openAndScroll('leave')} />
        )}
        {period.granularity === 'week' && (
          <KpiTile label="주간 휴가·부재 현황" value={empLeave.length} unit="명" color="#6d3fd1"
            sub={`휴가 ${empLeave.length}명 · 외근 ${totalOffsiteCount}건`}
            onClick={() => openAndScroll('leave')} />
        )}
        {period.granularity === 'month' && (
          <KpiTile label="연차 소진율" value={fmtDays(totalLeaveDays)} unit="일" color="#6d3fd1"
            sub="누적 사용일수 · 소진율(%) 계산은 준비중"
            onClick={() => openAndScroll('leave')} />
        )}
      </div>

      {/* ── Zone2: 🏢 조직도 카드 뷰 / 📋 이상치 목록 뷰 토글 ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs font-semibold text-gray-400">부서별 현황</p>
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('chart')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'chart' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              🏢 조직도 카드
            </button>
            <button
              onClick={() => setViewMode('anomaly')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'anomaly' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              📋 이상치 목록
            </button>
          </div>
        </div>

        {viewMode === 'chart' ? (
          <DivisionSummaryCardGrid
            divisions={metrics}
            divAnomaly={divAnomaly}
            divLeave={divLeave}
            divHoliday={divHoliday}
            showHolidayBadge={period.granularity !== 'day' || isHolidayToday}
          />
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <AnomalyPersonTable
              rows={empAnomaly.map(r => ({ key: r.key, name: r.label, division: r.division, late: r.late, shortage: r.shortage, notag: r.notag, total: r.total }))}
              showDivisionCol
            />
          </div>
        )}

        {period.granularity === 'week' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <DivisionCompareChart
              title="본부별 주간 평균 근로시간" color="#2f6fed" unit="h"
              data={metrics.map(m => ({ label: m.division, value: m.headcount > 0 ? Math.round((m.totalHours / m.headcount) * 10) / 10 : 0 })).filter(r => r.value > 0)}
            />
            <Box>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">주 52h 위험군 랭킹</p>
              {weeklyRiskByDivision.length === 0 ? <p className="text-xs text-gray-300">위험군 없음</p> : (
                <ul className="space-y-1">
                  {weeklyRiskByDivision.map(r => (
                    <li key={r.division} className="flex items-center justify-between text-xs">
                      <span className="text-gray-600 truncate">{r.division}</span>
                      <span className="font-semibold text-red-600 tabular-nums">{r.count}명</span>
                    </li>
                  ))}
                </ul>
              )}
            </Box>
          </div>
        )}

        {period.granularity === 'month' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Box>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">본부별 정상출근율 · 이상치</p>
              {divNormalRate.length === 0 ? <p className="text-xs text-gray-300">데이터 없음</p> : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 text-gray-400">
                      <th className="text-left py-1.5 font-medium">부서</th>
                      <th className="text-right py-1.5 font-medium">정상출근율</th>
                      <th className="text-right py-1.5 font-medium">이상치 합계</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {divNormalRate.map(r => (
                      <tr key={r.division} className="hover:bg-gray-50/70">
                        <td className="py-1.5 text-gray-700 font-medium">{r.division}</td>
                        <td className="py-1.5 text-right tabular-nums">{r.pct.toFixed(1)}%</td>
                        <td className="py-1.5 text-right tabular-nums">{divAnomaly.find(a => a.label === r.division)?.total ?? 0}건</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Box>
            <DivisionCompareChart
              title="주차별 이상치 추이" color="#c4291f" unit="건"
              data={weeklyAnomalySeries.map(w => ({ label: w.label, value: w.total }))}
            />
          </div>
        )}
      </div>

      {/* ── 조직 정합성: 인력 마스터가 아직 연동 전이면(재직자 0명) 자동으로 숨김 ── */}
      {masterActive.length > 0 && (
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

        {masterActive.length > 0 && (
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
