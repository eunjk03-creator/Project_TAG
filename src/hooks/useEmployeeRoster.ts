'use client'
import { useState, useEffect } from 'react'
import type { RosterRow } from '@/app/api/employee-master/roster/route'

export type { RosterRow }

export function useEmployeeRoster(): RosterRow[] {
  const [rows, setRows] = useState<RosterRow[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/employee-master/roster')
      .then(r => r.json())
      .then((data: RosterRow[]) => { if (!cancelled && Array.isArray(data)) setRows(data) })
      .catch(err => console.error('[useEmployeeRoster] load error', err))
    return () => { cancelled = true }
  }, [])

  return rows
}
