'use client'
import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { ALL_RECORDS } from '@/data/mockData'
import type { Employee, RawRecord, CapsRow, ErpUnifiedRow } from '@/types/tag'
import { parseAttendanceData, type ParseResult } from '@/utils/dataParser'
import { usePolicy } from '@/context/PolicyContext'

// ── Context interface ─────────────────────────────────────────────────────

interface AttendanceSourceContextValue {
  employees:     Employee[]
  rawRecords:    RawRecord[]
  isLiveData:    boolean
  /** True while initial DB fetch is in flight */
  isLoading:     boolean
  /** ISO string of last upload, or null if no data in DB */
  lastUploadedAt: string | null
  /**
   * Admin upload: parses CSV arrays, saves raw data to DB, updates state.
   * Returns ParseResult so the caller can show a status summary.
   */
  setRawData:    (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult>
  clearLiveData: () => Promise<void>
}

const AttendanceSourceContext = createContext<AttendanceSourceContextValue | null>(null)

// ── Helpers ───────────────────────────────────────────────────────────────

function normalizeDivisions(employees: Employee[]): Employee[] {
  return employees.map(e => e.division === '기타' ? { ...e, division: '신사업본부' } : e)
}

async function dbGet<T>(key: string): Promise<{ data: T | null; updatedAt: string | null }> {
  try {
    const res = await fetch(`/api/shared-data/${key}`)
    if (!res.ok) return { data: null, updatedAt: null }
    return res.json()
  } catch {
    return { data: null, updatedAt: null }
  }
}

async function dbPut(key: string, data: unknown): Promise<string | null> {
  try {
    const res = await fetch(`/api/shared-data/${key}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data }),
    })
    if (!res.ok) return null
    const json = await res.json() as { ok: boolean; updatedAt: string }
    return json.updatedAt ?? null
  } catch {
    return null
  }
}

// ── Provider ──────────────────────────────────────────────────────────────

export function AttendanceSourceProvider({ children }: { children: ReactNode }) {
  const { policy } = usePolicy()

  const [liveEmployees, setLiveEmployees] = useState<Employee[] | null>(null)
  const [liveRecords,   setLiveRecords]   = useState<RawRecord[] | null>(null)
  const [rawCaps,       setRawCaps]       = useState<CapsRow[]        | null>(null)
  const [rawErp,        setRawErp]        = useState<ErpUnifiedRow[]  | null>(null)
  const [isLoading,     setIsLoading]     = useState(true)
  const [lastUploadedAt, setLastUploadedAt] = useState<string | null>(null)

  const isLiveData = liveEmployees !== null

  // ── Initial load from DB ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      const [capsRes, erpRes] = await Promise.all([
        dbGet<CapsRow[]>('caps_data'),
        dbGet<ErpUnifiedRow[]>('erp_data'),
      ])

      if (cancelled) return

      const caps = capsRes.data
      const erp  = erpRes.data

      if (caps && erp) {
        const result     = parseAttendanceData(caps, erp, policy)
        const normalized = normalizeDivisions(result.employees)
        setRawCaps(caps)
        setRawErp(erp)
        setLiveEmployees(normalized)
        setLiveRecords(result.rawRecords)
        // use the later of the two timestamps
        const ts = erpRes.updatedAt ?? capsRes.updatedAt ?? null
        setLastUploadedAt(ts)
      }

      setIsLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Re-parse when policy changes (skip initial mount) ─────────────────
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    if (!rawCaps || !rawErp) return
    const { employees, rawRecords } = parseAttendanceData(rawCaps, rawErp, policy)
    const normalized = normalizeDivisions(employees)
    setLiveEmployees(normalized)
    setLiveRecords(rawRecords)
  }, [policy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── setRawData: admin upload → save to DB → update state ──────────────
  const setRawData = useCallback(async (caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<ParseResult> => {
    const result     = parseAttendanceData(caps, erp, policy)
    const normalized = normalizeDivisions(result.employees)

    setRawCaps(caps)
    setRawErp(erp)
    setLiveEmployees(normalized)
    setLiveRecords(result.rawRecords)

    // persist to DB (fire both, await both)
    const [capsTs, erpTs] = await Promise.all([
      dbPut('caps_data', caps),
      dbPut('erp_data',  erp),
    ])
    // only mark as shared if at least one save confirmed
    if (capsTs || erpTs) {
      setLastUploadedAt(erpTs ?? capsTs ?? null)
    }

    return { ...result, employees: normalized }
  }, [policy])

  // ── clearLiveData: wipe DB + state ───────────────────────────────────
  const clearLiveData = useCallback(async () => {
    await Promise.all([
      dbPut('caps_data', null),
      dbPut('erp_data',  null),
    ])
    setRawCaps(null)
    setRawErp(null)
    setLiveEmployees(null)
    setLiveRecords(null)
    setLastUploadedAt(null)
  }, [])

  return (
    <AttendanceSourceContext.Provider value={{
      employees:      liveEmployees ?? EMPLOYEES,
      rawRecords:     liveRecords   ?? ALL_RECORDS,
      isLiveData,
      isLoading,
      lastUploadedAt,
      setRawData,
      clearLiveData,
    }}>
      {children}
    </AttendanceSourceContext.Provider>
  )
}

export function useAttendanceSource(): AttendanceSourceContextValue {
  const ctx = useContext(AttendanceSourceContext)
  if (!ctx) throw new Error('useAttendanceSource must be used within AttendanceSourceProvider')
  return ctx
}
