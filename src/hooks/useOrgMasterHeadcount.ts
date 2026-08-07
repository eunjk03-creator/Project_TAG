'use client'
import { useState, useEffect } from 'react'

/** 인력 마스터(EmployeeMaster) 기준 division별 재직자 수. 마스터가 아직 비어있는
 *  division은 이 Map에 키 자체가 없다 — useManagementMetrics가 그 경우 CSV 기준으로
 *  fallback하므로 마이그레이션 중간 상태에서도 화면이 깨지지 않는다. */
export function useOrgMasterHeadcount(): Map<string, number> {
  const [map, setMap] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    fetch('/api/employee-master/headcount-by-division')
      .then(r => r.json())
      .then((data: Record<string, number>) => {
        if (cancelled) return
        setMap(new Map(Object.entries(data)))
      })
      .catch(err => console.error('[useOrgMasterHeadcount] load error', err))
    return () => { cancelled = true }
  }, [])

  return map
}
