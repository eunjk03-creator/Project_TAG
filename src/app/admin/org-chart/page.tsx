'use client'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { DIVISION_ORDER } from '@/data/orgChart'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { usePeriodRange } from '@/hooks/usePeriodRange'
import { flagToAnomalyCategories } from '@/utils/attendanceCalc'
import { PeriodSelector } from '@/components/admin/PeriodSelector'
import { AnomalyMetricBadges, emptyDivisionAnomalyMetrics, type DivisionAnomalyMetrics } from '@/components/admin/AnomalyMetricBadges'
import { AnomalyPersonTable } from '@/components/admin/AnomalyPersonTable'
import type { Employee, EmployeeAttributeOverrides, ProcessedRecord } from '@/types/tag'

const BUSINESS_DIVISIONS = DIVISION_ORDER.slice(0, 5)   // 사업조직 — HMR/음료/헬스케어/뷰티/신사업본부
const SUPPORT_DIVISIONS = DIVISION_ORDER.slice(5)       // 지원조직 — 경영기획/피플/SCM/GTM/HQ

/** "조직도" = 지금처럼 직책·성명·직무 트리, "이상치" = 같은 자리에 이상치 발생자 목록 —
 *  두 정보가 한 화면에 뭉쳐 있으면 못 알아본다는 피드백으로 토글로 분리. */
type ViewMode = 'chart' | 'anomaly'

function computeMetrics(records: ProcessedRecord[]): DivisionAnomalyMetrics {
  const m = emptyDivisionAnomalyMetrics()
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
  return m
}

/**
 * "정상출근율"의 인원 기준 — 레코드(사람×근무일) 합산이 아니라 사람 단위로 센다.
 * 그렇게 안 하면 주/월로 갈수록 분모가 인원×근무일수로 부풀어서 "785명"처럼 총원과
 * 무관한 숫자가 나온다(2026-08-06 피드백). 대상은 조직도 로스터에 CAPS로 매칭된
 * 사람 중 이 기간에 퇴사자로 제외되지 않은 유효 인원만 — admin/page.tsx가 쓰는 것과
 * 동일한 퇴사자 규칙(resignedFrom 미설정 시 무조건 제외, 설정돼 있으면 기간 시작 이전
 * 퇴사일 때만 제외)을 그대로 재사용해서 두 화면의 "유효 인원" 정의가 갈리지 않게 한다.
 */
function isValidForPeriod(
  empId: string,
  globalExclusionIds: Set<string>,
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
  periodFrom: string,
): boolean {
  if (globalExclusionIds.has(empId)) return false
  const attrs = finalAttrMap.get(empId)
  if (attrs?.isResigned && (!attrs.resignedFrom || attrs.resignedFrom < periodFrom)) return false
  return true
}

