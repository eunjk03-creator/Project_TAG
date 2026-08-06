'use client'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { DIVISION_ORDER } from '@/data/orgChart'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { usePeriodRange, type PeriodGranularity } from '@/hooks/usePeriodRange'
import { computeNormalRate } from '@/utils/overviewAggregations'
import { flagToAnomalyCategories } from '@/utils/attendanceCalc'
import type { Employee, ProcessedRecord } from '@/types/tag'

const BUSINESS_DIVISIONS = DIVISION_ORDER.slice(0, 5)   // 사업조직 — HMR/음료/헬스케어/뷰티/신사업본부
const SUPPORT_DIVISIONS = DIVISION_ORDER.slice(5)       // 지원조직 — 경영기획/피플/SCM/GTM/HQ
const HEATMAP_ORDER = ['임원', ...SUPPORT_DIVISIONS, ...BUSINESS_DIVISIONS]

/** "조직도" = 지금처럼 직책·성명·직무 트리, "이상치" = 같은 자리에 이상치 발생자 목록 —
 *  두 정보가 한 화면에 뭉쳐 있으면 못 알아본다는 피드백으로 토글로 분리. */
type ViewMode = 'chart' | 'anomaly'

/** 종합현황과 동일한 4개 지표 — "이상치 N건"으로 뭉뜽그리지 않고 지각/미달/미태깅/휴가를
 *  각각 다른 색으로 분리해서 보여준다(뭉쳐 있으면 뭐가 문제인지 안 보인다는 피드백 반영). */
interface DivisionMetrics {
  late: number
  shortage: number
  notag: number
  leave: number
  normal: number
  totalRecords: number
}

function emptyMetrics(): DivisionMetrics {
  return { late: 0, shortage: 0, notag: 0, leave: 0, normal: 0, totalRecords: 0 }
}

function computeMetrics(records: ProcessedRecord[]): DivisionMetrics {
  const m = emptyMetrics()
  for (const r of records) {
    if (r.leaveType) m.leave++
    if (r.flag) {
      for (const cat of flagToAnomalyCategories(r.flag)) {
        if (cat === 'late') m.late++
        else if (cat === 'shortage') m.shortage++
        else if (cat === 'notag') m.notag++
      }
    }
  }
  // 종합현황의 출근율과 동일 기준(평일 & 연차 제외) — 분모를 records.length가 아니라
  // 이 필터링된 total로 맞춰야 "정상출근율" 숫자가 종합현황과 일치한다.
  const rate = computeNormalRate(records)
  m.normal = rate.normal
  m.totalRecords = rate.total
  return m
}

interface PersonAnomalyRow {
  rawId: string
  name: string
  team: string
  late: number
  shortage: number
  notag: number
  total: number
}

interface RosterRow {
  division: string
  team: string
  title: string
  name: string
  jobFunction: string | null
  isConcurrent: boolean
  rawId: string | null
}

interface RosterResponse {
  tabName: string | null
  syncedAt: string | null
  sheetTotals: Record<string, number>
  rows: RosterRow[]
}

interface DivisionGroup {
  name: string
  headcount: number
  teams: { name: string; rows: RosterRow[] }[]
}

/** division/team을 로스터에 처음 등장한 순서 그대로 그룹핑 — 엑셀 원본의 좌→우, 위→아래
 *  순서를 그대로 유지해서 PDF로 보던 배치와 웹에서 보는 순서가 일치하게 한다. */
