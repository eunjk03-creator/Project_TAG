'use client'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
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
  setPolicy: (p: PolicySettings) => Promise<void>
  isLoading: boolean
  saveError: string | null
}

const PolicyContext = createContext<PolicyContextType>({
  policy: DEFAULT_POLICY,
  setPolicy: async () => {},
  isLoading: false,
  saveError: null,
})

export function PolicyProvider({ children }: { children: ReactNode }) {
  const [policy, setPolicyState] = useState<PolicySettings>(loadPolicy)
  const [isLoading, setIsLoading] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)

  // localStorage 캐시로 즉시 렌더 → DB 값 도착하면 그걸로 갱신 (세션 독립적인 단일 소스)
  useEffect(() => {
    let cancelled = false
    fetch('/api/policy')
      .then(res => res.json())
      .then((data: { policy?: PolicySettings }) => {
        if (cancelled || !data.policy) return
        setPolicyState(data.policy)
        try { localStorage.setItem(LS_KEY, JSON.stringify(data.policy)) } catch {}
      })
      .catch(err => console.error('정책 DB 로드 실패:', err))
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function setPolicy(p: PolicySettings) {
    setPolicyState(p)
    try { localStorage.setItem(LS_KEY, JSON.stringify(p)) } catch {}
    setSaveError(null)
    try {
      const res = await fetch('/api/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: p }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch (err) {
      console.error('정책 DB 저장 실패:', err)
      setSaveError(String(err))
    }
  }

  return (
    <PolicyContext.Provider value={{ policy, setPolicy, isLoading, saveError }}>
      {children}
    </PolicyContext.Provider>
  )
}

export function usePolicy() {
  return useContext(PolicyContext)
}
