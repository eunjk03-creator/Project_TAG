'use client'
import { useMemo } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { useOrgFilter } from '@/context/OrgFilterContext'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangePicker } from '@/components/admin/DateRangePicker'

const divisions = [...new Set(EMPLOYEES.map(e => e.division))]

const divisionTeams: Record<string, string[]> = {}
for (const emp of EMPLOYEES) {
  if (!divisionTeams[emp.division]) divisionTeams[emp.division] = []
  if (!divisionTeams[emp.division].includes(emp.team)) {
    divisionTeams[emp.division].push(emp.team)
  }
}

export function OrgFilterBar() {
  const { division, team, setDivision, setTeam } = useOrgFilter()
  const { dateRange, setDateRange } = useDateRange()

  const teams = useMemo(
    () => (division ? divisionTeams[division] ?? [] : []),
    [division],
  )

  const hasFilter = division !== null || team !== null

  return (
    <div className="flex items-center gap-3 px-6 py-2.5 bg-white border-b border-gray-100 shrink-0">

      {/* Date range picker */}
      <DateRangePicker value={dateRange} onChange={setDateRange} />

      <div className="w-px h-4 bg-gray-200 shrink-0" />

      <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider shrink-0">
        조직 필터
      </span>

      {/* Business Unit */}
      <div className="relative">
        <select
          value={division ?? ''}
          onChange={e => setDivision(e.target.value || null)}
          className="appearance-none pl-3 pr-7 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer min-w-[140px]"
        >
          <option value="">전체 본부</option>
          {divisions.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[10px]">▾</span>
      </div>

      {/* Department — disabled until a division is selected */}
      <div className="relative">
        <select
          value={team ?? ''}
          onChange={e => setTeam(e.target.value || null)}
          disabled={!division}
          className="appearance-none pl-3 pr-7 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer min-w-[160px] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <option value="">전체 팀/부서</option>
          {teams.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[10px]">▾</span>
      </div>

      {/* Active filter pill + clear */}
      {hasFilter && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
            {team ?? division}
          </span>
          <button
            onClick={() => setDivision(null)}
            className="text-gray-300 hover:text-gray-500 transition-colors text-xs leading-none"
            title="필터 초기화"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
