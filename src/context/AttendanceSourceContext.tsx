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
  setRawData:            (caps: CapsRow[], erp: ErpUnifiedRow[], onProgress?: (step: number, total: number) => void) => Promise<IngestSummary>
  mergeRawData:          (caps: CapsRow[], erp: ErpUnifiedRow[], onProgress?: (step: number, total: number) => void) => Promise<IngestSummary>
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
// 재현이 안 됐음). caps/erp를 각각 청크로 쪼개 순차 요청 — caps 청크 → erp 청크 순서로
// 보낸다(같은 요청에 둘 다 채우면 최악의 경우 청크 두 개 크기가 합쳐져 다시 초과할 수 있어서
// 아예 종류별로 분리).
//
// ingest 라우트는 청크에 등장한 직원만 골라 "그 직원의 전체 이력"을 재계산한다(날짜 범위
// 스코핑 없음, recomputeFromNormalized.ts 참고). row-count로만 청크를 나누면 파일이
// 날짜순 정렬이라 3000행짜리 청크 하나에도 거의 전 직원(400명+)이 다 걸려서, 청크마다
// "사실상 전 직원 전체 이력 재계산"이 반복되고 그게 Vercel 60초 함수 제한에 걸려 504가 났다
// (2026-09-08, 서브 배포에서 실측: 재계산 1건이 caps 저장 후 58초 만에 끝남 — 턱걸이).
// 재계산 비용은 row 수가 아니라 "몇 명분 전체 이력을 다시 훑느냐"에 좌우되므로, 직원 수
// 기준으로 청크를 나눠 청크당 재계산 비용을 예측 가능한 선으로 묶는다. 413 방지용 row 상한은
// 안전망으로 유지.
const EMPLOYEES_PER_CHUNK = 30
const MAX_ROWS_PER_CHUNK  = 3000

/** rawId(사원번호)로 그룹핑한 뒤 "직원 수" 기준으로 청크를 나눈다 — 같은 직원의 행은 항상
 *  한 청크 안에 모이고(재계산 중복 실행이 없어짐), 청크 하나가 담는 서로 다른 직원 수가
 *  employeesPerChunk를 넘지 않는다. maxRows는 413 방지용 안전망(한 직원이 유별나게 행이
 *  많아도 한 청크가 너무 커지지 않게). */
function chunkByEmployee<T>(
  rows: T[], idOf: (row: T) => string, employeesPerChunk: number, maxRows: number,
): T[][] {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const id = idOf(r)
    const g = groups.get(id)
    if (g) g.push(r); else groups.set(id, [r])
  }

  const chunks: T[][] = []
  let current: T[] = []
  let employeesInCurrent = 0
  for (const group of groups.values()) {
    if (current.length > 0 && (employeesInCurrent >= employeesPerChunk || current.length + group.length > maxRows)) {
      chunks.push(current)
      current = []
      employeesInCurrent = 0
    }
    current.push(...group)
    employeesInCurrent++
  }
  if (current.length > 0) chunks.push(current)
  return chunks
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

async function ingest(
  caps: CapsRow[], erp: ErpUnifiedRow[],
  onProgress?: (step: number, total: number) => void,
): Promise<{ result: IngestResponse | null; error: string | null }> {
  const capsChunks = chunkByEmployee(caps, r => String(r.사원번호 ?? '').trim(), EMPLOYEES_PER_CHUNK, MAX_ROWS_PER_CHUNK)
  const erpChunks  = chunkByEmployee(erp,  r => String(r.사원번호 ?? '').trim(), EMPLOYEES_PER_CHUNK, MAX_ROWS_PER_CHUNK)
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
    onProgress?.(step, totalSteps)
  }
  for (const part of erpChunks) {
    step++
    const { result, error } = await postIngestChunk([], part, `ERP ${step}/${totalSteps}`)
    if (!result) return { result: null, error }
    acc.processedRecords  += result.processedRecords
    acc.skippedCount      += result.skippedCount
    acc.erpOtMatchCount   += result.erpOtMatchCount
    acc.affectedEmployees  = Math.max(acc.affectedEmployees, result.affectedEmployees)
    onProgress?.(step, totalSteps)
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
  // PolicyContext가 마운트 시 localStorage 캐시로 먼저 렌더한 뒤 DB에서 받아온 값으로
  // 한 번 더 setPolicyState를 호출하는데, 내용이 그대로여도 매번 "새 객체 참조"라 이 effect가
  // [policy] 참조 변경만 보고 매 새로고침마다 전체 재계산을 돌리고 있었다(2026-09-07 발견 —
  // 업로드는 이미 attendance-ingest에서 DB 안에서 증분 재계산되므로 이 자동 재계산은 "실제로
  // 정책 내용이 바뀐 경우"에만 필요). 내용 비교로 진짜 변경일 때만 돌리도록 수정.
  const mountedRef    = useRef(false)
  const prevPolicyRef = useRef<PolicySettings | null>(null)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      prevPolicyRef.current = policy
      return
    }
    const changed = JSON.stringify(prevPolicyRef.current) !== JSON.stringify(policy)
    prevPolicyRef.current = policy
    if (!changed || !isLiveData) return

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
    onProgress?: (step: number, total: number) => void,
  ): Promise<IngestSummary> => {
    setIsProcessing(true)
    setDbSaveError(null)
    try {
      const { result, error } = await ingest(caps, erp, onProgress)
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

  const setRawData = useCallback(async (
    caps: CapsRow[], erp: ErpUnifiedRow[], onProgress?: (step: number, total: number) => void,
  ): Promise<IngestSummary> => {
    return runIngest(caps, erp, onProgress)
  }, [runIngest])

  const mergeRawData = useCallback(async (
    caps: CapsRow[], erp: ErpUnifiedRow[], onProgress?: (step: number, total: number) => void,
  ): Promise<IngestSummary> => {
    return runIngest(caps, erp, onProgress)
  }, [runIngest])

  // ── deleteRecordsByKeys: 업로드한 파일 되돌리기 ─────────────────────────
  // ingest()와 동일한 이유(413 + 재계산 비용은 직원 수 기준)로 직원 수 기준 청크 분할.
  // 키 형식은 `${사원번호}_${이름}_${근무일자}` — 첫 '_' 앞이 사원번호(route.ts DELETE
  // 핸들러가 파싱하는 방식과 동일).
  const deleteRecordsByKeys = useCallback(async (keys: Set<string>): Promise<{ deletedCount: number }> => {
    setIsProcessing(true)
    setDbSaveError(null)
    try {
      const chunks = chunkByEmployee([...keys], k => k.slice(0, k.indexOf('_')), EMPLOYEES_PER_CHUNK, MAX_ROWS_PER_CHUNK)
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
