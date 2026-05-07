'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'

interface OrgFilterState {
  division: string | null
  team: string | null
  setDivision: (d: string | null) => void
  setTeam: (t: string | null) => void
}

const OrgFilterContext = createContext<OrgFilterState>({
  division: null,
  team: null,
  setDivision: () => {},
  setTeam: () => {},
})

export function OrgFilterProvider({ children }: { children: ReactNode }) {
  const [division, setDivisionState] = useState<string | null>(null)
  const [team, setTeam] = useState<string | null>(null)

  function setDivision(d: string | null) {
    setDivisionState(d)
    setTeam(null)
  }

  return (
    <OrgFilterContext.Provider value={{ division, team, setDivision, setTeam }}>
      {children}
    </OrgFilterContext.Provider>
  )
}

export function useOrgFilter() {
  return useContext(OrgFilterContext)
}
