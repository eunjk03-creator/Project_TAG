'use client'
import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { ALL_RECORDS } from '@/data/mockData'
import type { Employee, RawRecord, CapsRow, ErpUnifiedRow, ProcessedRecord, PolicySettings } from '@/types/tag'
import { parseAttendanceData, type ParseResult } from '@/utils/dataParser'
import { usePolicy } from '@/context/PolicyContext'

// ── Context interface ─────────────────────────────────────────────────────

interface AttendanceSourceContextValue {
  employees:          Employee[]
  rawRecords:         RawRecord[]
  processedRecords:   ProcessedRecord[] | null
  processedAt:        string | null
  isLiveData:         boolean
  isLoading:          boolean
  isProcessing:       boolean
  lastUploadedAt:     string | null
  dbSaveError:        string | null
  setRawData:         (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult>
  clearLiveData:      () => Promise<void>
  recomputeProcessed: () => Promise<void>
}

const AttendanceSourceContext = createContext<AttendanceSourceContextValue | null>(null)

// ── Stored shapes ─────────────────────────────────────────────────────────
interface StoredAttendance {
  employees:  Employee[]
  rawRecords: RawRecord[]
}

// attendance_data key stores only employees + chunk metadata (rawRecords split across chunk keys)
interface AttendanceDataMeta {
  employees:   Employee[]
  chunkCount:  number
  rawRecords?: RawRecord[]  // legacy: old uploads stored records here directly
}

const CHUNK_SIZE = 4000  // records per chunk — keeps each PUT well under Vercel's 4.5MB limit

interface StoredProcessed {
  processed:   ProcessedRecord[]
  processedAt: string
}

interface CacheEntry extends StoredAttendance {
  updatedAt: string
}

interface ProcessedCacheEntry extends StoredProcessed {
  cachedAt: string
}

// ── localStorage helpers ──────────────────────────────────────────────────
const LS_KEY           = 'tag_attendance_v1'
const LS_PROCESSED_KEY = 'tag_processed_v1'

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

function lsLoadProcessed(): ProcessedCacheEntry | null {
  if (typeof window === 'undefined') return null
  try {
    const s = localStorage.getItem(LS_PROCESSED_KEY)
    return s ? (JSON.parse(s) as ProcessedCacheEntry) : null
  } catch { return null }
}

function lsSaveProcessed(entry: ProcessedCacheEntry) {
  try { localStorage.setItem(LS_PROCESSED_KEY, JSON.stringify(entry)) } catch {}
}

function lsClearProcessed() {
  try { localStorage.removeItem(LS_PROCESSED_KEY) } catch {}
}

// ── DB helpers ────────────────────────────────────────────────────────────

function normalizeDivisions(employees: Employee[]): Employee[] {
  return employees.map(e => e.division === '기타' ? { ...e, division: '신사업본부' } : e)
}

async function dbGet(): Promise<{ data: StoredAttendance | null; updatedAt: string | null }> {
  try {
    const res = await fetch('/api/shared-data/attendance_data')
    if (!res.ok) return { data: null, updatedAt: null }
    const { data: meta, updatedAt } = await res.json() as { data: AttendanceDataMeta | null; updatedAt: string | null }
    if (!meta?.employees) return { data: null, updatedAt: null }

    // Legacy: rawRecords stored directly (single chunk upload)
    if (meta.rawRecords?.length) {
      return { data: { employees: meta.employees, rawRecords: meta.rawRecords }, updatedAt }
    }

    // New chunked format
    const chunkCount = meta.chunkCount ?? 0
    if (chunkCount === 0) return { data: { employees: meta.employees, rawRecords: [] }, updatedAt }

    const chunkResponses = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        fetch(`/api/shared-data/attendance_records_${i}`)
          .then(r => r.ok ? r.json() as Promise<{ data: { records: RawRecord[] } | null }> : { data: null })
          .catch(() => ({ data: null })),
      ),
    )
    const rawRecords = chunkResponses.flatMap(r => r.data?.records ?? [])
    return { data: { employees: meta.employees, rawRecords }, updatedAt }
  } catch {
    return { data: null, updatedAt: null }
  }
}

