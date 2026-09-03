'use client'
import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import type { Employee, CapsRow, ErpUnifiedRow, ProcessedRecord, PolicySettings } from '@/types/tag'
import { usePolicy } from '@/context/PolicyContext'

// ── Context interface ─────────────────────────────────────────────────────
// processedRecords(전체 연도)도, rawRecords(전체 6만+행)도 여기서 더 이상 들고 있지 않는다 —
// 둘 다 "화면마다 필요한 범위가 다 다른데 굳이 다 받아서 메모리에 올려두고 자를 이유가
// 없다"는 이유로 각 화면이 자기 몫만 직접 서버에서 받아간다:
//   - processedRecords → useProcessedAttendance(from, to) (src/hooks/useProcessedAttendance.ts)
//   - rawRecords(직원 1명분)   → EmployeeDrawer가 /api/attendance-raw-records?employeeId= 직접 호출
//   - rawRecords(전체, 드묾)   → admin/anomalies처럼 정말 전 직원이 필요한 화면만
//     /api/attendance-raw-records?full=1 직접 호출
// 여기 Context는 employees(가벼움, ~400명)와 rawRecordCount/dateBounds(배지·기본기간 추정용
// 숫자 몇 개)만 들고 있고, dataVersion으로 "서버 데이터가 방금 바뀌었다"만 신호로 준다.