function computePersonRate(
  records: ProcessedRecord[],
  validIds: Set<string>,
): { normal: number; total: number } {
  const byEmp = new Map<string, ProcessedRecord[]>()
  for (const r of records) {
    if (!validIds.has(r.employeeId)) continue
    const list = byEmp.get(r.employeeId) ?? []
    list.push(r)
    byEmp.set(r.employeeId, list)
  }
  let normal = 0, total = 0
  for (const recs of byEmp.values()) {
    const qualifying = recs.filter(r => r.dayType === 'WEEKDAY' && r.finalStatus !== '연차')
    if (qualifying.length === 0) continue // 이 기간 내내 연차/휴일뿐이면 평가 대상에서 제외
    total++
    if (qualifying.every(r => !r.flag)) normal++
  }
  return { normal, total }
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

function LeaveBadge({ count }: { count: number }) {
  if (count === 0) return null
  return <span className="text-[11px] font-medium text-violet-300">휴가 {count}</span>
}

function DivisionCard({
  division, isOpen, onToggle, metrics, teamAnomalies, viewMode, personAnomalies, showList, onToggleList,
}: {
  division: DivisionGroup; isOpen: boolean; onToggle: () => void
  metrics: DivisionAnomalyMetrics; teamAnomalies: Map<string, number>
  viewMode: ViewMode; personAnomalies: PersonAnomalyRow[]
  /** "조직도" 뷰를 유지한 채로 이 카드만 이상치 명단을 펼쳐보는 로컬 토글 —
   *  페이지 전체를 "이상치 목록" 모드로 바꾸지 않아도 요약 줄에서 바로 확인 가능. */
  showList: boolean; onToggleList: () => void
}) {
  const anomalyRows = personAnomalies.map(p => (
    { key: p.rawId, name: p.name, team: p.team, late: p.late, shortage: p.shortage, notag: p.notag, total: p.total }
  ))
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
      <div className="px-4 py-2.5 border-b border-gray-50 bg-gray-50/60 flex items-center justify-between gap-2">
        <AnomalyMetricBadges m={metrics} shortageLabel="미달" />
        {viewMode === 'chart' && metrics.late + metrics.shortage + metrics.notag > 0 && (
          <button
            onClick={onToggleList}
            className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors ${
              showList ? 'bg-red-50 border-red-200 text-red-600' : 'border-gray-200 text-gray-400 hover:text-gray-600'
            }`}
          >
            명단 {showList ? '숨기기' : '보기'}
          </button>
        )}
      </div>
      {viewMode === 'chart' && showList && (
        <div className="px-3 py-2.5 border-b border-gray-50">
          <AnomalyPersonTable rows={anomalyRows} pageSize={5} />
        </div>
      )}
      <button onClick={onToggle} className="w-full flex items-center justify-center py-1 text-gray-300 hover:bg-gray-50">
        <ChevronIcon open={isOpen} />
      </button>
      {isOpen && (
        <div className="p-3 max-h-[480px] overflow-y-auto">
          {viewMode === 'anomaly' ? (
            <AnomalyPersonTable rows={anomalyRows} pageSize={8} />
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

export default function OrgChartPage() {
  const [roster, setRoster] = useState<RosterResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<ViewMode>('chart')
  const [expandedList, setExpandedList] = useState<Set<string>>(new Set())
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
  const { records, employees, finalAttrMap, globalExclusionIds } = useProcessedAttendance(period.from, period.to)
  const { resolutions } = useAttendanceData()
  const approvedKeys = useMemo(() => new Set(Object.keys(resolutions)), [resolutions])

  const empMap = useMemo(() => new Map<string, Employee>(employees.map(e => [e.id, e])), [employees])

  // 승인된(관리자 확인된) 이상치는 종합현황과 동일하게 정상 취급 — flag는 있지만 anomaly로 안 셈.
  const effectiveRecords = useMemo(
    () => records.map(r => (r.flag && approvedKeys.has(`${r.employeeId}_${r.date}`) ? { ...r, flag: null } : r)),
    [records, approvedKeys],
  )

  // 이 기간에 "유효한" 인원(전역제외 아니고, 기간 시작일 기준 퇴사자 아님) — 정상출근율의
  // 인원 분모로만 쓰인다. admin/page.tsx의 퇴사자 규칙과 동일하게 맞춰서 화면 간 정의가
  // 갈리지 않게 한다.
  const validEmployeeIds = useMemo(() => {
    const set = new Set<string>()
    for (const e of employees) {
      if (isValidForPeriod(e.id, globalExclusionIds, finalAttrMap, period.from)) set.add(e.id)
    }
    return set
  }, [employees, globalExclusionIds, finalAttrMap, period.from])

  const overallPersonRate = useMemo(
    () => computePersonRate(effectiveRecords, validEmployeeIds),
    [effectiveRecords, validEmployeeIds],
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
    const map = new Map<string, DivisionAnomalyMetrics>()
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
  function toggleList(name: string) {
    setExpandedList(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
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
        <PeriodSelector period={period} />
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
            {overallPersonRate.total > 0 ? ((overallPersonRate.normal / overallPersonRate.total) * 100).toFixed(1) : '0.0'}%
          </p>
          <p className="text-xs text-gray-400 tabular-nums">
            ({overallPersonRate.normal}/{overallPersonRate.total}명 · 조직도/CAPS 매칭·퇴사자 제외 유효인원)
          </p>
        </div>
        <div className="hidden md:block bg-gray-100 w-px h-full" />
        <AnomalyMetricBadges m={overallMetrics} size="lg" shortageLabel="미달" />
      </div>

      {execDivision && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">임원</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <DivisionCard
              division={execDivision} isOpen={!collapsed.has(execDivision.name)} onToggle={() => toggle(execDivision.name)}
              metrics={metricsByDivision.get(execDivision.name) ?? emptyDivisionAnomalyMetrics()}
              teamAnomalies={teamStatsByDivision.get(execDivision.name) ?? new Map()}
              viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(execDivision.name) ?? []}
              showList={expandedList.has(execDivision.name)} onToggleList={() => toggleList(execDivision.name)}
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
                metrics={metricsByDivision.get(division.name) ?? emptyDivisionAnomalyMetrics()}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
                viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(division.name) ?? []}
                showList={expandedList.has(division.name)} onToggleList={() => toggleList(division.name)}
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
                metrics={metricsByDivision.get(division.name) ?? emptyDivisionAnomalyMetrics()}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
                viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(division.name) ?? []}
                showList={expandedList.has(division.name)} onToggleList={() => toggleList(division.name)}
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
                metrics={metricsByDivision.get(division.name) ?? emptyDivisionAnomalyMetrics()}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
                viewMode={viewMode} personAnomalies={personAnomaliesByDivision.get(division.name) ?? []}
                showList={expandedList.has(division.name)} onToggleList={() => toggleList(division.name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