function groupInOrder(rows: RosterRow[]): DivisionGroup[] {
  const divisions: { name: string; rows: RosterRow[] }[] = []
  const divisionIndex = new Map<string, number>()

  for (const row of rows) {
    let di = divisionIndex.get(row.division)
    if (di === undefined) {
      di = divisions.length
      divisionIndex.set(row.division, di)
      divisions.push({ name: row.division, rows: [] })
    }
    divisions[di].rows.push(row)
  }

  return divisions.map(({ name, rows: divRows }) => {
    const teams: { name: string; rows: RosterRow[] }[] = []
    const teamIndex = new Map<string, number>()
    for (const row of divRows) {
      let ti = teamIndex.get(row.team)
      if (ti === undefined) {
        ti = teams.length
        teamIndex.set(row.team, ti)
        teams.push({ name: row.team, rows: [] })
      }
      teams[ti].rows.push(row)
    }
    return { name, headcount: divRows.length, teams }
  })
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-300 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function PersonRow({ p }: { p: RosterRow }) {
  const unmatched = p.rawId === null
  return (
    <tr className={unmatched ? 'text-gray-300' : 'text-gray-700'}>
      <td className="py-1 pr-3 text-xs whitespace-nowrap">{p.title}</td>
      <td className="py-1 pr-3 text-xs font-medium whitespace-nowrap">
        {p.name}
        {p.isConcurrent && <span className="text-amber-500 ml-0.5" title="겸임">*</span>}
        {unmatched && (
          <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-400 font-normal">미매칭</span>
        )}
      </td>
      <td className="py-1 text-xs text-gray-400 truncate max-w-[220px]">{p.jobFunction ?? ''}</td>
    </tr>
  )
}

function TeamHeaderRow({ name, count, anomalies }: { name: string; count: number; anomalies: number }) {
  return (
    <tr>
      <td colSpan={3} className="pt-2.5 pb-1">
        <span className="text-[11px] font-semibold text-gray-500 bg-gray-50 rounded px-2 py-0.5">
          {name} <span className="text-gray-400 font-normal">({count}명)</span>
          {anomalies > 0 && <span className="text-red-500 font-normal ml-1">이상치 {anomalies}건</span>}
        </span>
      </td>
    </tr>
  )
}

/** 지각/근무미달/미태깅 — "이상치" 3종만 색으로 뚜렷이 분리(종합현황 KPI 타일과 동일 색:
 *  지각=amber, 미달·미태깅=red). 휴가는 이상치가 아니라서 여기 안 섞고 별도 뱃지로 뺐다
 *  (종합현황도 "근태 이상치 상세"와 "휴가 사용 상세"를 서로 다른 카드로 분리해서 보여줌). */
function MetricBadges({ m, size = 'sm' }: { m: DivisionMetrics; size?: 'sm' | 'lg' }) {
  const items = [
    { label: '지각', value: m.late, color: size === 'lg' ? '#b4650a' : 'text-amber-600' },
    { label: '미달', value: m.shortage, color: size === 'lg' ? '#c4291f' : 'text-red-600' },
    { label: '미태깅', value: m.notag, color: size === 'lg' ? '#c4291f' : 'text-red-600' },
  ]
  if (size === 'lg') {
    return (
      <div className="grid grid-cols-3 divide-x divide-gray-100">
        {items.map(it => (
          <div key={it.label} className="px-3 first:pl-0">
            <p className="text-xs text-gray-400 font-medium mb-0.5">{it.label}</p>
            <p className="text-2xl font-extrabold tabular-nums leading-tight" style={{ color: it.color as string }}>
              {it.value}<span className="text-xs font-semibold text-gray-300 ml-0.5">건</span>
            </p>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5">
      {items.map(it => (
        <span key={it.label} className={`text-[10px] font-semibold whitespace-nowrap ${it.color as string}`}>
          {it.label} {it.value}
        </span>
      ))}
    </div>
  )
}

function LeaveBadge({ count }: { count: number }) {
  if (count === 0) return null
  return <span className="text-[11px] font-medium text-violet-300">휴가 {count}</span>
}

/** "이상치" 모드에서 조직트리 대신 보여줄, 종합현황 person-table의 division 축소판.
 *  부서 컬럼 없이(이미 이 카드=그 부서) 팀·이름·지각·미달·미태깅·총합계만. */
function AnomalyTable({ rows }: { rows: PersonAnomalyRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-gray-300 text-center py-6">이 기간 이상치 없음</p>
  }
  return (
    <table className="w-full">
      <thead>
        <tr className="text-[10px] text-gray-300 uppercase tracking-wide border-b border-gray-100">
          <th className="text-left pb-1.5 font-medium">팀</th>
          <th className="text-left pb-1.5 font-medium">이름</th>
          <th className="text-right pb-1.5 font-medium">지각</th>
          <th className="text-right pb-1.5 font-medium">미달</th>
          <th className="text-right pb-1.5 font-medium">미태깅</th>
          <th className="text-right pb-1.5 font-medium">합계</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map(r => (
          <tr key={r.rawId}>
            <td className="py-1 text-xs text-gray-400 truncate max-w-[100px]">{r.team}</td>
            <td className="py-1 text-xs font-medium text-gray-800 whitespace-nowrap">{r.name}</td>
            <td className="py-1 text-xs text-right tabular-nums text-amber-600">{r.late || '—'}</td>
            <td className="py-1 text-xs text-right tabular-nums text-red-600">{r.shortage || '—'}</td>
            <td className="py-1 text-xs text-right tabular-nums text-red-600">{r.notag || '—'}</td>
            <td className="py-1 text-xs text-right tabular-nums font-bold text-gray-800">{r.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DivisionCard({
  division, isOpen, onToggle, metrics, teamAnomalies, viewMode, personAnomalies,
}: {
  division: DivisionGroup; isOpen: boolean; onToggle: () => void
  metrics: DivisionMetrics; teamAnomalies: Map<string, number>
  viewMode: ViewMode; personAnomalies: PersonAnomalyRow[]
}) {
  return (
    <section id={`div-${division.name}`} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 text-white hover:bg-gray-700 transition-colors"
      >
        <span className="text-sm font-semibold truncate">{division.name}</span>
        <span className="flex items-center gap-2 shrink-0">
          <LeaveBadge count={metrics.leave} />
          <span className="text-xs font-medium text-gray-300 tabular-nums">{division.headcount}명</span>
        </span>
      </button>
      <div className="px-4 py-2.5 border-b border-gray-50 bg-gray-50/60">
        <MetricBadges m={metrics} />
      </div>
      <button onClick={onToggle} className="w-full flex items-center justify-center py-1 text-gray-300 hover:bg-gray-50">
        <ChevronIcon open={isOpen} />
      </button>
      {isOpen && (
        <div className="p-3 max-h-[480px] overflow-y-auto">
          {viewMode === 'anomaly' ? (
            <AnomalyTable rows={personAnomalies} />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-gray-300 uppercase tracking-wide">
                  <th className="text-left pb-1 font-medium w-14">직책</th>
                  <th className="text-left pb-1 font-medium w-20">성명</th>
                  <th className="text-left pb-1 font-medium">직무</th>
                </tr>
              </thead>
              <tbody>
                {division.teams.map(team => (
                  <Fragment key={team.name}>
                    {team.name !== division.name && (
                      <TeamHeaderRow name={team.name} count={team.rows.length} anomalies={teamAnomalies.get(team.name) ?? 0} />
                    )}
                    {team.rows.map((p, i) => <PersonRow key={`${team.name}-${i}-${p.name}`} p={p} />)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}

function HeatmapTile({
  name, headcount, metrics, onClick,
}: { name: string; headcount: number; metrics: DivisionMetrics; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 text-left shadow-sm hover:shadow transition-shadow"
    >
      <p className="text-[11px] font-semibold text-gray-700 truncate">{name}</p>
      <p className="text-base font-extrabold tabular-nums leading-tight text-gray-900 mb-1.5">
        {headcount}<span className="text-[10px] font-medium text-gray-400 ml-0.5">명</span>
      </p>
      <MetricBadges m={metrics} />
    </button>
  )
}

export default function OrgChartPage() {
  const [roster, setRoster] = useState<RosterResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<ViewMode>('chart')
  const period = usePeriodRange()

  useEffect(() => {
    fetch('/api/org-sync/latest-roster')
      .then(r => r.json())
      .then((data: RosterResponse & { error?: string }) => {
        if (data.error) throw new Error(data.error)
        setRoster(data)
      })
      .catch(err => setError(String(err)))
      .finally(() => setIsLoading(false))
  }, [])

  const allDivisions = useMemo(() => groupInOrder(roster?.rows ?? []), [roster])
  const byName = useMemo(() => new Map(allDivisions.map(d => [d.name, d])), [allDivisions])
  const execDivision = byName.get('임원') ?? null
  const businessDivisions = BUSINESS_DIVISIONS.map(name => byName.get(name)).filter((d): d is DivisionGroup => !!d)
  const supportDivisions = SUPPORT_DIVISIONS.map(name => byName.get(name)).filter((d): d is DivisionGroup => !!d)
  const knownNames = new Set(['임원', ...BUSINESS_DIVISIONS, ...SUPPORT_DIVISIONS])
  const otherDivisions = allDivisions.filter(d => !knownNames.has(d.name))

  const unmatchedCount = useMemo(() => (roster?.rows ?? []).filter(r => r.rawId === null).length, [roster])
  const allNames = useMemo(() => allDivisions.map(d => d.name), [allDivisions])

  // ── 종합현황과 동일한 기준으로 선택 기간(일/주/월)의 지각/미달/미태깅/휴가/정상출근율을
  // division별로 집계 — buildDivisionAnomalyRollup 대신 직접 묶는 이유는 division마다
  // "정상출근율"까지 따로 계산해야 해서(그 함수는 이상치 있는 레코드만 모음). ──────────────
  const { records, employees } = useProcessedAttendance(period.from, period.to)
  const { resolutions } = useAttendanceData()
  const approvedKeys = useMemo(() => new Set(Object.keys(resolutions)), [resolutions])

  const empMap = useMemo(() => new Map<string, Employee>(employees.map(e => [e.id, e])), [employees])

  // 승인된(관리자 확인된) 이상치는 종합현황과 동일하게 정상 취급 — flag는 있지만 anomaly로 안 셈.
  const effectiveRecords = useMemo(
    () => records.map(r => (r.flag && approvedKeys.has(`${r.employeeId}_${r.date}`) ? { ...r, flag: null } : r)),
    [records, approvedKeys],
  )

  const recordsByDivision = useMemo(() => {
    const map = new Map<string, ProcessedRecord[]>()
    for (const r of effectiveRecords) {
      const div = empMap.get(r.employeeId)?.division
      if (!div) continue
      const list = map.get(div) ?? []
      list.push(r)
      map.set(div, list)
    }
    return map
  }, [effectiveRecords, empMap])

  const metricsByDivision = useMemo(() => {
    const map = new Map<string, DivisionMetrics>()
    for (const division of allDivisions) map.set(division.name, computeMetrics(recordsByDivision.get(division.name) ?? []))
    return map
  }, [allDivisions, recordsByDivision])

  const overallMetrics = useMemo(() => computeMetrics(effectiveRecords), [effectiveRecords])

  // ── 팀 단위 드릴다운은 CAPS rawId ↔ 로스터 rawId 조인으로 유지(팀 세분화는 CSV division
  // 텍스트만으로는 안 되므로) — 겸임(*)이 있으면 본직 소속으로 귀속. ──────────────────────
  const rawIdByCompositeId = useMemo(
    () => new Map(employees.map(e => [e.id, e.rawId ?? e.id.split('_')[0]])),
    [employees],
  )
  const locationByRawId = useMemo(() => {
    const map = new Map<string, { division: string; team: string }>()
    const rows = [...(roster?.rows ?? [])].sort((a, b) => Number(b.isConcurrent) - Number(a.isConcurrent))
    for (const r of rows) if (r.rawId) map.set(r.rawId, { division: r.division, team: r.team })
    return map
  }, [roster])

  const teamStatsByDivision = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const r of effectiveRecords) {
      if (!r.flag) continue
      const rawId = rawIdByCompositeId.get(r.employeeId)
      if (!rawId) continue
      const loc = locationByRawId.get(rawId)
      if (!loc) continue
      const teamMap = map.get(loc.division) ?? new Map<string, number>()
      teamMap.set(loc.team, (teamMap.get(loc.team) ?? 0) + 1)
      map.set(loc.division, teamMap)
    }
    return map
  }, [effectiveRecords, rawIdByCompositeId, locationByRawId])

  // ── "이상치" 모드 본문: division별 사람 단위 지각/미달/미태깅 — 종합현황의 person-table을
  // division 카드 안으로 옮겨온 것. 총합계 내림차순으로 "누가 제일 문제인지"가 위로 온다. ──
  const personAnomaliesByDivision = useMemo(() => {
    const map = new Map<string, Map<string, PersonAnomalyRow>>()
    for (const r of effectiveRecords) {
      if (!r.flag) continue
      const rawId = rawIdByCompositeId.get(r.employeeId)
      if (!rawId) continue
      const loc = locationByRawId.get(rawId)
      if (!loc) continue
      const divMap = map.get(loc.division) ?? new Map<string, PersonAnomalyRow>()
      const row = divMap.get(rawId) ?? {
        rawId, name: empMap.get(r.employeeId)?.name ?? rawId, team: loc.team,
        late: 0, shortage: 0, notag: 0, total: 0,
      }
      for (const cat of flagToAnomalyCategories(r.flag)) {
        if (cat === 'late') row.late++
        else if (cat === 'shortage') row.shortage++
        else if (cat === 'notag') row.notag++
      }
      row.total = row.late + row.shortage + row.notag
      divMap.set(rawId, row)
      map.set(loc.division, divMap)
    }
    const sorted = new Map<string, PersonAnomalyRow[]>()
    for (const [div, divMap] of map) sorted.set(div, [...divMap.values()].sort((a, b) => b.total - a.total))
    return sorted
  }, [effectiveRecords, rawIdByCompositeId, locationByRawId, empMap])

  function toggle(name: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }
  function collapseAll() { setCollapsed(new Set(allNames)) }
  function expandAll() { setCollapsed(new Set()) }
  function changeViewMode(mode: ViewMode) {
    setViewMode(mode)
    setCollapsed(new Set()) // 모드 바꾸면 전부 펼쳐서 바로 보이게
  }
  function focusDivision(name: string) {
    setCollapsed(prev => { const next = new Set(prev); next.delete(name); return next })
    requestAnimationFrame(() => {
      document.getElementById(`div-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  if (isLoading) return <div className="p-8 text-sm text-gray-400">불러오는 중…</div>
  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>
  if (!roster || allDivisions.length === 0) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-400 text-center py-10">
          아직 조직도 데이터가 없습니다. 설정 &gt; 조직도 동기화에서 엑셀 파일을 먼저 반영해주세요.
        </p>
      </div>
    )
  }

  const totalsOrder = ['임원', '사업조직', '지원조직', '총 인원']

  return (
    <div className="p-6 space-y-5 max-w-[1600px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">조직도</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            "{roster.tabName}" 탭 기준 · 파싱 {roster.rows.length}명
            {unmatchedCount > 0 && <span className="text-gray-300"> · CAPS 미매칭 {unmatchedCount}명(연하게 표시)</span>}
          </p>
        </div>
        {/* ── 기간 선택: 종합현황과 동일한 일/주/월 + 이동 ── */}
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {(['day', 'week', 'month'] as PeriodGranularity[]).map(g => (
              <button
                key={g}
                onClick={() => period.setGranularity(g)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  period.granularity === g ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {g === 'day' ? '일' : g === 'week' ? '주' : '월'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-1">
            <button onClick={() => period.shift(-1)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-50">‹</button>
            <span className="text-xs font-medium text-gray-700 px-1.5 min-w-[120px] text-center tabular-nums">{period.label}</span>
            <button onClick={() => period.shift(1)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-50">›</button>
          </div>
          <button onClick={period.goToday} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">오늘</button>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* 시트 상단 "구분/총인원(명)" 집계 그대로 */}
        <div className="flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-2 shadow-sm">
          {totalsOrder.filter(k => roster.sheetTotals[k] != null).map(k => (
            <div key={k} className="text-center px-1">
              <p className="text-[10px] text-gray-400 whitespace-nowrap">{k}</p>
              <p className="text-sm font-bold text-gray-800 tabular-nums">{roster.sheetTotals[k]}</p>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          {/* ── 조직도/이상치 토글: 본부 카드 본문을 통째로 바꾼다 ── */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => changeViewMode('chart')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'chart' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              조직도
            </button>
            <button
              onClick={() => changeViewMode('anomaly')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'anomaly' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              이상치
            </button>
          </div>
          <button onClick={expandAll} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">전체 펼치기</button>
          <button onClick={collapseAll} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">전체 접기</button>
        </div>
      </div>

      {/* ── 경영진용 한눈에 보기: 종합현황과 같은 지표(정상출근율 + 지각·미달·미태깅·휴가) ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 grid grid-cols-1 md:grid-cols-[auto_1px_1fr] gap-5 items-center">
        <div>
          <p className="text-xs text-gray-400">{period.label} 정상출근율</p>
          <p className="text-2xl font-extrabold tabular-nums text-gray-900">
            {overallMetrics.totalRecords > 0 ? ((overallMetrics.normal / overallMetrics.totalRecords) * 100).toFixed(1) : '0.0'}%
          </p>
          <p className="text-xs text-gray-400 tabular-nums">({overallMetrics.normal}/{overallMetrics.totalRecords})</p>
        </div>
        <div className="hidden md:block bg-gray-100 w-px h-full" />
        <MetricBadges m={overallMetrics} size="lg" />
      </div>

      <div>
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">본부별 현황 ({period.label})</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-11 gap-2">
          {HEATMAP_ORDER.map(name => {
            const division = byName.get(name)
            if (!division) return null
            return (
              <HeatmapTile
                key={name}
                name={name}
                headcount={division.headcount}
                metrics={metricsByDivision.get(name) ?? emptyMetrics()}
                onClick={() => focusDivision(name)}
              />
            )
          })}
        </div>
      </div>

      {execDivision && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">임원</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <DivisionCard
              division={execDivision} isOpen={!collapsed.has(execDivision.name)} onToggle={() => toggle(execDivision.name)}
              metrics={metricsByDivision.get(execDivision.name) ?? emptyMetrics()}
              teamAnomalies={teamStatsByDivision.get(execDivision.name) ?? new Map()}
              viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(execDivision.name) ?? []}
            />
          </div>
        </div>
      )}

      {supportDivisions.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">지원조직</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {supportDivisions.map(division => (
              <DivisionCard
                key={division.name} division={division} isOpen={!collapsed.has(division.name)} onToggle={() => toggle(division.name)}
                metrics={metricsByDivision.get(division.name) ?? emptyMetrics()}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
                viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(division.name) ?? []}
              />
            ))}
          </div>
        </div>
      )}

      {businessDivisions.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">사업조직</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {businessDivisions.map(division => (
              <DivisionCard
                key={division.name} division={division} isOpen={!collapsed.has(division.name)} onToggle={() => toggle(division.name)}
                metrics={metricsByDivision.get(division.name) ?? emptyMetrics()}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
                viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(division.name) ?? []}
              />
            ))}
          </div>
        </div>
      )}

      {otherDivisions.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">기타</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {otherDivisions.map(division => (
              <DivisionCard
                key={division.name} division={division} isOpen={!collapsed.has(division.name)} onToggle={() => toggle(division.name)}
                metrics={metricsByDivision.get(division.name) ?? emptyMetrics()}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
                viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(division.name) ?? []}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
