'use client'
import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { ALL_RECORDS } from '@/data/mockData'
import type { Employee, RawRecord, CapsRow, ErpUnifiedRow } from '@/types/tag'
import { parseAttendanceData, type ParseResult } from '@/utils/dataParser'
import { usePolicy } from '@/context/PolicyContext'

// ── Context interface ─────────────────────────────────────────────────────

interface AttendanceSourceContextValue {
  employees:      Employee[]
  rawRecords:     RawRecord[]
  isLiveData:     boolean
  isLoading:      boolean
  lastUploadedAt: string | null
  setRawData:     (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult>
  clearLiveData:  () => Promise<void>
}

const AttendanceSourceContext = createContext<AttendanceSourceContextValue | null>(null)

// ── Stored shape ──────────────────────────────────────────────────────────
interface StoredAttendance {
  employees:  Employee[]
  rawRecords: RawRecord[]
}

interface CacheEntry extends StoredAttendance {
  updatedAt: string
}

// ── localStorage cache helpers ────────────────────────────────────────────
const LS_KEY = 'tag_attendance_v1'

function lsLoad(): CacheEntry | null {
  if (typeof window === 'undefined') return null
  try {
    const s = localStorage.getItem(LS_KEY)
    return s ? (JSON.parse(s) as CacheEntry) : null
  } catch { return null }
}

function lsSave(entry: CacheEntry) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(entry)) } catch {}
}

function lsClear() {
  try { localStorage.removeItem(LS_KEY) } catch {}
}

// ── DB helpers ────────────────────────────────────────────────────────────

function normalizeDivisions(employees: Employee[]): Employee[] {
  return employees.map(e => e.division === '기타' ? { ...e, division: '신사업본부' } : e)
}

async function dbGet(): Promise<{ data: StoredAttendance | null; updatedAt: string | null }> {
  try {
    const res = await fetch('/api/shared-data/attendance_data')
    if (!res.ok) return { data: null, updatedAt: null }
    return res.json()
  } catch {
    return { data: null, updatedAt: null }
  }
}

async function dbPut(data: StoredAttendance | null): Promise<string | null> {
  try {
    const res = await fetch('/api/shared-data/attendance_data', {
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

  const [liveEmployees,  setLiveEmployees]  = useState<Employee[] | null>(null)
  const [liveRecords,    setLiveRecords]    = useState<RawRecord[] | null>(null)
  const [rawCaps,        setRawCaps]        = useState<CapsRow[]        | null>(null)
  const [rawErp,         setRawErp]         = useState<ErpUnifiedRow[]  | null>(null)
  const [isLoading,      setIsLoading]      = useState(true)
  const [lastUploadedAt, setLastUploadedAt] = useState<string | null>(null)

  const isLiveData = liveEmployees !== null

  // ── Initial load: localStorage → 즉시 표시, DB에서 백그라운드 갱신 ──────
  useEffect(() => {
    let cancelled = false

    async function load() {
      // 1) localStorage 캐시가 있으면 즉시 화면에 표시
      const cached = lsLoad()
      if (cached?.employees && cached?.rawRecords) {
        if (!cancelled) {
          const normalized = normalizeDivisions(cached.employees)
          setLiveEmployees(normalized)
          setLiveRecords(cached.rawRecords)
          setLastUploadedAt(cached.updatedAt)
          setIsLoading(false)
        }

        // 2) 백그라운드에서 DB 타임스탬프 확인
        try {
          const { data, updatedAt: dbTs } = await dbGet()
          if (cancelled) return
          // DB에 더 최신 데이터가 있을 때만 교체
          if (dbTs && dbTs > cached.updatedAt && data?.employees && data?.rawRecords) {
            const normalized = normalizeDivisions(data.employees)
            setLiveEmployees(normalized)
            setLiveRecords(data.rawRecords)
            setLastUploadedAt(dbTs)
            lsSave({ ...data, employees: normalized, updatedAt: dbTs })
          }
        } catch { /* 네트워크 오류 시 캐시 그대로 사용 */ }
        return
      }

      // 3) 캐시 없으면 DB에서 전체 로드
      setIsLoading(true)
      try {
        const { data, updatedAt } = await dbGet()
        if (cancelled) return
        if (data?.employees && data?.rawRecords) {
          const normalized = normalizeDivisions(data.employees)
          setLiveEmployees(normalized)
          setLiveRecords(data.rawRecords)
          setLastUploadedAt(updatedAt)
          if (updatedAt) lsSave({ ...data, employees: normalized, updatedAt })
        }
      } catch (err) {
        console.error('[AttendanceSourceContext] DB load failed:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  // ── Re-parse when policy changes (only if raw CSV is in memory) ────────
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    if (!rawCaps || !rawErp) return
    const { employees, rawRecords } = parseAttendanceData(rawCaps, rawErp, policy)
    const normalized = normalizeDivisions(employees)
    setLiveEmployees(normalized)
    setLiveRecords(rawRecords)
  }, [policy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── setRawData: parse → DB 저장 + localStorage 캐시 갱신 ─────────────
  const setRawData = useCallback(async (caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<ParseResult> => {
    const result     = parseAttendanceData(caps, erp, policy)
    const normalized = normalizeDivisions(result.employees)

    setRawCaps(caps)
    setRawErp(erp)
    setLiveEmployees(normalized)
    setLiveRecords(result.rawRecords)

    const ts = await dbPut({ employees: normalized, rawRecords: result.rawRecords })
    if (ts) {
      setLastUploadedAt(ts)
      lsSave({ employees: normalized, rawRecords: result.rawRecords, updatedAt: ts })
    }

    return { ...result, employees: normalized }
  }, [policy])

  // ── clearLiveData ─────────────────────────────────────────────────────
  const clearLiveData = useCallback(async () => {
    await dbPut(null)
    lsClear()
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
