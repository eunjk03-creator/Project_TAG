'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { DEFAULT_POLICY, type PolicySettings } from '@/types/tag'

interface PolicyContextType {
  policy: PolicySettings
  setPolicy: (p: PolicySettings) => void
}

const PolicyContext = createContext<PolicyContextType>({
  policy: DEFAULT_POLICY,
  setPolicy: () => {},
})

export function PolicyProvider({ children }: { children: ReactNode }) {
  const [policy, setPolicy] = useState<PolicySettings>(DEFAULT_POLICY)
  return (
    <PolicyContext.Provider value={{ policy, setPolicy }}>
      {children}
    </PolicyContext.Provider>
  )
}

export function usePolicy() {
  return useContext(PolicyContext)
}
