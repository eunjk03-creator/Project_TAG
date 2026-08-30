'use client'
import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { ALL_RECORDS } from '@/data/mockData'
import type { Employee, RawRecord, CapsRow, ErpUnifiedRow, ProcessedRecord, PolicySettings } from '@/types/tag'
import type { ParseResult } from '@/utils/dataParser'
import { usePolicy } from '@/context/PolicyContext'

// ── Context interface ─────────────────────────────────────────────────────
// (변경 없음 — 내부 데이터 소스만 shared_data_store JSON 캐시에서 정규화 테이블
// (caps_daily_logs/erp_applications/daily_attendance) 기반 API로 교체됐다.)

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
  setRawData:            (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult>
  mergeRawData:          (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult & { addedCount: number; updatedCount: number }>
  deleteRecordsByKeys:   (keys: Set<string>) => Promise<{ deletedCount: number }>
  recomputeProcessed:    () => Promise<void>
}

const AttendanceSourceContext = createContext<AttendanceSourceContextValue | null>(null)

// ── localStorage helpers (그대로) ───────────────────────────────────────────
interface StoredAttendance {
  employees:  Employee[]
  rawRecords: RawRecord[]
}
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

function normalizeDivisions(employees: Employee[]): Employee[] {
  return employees.map(e => e.division === '기타' ? { ...e, division: '신사업본부' } : e)
}

// ── 서버 API 헬퍼 ────────────────────────────────────────────────────────────
// caps_data/erp_data/attendance_data/processed_data(shared_data_store JSON 청크)는 전부
// 은퇴 — caps_daily_logs/erp_applications/daily_attendance(정규화 테이블) 기반 API로 교체.

async function fetchRawRecords(): Promise<{ data: StoredAttendance | null; updatedAt: string | null }> {
  try {
    const res = await fetch('/api/attendance-raw-records')
    if (!res.ok) return { data: null, updatedAt: null }
    const json = await res.json() as { employees: Employee[]; rawRecords: RawRecord[]; fetchedAt: string }
    if (!json.employees?.length) return { data: null, updatedAt: null }
    return { data: { employees: json.employees, rawRecords: json.rawRecords }, updatedAt: json.fetchedAt }
  } catch {
    return { data: null, updatedAt: null }
  }
}

async function fetchProcessedRecords(): Promise<{ data: StoredProcessed | null; updatedAt: string | null }> {
  try {
    const res = await fetch('/api/attendance-records')
    if (!res.ok) return { data: null, updatedAt: null }
    const json = await res.json() as { employees: Employee[]; records: ProcessedRecord[]; fetchedAt: string }
    if (!json.records?.length) return { data: null, updatedAt: null }
    return { data: { processed: json.records, processedAt: json.fetchedAt }, updatedAt: json.fetchedAt }
  } catch {
    return { data: null, updatedAt: null }
  }
}

interface IngestResponse {
  ok: boolean
  affectedEmployees: number
  processedRecords: number
  skippedCount: number
  erpOtMatchCount: number
}

async function ingest(caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<{ result: IngestResponse | null; error: string | null }> {
  try {
    const res = await fetch('/api/attendance-ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caps, erp }),
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      let msg = bodyText
      try { msg = (JSON.parse(bodyText) as { error?: string }).error ?? bodyText } catch { /* not JSON */ }
      return { result: null, error: `업로드 실패 (HTTP ${res.status})${msg ? `: ${msg.slice(0, 200)}` : ''}` }
    }
    return { result: await res.json() as IngestResponse, error: null }
  } catch (err) {
    return { result: null, error: `업로드 요청 실패: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// 한 페이지당 처리 건수 — /api/compute-attendance가 이 슬라이스만큼만 processRecord()를
// 돌리고 daily_attendance에 upsert한다(정책 변경처럼 전 직원 영향받는 "전체 재계산" 전용 —
// CAPS/ERP 업로드는 더 이상 이 경로를 안 씀, ingest()가 영향받은 직원만 증분 재계산).
const RECOMPUTE_PAGE_SIZE = 2000

interface ComputePageResponse {
  ok:          boolean
  processed:   ProcessedRecord[]
  totalCount:  number
  offset:      number
  done:        boolean
  processedAt: string
}

async function fetchComputePage(
  policy: PolicySettings, offset: number, limit: number,
): Promise<{ page: ComputePageResponse | null; error: string | null }> {
  try {
    const res = await fetch('/api/compute-attendance', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ policy, offset, limit }),
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      let msg = bodyText
      try { msg = (JSON.parse(bodyText) as { error?: string }).error ?? bodyText } catch { /* not JSON */ }
      return { page: null, error: `전체 재계산 실패 (HTTP ${res.status})${msg ? `: ${msg.slice(0, 200)}` : ''}` }
    }
    return { page: await res.json() as ComputePageResponse, error: null }
  } catch (err) {
    return { page: null, error: `전체 재계산 요청 실패: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** offset/limit 페이지네이션으로 compute-attendance를 반복 호출해 전체 레코드를 처리한다.
 *  각 페이지가 daily_attendance를 이미 upsert하므로(route.ts 참고), 여기선 끝까지 도는 것만
 *  책임진다 — 예전처럼 클라이언트에서 전체 결과를 누적해 JSON 캐시에 다시 쓰는 단계는 없다. */
async function apiRecomputeAll(policy: PolicySettings): Promise<{ error: string | null }> {
  let offset = 0
  for (;;) {
    const { page, error } = await fetchComputePage(policy, offset, RECOMPUTE_PAGE_SIZE)
    if (error || !page) return { error }
    if (page.processed.length === 0 || page.done) break
    offset += page.processed.length
  }
  return { error: null }
}

// ── Provider ──────────────────────────────────────────────────────────────

export function AttendanceSourceProvider({ children }: { children: ReactNode }) {
  const { policy } = usePolicy()

  const [liveEmployees,    setLiveEmployees]    = useState<Employee[] | null>(null)
  const [liveRecords,      setLiveRecords]      = useState<RawRecord[] | null>(null)
  const [processedRecords, setProcessedRecords] = useState<ProcessedRecord[] | null>(null)
  const [processedAt,      setProcessedAt]      = useState<string | null>(null)
  const [isLoading,        setIsLoading]        = useState(true)
  const [isProcessing,     setIsProcessing]     = useState(false)
  const [lastUploadedAt,   setLastUploadedAt]   = useState<string | null>(null)
  const [dbSaveError,      setDbSaveError]      = useState<string | null>(null)

  const isLiveData = liveEmployees !== null

  // ── 서버에서 employees/rawRecords + processedRecords 새로고침 ──────────
  const refreshFromServer = useCallback(async () => {
    const [rawResult, pdResult] = await Promise.all([fetchRawRecords(), fetchProcessedRecords()])

    const { data, updatedAt } = rawResult
    if (data?.employees?.length) {
      const normalized = normalizeDivisions(data.employees)
      setLiveEmployees(normalized)
      setLiveRecords(data.rawRecords)
      setLastUploadedAt(updatedAt)
      if (updatedAt) lsSave({ employees: normalized, rawRecords: data.rawRecords, updatedAt })
    }

    const { data: pd, updatedAt: pdTs } = pdResult
    if (pd?.processed?.length) {
      setProcessedRecords(pd.processed)
      setProcessedAt(pdTs ?? pd.processedAt)
      lsSaveProcessed({ processed: pd.processed, processedAt: pd.processedAt, cachedAt: new Date().toISOString() })
    }
  }, [])

  // ── Initial load: localStorage → 즉시 표시, 서버에서 백그라운드 갱신 ────
  useEffect(() => {
    let cancelled = false

    async function load() {
      const cachedProcessed = lsLoadProcessed()
      if (cachedProcessed?.processed?.length && !cancelled) {
        setProcessedRecords(cachedProcessed.processed)
        setProcessedAt(cachedProcessed.processedAt)
      }

      const cached = lsLoad()
      if (cached?.employees?.length && !cancelled) {
        const normalized = normalizeDivisions(cached.employees)
        setLiveEmployees(normalized)
        setLiveRecords(cached.rawRecords)
        setLastUploadedAt(cached.updatedAt)
        setIsLoading(false)
      } else {
        setIsLoading(true)
      }

      try {
        await refreshFromServer()
      } catch (err) {
        console.error('[AttendanceSourceContext] 서버 로드 실패:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [refreshFromServer])

  // ── 정책 변경 시 자동 전체 재계산 (예: 공휴일 추가) ─────────────────────
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    if (!isLiveData) return

    setIsProcessing(true)
    apiRecomputeAll(policy)
      .then(async ({ error }) => {
        if (error) { setDbSaveError(error); return }
        await refreshFromServer()
      })
      .catch(err => setDbSaveError(String(err)))
      .finally(() => setIsProcessing(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy])

  // ── recomputeProcessed: 사용자가 직접 누르는 "전체 재계산" 버튼 ─────────
  const recomputeProcessed = useCallback(async () => {
    setIsProcessing(true)
    try {
      const { error } = await apiRecomputeAll(policy)
      if (error) {
        setDbSaveError(error)
      } else {
        setDbSaveError(null)
        await refreshFromServer()
      }
    } catch (err) {
      setDbSaveError(`전체 재계산 실패: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsProcessing(false)
    }
  }, [policy, refreshFromServer])

  // ── setRawData / mergeRawData: /api/attendance-ingest에 위임 ────────────
  // upsert 기반이라 "전체 교체"와 "병합"의 구분이 없어졌다(둘 다 누적) — setRawData는
  // 호출부가 없어(레거시) mergeRawData와 동일하게 동작해도 무방.
  const runIngest = useCallback(async (
    caps: CapsRow[], erp: ErpUnifiedRow[],
  ): Promise<ParseResult & { addedCount: number; updatedCount: number }> => {
    setIsProcessing(true)
    setDbSaveError(null)
    try {
      const { result, error } = await ingest(caps, erp)
      if (!result) {
        setDbSaveError(error ?? '업로드 처리에 실패했습니다.')
        return { employees: [], rawRecords: [], skippedCount: 0, erpOtMatchCount: 0, addedCount: 0, updatedCount: 0 }
      }
      await refreshFromServer()
      return {
        employees: liveEmployees ?? [],
        rawRecords: liveRecords ?? [],
        skippedCount: result.skippedCount,
        erpOtMatchCount: result.erpOtMatchCount,
        addedCount: result.affectedEmployees,
        updatedCount: 0,
      }
    } finally {
      setIsProcessing(false)
    }
  }, [refreshFromServer, liveEmployees, liveRecords])

  const setRawData = useCallback(async (caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<ParseResult> => {
    return runIngest(caps, erp)
  }, [runIngest])

  const mergeRawData = useCallback(async (
    caps: CapsRow[], erp: ErpUnifiedRow[],
  ): Promise<ParseResult & { addedCount: number; updatedCount: number }> => {
    return runIngest(caps, erp)
  }, [runIngest])

  // ── deleteRecordsByKeys: 업로드한 파일 되돌리기 ─────────────────────────
  const deleteRecordsByKeys = useCallback(async (keys: Set<string>): Promise<{ deletedCount: number }> => {
    setIsProcessing(true)
    setDbSaveError(null)
    try {
      const res = await fetch('/api/attendance-ingest', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [...keys] }),
      })
      if (!res.ok) {
        setDbSaveError(`삭제 실패 (HTTP ${res.status})`)
        return { deletedCount: 0 }
      }
      const { deletedCount } = await res.json() as { deletedCount: number }
      await refreshFromServer()
      return { deletedCount }
    } finally {
      setIsProcessing(false)
    }
  }, [refreshFromServer])

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
      mergeRawData,
      deleteRecordsByKeys,
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
