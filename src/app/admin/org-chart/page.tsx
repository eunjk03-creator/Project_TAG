'use client'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { DIVISION_ORDER } from '@/data/orgChart'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useAttendanceData } from '@/context/AttendanceDataContext'

const BUSINESS_DIVISIONS = DIVISION_ORDER.slice(0, 5)   // 사업조직 — HMR/음료/헬스케어/뷰티/신사업본부
const SUPPORT_DIVISIONS = DIVISION_ORDER.slice(5)       // 지원조직 — 경영기획/피플/SCM/GTM/HQ
const HEATMAP_ORDER = ['임원', ...SUPPORT_DIVISIONS, ...BUSINESS_DIVISIONS]
const HEALTH_WINDOW_DAYS = 7

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface HealthStat { total: number; anomalies: number }

/** 총원을 상태별로 쪼갠 값 — "이상치 N건"(이벤트 카운트)이 아니라 "총원 중 몇 명"(정원 기준)으로
 *  보기 위한 구조. unknown은 계산하지 않고 total에서 나머지를 뺀 값으로 항상 맞춘다
 *  (미매칭 인원 + 오늘 레코드 자체가 없는 사람이 자연스럽게 여기로 모인다). */
interface StatusBreakdown { total: number; normal: number; leave: number; anomaly: number }

function breakdownUnknown(b: StatusBreakdown): number {
  return Math.max(0, b.total - b.normal - b.leave - b.anomaly)
}

