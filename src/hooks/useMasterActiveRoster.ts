'use client'
import { useState, useEffect, useCallback } from 'react'

export interface MasterActiveRow {
  rawId: string
  name: string
  division: string
}

/** [rows, refetch] — 파트타이머를 "재직자로 등록"한 직후 이 목록도 다시 받아와야
 *  CAPS_NOT_IN_MASTER 판정(buildMasterDiscrepancyRollup)에서 즉시 빠진다. */
export function useMasterActiveRoster(): [MasterActiveRow[], () => Promise<void>] {
  const [rows, setRows] = useState<MasterActiveRow[]>([])

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/employee-master/active-roster')
      const data = await res.json() as MasterActiveRow[]
      if (Array.isArray(data)) setRows(data)
    } catch (err) {
      console.error('[useMasterActiveRoster] load error', err)
    }
  }, [])

  useEffect(() => { refetch() }, [refetch])

  return [rows, refetch]
}