async function dbPut(data: StoredAttendance | null): Promise<string | null> {
  try {
    if (!data) {
      const res = await fetch('/api/shared-data/attendance_data', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: null }),
      })
      if (!res.ok) return null
      return ((await res.json()) as { updatedAt: string }).updatedAt ?? null
    }

    const { employees, rawRecords } = data
    const chunkCount = Math.ceil(rawRecords.length / CHUNK_SIZE)
    console.log(`[TAG] dbPut: 직원 ${employees.length}명 · 레코드 ${rawRecords.length}건 → ${chunkCount}개 청크 병렬 업로드`)

    // Step 1: write metadata (employees + chunkCount) — always small
    const metaPayload = JSON.stringify({ data: { employees, chunkCount } })
    console.log(`[TAG] dbPut meta: ${(metaPayload.length / 1024).toFixed(0)}KB`)
    const metaRes = await fetch('/api/shared-data/attendance_data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: metaPayload,
    })
    if (!metaRes.ok) {
      const errText = await metaRes.text().catch(() => '응답 없음')
      console.error(`[TAG] dbPut meta 실패 HTTP ${metaRes.status}:`, errText.slice(0, 300))
      return null
    }
    const metaJson = await metaRes.json() as { ok: boolean; updatedAt: string }

    // Step 2: write record chunks in parallel — each ~1MB, under Vercel's 4.5MB limit
    const chunkResults = await Promise.all(
      Array.from({ length: chunkCount }, async (_, i) => {
        const records = rawRecords.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        const payload = JSON.stringify({ data: { records } })
        console.log(`[TAG] dbPut chunk ${i}: ${(payload.length / 1024).toFixed(0)}KB (${records.length}건)`)
        const res = await fetch(`/api/shared-data/attendance_records_${i}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload,
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => '응답 없음')
          console.error(`[TAG] dbPut chunk ${i} 실패 HTTP ${res.status}:`, errText.slice(0, 300))
          return false
        }
        return true
      }),
    )

    if (chunkResults.some(ok => !ok)) {
      console.error('[TAG] dbPut: 일부 청크 저장 실패')
      return null
    }

    console.log(`[TAG] dbPut 완료 (${chunkCount}개 청크): ${metaJson.updatedAt}`)
    return metaJson.updatedAt ?? null
  } catch (e) {
    console.error('[TAG] dbPut 예외:', e)
    return null
  }
}

async function dbGetProcessed(): Promise<{ data: StoredProcessed | null; updatedAt: string | null }> {
  try {
    const res = await fetch('/api/shared-data/processed_data')
    if (!res.ok) return { data: null, updatedAt: null }
    return res.json()
  } catch {
    return { data: null, updatedAt: null }
  }
}

async function apiCompute(policy: PolicySettings): Promise<string | null> {
  try {
    const res = await fetch('/api/compute-attendance', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ policy }),
    })
    if (!res.ok) return null
    const json = await res.json() as { ok: boolean; processedAt: string }
    return json.processedAt ?? null
  } catch {
    return null
  }
}

// ── Provider ──────────────────────────────────────────────────────────────

export function AttendanceSourceProvider({ children }: { children: ReactNode }) {
  const { policy } = usePolicy()

  const [liveEmployees,    setLiveEmployees]    = useState<Employee[] | null>(null)
  const [liveRecords,      setLiveRecords]      = useState<RawRecord[] | null>(null)
  const [rawCaps,          setRawCaps]          = useState<CapsRow[]       | null>(null)
  const [rawErp,           setRawErp]           = useState<ErpUnifiedRow[] | null>(null)
  const [processedRecords, setProcessedRecords] = useState<ProcessedRecord[] | null>(null)
  const [processedAt,      setProcessedAt]      = useState<string | null>(null)
  const [isLoading,        setIsLoading]        = useState(true)
  const [isProcessing,     setIsProcessing]     = useState(false)
  const [lastUploadedAt,   setLastUploadedAt]   = useState<string | null>(null)
  const [dbSaveError,      setDbSaveError]      = useState<string | null>(null)

  const isLiveData = liveEmployees !== null

  // ── Load processed records from DB / localStorage ─────────────────────
  const loadProcessedFromDB = useCallback(async () => {
    const { data, updatedAt } = await dbGetProcessed()
    if (data?.processed?.length) {
      setProcessedRecords(data.processed)
      setProcessedAt(updatedAt ?? data.processedAt)
      lsSaveProcessed({ processed: data.processed, processedAt: data.processedAt, cachedAt: new Date().toISOString() })
    }
  }, [])

  // ── Initial load: localStorage → 즉시 표시, DB 백그라운드 갱신 ─────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      // Load processed records from localStorage immediately
      const cachedProcessed = lsLoadProcessed()
      if (cachedProcessed?.processed?.length) {
        if (!cancelled) {
          setProcessedRecords(cachedProcessed.processed)
          setProcessedAt(cachedProcessed.processedAt)
        }
      }

      // Load raw records
      const cached = lsLoad()
      if (cached?.employees && cached?.rawRecords) {
        if (!cancelled) {
          const normalized = normalizeDivisions(cached.employees)
          setLiveEmployees(normalized)
          setLiveRecords(cached.rawRecords)
          setLastUploadedAt(cached.updatedAt)
          setIsLoading(false)
        }

        // Background: sync DB raw data
        try {
          const { data, updatedAt: dbTs } = await dbGet()
          if (cancelled) return
          if (dbTs && dbTs > cached.updatedAt && data?.employees && data?.rawRecords) {
            const normalized = normalizeDivisions(data.employees)
            if (!cancelled) {
              setLiveEmployees(normalized)
              setLiveRecords(data.rawRecords)
              setLastUploadedAt(dbTs)
              lsSave({ ...data, employees: normalized, updatedAt: dbTs })
            }
          }
        } catch { /* network error — use cache */ }

        // Background: sync DB processed data
        try {
          const { data: pd, updatedAt: pdTs } = await dbGetProcessed()
          if (cancelled) return
          const currentPdAt = cachedProcessed?.processedAt ?? ''
          if (pd?.processed?.length && (!currentPdAt || (pdTs && pdTs > currentPdAt))) {
            if (!cancelled) {
              setProcessedRecords(pd.processed)
              setProcessedAt(pdTs ?? pd.processedAt)
              lsSaveProcessed({ processed: pd.processed, processedAt: pd.processedAt, cachedAt: new Date().toISOString() })
            }
          }
        } catch { /* network error — use cache */ }
        return
      }

      // No cache — full load from DB
      setIsLoading(true)
      try {
        const [rawResult, pdResult] = await Promise.all([dbGet(), dbGetProcessed()])
        if (cancelled) return

        const { data, updatedAt } = rawResult
        if (data?.employees && data?.rawRecords) {
          const normalized = normalizeDivisions(data.employees)
          setLiveEmployees(normalized)
          setLiveRecords(data.rawRecords)
          setLastUploadedAt(updatedAt)
          if (updatedAt) lsSave({ ...data, employees: normalized, updatedAt })
        }

        const { data: pd, updatedAt: pdTs } = pdResult
        if (pd?.processed?.length) {
          setProcessedRecords(pd.processed)
          setProcessedAt(pdTs ?? pd.processedAt)
          lsSaveProcessed({ processed: pd.processed, processedAt: pd.processedAt, cachedAt: new Date().toISOString() })
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

  // ── Re-parse rawRecords when policy changes (raw CSV in memory) ────────
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    if (!rawCaps || !rawErp) return
    const { employees, rawRecords } = parseAttendanceData(rawCaps, rawErp, policy)
    const normalized = normalizeDivisions(employees)
    setLiveEmployees(normalized)
    setLiveRecords(rawRecords)
  }, [policy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── recomputeProcessed: trigger server-side computation ───────────────
  const recomputeProcessed = useCallback(async () => {
    setIsProcessing(true)
    try {
      const processedAt = await apiCompute(policy)
      if (processedAt) {
        await loadProcessedFromDB()
      }
    } catch (err) {
      console.error('[AttendanceSourceContext] recompute failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }, [policy, loadProcessedFromDB])

  // ── setRawData: parse → save to DB → server compute ───────────────────
  const setRawData = useCallback(async (caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<ParseResult> => {
    const result     = parseAttendanceData(caps, erp, policy)
    const normalized = normalizeDivisions(result.employees)

    setRawCaps(caps)
    setRawErp(erp)
    setLiveEmployees(normalized)
    setLiveRecords(result.rawRecords)
    setDbSaveError(null)

    const ts = await dbPut({ employees: normalized, rawRecords: result.rawRecords })
    if (ts) {
      setLastUploadedAt(ts)
      lsSave({ employees: normalized, rawRecords: result.rawRecords, updatedAt: ts })
    } else {
      const msg = `DB 저장 실패 — 브라우저에만 저장됨. 새로고침 시 데이터가 사라질 수 있습니다. (콘솔에서 상세 오류 확인)`
      setDbSaveError(msg)
      console.warn('[TAG] setRawData: dbPut 실패. 현재 세션에서만 데이터 유효.')
    }

    // Trigger server-side computation (non-blocking)
    setIsProcessing(true)
    apiCompute(policy).then(async (processedAt) => {
      if (processedAt) {
        await loadProcessedFromDB()
      } else {
        console.warn('[TAG] apiCompute 실패 — 처리 결과가 업데이트되지 않음. 재계산 버튼 클릭 필요.')
      }
    }).catch(console.error).finally(() => setIsProcessing(false))

    return { ...result, employees: normalized }
  }, [policy, loadProcessedFromDB])

  // ── clearLiveData ─────────────────────────────────────────────────────
  const clearLiveData = useCallback(async () => {
    await dbPut(null)
    lsClear()
    lsClearProcessed()
    setRawCaps(null)
    setRawErp(null)
    setLiveEmployees(null)
    setLiveRecords(null)
    setProcessedRecords(null)
    setProcessedAt(null)
    setLastUploadedAt(null)
  }, [])

  return (
    <AttendanceSourceContext.Provider value={{
      employees:          liveEmployees ?? EMPLOYEES,
      rawRecords:         liveRecords   ?? ALL_RECORDS,
      processedRecords,
      processedAt,
      isLiveData,
      isLoading,
      isProcessing,
      lastUploadedAt,
      dbSaveError,
      setRawData,
      clearLiveData,
      recomputeProcessed,
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
