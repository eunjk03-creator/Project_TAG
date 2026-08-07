'use client'
import { useState, useEffect } from 'react'

export interface MasterActiveRow {
  rawId: string
  name: string
  division: string
}

export function useMasterActiveRoster(): MasterActiveRow[] {
  const [rows, setRows] = useState<MasterActiveRow[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/employee-master/active-roster')
      .then(r => r.json())
      .then((data: MasterActiveRow[]) => { if (!cancelled && Array.isArray(data)) setRows(data) })
      .catch(err => console.error('[useMasterActiveRoster] load error', err))
    return () => { cancelled = true }
  }, [])

  return rows
}
