'use client'
import { useState, useEffect, useCallback } from 'react'
import type { RosterRow } from '@/app/api/employee-master/roster/route'

export type { RosterRow }

/** [rows, refetch] — refetch() 없이는 퇴사 확정 등 PATCH 이후에도 목록이 갱신 전 상태로
 *  남아있어, 마스터에 없던 사람(신규 upsert)은 화면에서 아예 사라져 보인다. */
export function useEmployeeRoster(): [RosterRow[], () => Promise<void>] {
  const [rows, setRows] = useState<RosterRow[]>([])

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/employee-master/roster')
      const data = await res.json() as RosterRow[]
      if (Array.isArray(data)) setRows(data)
    } catch (err) {
      console.error('[useEmployeeRoster] load error', err)
    }
  }, [])

  useEffect(() => { refetch() }, [refetch])

  return [rows, refetch]
}
