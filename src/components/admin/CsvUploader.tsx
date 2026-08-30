'use client'
import { useState, useRef } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack, type SlackConfig } from '@/context/SlackContext'
import { normalizeDate } from '@/utils/dataParser'
import type { CapsRow, ErpUnifiedRow } from '@/types/tag'

// ── Required columns for each file type ──────────────────────────────────
const CAPS_REQUIRED = ['사원번호', '이름', '부서', '근무일자', '출근', '퇴근'] as const
// Unified ERP: leave + OT in one sheet — 종료일/인정시간 are optional columns
const ERP_REQUIRED  = ['사원번호', '성명', '근태코드', '승인상태', '시작일'] as const

// ── File-slot state ───────────────────────────────────────────────────────
type SlotState =
  | { phase: 'idle' }
  | { phase: 'parsing' }
  | { phase: 'ready';  name: string; rowCount: number }
  | { phase: 'error';  name: string; msg: string }

type ApplyResult =
  | { ok: true;  empCount: number; affectedCount: number; skipped: number; erpOtMatchCount?: number }
  | { ok: false; msg: string }

// ── Low-level file → rows parser ──────────────────────────────────────────
async function readRows(file: File): Promise<Record<string, string>[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  if (ext === 'csv') {
    const text = await file.text()
    const r = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      transform: (v: string) => (v ?? '').trim(),
    })
    if (r.errors.length > 0 && r.data.length === 0) throw new Error(r.errors[0].message)
    return r.data
  }

  if (ext === 'xls' || ext === 'xlsx') {
    const buf = await file.arrayBuffer()
    const wb  = XLSX.read(buf, { type: 'array' })
    const ws  = wb.Sheets[wb.SheetNames[0]]
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { raw: false, defval: '' })
    return raw.map(row =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.trim(), String(v ?? '').trim()])
      )
    )
  }

  throw new Error(`.${ext || '?'} 파일은 지원하지 않습니다 (CSV / XLS / XLSX 허용)`)
}

function missingCols(rows: Record<string, string>[], required: readonly string[]): string[] {
  if (rows.length === 0) return ['파일에 데이터 없음']
  const h = new Set(Object.keys(rows[0]))
  return required.filter(c => !h.has(c))
}

// ── DropZone ──────────────────────────────────────────────────────────────
function DropZone({
  label, hint, slot, onFile,
}: {
  label:  string
  hint:   string
  slot:   SlotState
  onFile: (f: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const borderCls =
    dragging               ? 'border-blue-400  bg-blue-50/60'  :
    slot.phase === 'ready' ? 'border-green-300 bg-green-50/60' :
    slot.phase === 'error' ? 'border-red-300   bg-red-50/60'   :
    slot.phase === 'parsing' ? 'border-blue-200 bg-blue-50/40' :
                               'border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/30'

  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-4 cursor-pointer transition-all select-none text-center min-h-[80px] ${borderCls}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e  => { e.preventDefault(); setDragging(true)  }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault(); setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) onFile(f)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xls,.xlsx"
        className="sr-only"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) { onFile(f); e.target.value = '' }
        }}
      />

      {slot.phase === 'idle' && (
        <>
          <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-[11px] font-semibold text-gray-600">{label}</p>
          <p className="text-[10px] text-gray-400 leading-tight">{hint}</p>
        </>
      )}

      {slot.phase === 'parsing' && (
        <>
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-[11px] text-blue-600 font-medium">파싱 중...</p>
        </>
      )}

      {slot.phase === 'ready' && (
        <>
          <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-[11px] font-semibold text-green-700 truncate max-w-full px-1">{slot.name}</p>
          <p className="text-[10px] text-green-600">{slot.rowCount.toLocaleString()}행 인식</p>
          <p className="text-[9px] text-gray-300 mt-0.5">클릭하여 교체</p>
        </>
      )}

      {slot.phase === 'error' && (
        <>
          <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <p className="text-[11px] font-semibold text-red-600 truncate max-w-full px-1">{slot.name}</p>
          <p className="text-[10px] text-red-500 leading-tight px-1">{slot.msg}</p>
          <p className="text-[9px] text-gray-300 mt-0.5">클릭하여 재시도</p>
        </>
      )}
    </div>
  )
}

