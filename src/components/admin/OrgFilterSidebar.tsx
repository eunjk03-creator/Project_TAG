'use client'
import { useState } from 'react'
import { DIVISIONS, DIVISION_TEAMS } from '@/data/orgChart'
import { useOrgFilter } from '@/context/OrgFilterContext'

const divisionTeams: Record<string, readonly string[]> = DIVISION_TEAMS
const divisions = [...DIVISIONS]

export function OrgFilterSidebar() {
  const { division: activeDivision, team: activeTeam, setDivision, setTeam } = useOrgFilter()
  const [expandedDivision, setExpandedDivision] = useState<string | null>(null)

  function handleDivisionClick(div: string) {
    if (expandedDivision === div) {
      if (activeDivision === div) {
        setExpandedDivision(null)
        setDivision(null)
      } else {
        setDivision(div)
      }
    } else {
      setExpandedDivision(div)
      setDivision(div)
    }
  }

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => { setDivision(null); setExpandedDivision(null) }}
        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
          activeDivision === null
            ? 'bg-blue-50 text-blue-700 font-medium'
            : 'text-gray-600 hover:bg-gray-50'
        }`}
      >
        전체
      </button>

      {divisions.map(div => {
        const teams = divisionTeams[div]
        const isExpanded = expandedDivision === div
        const isDivActive = activeDivision === div

        return (
          <div key={div}>
            <button
              onClick={() => handleDivisionClick(div)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between gap-1 ${
                isDivActive && !activeTeam
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : isDivActive
                  ? 'text-blue-600 bg-blue-50/50'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span className="truncate">{div}</span>
              {teams.length > 0 && (
                <span className={`shrink-0 text-xs transition-transform ${isExpanded ? 'rotate-90' : ''} text-gray-400`}>
                  ▸
                </span>
              )}
            </button>

            {isExpanded && (
              <div className="ml-2 mt-0.5 space-y-0.5 border-l border-gray-100 pl-2">
                {teams.map(team => (
                  <button
                    key={team}
                    onClick={() => setTeam(team)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                      activeTeam === team
                        ? 'bg-blue-50 text-blue-700 font-medium'
                        : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                    }`}
                  >
                    {team}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