interface AttendanceSourceContextValue {
  employees:          Employee[]
  rawRecordCount:      number
  dateBounds:          { min: string; max: string } | null
  dataVersion:        number
  isLiveData:         boolean
  isLoading:          boolean
  isProcessing:       boolean
  lastUploadedAt:     string | null
  dbSaveError:        string | null
  setRawData:            (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<IngestSummary>
  mergeRawData:          (caps: CapsRow[], erp: ErpUnifiedRow[]) => Promise<IngestSummary>
  deleteRecordsByKeys:   (keys: Set<string>) => Promise<{ deletedCount: number }>
  recomputeProcessed:    () => Promise<void>
}

export interface IngestSummary {
  employeeCount:   number
  affectedCount:   number
  skippedCount:    number
  erpOtMatchCount: number
}

const AttendanceSourceContext = createContext<AttendanceSourceContextValue | null>(null)

// ── localStorage helpers — 가벼운 값(직원 목록 + 건수 + 날짜범위)만 캐싱 ──────
interface StoredLight {
  employees:      Employee[]
  rawRecordCount: number
  dateBounds:     { min: string; max: string } | null
}
interface CacheEntry extends StoredLight {
  updatedAt: string
}

const LS_KEY = 'tag_attendance_v2'

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

function normalizeDivisions(employees: Employee[]): Employee[] {
  return employees.map(e => e.division === '기타' ? { ...e, division: '신사업본부' } : e)
}

// ── 서버 API 헬퍼 ────────────────────────────────────────────────────────────

async function fetchRoster(): Promise<{ data: StoredLight | null; updatedAt: string | null }> {
  try {
    const res = await fetch('/api/attendance-raw-records')
    if (!res.ok) return { data: null, updatedAt: null }
    const json = await res.json() as {
      employees: Employee[]; rawRecordCount: number
      dateBounds: { min: string; max: string } | null; fetchedAt: string
    }
    if (!json.employees?.length) return { data: null, updatedAt: null }
    return {
      data: { employees: json.employees, rawRecordCount: json.rawRecordCount, dateBounds: json.dateBounds },
      updatedAt: json.fetchedAt,
    }
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

// 반기 CAPS 파일 하나가 수만 행이라, caps/erp를 한 번의 POST에 통째로 담으면 Vercel
// 서버리스 요청 본문 제한(~4.5MB)에 걸려 413으로 조용히 실패한다(로컬은 이 제한이 없어서
// 재현이 안 됐음). caps/erp를 각각 이 크기로 쪼개 순차 요청 — caps 청크 → erp 청크 순서로
// 보낸다(같은 요청에 둘 다 채우면 최악의 경우 청크 두 개 크기가 합쳐져 다시 초과할 수 있어서
// 아예 종류별로 분리). 청크마다 영향받은 직원만 증분 재계산되는 기존 ingest 라우트 동작은
// 그대로라 최종 결과는 동일하고, 같은 직원이 여러 청크에 걸치면 재계산이 중복 실행될 수
// 있는 정도의 비용만 감수한다.
const INGEST_CHUNK_SIZE = 3000

function chunkRows<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

async function postIngestChunk(
  caps: CapsRow[], erp: ErpUnifiedRow[], label: string,
): Promise<{ result: IngestResponse | null; error: string | null }> {
  try {
    const res = await fetch('/api/attendance-ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caps, erp }),
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      let msg = bodyText
      try { msg = (JSON.parse(bodyText) as { error?: string }).error ?? bodyText } catch { /* not JSON */ }
      return { result: null, error: `업로드 실패 (${label}, HTTP ${res.status})${msg ? `: ${msg.slice(0, 200)}` : ''}` }
    }
    return { result: await res.json() as IngestResponse, error: null }
  } catch (err) {
    return { result: null, error: `업로드 요청 실패 (${label}): ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function ingest(caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<{ result: IngestResponse | null; error: string | null }> {
  const capsChunks = chunkRows(caps, INGEST_CHUNK_SIZE)
  const erpChunks  = chunkRows(erp, INGEST_CHUNK_SIZE)
  const totalSteps = capsChunks.length + erpChunks.length || 1

  const acc: IngestResponse = { ok: true, affectedEmployees: 0, processedRecords: 0, skippedCount: 0, erpOtMatchCount: 0 }
  let step = 0

  if (capsChunks.length === 0 && erpChunks.length === 0) {
    return { result: acc, error: null }
  }

  for (const part of capsChunks) {
    step++
    const { result, error } = await postIngestChunk(part, [], `CAPS ${step}/${totalSteps}`)
    if (!result) return { result: null, error }
    acc.processedRecords  += result.processedRecords
    acc.skippedCount      += result.skippedCount
    acc.erpOtMatchCount   += result.erpOtMatchCount
    acc.affectedEmployees  = Math.max(acc.affectedEmployees, result.affectedEmployees)
  }
  for (const part of erpChunks) {
    step++
    const { result, error } = await postIngestChunk([], part, `ERP ${step}/${totalSteps}`)
    if (!result) return { result: null, error }
    acc.processedRecords  += result.processedRecords
    acc.skippedCount      += result.skippedCount
    acc.erpOtMatchCount   += result.erpOtMatchCount
    acc.affectedEmployees  = Math.max(acc.affectedEmployees, result.affectedEmployees)
  }
  return { result: acc, error: null }
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
 *  책임진다 — 클라이언트에서 전체 결과를 누적해 들고 있지 않는다(각 화면이 자기 범위만
 *  useProcessedAttendance로 따로 받아간다). */
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
  const [rawRecordCount,   setRawRecordCount]   = useState(0)
  const [dateBounds,       setDateBounds]       = useState<{ min: string; max: string } | null>(null)
  const [dataVersion,      setDataVersion]      = useState(0)
  const [isLoading,        setIsLoading]        = useState(true)
  const [isProcessing,     setIsProcessing]     = useState(false)
  const [lastUploadedAt,   setLastUploadedAt]   = useState<string | null>(null)
  const [dbSaveError,      setDbSaveError]      = useState<string | null>(null)

  const isLiveData = liveEmployees !== null

  // ── 서버에서 직원 목록 + 건수/날짜범위 새로고침 ────────────────────────
  const refreshFromServer = useCallback(async () => {
    const { data, updatedAt } = await fetchRoster()
    if (data?.employees?.length) {
      const normalized = normalizeDivisions(data.employees)
      setLiveEmployees(normalized)
      setRawRecordCount(data.rawRecordCount)
      setDateBounds(data.dateBounds)
      setLastUploadedAt(updatedAt)
      if (updatedAt) lsSave({ ...data, employees: normalized, updatedAt })
    }
  }, [])

  // ── Initial load: localStorage → 즉시 표시, 서버에서 백그라운드 갱신 ────
  useEffect(() => {
    let cancelled = false

    async function load() {
      const cached = lsLoad()
      if (cached?.employees?.length && !cancelled) {
        const normalized = normalizeDivisions(cached.employees)
        setLiveEmployees(normalized)
        setRawRecordCount(cached.rawRecordCount)
        setDateBounds(cached.dateBounds)
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
      .then(({ error }) => {
        if (error) { setDbSaveError(error); return }
        setDataVersion(v => v + 1)
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
        setDataVersion(v => v + 1)
      }
    } catch (err) {
      setDbSaveError(`전체 재계산 실패: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsProcessing(false)
    }
  }, [policy])

  // ── setRawData / mergeRawData: /api/attendance-ingest에 위임 ────────────
  // upsert 기반이라 "전체 교체"와 "병합"의 구분이 없어졌다(둘 다 누적) — setRawData는
  // 호출부가 없어(레거시) mergeRawData와 동일하게 동작해도 무방.
  const runIngest = useCallback(async (
    caps: CapsRow[], erp: ErpUnifiedRow[],
  ): Promise<IngestSummary> => {
    setIsProcessing(true)
    setDbSaveError(null)
    try {
      const { result, error } = await ingest(caps, erp)
      if (!result) {
        setDbSaveError(error ?? '업로드 처리에 실패했습니다.')
        return { employeeCount: 0, affectedCount: 0, skippedCount: 0, erpOtMatchCount: 0 }
      }
      await refreshFromServer()
      setDataVersion(v => v + 1)
      return {
        employeeCount:   liveEmployees?.length ?? 0,
        affectedCount:   result.affectedEmployees,
        skippedCount:    result.skippedCount,
        erpOtMatchCount: result.erpOtMatchCount,
      }
    } finally {
      setIsProcessing(false)
    }
  }, [refreshFromServer, liveEmployees])

  const setRawData = useCallback(async (caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<IngestSummary> => {
    return runIngest(caps, erp)
  }, [runIngest])

  const mergeRawData = useCallback(async (caps: CapsRow[], erp: ErpUnifiedRow[]): Promise<IngestSummary> => {
    return runIngest(caps, erp)
  }, [runIngest])

  // ── deleteRecordsByKeys: 업로드한 파일 되돌리기 ─────────────────────────
  // ingest()와 동일한 이유로 청크 분할 — 반기 파일 되돌리기는 키 수만 건이라 한 번에 보내면
  // 마찬가지로 413에 걸린다.
  const deleteRecordsByKeys = useCallback(async (keys: Set<string>): Promise<{ deletedCount: number }> => {
    setIsProcessing(true)
    setDbSaveError(null)
    try {
      const chunks = chunkRows([...keys], INGEST_CHUNK_SIZE)
      let deletedCount = 0
      for (const part of chunks) {
        const res = await fetch('/api/attendance-ingest', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: part }),
        })
        if (!res.ok) {
          setDbSaveError(`삭제 실패 (HTTP ${res.status})`)
          return { deletedCount }
        }
        const part_ = await res.json() as { deletedCount: number }
        deletedCount += part_.deletedCount
      }
      await refreshFromServer()
      setDataVersion(v => v + 1)
      return { deletedCount }
    } finally {
      setIsProcessing(false)
    }
  }, [refreshFromServer])

  return (
    <AttendanceSourceContext.Provider value={{
      employees:          liveEmployees ?? EMPLOYEES,
      rawRecordCount,
      dateBounds,
      dataVersion,
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
