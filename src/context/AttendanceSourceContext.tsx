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
  setRawData:            (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult>
  mergeRawData:          (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<ParseResult & { addedCount: number; updatedCount: number }>
  deleteRecordsByKeys:   (keys: Set<string>) => Promise<{ deletedCount: number }>
  clearLiveData:         () => Promise<void>
  recomputeProcessed:    () => Promise<void>
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

// processed_data key stores only processedAt + chunk metadata (processed records split
// across processed_records_N keys, same convention as attendance_records_N above).
interface ProcessedDataMeta {
  processedAt: string
  chunkCount:  number
  processed?:  ProcessedRecord[]  // legacy: old saves stored records here directly
}

// Smaller than CHUNK_SIZE (4000) — ProcessedRecord carries roughly double the fields of a
// RawRecord (effectiveClockIn/regularHours/overtimeHours/nightHours/holidayHours/etc.), so
// the same record count per chunk runs closer to Vercel's ~4.5MB body limit.
const PROCESSED_CHUNK_SIZE = 2000

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

// 청크 GET도 전부 동시에 쏘면(구 Promise.all 방식) 초기 로드 시 attendance_records_N +
// processed_records_N 합쳐 수십 개 요청이 한꺼번에 나가 Supabase 풀러 커넥션이 터지고,
// 그 여파로 문서 자체 응답까지 503이 나서 페이지 전체가 로드 실패하는 사례가 실측됨
// (2026-08-10, personnel-roster 브랜치 프리뷰 점검 중 발견). dbPut()/apiCompute() 쓰기
// 경로에 이미 있는 CHUNK_BATCH_SIZE=4 배치 컨벤션을 읽기 경로에도 동일하게 적용한다.
const CHUNK_READ_BATCH_SIZE = 4

async function fetchChunksBatched<T>(keyOf: (i: number) => string, chunkCount: number): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; start < chunkCount; start += CHUNK_READ_BATCH_SIZE) {
    const batchIdx = Array.from(
      { length: Math.min(CHUNK_READ_BATCH_SIZE, chunkCount - start) },
      (_, j) => start + j,
    )
    const batch = await Promise.all(
      batchIdx.map(i =>
        fetch(`/api/shared-data/${keyOf(i)}`)
          .then(r => r.ok ? r.json() as Promise<{ data: { records: T[] } | null }> : { data: null })
          .then(r => r.data?.records ?? [])
          .catch(() => [] as T[]),
      ),
    )
    for (const recs of batch) out.push(...recs)
  }
  return out
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

    const rawRecords = await fetchChunksBatched<RawRecord>(i => `attendance_records_${i}`, chunkCount)
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

    // Step 2: write record chunks in small batches (not all at once) — firing every chunk
    // in parallel spiked concurrent connections through the Supabase pooler and caused
    // intermittent 500s (even on the small meta write above, from overlapping upload
    // attempts). Each ~1MB, under Vercel's 4.5MB limit either way.
    const CHUNK_BATCH_SIZE = 4
    const chunkResults: boolean[] = []
    for (let start = 0; start < chunkCount; start += CHUNK_BATCH_SIZE) {
      const batchIdx = Array.from(
        { length: Math.min(CHUNK_BATCH_SIZE, chunkCount - start) },
        (_, j) => start + j,
      )
      const batchResults = await Promise.all(
        batchIdx.map(async (i) => {
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
      chunkResults.push(...batchResults)
    }

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
    const { data: meta, updatedAt } = await res.json() as { data: ProcessedDataMeta | null; updatedAt: string | null }
    if (!meta) return { data: null, updatedAt: null }

    // Legacy: processed records stored directly (single-row save, pre-chunking)
    if (meta.processed?.length) {
      return { data: { processed: meta.processed, processedAt: meta.processedAt }, updatedAt }
    }

    const chunkCount = meta.chunkCount ?? 0
    if (chunkCount === 0) return { data: { processed: [], processedAt: meta.processedAt }, updatedAt }

    const processed = await fetchChunksBatched<ProcessedRecord>(i => `processed_records_${i}`, chunkCount)
    return { data: { processed, processedAt: meta.processedAt }, updatedAt }
  } catch {
    return { data: null, updatedAt: null }
  }
}

// 한 페이지당 처리 건수 — compute-attendance/route.ts가 이 슬라이스만큼만 processRecord()를
// 돌리고 새 DailyAttendance 테이블에 upsert한다. 여러 번 나눠 호출해서 요청 하나가 4~5만
// 건을 전부 처리할 필요가 없게 만드는 게 타임아웃(B14)의 구조적 해결책 — 이 상수를 줄이면
// 요청당 부담은 더 줄고 왕복 횟수는 늘어난다.
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
      // 504(Vercel 함수 타임아웃)는 본문이 HTML이거나 비어있을 수 있어 text()로 우선 확보
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

/**
 * offset/limit 페이지네이션으로 compute-attendance를 반복 호출해 전체 레코드를 처리한다.
 * 각 페이지 응답의 processed 슬라이스를 클라이언트에서 누적한 뒤, 전부 끝나면 그 완전한
 * 배열을 processed_data(메타) + processed_records_N(청크) 로 나눠 쓴다(라우트 자체는
 * 페이지네이션 호출 시 blob을 안 건드림 — route.ts 주석 참고).
 *
 * 데이터가 5만 건을 넘으면(20MB+) 한 번의 PUT으로는 Vercel 요청 본문 크기 제한(~4.5MB)에
 * 걸려 HTTP 413로 실패했다(2026-08-04 발견). attendance_records_N과 동일한 청크 컨벤션으로
 * 나눠 쓰도록 수정(2026-08-05) — DailyAttendance(그리드/수당집계/내보내기 3종)는 페이지마다
 * 이미 정상 갱신되고, 이 청크 저장은 대시보드 새로고침용 캐시(processedRecords)를 갱신한다.
 */
async function apiCompute(policy: PolicySettings): Promise<{ processedAt: string | null; error: string | null }> {
  const accumulated: ProcessedRecord[] = []
  let offset = 0
  let processedAt = new Date().toISOString()

  for (;;) {
    const { page, error } = await fetchComputePage(policy, offset, RECOMPUTE_PAGE_SIZE)
    if (error || !page) return { processedAt: null, error }
    accumulated.push(...page.processed)
    processedAt = page.processedAt
    if (page.processed.length === 0 || page.done) break
    offset += page.processed.length
  }

  if (accumulated.length === 0) return { processedAt, error: null }

  try {
    const chunkCount = Math.ceil(accumulated.length / PROCESSED_CHUNK_SIZE)

    // Step 1: write metadata (processedAt + chunkCount) — always small
    const metaRes = await fetch('/api/shared-data/processed_data', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data: { processedAt, chunkCount } }),
    })
    if (!metaRes.ok) return { processedAt: null, error: `재계산 결과 저장 실패 (HTTP ${metaRes.status}) — DailyAttendance는 정상 갱신됨, 대시보드 새로고침용 캐시만 실패` }

    // Step 2: write record chunks in small batches — same rationale as dbPut() above
    // (firing every chunk in parallel spiked concurrent connections through the Supabase pooler).
    const CHUNK_BATCH_SIZE = 4
    for (let start = 0; start < chunkCount; start += CHUNK_BATCH_SIZE) {
      const batchIdx = Array.from(
        { length: Math.min(CHUNK_BATCH_SIZE, chunkCount - start) },
        (_, j) => start + j,
      )
      const batchOk = await Promise.all(
        batchIdx.map(async (i) => {
          const records = accumulated.slice(i * PROCESSED_CHUNK_SIZE, (i + 1) * PROCESSED_CHUNK_SIZE)
          const res = await fetch(`/api/shared-data/processed_records_${i}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ data: { records } }),
          })
          return res.ok
        }),
      )
      if (batchOk.some(ok => !ok)) {
        return { processedAt: null, error: '재계산 결과 저장 실패 (청크 업로드 실패) — DailyAttendance는 정상 갱신됨, 대시보드 새로고침용 캐시만 실패' }
      }
    }
  } catch (err) {
    return { processedAt: null, error: `재계산 결과 저장 실패: ${err instanceof Error ? err.message : String(err)}` }
  }

  return { processedAt, error: null }
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
        // Skip if processed_data is older than the raw upload — it means a prior apiCompute
        // failed after the last merge, and loading stale data would hide the new records.
        try {
          const { data: pd, updatedAt: pdTs } = await dbGetProcessed()
          if (cancelled) return
          const currentPdAt   = cachedProcessed?.processedAt ?? ''
          const rawUploadedAt = cached.updatedAt ?? ''
          const isStale       = !!(pdTs && rawUploadedAt && pdTs < rawUploadedAt)
          if (!isStale && pd?.processed?.length && (!currentPdAt || (pdTs && pdTs > currentPdAt))) {
            if (!cancelled) {
              setProcessedRecords(pd.processed)
              setProcessedAt(pdTs ?? pd.processedAt)
              lsSaveProcessed({ processed: pd.processed, processedAt: pd.processedAt, cachedAt: new Date().toISOString() })
            }
          } else if (isStale && !cancelled) {
            // Stale processed data detected on load: trigger background recompute silently
            setIsProcessing(true)
            apiCompute(policy)
              .then(async ({ processedAt: pt }) => { if (pt) await loadProcessedFromDB() })
              .catch(console.error)
              .finally(() => { if (!cancelled) setIsProcessing(false) })
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
        // Skip stale processed data: if raw upload is newer than last computation,
        // the processed data doesn't include the new records.
        const isStale = !!(pdTs && updatedAt && pdTs < updatedAt)
        if (!isStale && pd?.processed?.length) {
          setProcessedRecords(pd.processed)
          setProcessedAt(pdTs ?? pd.processedAt)
          lsSaveProcessed({ processed: pd.processed, processedAt: pd.processedAt, cachedAt: new Date().toISOString() })
        } else if (isStale && data?.rawRecords?.length && !cancelled) {
          // Stale processed data detected on fresh load: trigger background recompute
          setIsProcessing(true)
          apiCompute(policy)
            .then(async ({ processedAt: pt }) => { if (pt) await loadProcessedFromDB() })
            .catch(console.error)
            .finally(() => { if (!cancelled) setIsProcessing(false) })
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
  // Also auto-recompute processed data if live DB data exists (e.g. after adding company holidays)
  const mountedRef     = useRef(false)
  const isLiveDataRef  = useRef(false)
  useEffect(() => { isLiveDataRef.current = liveEmployees !== null }, [liveEmployees])

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }

    if (rawCaps && rawErp) {
      const { employees, rawRecords } = parseAttendanceData(rawCaps, rawErp, policy)
      const normalized = normalizeDivisions(employees)
      setLiveEmployees(normalized)
      setLiveRecords(rawRecords)
    }

    if (isLiveDataRef.current) {
      setIsProcessing(true)
      apiCompute(policy)
        .then(async ({ processedAt: pt }) => { if (pt) await loadProcessedFromDB() })
        .catch(console.error)
        .finally(() => setIsProcessing(false))
    }
  }, [policy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── recomputeProcessed: trigger server-side computation (사용자가 직접 누르는 버튼) ──
  // 조용히 실패하면 안 됨 — 실패 시 dbSaveError에 이유를 남겨서 CsvUploader 등에서
  // 그대로 노출한다 (기존엔 버튼을 눌러도 실패가 콘솔에만 찍히고 화면엔 아무 표시가 없었음).
  const recomputeProcessed = useCallback(async () => {
    setIsProcessing(true)
    try {
      const { processedAt, error } = await apiCompute(policy)
      if (processedAt) {
        setDbSaveError(null)
        await loadProcessedFromDB()
      } else {
        setDbSaveError(error ?? '전체 재계산에 실패했습니다. 다시 시도해 주세요.')
      }
    } catch (err) {
      setDbSaveError(`전체 재계산 실패: ${err instanceof Error ? err.message : String(err)}`)
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
    // Clear stale processed records so the client-side fallback uses fresh rawRecords
    // while the server recomputes. Without this, old serverProcessed (with stale
    // erpOtApplied values) would block the client-side path.
    setProcessedRecords(null)
    lsClearProcessed()

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
    apiCompute(policy).then(async ({ processedAt, error }) => {
      if (processedAt) {
        await loadProcessedFromDB()
      } else {
        console.warn('[TAG] apiCompute 실패 — 처리 결과가 업데이트되지 않음. 재계산 버튼 클릭 필요.', error)
      }
    }).catch(console.error).finally(() => setIsProcessing(false))

    return { ...result, employees: normalized }
  }, [policy, loadProcessedFromDB])

  // ── mergeRawData: 기존 DB 데이터 유지 + 신규 파일 병합 ───────────────
  // (사번 + 날짜) 기준으로 merge — 신규 파일 쪽이 기존 데이터를 덮어씀
  const mergeRawData = useCallback(async (
    caps: CapsRow[],
    erp:  ErpUnifiedRow[],
  ): Promise<ParseResult & { addedCount: number; updatedCount: number }> => {
    // 기존 DB 데이터 먼저 로드 — 이번 CAPS 배치에 없는 기존 직원도 ERP 휴가/연장 매칭 대상에
    // 포함시켜야 함(안 그러면 이번에 CAPS를 재업로드하지 않은 직원의 ERP 행이 전부
    // "직원 목록에 없음"으로 스킵되어 매칭 건수가 실제보다 크게 적게 나옴).
    const { data: existing } = await dbGet()

    const newResult     = parseAttendanceData(caps, erp, policy, existing?.employees ?? [])
    const newNormalized = normalizeDivisions(newResult.employees)

    // 기존 데이터 없으면 전체 교체와 동일하게 처리
    if (!existing || existing.rawRecords.length === 0) {
      setRawCaps(caps)
      setRawErp(erp)
      setLiveEmployees(newNormalized)
      setLiveRecords(newResult.rawRecords)
      setDbSaveError(null)
      setProcessedRecords(null)
      lsClearProcessed()
      const ts = await dbPut({ employees: newNormalized, rawRecords: newResult.rawRecords })
      if (ts) {
        setLastUploadedAt(ts)
        lsSave({ employees: newNormalized, rawRecords: newResult.rawRecords, updatedAt: ts })
      } else {
        setDbSaveError('DB 저장 실패 — 브라우저에만 저장됨. 새로고침 시 데이터가 사라질 수 있습니다.')
      }
      setIsProcessing(true)
      apiCompute(policy).then(async ({ processedAt: pt }) => { if (pt) await loadProcessedFromDB() })
        .catch(console.error).finally(() => setIsProcessing(false))
      return { ...newResult, employees: newNormalized, addedCount: newResult.rawRecords.length, updatedCount: 0 }
    }

    // (employeeId_date) 기준 merge — 신규 우선
    const existingKeySet = new Set(existing.rawRecords.map(r => `${r.employeeId}_${r.date}`))
    const mergedMap = new Map<string, RawRecord>()
    for (const r of existing.rawRecords)    mergedMap.set(`${r.employeeId}_${r.date}`, r)
    for (const r of newResult.rawRecords)   mergedMap.set(`${r.employeeId}_${r.date}`, r)
    const mergedRecords = Array.from(mergedMap.values())
      .sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId))

    // 직원 merge — 신규 우선
    const empMap = new Map<string, Employee>()
    for (const e of existing.employees) empMap.set(e.id, e)
    for (const e of newNormalized)      empMap.set(e.id, e)
    const mergedEmployees = Array.from(empMap.values())

    const addedCount   = newResult.rawRecords.filter(r => !existingKeySet.has(`${r.employeeId}_${r.date}`)).length
    const updatedCount = newResult.rawRecords.length - addedCount

    setLiveEmployees(mergedEmployees)
    setLiveRecords(mergedRecords)
    setDbSaveError(null)
    setProcessedRecords(null)
    lsClearProcessed()

    const ts = await dbPut({ employees: mergedEmployees, rawRecords: mergedRecords })
    if (ts) {
      setLastUploadedAt(ts)
      lsSave({ employees: mergedEmployees, rawRecords: mergedRecords, updatedAt: ts })
    } else {
      setDbSaveError('DB 저장 실패 — 브라우저에만 저장됨. 새로고침 시 데이터가 사라질 수 있습니다.')
    }

    setIsProcessing(true)
    apiCompute(policy).then(async ({ processedAt: pt }) => { if (pt) await loadProcessedFromDB() })
      .catch(console.error).finally(() => setIsProcessing(false))

    return { ...newResult, employees: mergedEmployees, rawRecords: mergedRecords, addedCount, updatedCount }
  }, [policy, loadProcessedFromDB]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── deleteRecordsByKeys: 특정 레코드만 DB에서 삭제 ───────────────────
  const deleteRecordsByKeys = useCallback(async (keys: Set<string>): Promise<{ deletedCount: number }> => {
    const current = liveRecords ?? []
    const remaining = current.filter(r => !keys.has(`${r.employeeId}_${r.date}`))
    const deletedCount = current.length - remaining.length
    if (deletedCount === 0) return { deletedCount: 0 }

    setLiveRecords(remaining)
    setDbSaveError(null)
    const ts = await dbPut({ employees: liveEmployees ?? [], rawRecords: remaining })
    if (ts) {
      setLastUploadedAt(ts)
      lsSave({ employees: liveEmployees ?? [], rawRecords: remaining, updatedAt: ts })
    } else {
      setDbSaveError('DB 저장 실패')
    }

    setIsProcessing(true)
    apiCompute(policy).then(async ({ processedAt: pt }) => { if (pt) await loadProcessedFromDB() })
      .catch(console.error).finally(() => setIsProcessing(false))

    return { deletedCount }
  }, [liveRecords, liveEmployees, policy, loadProcessedFromDB])

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
      mergeRawData,
      deleteRecordsByKeys,
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
