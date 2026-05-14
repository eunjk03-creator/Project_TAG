'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { DEFAULT_POLICY, type PolicySettings } from '@/types/tag'

const LS_KEY = 'tag_policy'

function loadPolicy(): PolicySettings {
  if (typeof window === 'undefined') return DEFAULT_POLICY
  try {
    const s = localStorage.getItem(LS_KEY)
    if (!s) return DEFAULT_POLICY
    // Spread DEFAULT_POLICY first so any new fields added later have fallback values
    return { ...DEFAULT_POLICY, ...JSON.parse(s) } as PolicySettings
  } catch {
    return DEFAULT_POLICY
  }
}

interface PolicyContextType {
  policy: PolicySettings
  setPolicy: (p: PolicySettings) => void
}

const PolicyContext = createContext<PolicyContextType>({
  policy: DEFAULT_POLICY,
  setPolicy: () => {},
})

export function PolicyProvider({ children }: { children: ReactNode }) {
  const [policy, setPolicyState] = useState<PolicySettings>(loadPolicy)

  function setPolicy(p: PolicySettings) {
    setPolicyState(p)
    try { localStorage.setItem(LS_KEY, JSON.stringify(p)) } catch {}
  }

  return (
    <PolicyContext.Provider value={{ policy, setPolicy }}>
      {children}
    </PolicyContext.Provider>
  )
}

export function usePolicy() {
  return useContext(PolicyContext)
}
