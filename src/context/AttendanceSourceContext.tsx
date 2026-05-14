'use client'
import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { ALL_RECORDS } from '@/data/mockData'
import type { Employee, RawRecord, CapsRow, ErpRow, ErpOtRow } from '@/types/tag'
import { parseAttendanceData, type ParseResult } from '@/utils/dataParser'
import { usePolicy } from '@/context/PolicyContext'

// ── localStorage keys ─────────────────────────────────────────────────────

const LS_EMP    = 'tag_live_employees'
const LS_REC    = 'tag_live_rawRecords'
const LS_CAPS   = 'tag_raw_caps'
const LS_ERP_LV = 'tag_raw_erp_leave'
const LS_ERP_OT = 'tag_raw_erp_ot'

function load<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

function drop(key: string) {
  try { localStorage.removeItem(key) } catch {}
}

// ── Context interface ─────────────────────────────────────────────────────

interface AttendanceSourceContextValue {
  employees:    Employee[]
  rawRecords:   RawRecord[]
  isLiveData:   boolean
  /**
   * Upload raw CSV arrays.  Context parses them immediately with the current
   * policy, persists everything to localStorage, and returns the ParseResult
   * (including skippedCount) so the caller can show a status summary.
   */
  setRawData:   (caps: CapsRow[], erpLeave: ErpRow[], erpOt: ErpOtRow[]) => ParseResult
  clearLiveData: () => void
}

const AttendanceSourceContext = createContext<AttendanceSourceContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────

export function AttendanceSourceProvider({ children }: { children: ReactNode }) {
  const { policy } = usePolicy()

  // ── Parsed (derived) state ────────────────────────────────────────────
  const [liveEmployees, setLiveEmployees] = useState<Employee[] | null>(
    () => load<Employee[]>(LS_EMP),
  )
  const [liveRecords, setLiveRecords] = useState<RawRecord[] | null>(
    () => load<RawRecord[]>(LS_REC),
  )

  // ── Raw CSV state (kept for policy-triggered re-parse) ────────────────
  const [rawCaps,     setRawCaps]     = useState<CapsRow[]   | null>(() => load<CapsRow[]>(LS_CAPS))
  const [rawErpLeave, setRawErpLeave] = useState<ErpRow[]    | null>(() => load<ErpRow[]>(LS_ERP_LV))
  const [rawErpOt,    setRawErpOt]    = useState<ErpOtRow[]  | null>(() => load<ErpOtRow[]>(LS_ERP_OT))

  const isLiveData = liveEmployees !== null

  // ── Re-parse when policy changes (skip initial mount) ─────────────────
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    if (!rawCaps || !rawErpLeave || !rawErpOt) return

    const { employees, rawRecords } = parseAttendanceData(rawCaps, rawErpLeave, rawErpOt, policy)
    setLiveEmployees(employees)
    setLiveRecords(rawRecords)
    save(LS_EMP, employees)
    save(LS_REC, rawRecords)
  }, [policy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── setRawData: called by CsvUploader on new upload ───────────────────
  function setRawData(
    caps:      CapsRow[],
    erpLeave:  ErpRow[],
    erpOt:     ErpOtRow[],
  ): ParseResult {
    // Persist raw arrays so a future policy change can re-parse
    setRawCaps(caps);     save(LS_CAPS,   caps)
    setRawErpLeave(erpLeave); save(LS_ERP_LV, erpLeave)
    setRawErpOt(erpOt);   save(LS_ERP_OT, erpOt)

    // Parse with current policy and persist derived data
    const result = parseAttendanceData(caps, erpLeave, erpOt, policy)
    setLiveEmployees(result.employees)
    setLiveRecords(result.rawRecords)
    save(LS_EMP, result.employees)
    save(LS_REC, result.rawRecords)

    return result
  }

  // ── clearLiveData: wipe everything ────────────────────────────────────
  function clearLiveData() {
    setRawCaps(null);     drop(LS_CAPS)
    setRawErpLeave(null); drop(LS_ERP_LV)
    setRawErpOt(null);    drop(LS_ERP_OT)
    setLiveEmployees(null); drop(LS_EMP)
    setLiveRecords(null);   drop(LS_REC)
  }

  return (
    <AttendanceSourceContext.Provider value={{
      employees:  liveEmployees ?? EMPLOYEES,
      rawRecords: liveRecords   ?? ALL_RECORDS,
      isLiveData,
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