// ── Slack compact panel ───────────────────────────────────────────────────
function SlackPanel() {
  const {
    config, setConfig,
    exceptions,
    isLoading, lastSynced, syncedRange, error,
    fetchAndParse, clearExceptions,
  } = useSlack()

  const [draft, setDraft] = useState<SlackConfig>({ ...config })
  const isDirty = JSON.stringify(draft) !== JSON.stringify(config)

  function patch(partial: Partial<SlackConfig>) {
    setDraft(prev => ({ ...prev, ...partial }))
  }

  function handleSync() {
    if (isDirty) setConfig(draft)
    fetchAndParse()
  }

  const hasCredentials = !!draft.token && !!draft.channelId
  const dateRangeValid = !!draft.startDate && !!draft.endDate && draft.startDate <= draft.endDate
  const canSync = hasCredentials && dateRangeValid
  const synced  = exceptions.length > 0

  return (
    <div className="flex flex-col gap-2 h-full">

      {/* Token */}
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
          Bot Token
        </p>
        <input
          type="password"
          placeholder="xoxb-…"
          value={draft.token}
          onChange={e => patch({ token: e.target.value })}
          className="w-full px-2.5 py-1.5 text-[11px] border border-gray-200 rounded-lg
            focus:outline-none focus:ring-2 focus:ring-violet-400 font-mono
            placeholder:text-gray-300 bg-white"
        />
      </div>

      {/* Channel ID */}
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
          Channel ID
        </p>
        <input
          type="text"
          placeholder="C0XXXXXXXX"
          value={draft.channelId}
          onChange={e => patch({ channelId: e.target.value })}
          className="w-full px-2.5 py-1.5 text-[11px] border border-gray-200 rounded-lg
            focus:outline-none focus:ring-2 focus:ring-violet-400 font-mono
            placeholder:text-gray-300 bg-white"
        />
      </div>

      {/* Date range */}
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
          조회 기간
        </p>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={draft.startDate}
            onChange={e => patch({ startDate: e.target.value })}
            className="flex-1 min-w-0 px-2 py-1.5 text-[11px] border border-gray-200 rounded-lg
              focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
          />
          <span className="text-[10px] text-gray-400 shrink-0">~</span>
          <input
            type="date"
            value={draft.endDate}
            onChange={e => patch({ endDate: e.target.value })}
            className="flex-1 min-w-0 px-2 py-1.5 text-[11px] border border-gray-200 rounded-lg
              focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
          />
        </div>
        {!dateRangeValid && draft.startDate && draft.endDate && (
          <p className="text-[10px] text-red-400 mt-0.5">시작일이 종료일보다 늦습니다</p>
        )}
      </div>

      {/* Action button */}
      <button
        onClick={handleSync}
        disabled={isLoading || !canSync}
        className={`mt-auto w-full flex items-center justify-center gap-1.5 px-3 py-2
          text-[11px] font-semibold rounded-lg transition-colors
          ${canSync
            ? 'bg-violet-600 hover:bg-violet-700 text-white'
            : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }
          disabled:opacity-60 disabled:cursor-not-allowed`}
      >
        {isLoading ? (
          <>
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            메시지 조회 중…
          </>
        ) : (
          <>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Slack 동기화 · Sieve 실행
          </>
        )}
      </button>

      {/* Loading hint */}
      {isLoading && (
        <p className="text-[10px] text-violet-400 text-center leading-tight">
          조회 기간이 길수록 시간이 걸릴 수 있습니다
        </p>
      )}

      {/* Status line */}
      {error && (
        <p className="text-[10px] text-red-500 leading-tight">{error}</p>
      )}
      {!error && synced && (
        <div className="text-[10px] text-violet-600 font-medium text-center space-y-0.5">
          <p>✓ {exceptions.length}건 매칭</p>
          {syncedRange && (
            <p className="text-gray-400 font-normal">{syncedRange.start} ~ {syncedRange.end}</p>
          )}
          <p className="text-gray-400 font-normal">{lastSynced}</p>
          <button
            onClick={clearExceptions}
            className="text-gray-400 hover:text-red-400 transition-colors underline underline-offset-1"
          >
            초기화
          </button>
        </div>
      )}
      {!error && !synced && lastSynced && (
        <p className="text-[10px] text-gray-400 text-center">동기화 완료 — 매칭 없음</p>
      )}
    </div>
  )
}

