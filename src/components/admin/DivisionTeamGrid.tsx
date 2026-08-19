'use client'
import { useEffect, useState } from 'react'
import { sortByDivisionOrder } from '@/data/orgChart'

interface RosterRow {
  division: string
  team:     string
  rawId:    string | null
}

interface RosterResponse {
  rows: RosterRow[]
}

interface TeamCount { name: string; count: number }
interface DivisionTeams { name: string; headcount: number; teams: TeamCount[] }

/** 로스터 원본 등장 순서 그대로 division→team을 그룹핑 — 조직도 페이지의 groupInOrder와
 *  동일 원칙(엑셀 원본의 팀 나열 순서를 유지). 여긴 팀별 인원 "수"만 필요해서 사람별
 *  행(title/jobFunction 등)까지는 안 들고 온다(그건 조직도 페이지 몫). */
function groupTeams(rows: RosterRow[]): DivisionTeams[] {
  const divOrder: string[] = []
  const byDiv = new Map<string, { teamOrder: string[]; counts: Map<string, number> }>()
  for (const r of rows) {
    let entry = byDiv.get(r.division)
    if (!entry) {
      entry = { teamOrder: [], counts: new Map() }
      byDiv.set(r.division, entry)
      divOrder.push(r.division)
    }
    if (!entry.counts.has(r.team)) entry.teamOrder.push(r.team)
    entry.counts.set(r.team, (entry.counts.get(r.team) ?? 0) + 1)
  }
  return divOrder.map(name => {
    const entry = byDiv.get(name)!
    const teams = entry.teamOrder.map(t => ({ name: t, count: entry.counts.get(t) ?? 0 }))
    return { name, headcount: teams.reduce((s, t) => s + t.count, 0), teams }
  })
}

/**
 * 종합현황 Zone2 "조직도" 탭 — division별 팀 구성을 가볍게 보여준다("이상치" 탭의
 * DivisionSummaryCardGrid와 달리 이상치/휴가 데이터 없이 순수 조직 구조만).
 * 팀 단위 상세(직책·성명 등)가 필요하면 조직도 페이지로 이동해서 본다.
 */
export function DivisionTeamGrid() {
  const [roster, setRoster] = useState<RosterResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

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

  const groups = groupTeams(roster.rows)
  const byName = new Map(groups.map(g => [g.name, g]))
  const ordered = sortByDivisionOrder(groups.map(g => g.name))

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      {ordered.map(name => {
        const d = byName.get(name)
        if (!d) return null
        return (
          <section key={name} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-gray-800 text-white">
              <span className="text-sm font-semibold truncate">{name}</span>
              <span className="text-xs font-medium text-gray-300 tabular-nums shrink-0">{d.headcount}명</span>
            </div>
            <div className="p-3 flex flex-wrap gap-1.5">
              {d.teams.map(t => (
                <span key={t.name} className="text-[11px] font-medium text-gray-600 bg-gray-50 border border-gray-100 rounded-full px-2 py-0.5 whitespace-nowrap">
                  {t.name} <span className="text-gray-400 tabular-nums">{t.count}</span>
                </span>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