function emptyBreakdown(total: number): StatusBreakdown {
  return { total, normal: 0, leave: 0, anomaly: 0 }
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

function DivisionCard({
  division, isOpen, onToggle, anomalyCount, teamAnomalies,
}: {
  division: DivisionGroup; isOpen: boolean; onToggle: () => void
  anomalyCount: number; teamAnomalies: Map<string, number>
}) {
  return (
    <section id={`div-${division.name}`} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 text-white hover:bg-gray-700 transition-colors"
      >
        <span className="text-sm font-semibold truncate">{division.name}</span>
        <span className="flex items-center gap-2 shrink-0">
          {anomalyCount > 0 && (
            <span className="text-[11px] font-medium text-red-300">이상치 {anomalyCount}건</span>
          )}
          <span className="text-xs font-medium text-gray-300 tabular-nums">{division.headcount}명</span>
          <ChevronIcon open={isOpen} />
        </span>
      </button>
      {isOpen && (
        <div className="p-3 max-h-[480px] overflow-y-auto">
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
        </div>
      )}
    </section>
  )
}

/** 총원=100% 스택바 — compact는 히트맵 타일 안에 들어가는 축소판, 그 외엔 종합요약용 전체 크기. */
function StatusBar({ b, compact }: { b: StatusBreakdown; compact?: boolean }) {
  const unknown = breakdownUnknown(b)
  const pct = (n: number) => (b.total > 0 ? (n / b.total) * 100 : 0)
  const segments = [
    { n: b.normal, cls: 'bg-emerald-500' },
    { n: b.leave, cls: 'bg-violet-400' },
    { n: b.anomaly, cls: 'bg-red-500' },
    { n: unknown, cls: 'bg-gray-300' },
  ]
  return (
    <div>
      <div className={`w-full rounded-full overflow-hidden flex bg-gray-100 ${compact ? 'h-1.5' : 'h-2.5'}`}>
        {b.total === 0
          ? <div className="w-full bg-gray-200" />
          : segments.map((s, i) => s.n > 0 && <div key={i} className={s.cls} style={{ width: `${pct(s.n)}%` }} />)}
      </div>
      {!compact && (
        <div className="flex gap-3 text-[11px] mt-1.5">
          <span className="text-emerald-600 font-medium">출근 {b.normal}</span>
          <span className="text-violet-500 font-medium">휴가 {b.leave}</span>
          <span className="text-red-500 font-medium">이상 {b.anomaly}</span>
          {unknown > 0 && <span className="text-gray-400">미확인 {unknown}</span>}
        </div>
      )}
    </div>
  )
}

function HeatmapTile({
  name, breakdown, onClick,
}: { name: string; breakdown: StatusBreakdown; onClick: () => void }) {
  const unknown = breakdownUnknown(breakdown)
  return (
    <button
      onClick={onClick}
      title={`${name} — 출근 ${breakdown.normal} · 휴가 ${breakdown.leave} · 이상 ${breakdown.anomaly} · 미확인 ${unknown} / 총 ${breakdown.total}명`}
      className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 text-left shadow-sm hover:shadow transition-shadow"
    >
      <p className="text-[11px] font-semibold text-gray-700 truncate">{name}</p>
      <p className="text-base font-extrabold tabular-nums leading-tight text-gray-900">
        {breakdown.total}<span className="text-[10px] font-medium text-gray-400 ml-0.5">명</span>
      </p>
      <div className="mt-1.5">
        <StatusBar b={breakdown} compact />
      </div>
      <p className="text-[9px] text-gray-400 mt-1 truncate">
        출근{breakdown.normal}·휴가{breakdown.leave}·이상{breakdown.anomaly}{unknown > 0 && `·미확인${unknown}`}
      </p>
    </button>
  )
}

export default function OrgChartPage() {
  const [roster, setRoster] = useState<RosterResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  // ── 근태 이상치 join: EmployeeMaster/로스터의 rawId를 CAPS Employee.rawId와 맞춰서
  // 최근 N일 ProcessedRecord를 division/team별로 집계 — 새 데이터를 만들지 않고 기존
  // rawId 조인키만 활용(종합현황의 anomaly 판정 기준과 동일: r.flag!==null && 미승인) ──────
  const to = useMemo(() => toDateStr(new Date()), [])
  const from = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - HEALTH_WINDOW_DAYS); return toDateStr(d) }, [])
  const { records, employees } = useProcessedAttendance(from, to)
  const { resolutions } = useAttendanceData()
  const approvedKeys = useMemo(() => new Set(Object.keys(resolutions)), [resolutions])

  const rawIdByCompositeId = useMemo(
    () => new Map(employees.map(e => [e.id, e.rawId ?? e.id.split('_')[0]])),
    [employees],
  )
  // 겸임(*) 행이 있으면 본직(비겸임) 소속이 최종적으로 남게 — syncOrgChart의 EmployeeMaster
  // 저장 우선순위와 동일한 규칙(겸임 먼저 넣고 본직으로 덮어씀).
  const locationByRawId = useMemo(() => {
    const map = new Map<string, { division: string; team: string }>()
    const rows = [...(roster?.rows ?? [])].sort((a, b) => Number(b.isConcurrent) - Number(a.isConcurrent))
    for (const r of rows) if (r.rawId) map.set(r.rawId, { division: r.division, team: r.team })
    return map
  }, [roster])

  const { divisionStats, teamStatsByDivision } = useMemo(() => {
    const divisionStats = new Map<string, HealthStat>()
    const teamStatsByDivision = new Map<string, Map<string, number>>() // division → team → anomaly count
    for (const r of records) {
      const rawId = rawIdByCompositeId.get(r.employeeId)
      if (!rawId) continue
      const loc = locationByRawId.get(rawId)
      if (!loc) continue
      const stat = divisionStats.get(loc.division) ?? { total: 0, anomalies: 0 }
      stat.total++
      const isAnomaly = r.flag != null && !approvedKeys.has(`${r.employeeId}_${r.date}`)
      if (isAnomaly) {
        stat.anomalies++
        const teamMap = teamStatsByDivision.get(loc.division) ?? new Map<string, number>()
        teamMap.set(loc.team, (teamMap.get(loc.team) ?? 0) + 1)
        teamStatsByDivision.set(loc.division, teamMap)
      }
      divisionStats.set(loc.division, stat)
    }
    return { divisionStats, teamStatsByDivision }
  }, [records, rawIdByCompositeId, locationByRawId, approvedKeys])

  // ── 총원 기준 상태분해(오늘): 정상출근/휴가·휴일/이상치/미확인 — roster의 division.rows를
  // 그대로 순회해서 헤드카운트가 카드 상단에 표시되는 총원 숫자와 항상 일치하게 한다. ──────
  const recordByRawIdToday = useMemo(() => {
    const map = new Map<string, typeof records[number]>()
    for (const r of records) {
      if (r.date !== to) continue
      const rawId = rawIdByCompositeId.get(r.employeeId)
      if (rawId) map.set(rawId, r)
    }
    return map
  }, [records, rawIdByCompositeId, to])

  function classify(row: RosterRow): 'normal' | 'leave' | 'anomaly' | null {
    if (!row.rawId) return null
    const r = recordByRawIdToday.get(row.rawId)
    if (!r) return null
    if (r.leaveType) return 'leave'
    const isAnomaly = r.flag != null && !approvedKeys.has(`${r.employeeId}_${r.date}`)
    return isAnomaly ? 'anomaly' : 'normal'
  }

  const divisionBreakdown = useMemo(() => {
    const map = new Map<string, StatusBreakdown>()
    for (const division of allDivisions) {
      const b = emptyBreakdown(division.headcount)
      for (const team of division.teams) for (const row of team.rows) {
        const status = classify(row)
        if (status === 'normal') b.normal++
        else if (status === 'leave') b.leave++
        else if (status === 'anomaly') b.anomaly++
      }
      map.set(division.name, b)
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDivisions, recordByRawIdToday, approvedKeys])

  const overallBreakdown = useMemo(() => {
    const b = emptyBreakdown(roster?.rows.length ?? 0)
    for (const row of roster?.rows ?? []) {
      const status = classify(row)
      if (status === 'normal') b.normal++
      else if (status === 'leave') b.leave++
      else if (status === 'anomaly') b.anomaly++
    }
    return b
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, recordByRawIdToday, approvedKeys])

  function toggle(name: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }
  function collapseAll() { setCollapsed(new Set(allNames)) }
  function expandAll() { setCollapsed(new Set()) }
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
        <div className="flex items-center gap-3">
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
            <button onClick={expandAll} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">
              전체 펼치기
            </button>
            <button onClick={collapseAll} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">
              전체 접기
            </button>
          </div>
        </div>
      </div>

      {/* ── 경영진용 한눈에 보기: 전체 기준 + 본부 기준을 같은 상태분해 막대로 ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">전체 현황 (오늘 {to})</p>
        <div className="flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-2xl font-extrabold text-gray-900 tabular-nums">
              {overallBreakdown.total > 0 ? ((overallBreakdown.normal / overallBreakdown.total) * 100).toFixed(1) : '0.0'}%
            </p>
            <p className="text-[11px] text-gray-400">정상출근율 ({overallBreakdown.normal}/{overallBreakdown.total}명)</p>
          </div>
          <div className="flex-1 min-w-[280px]">
            <StatusBar b={overallBreakdown} />
          </div>
        </div>
      </div>

      <div>
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
          본부별 현황 (오늘)
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-11 gap-2">
          {HEATMAP_ORDER.map(name => {
            const division = byName.get(name)
            if (!division) return null
            return (
              <HeatmapTile
                key={name}
                name={name}
                breakdown={divisionBreakdown.get(name) ?? emptyBreakdown(division.headcount)}
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
              anomalyCount={divisionStats.get(execDivision.name)?.anomalies ?? 0}
              teamAnomalies={teamStatsByDivision.get(execDivision.name) ?? new Map()}
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
                anomalyCount={divisionStats.get(division.name)?.anomalies ?? 0}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
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
                anomalyCount={divisionStats.get(division.name)?.anomalies ?? 0}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
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
                anomalyCount={divisionStats.get(division.name)?.anomalies ?? 0}
                teamAnomalies={teamStatsByDivision.get(division.name) ?? new Map()}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