const MAX_CAPS = 5
const MAX_ERP  = 5

// ── CAPS 로우에서 DB 삭제 키 추출 (employeeId_date 형식) ─────────────────
function extractCapsKeys(rows: Record<string, string>[]): Set<string> {
  const keys = new Set<string>()
  for (const r of rows) {
    const empId = (r['사원번호'] ?? '').trim()
    const name  = (r['이름']    ?? '').trim()
    const date  = normalizeDate(r['근무일자'])
    if (empId && name && date) keys.add(`${empId}_${name}_${date}`)
  }
  return keys
}

// ── Main export ───────────────────────────────────────────────────────────
export function CsvUploader() {
  const { mergeRawData, deleteRecordsByKeys, isLiveData, isLoading: isDbLoading, lastUploadedAt, employees, rawRecordCount, dbSaveError, isProcessing } = useAttendanceSource()

  // CAPS: 복수 파일 지원 (최대 MAX_CAPS)
  const capsDataRefs = useRef<(Record<string, string>[] | null)[]>([null])
  const erpDataRefs  = useRef<(Record<string, string>[] | null)[]>([null])

  const [capsSlots, setCapsSlots] = useState<SlotState[]>([{ phase: 'idle' }])
  const [erpSlots,  setErpSlots]  = useState<SlotState[]>([{ phase: 'idle' }])
  const [result,    setResult]    = useState<ApplyResult | null>(null)
  const [expanded,  setExpanded]  = useState(false)
  const [isSaving,  setIsSaving]  = useState(false)

  // ── 업로드 잠금 — 탭당 1회만 확인(sessionStorage), 새로고침하면 다시 물어봄 ──────
  const [unlocked,     setUnlocked]     = useState(
    () => typeof window !== 'undefined' && sessionStorage.getItem('tag_upload_unlocked') === '1',
  )
  const [showPwPrompt, setShowPwPrompt] = useState(false)
  const [pwInput,      setPwInput]      = useState('')
  const [pwError,      setPwError]      = useState<string | null>(null)
  const [pwChecking,   setPwChecking]   = useState(false)
  function handleUploadToggleClick() {
    if (expanded)  { setExpanded(false); return }
    if (unlocked)  { setExpanded(true);  return }
    setPwError(null)
    setShowPwPrompt(true)
  }

  async function submitUploadPassword() {
    if (!pwInput || pwChecking) return
    setPwChecking(true)
    setPwError(null)
    try {
      const res  = await fetch('/api/upload-auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: pwInput }),
      })
      const data = await res.json() as { ok: boolean }
      if (data.ok) {
        setUnlocked(true)
        sessionStorage.setItem('tag_upload_unlocked', '1')
        setShowPwPrompt(false)
        setPwInput('')
        setExpanded(true)
      } else {
        setPwError('암호가 올바르지 않습니다.')
      }
    } catch {
      setPwError('확인 중 오류가 발생했습니다. 다시 시도해 주세요.')
    } finally {
      setPwChecking(false)
    }
  }

  function setCapsSlot(idx: number, s: SlotState) {
    setCapsSlots(prev => prev.map((v, i) => i === idx ? s : v))
  }
  function setErpSlot(idx: number, s: SlotState) {
    setErpSlots(prev => prev.map((v, i) => i === idx ? s : v))
  }

  function addCapsSlot() {
    if (capsSlots.length >= MAX_CAPS) return
    capsDataRefs.current = [...capsDataRefs.current, null]
    setCapsSlots(prev => [...prev, { phase: 'idle' }])
  }
  function addErpSlot() {
    if (erpSlots.length >= MAX_ERP) return
    erpDataRefs.current = [...erpDataRefs.current, null]
    setErpSlots(prev => [...prev, { phase: 'idle' }])
  }

  async function removeCapsSlot(idx: number) {
    const slot = capsSlots[idx]
    // ready 상태면 해당 파일의 레코드를 DB에서도 삭제
    if (slot.phase === 'ready' && capsDataRefs.current[idx]) {
      const keys = extractCapsKeys(capsDataRefs.current[idx]!)
      if (keys.size > 0) {
        setIsSaving(true)
        try {
          await deleteRecordsByKeys(keys)
          setResult(null)
        } finally {
          setIsSaving(false)
        }
      }
    }
    if (capsSlots.length <= 1) {
      capsDataRefs.current[idx] = null
      setCapsSlot(idx, { phase: 'idle' })
      return
    }
    capsDataRefs.current = capsDataRefs.current.filter((_, i) => i !== idx)
    setCapsSlots(prev => prev.filter((_, i) => i !== idx))
  }
  async function removeErpSlot(idx: number) {
    const slot = erpSlots[idx]
    // ERP는 기존 레코드의 휴가/OT 플래그에 반영된 상태 → 남은 파일로 재계산
    if (slot.phase === 'ready') {
      erpDataRefs.current[idx] = null
      if (erpSlots.length <= 1) {
        setErpSlot(idx, { phase: 'idle' })
      } else {
        setErpSlots(prev => prev.filter((_, i) => i !== idx))
        erpDataRefs.current = erpDataRefs.current.filter((_, i) => i !== idx)
      }
      setResult(null)
      // 남은 CAPS + ERP로 재계산 트리거
      await applyAll()
      return
    }
    if (erpSlots.length <= 1) {
      erpDataRefs.current[idx] = null
      setErpSlot(idx, { phase: 'idle' })
      setResult(null)
      return
    }
    erpDataRefs.current = erpDataRefs.current.filter((_, i) => i !== idx)
    setErpSlots(prev => prev.filter((_, i) => i !== idx))
    setResult(null)
  }

  // ── Merge + push to context (async: saves to DB) ─────────────────────
  async function applyAll() {
    const allCaps = capsDataRefs.current.filter(Boolean) as Record<string, string>[][]
    const allErp  = erpDataRefs.current.filter(Boolean)  as Record<string, string>[][]
    // CAPS/ERP 둘 다 없으면 할 게 없음 — 하나만 있어도 나머지는 mergeRawData가
    // DB에 저장된 마지막 원본 스냅샷으로 채워서 정상 병합한다.
    if (allCaps.length === 0 && allErp.length === 0) return

    const mergedCaps = allCaps.flat()
    const mergedErp  = allErp.flat()
    setIsSaving(true)
    try {
      const { employeeCount, affectedCount, skippedCount, erpOtMatchCount } = await mergeRawData(
        mergedCaps as unknown as CapsRow[],
        mergedErp  as unknown as ErpUnifiedRow[],
      )
      setResult({ ok: true, empCount: employeeCount, affectedCount, skipped: skippedCount, erpOtMatchCount })
      setExpanded(false)
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message })
    } finally {
      setIsSaving(false)
    }
  }

  // ── CAPS 파일 처리 ────────────────────────────────────────────────────
  async function processCapsFile(file: File, idx: number) {
    setCapsSlot(idx, { phase: 'parsing' })
    setResult(null)
    capsDataRefs.current[idx] = null

    try {
      const rows    = await readRows(file)
      const missing = missingCols(rows, CAPS_REQUIRED)
      if (missing.length > 0) {
        setCapsSlot(idx, { phase: 'error', name: file.name, msg: `누락 컬럼: ${missing.join(' · ')}` })
        return
      }
      capsDataRefs.current[idx] = rows
      setCapsSlot(idx, { phase: 'ready', name: file.name, rowCount: rows.length })
      applyAll()
    } catch (e) {
      setCapsSlot(idx, { phase: 'error', name: file.name, msg: (e as Error).message })
    }
  }

  // ── ERP 파일 처리 ─────────────────────────────────────────────────────
  async function processErpFile(file: File, idx: number) {
    setErpSlot(idx, { phase: 'parsing' })
    setResult(null)
    erpDataRefs.current[idx] = null

    try {
      const rows    = await readRows(file)
      const missing = missingCols(rows, ERP_REQUIRED)
      if (missing.length > 0) {
        setErpSlot(idx, { phase: 'error', name: file.name, msg: `누락 컬럼: ${missing.join(' · ')}` })
        return
      }
      erpDataRefs.current[idx] = rows
      setErpSlot(idx, { phase: 'ready', name: file.name, rowCount: rows.length })
      applyAll()
    } catch (e) {
      setErpSlot(idx, { phase: 'error', name: file.name, msg: (e as Error).message })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="mx-6 mt-3 mb-1 rounded-xl border border-gray-200 bg-white overflow-hidden shrink-0">

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 min-h-0">

        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">
          데이터 소스
        </span>

        {/* 상태 배지 */}
        {isDbLoading ? (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-500 text-[11px] font-semibold whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
            DB 로딩 중…
          </div>
        ) : (
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${
            isLiveData ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isLiveData ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            {isLiveData
              ? `LIVE · ${employees.length}명 · ${rawRecordCount.toLocaleString()}건`
              : '목업 데이터'}
          </div>
        )}

        {/* DB 공유 표시 */}
        {isLiveData && !isDbLoading && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium whitespace-nowrap">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
            DB 공유 중
            {lastUploadedAt && (
              <span className="text-gray-400 font-normal">
                · {new Date(lastUploadedAt).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}
              </span>
            )}
          </span>
        )}

        {isSaving && (
          <span className="text-[11px] text-blue-500 font-medium whitespace-nowrap flex items-center gap-1">
            <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            DB 저장 중…
          </span>
        )}
        {!isSaving && result?.ok && !dbSaveError && (
          <span className="text-[11px] text-emerald-600 font-medium whitespace-nowrap flex items-center gap-2">
            ✓ 영향받은 직원 {result.affectedCount}명 · 스킵 {result.skipped}건
            {result.erpOtMatchCount !== undefined && (
              <span
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                  result.erpOtMatchCount > 0
                    ? 'bg-green-100 text-green-700'
                    : 'bg-amber-100 text-amber-700'
                }`}
                title="ERP 연장근로 신청 매칭 건수 (0이면 OT 파일 미포함 또는 컬럼 불일치)"
              >
                연장신청 {result.erpOtMatchCount}건 매칭
              </span>
            )}
          </span>
        )}
        {!isSaving && result?.ok && dbSaveError && (
          <span className="text-[11px] text-amber-600 font-medium whitespace-nowrap" title={dbSaveError}>
            ⚠ 파싱 완료 · DB 저장 실패 (콘솔 확인)
          </span>
        )}
        {result && !result.ok && (
          <span className="text-[11px] text-red-500 font-medium truncate max-w-xs">
            오류: {result.msg}
          </span>
        )}
        {isProcessing && !isSaving && (
          <span className="text-[11px] text-indigo-500 font-medium whitespace-nowrap flex items-center gap-1">
            <span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            처리 중…
          </span>
        )}

        {/* 접힌 상태에서 업로드된 파일명 표시 */}
        {!expanded && (
          <div className="flex items-center gap-1 flex-wrap min-w-0">
            {(capsSlots.filter(s => s.phase === 'ready') as Extract<SlotState, { phase: 'ready' }>[]).map((s, i) => (
              <span key={`caps-${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-50 text-[10px] text-sky-600 font-medium max-w-[130px]" title={s.name}>
                <span className="truncate">{s.name}</span>
              </span>
            ))}
            {(erpSlots.filter(s => s.phase === 'ready') as Extract<SlotState, { phase: 'ready' }>[]).map((s, i) => (
              <span key={`erp-${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-[10px] text-amber-600 font-medium max-w-[130px]" title={s.name}>
                <span className="truncate">{s.name}</span>
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={handleUploadToggleClick}
            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 transition-colors font-medium"
            aria-label={expanded ? '업로더 접기' : '업로더 펼치기'}
          >
            <span>{expanded ? '접기' : '파일 업로드'}</span>
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Password gate — 파일 업로드 펼치기 전 확인 ───────────────────── */}
      {showPwPrompt && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
          <p className="text-[11px] font-semibold text-gray-600 mb-1.5">
            파일 업로드 암호 확인
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              value={pwInput}
              onChange={e => { setPwInput(e.target.value); setPwError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') void submitUploadPassword() }}
              placeholder="암호 입력"
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
            />
            <button
              onClick={() => void submitUploadPassword()}
              disabled={!pwInput || pwChecking}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white
                hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {pwChecking ? '확인 중…' : '확인'}
            </button>
            <button
              onClick={() => { setShowPwPrompt(false); setPwInput(''); setPwError(null) }}
              className="text-xs text-gray-400 hover:text-gray-600 px-1"
            >
              취소
            </button>
          </div>
          {pwError && <p className="text-[10px] text-red-500 mt-1">{pwError}</p>}
        </div>
      )}

      {/* ── Expandable upload body ──────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pt-3 pb-4">
          <div className="grid grid-cols-3 gap-3">

            {/* CAPS RAW — 복수 파일 */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  CAPS RAW
                  <span className="ml-1.5 normal-case font-normal text-gray-300">.xls · .xlsx · .csv</span>
                </p>
                {capsSlots.length < MAX_CAPS && (
                  <button
                    onClick={addCapsSlot}
                    className="text-[10px] font-semibold text-blue-500 hover:text-blue-700 transition-colors flex items-center gap-0.5"
                  >
                    <span>+</span> 파일 추가
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {capsSlots.map((slot, idx) => (
                  <div key={idx} className="flex items-start gap-1">
                    <div className="flex-1">
                      <DropZone
                        label={capsSlots.length > 1 ? `파일 ${idx + 1}` : '출퇴근 태깅 원본'}
                        hint={`필수: ${CAPS_REQUIRED.join(' · ')}`}
                        slot={slot}
                        onFile={f => processCapsFile(f, idx)}
                      />
                    </div>
                    {slot.phase !== 'idle' && (
                      <button
                        onClick={() => removeCapsSlot(idx)}
                        className="mt-1 text-gray-300 hover:text-red-400 transition-colors text-lg leading-none shrink-0"
                        title="제거"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* ERP 통합 (Leave + OT) — 복수 파일 지원 */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  ERP 근태신청
                  <span className="ml-1.5 normal-case font-normal text-gray-300">.xlsx · .csv</span>
                </p>
                {erpSlots.length < MAX_ERP && (
                  <button
                    onClick={addErpSlot}
                    className="text-[10px] font-semibold text-blue-500 hover:text-blue-700 transition-colors flex items-center gap-0.5"
                  >
                    <span>+</span> 파일 추가
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {erpSlots.map((slot, idx) => (
                  <div key={idx} className="flex items-start gap-1">
                    <div className="flex-1">
                      <DropZone
                        label={erpSlots.length > 1 ? `파일 ${idx + 1}` : '연차 · 반차 · 연장근로 통합'}
                        hint={`필수: ${ERP_REQUIRED.join(' · ')}`}
                        slot={slot}
                        onFile={f => processErpFile(f, idx)}
                      />
                    </div>
                    {slot.phase !== 'idle' && (
                      <button
                        onClick={() => removeErpSlot(idx)}
                        className="mt-1 text-gray-300 hover:text-red-400 transition-colors text-lg leading-none shrink-0"
                        title="제거"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Slack Integration Panel */}
            <div className="flex flex-col">
              <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mb-1.5">
                Slack 연동
                <span className="ml-1.5 normal-case font-normal text-gray-300">OOO 채널 동기화</span>
              </p>
              <div className="flex-1 rounded-lg border-2 border-dashed border-violet-200 bg-violet-50/40 px-3 py-3">
                <SlackPanel />
              </div>
            </div>

          </div>

          {/* Instruction footer */}
          {(capsSlots.every(s => s.phase === 'idle') && erpSlots.every(s => s.phase === 'idle')) && (
            <p className="mt-3 text-[10px] text-gray-400 text-center">
              CAPS RAW 또는 ERP 근태신청 — 한쪽만 올려도 자동 반영(나머지는 마지막 저장분 사용) · 여러 파일 추가 가능 · Slack은 선택
            </p>
          )}
          {(capsSlots.some(s => s.phase === 'ready') || erpSlots.some(s => s.phase === 'ready')) &&
           !(capsSlots.some(s => s.phase === 'ready') && erpSlots.some(s => s.phase === 'ready')) && (
            <p className="mt-3 text-[10px] text-blue-500 text-center font-medium">
              이대로 자동 반영됩니다 (나머지 파일은 마지막 저장분을 그대로 사용)
            </p>
          )}
        </div>
      )}
    </div>
  )
}
