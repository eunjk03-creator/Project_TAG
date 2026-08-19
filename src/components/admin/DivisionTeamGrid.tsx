'use client'
import { useEffect, useState, Fragment } from 'react'
import { sortByDivisionOrder } from '@/data/orgChart'

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
  rows: RosterRow[]
}

interface DivisionGroup {
  name: string
  headcount: number
  teams: { name: string; rows: RosterRow[] }[]
}

/** division/team을 로스터에 처음 등장한 순서 그대로 그룹핑 — 조직도 페이지의 groupInOrder와
 *  동일 원칙(엑셀 원본의 좌→우, 위→아래 순서를 그대로 유지). */
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

function TeamHeaderRow({ name, count }: { name: string; count: number }) {
  return (
    <tr>
      <td colSpan={3} className="pt-2.5 pb-1">
        <span className="text-[11px] font-semibold text-gray-500 bg-gray-50 rounded px-2 py-0.5">
          {name} <span className="text-gray-400 font-normal">({count}명)</span>
        </span>
      </td>
    </tr>
  )
}

function DivisionCard({ division, isOpen, onToggle }: { division: DivisionGroup; isOpen: boolean; onToggle: () => void }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 text-white hover:bg-gray-700 transition-colors"
      >
        <span className="text-sm font-semibold truncate">{division.name}</span>
        <span className="text-xs font-medium text-gray-300 tabular-nums shrink-0">{division.headcount}명</span>
      </button>
      <button onClick={onToggle} className="w-full flex items-center justify-center py-1 text-gray-300 hover:bg-gray-50">
        <ChevronIcon open={isOpen} />
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
                  {team.name !== division.name && <TeamHeaderRow name={team.name} count={team.rows.length} />}
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

/**
 * 종합현황 Zone2 "조직도" 탭 — 조직도 페이지와 동일한 로스터 시트 데이터(직책·성명·직무,
 * 팀 단위 그룹)를 그대로 보여준다. "이상치" 탭(DivisionSummaryCardGrid)이 이상치/휴가
 * 롤업 중심이라면, 이 탭은 순수 조직 구조 확인용 — 팀 상세 편집/동기화는 조직도 페이지에서.
 */
export function DivisionTeamGrid() {
  const [roster, setRoster] = useState<RosterResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/org-sync/latest-roster')
      .then(r => r.json())
      .then((data: RosterResponse & { error?: string }) => setRoster(data.error ? null : data))
      .catch(() => setRoster(null))
      .finally(() => setIsLoading(false))
  }, [])

  if (isLoading) return <p className="text-xs text-gray-300 text-center py-6">불러오는 중…</p>
  if (!roster || roster.rows.length === 0) {
    return (
      <p className="text-xs text-gray-300 text-center py-6">
        아직 조직도 데이터가 없습니다. 설정 &gt; 조직도 동기화에서 엑셀 파일을 먼저 반영해주세요.
      </p>
    )
  }

  const groups = groupInOrder(roster.rows)
  const byName = new Map(groups.map(g => [g.name, g]))
  const ordered = sortByDivisionOrder(groups.map(g => g.name))

  function toggle(name: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-2">
        <button onClick={() => setCollapsed(new Set())} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">전체 펼치기</button>
        <button onClick={() => setCollapsed(new Set(ordered))} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">전체 접기</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {ordered.map(name => {
          const d = byName.get(name)
          if (!d) return null
          return (
            <DivisionCard key={name} division={d} isOpen={!collapsed.has(name)} onToggle={() => toggle(name)} />
          )
        })}
      </div>
    </div>
  )
}
