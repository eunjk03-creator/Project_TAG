'use client'
import React, { useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import {
  useReactTable, getCoreRowModel, getFilteredRowModel, getSortedRowModel,
  getPaginationRowModel, getFacetedRowModel, getFacetedUniqueValues,
  flexRender, createColumnHelper,
  type ColumnDef, type VisibilityState, type ColumnFiltersState,
  type SortingState, type PaginationState, type FilterFn, type Column,
} from '@tanstack/react-table'
import type { ProcessedRecord, Employee } from '@/types/tag'
import { EMPLOYEES } from '@/data/orgChart'
import {
  parseTimeToMins,
  computeGasNightMins,
  computePayOtMins, computeLeaderPayOtMins, computeHolidayPayMins,
  compute4141BreakMins, computeEffClockIn,
} from '@/utils/attendanceCalc'

// ── Row shape ─────────────────────────────────────────────────────────────

export interface GridRow {
  record:         ProcessedRecord
  division:       string
  team:           string
  empId:          string
  name:           string
  date:           string
  clockIn:        string | null
  clockOut:       string | null
  leaveAmt:       number
  leaveType:      string | null
  leaveSource:    string        // 'ERP' | 'Slack' | ''
  gasWorkAMins:   number        // 근로A: 출근~퇴근 총 경과시간(gross, 휴게 차감 전)
  breakH:         number        // 휴게: 4/1/4/1 레일 스킵값
  finalWorkH:     number        // 최종근무: (근로A − 휴게) + 연차크레딧
  displayStatus:  string | null     // OT 계산용 내부 필드 (컬럼 미표시)
  attendanceStatus: '정상' | '비정상'
  normalTags:     string[]
  anomalyTags:    string[]
  // Zone 2 — payroll reference (GAS leave-last formula, 30-min floor)
  systemOtH:      number
  payrollOtH:      number   // Col 16: 급여용연장 (hours) — Slack 패널티 시 0
  slackOtH:        number   // Slack 주입 시 이론적 OT (표시용 dim red)
  isSlackLeave:    boolean  // leaveType이 Slack 주입된 경우
  payrollNightH:   number   // Col 17: 급여용야간 (hours)
  payrollHolidayH: number   // Col 18: 급여용휴일 (hours)
  erpOtStatus:    '신청' | '미신청' | '—'   // payrollOtH 기준 3-case
  auditFlag:      boolean
  note:           string
}

export interface Props {
  records:                  ProcessedRecord[]
  employees?:               Employee[]
  columnVisibility:         VisibilityState
  onColumnVisibilityChange: (updater: VisibilityState | ((prev: VisibilityState) => VisibilityState)) => void
  onRowClick?:              (employeeId: string, date: string) => void
  onNameClick?:             (employeeId: string) => void
  noteMap?:                 Map<string, string>
  onNoteChange?:            (employeeId: string, date: string, note: string) => void
  onDeleteRecord?:          (employeeId: string, date: string) => void
  selectedKeys?:            Set<string>
  onSelectionChange?:       (keys: Set<string>) => void
  otExemptIds?:             Set<string>
  /** 엑셀 내보내기 — 테이블 내부 필터·정렬·토글(인정시간/실제값, 크레딧) 반영된 화면 표시 행 그대로 전달 */
  onExport?:                (filteredRows: GridRow[]) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ColTip({ label, tip }: { label: string; tip: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

  function show() {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ x: r.left + r.width / 2, y: r.top - 6 })
  }

  return (
    <span
      ref={ref}
      className="inline-flex items-center gap-0.5 cursor-default select-none"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {label}
      <svg className="w-3 h-3 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {pos && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{ left: pos.x, top: pos.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="max-w-[200px] rounded-lg bg-gray-800 text-white text-[10px] leading-snug px-2.5 py-2 shadow-xl whitespace-normal text-center">
            {tip}
            <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}

function fmtH(hours: number): string {
  const m  = Math.round(hours * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function weekStartUTC(dateStr: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dt  = new Date(Date.UTC(y, mo - 1, d))
  const mon = new Date(dt.getTime() + (dt.getUTCDay() === 0 ? -6 : 1 - dt.getUTCDay()) * 86_400_000)
  return mon.getUTCFullYear() + '-' +
    String(mon.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(mon.getUTCDate()).padStart(2, '0')
}

const B = {
  blue:   'inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50   text-blue-700   border border-blue-200',
  amber:  'inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50  text-amber-700  border border-amber-200',
  orange: 'inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200',
  red:    'inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-50    text-red-700    border border-red-200',
  purple: 'inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200',
} as const

function statusBadge(status: string | null): ReactNode {
  if (!status || status === '정상' || status === '연차')
                                         return <span className="text-gray-300 text-[10px]">—</span>
  if (status === '지각')                 return <span className={B.amber}>{status}</span>
  if (status === '조기퇴근')             return <span className={B.orange}>{status}</span>
  if (status === '지각/조기퇴근')        return <span className={B.red}>{status}</span>
  if (status === '미태깅')               return <span className={B.red}>{status}</span>
  if (status === '근태이상')             return <span className={B.red}>{status}</span>
  if (status.startsWith('외근'))         return <span className={B.blue}>{status}</span>
  if (status.startsWith('휴일근무'))     return <span className={B.purple}>{status}</span>
  return <span className="text-gray-400 text-[10px]">{status}</span>
}

// ── Filter functions ──────────────────────────────────────────────────────

const multiSelectFilter: FilterFn<GridRow> = (row, columnId, filterValue: unknown[]) => {
  if (!filterValue?.length) return true
  return filterValue.includes(row.getValue(columnId))
}
multiSelectFilter.autoRemove = (val: unknown) => !Array.isArray(val) || val.length === 0

const numMultiSelectFilter: FilterFn<GridRow> = (row, columnId, filterValue: number[]) => {
  if (!filterValue?.length) return true
  return filterValue.includes(row.getValue<number>(columnId))
}
numMultiSelectFilter.autoRemove = (val: unknown) => !Array.isArray(val) || val.length === 0

const tagArrayFilter: FilterFn<GridRow> = (row, columnId, filterValue: string[]) => {
  if (!filterValue?.length) return true
  const tags = row.getValue(columnId) as string[]
  return filterValue.some(f => tags.includes(f))
}
tagArrayFilter.autoRemove = (val: unknown) => !Array.isArray(val) || val.length === 0

const ARRAY_COL_TAGS: Record<string, string[]> = {
  normalTags:  ['일반', '연장근로', '외근', '휴일근로'],
  anomalyTags: ['지각', '근무시간 미달', '미태깅'],
}

// Optional columns shown in the "열 설정" popover, grouped by zone
const OPTIONAL_COL_GROUPS = [
  {
    label: '근태상태 참조',
    cols: [
      { id: 'normalTags',  label: '정상정보' },
      { id: 'anomalyTags', label: '비정상정보' },
    ],
  },
  {
    label: 'T.A.G. 보조',
    cols: [
      { id: 'leaveSource',  label: '연차정보' },
      { id: 'gasWorkAMins', label: '근로A' },
      { id: 'breakH',       label: '휴게' },
    ],
  },
  {
    label: '급여 참조',
    cols: [
      { id: 'payrollOtH',      label: '급여용연장' },
      { id: 'payrollNightH',   label: '급여용야간' },
      { id: 'payrollHolidayH', label: '급여용휴일' },
      { id: 'erpOtApplied',    label: 'ERP연장신청' },
    ],
  },
]

// Columns that get an inline funnel filter button
const FILTERABLE = new Set(['division', 'date', 'leaveAmt', 'leaveType', 'leaveSource', 'breakH', 'attendanceStatus', 'normalTags', 'anomalyTags', 'erpOtApplied'])

const COL_LABELS: Record<string, string> = {
  division: '본부', empId: '사번', name: '이름', date: '날짜',
  clockIn: '출근', clockOut: '퇴근',
  leaveAmt: '연차일수', leaveType: '연차코드', leaveSource: '연차정보',
  gasWorkAMins: '근로A', breakH: '휴게',
  finalWorkH: '최종근무',
  attendanceStatus: '근태상태',
  normalTags: '정상정보',
  anomalyTags: '비정상정보',
  systemOtH: '초과근로', payrollOtH: '급여용연장',
  payrollNightH: '급여용야간', payrollHolidayH: '급여용휴일', erpOtApplied: 'ERP연장신청',
}

const col = createColumnHelper<GridRow>()

// ── Inline filter popup (rendered via portal to escape overflow clip) ──────

function fmtOption(colId: string, val: unknown): string {
  if (val === null || val === undefined || val === '') {
    return colId === 'leaveSource' ? '없음' : '없음'
  }
  if (colId === 'leaveAmt')  return `${Number(val)}일`
  if (colId === 'breakH')    return `${Math.round(Number(val) * 60)}m`
  return String(val)
}

function FilterPopupPortal({
  column,
  rect,
  onClose,
}: {
  column: Column<GridRow, unknown>
  rect: DOMRect
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const colId     = column.id
  const knownTags = ARRAY_COL_TAGS[colId]
  const isText    = colId === 'date'
  const faceted   = column.getFacetedUniqueValues()

  // array 컬럼(정상정보·비정상정보)은 각 태그별 개수를 직접 집계
  const tagCounts = useMemo(() => {
    if (!knownTags) return null
    const counts: Record<string, number> = {}
    column.getFacetedRowModel().rows.forEach(row => {
      const tags = row.getValue(colId) as string[]
      if (Array.isArray(tags)) tags.forEach(t => { counts[t] = (counts[t] ?? 0) + 1 })
    })
    return counts
  }, [knownTags, column, colId])

  const options: unknown[] = knownTags
    ? knownTags
    : [...faceted.keys()].sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b
        if (a === null || a === '') return -1
        if (b === null || b === '') return 1
        return String(a).localeCompare(String(b))
      })

  const currentFilter                 = column.getFilterValue()
  const selected: unknown[]           = Array.isArray(currentFilter) ? currentFilter : []
  const [textVal, setTextVal]         = useState(typeof currentFilter === 'string' ? currentFilter : '')

  function toggle(val: unknown) {
    const next = selected.some(s => s === val)
      ? selected.filter(s => s !== val)
      : [...selected, val]
    column.setFilterValue(next.length ? next : undefined)
  }

  // Viewport clamping so popup doesn't go off-screen
  const top  = Math.min(rect.bottom + 2, window.innerHeight - 260)
  const left = Math.min(rect.left, window.innerWidth - 240)

  if (!mounted) return null

  return createPortal(
    <>
      <div className="fixed inset-0 z-[100]" onClick={onClose} />
      <div
        style={{ position: 'fixed', top, left, zIndex: 101, minWidth: 160, maxWidth: 240 }}
        className="bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
            {COL_LABELS[colId] ?? colId}
          </span>
          {(selected.length > 0 || textVal) && (
            <button
              onClick={() => { column.setFilterValue(undefined); setTextVal('') }}
              className="text-[10px] text-blue-500 hover:text-blue-700"
            >
              초기화
            </button>
          )}
        </div>

        {isText ? (
          <div className="p-2">
            <input
              autoFocus
              value={textVal}
              onChange={e => { setTextVal(e.target.value); column.setFilterValue(e.target.value || undefined) }}
              placeholder="예: 2025-04"
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
        ) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {options.map((val, i) => {
              const isSelected = selected.some(s => s === val)
              const count = tagCounts
                ? (tagCounts[String(val)] ?? 0)
                : (faceted.get(val) ?? 0)
              return (
                <label key={i} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(val)}
                    className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 flex-shrink-0"
                  />
                  <span className="flex-1 text-xs text-gray-700 truncate">
                    {fmtOption(colId, val)}
                  </span>
                  <span className="text-[10px] text-gray-400 tabular-nums">
                    {count > 0 ? count : ''}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </>,
    document.body,
  )
}

// ── MemoCell ──────────────────────────────────────────────────────────────

function MemoCell({
  employeeId, date, initialNote, onSave,
}: {
  employeeId: string
  date: string
  initialNote: string
  onSave: (note: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(initialNote)

  useEffect(() => { setVal(initialNote) }, [initialNote])

  function commit() {
    setEditing(false)
    if (val !== initialNote) onSave(val)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(initialNote); setEditing(false) } }}
        onClick={e => e.stopPropagation()}
        className="w-full text-xs border border-blue-300 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 bg-white text-gray-800"
        placeholder="메모 입력..."
      />
    )
  }

  return (
    <button
      onClick={e => { e.stopPropagation(); setEditing(true) }}
      className="w-full text-left text-xs text-gray-500 hover:text-gray-800 truncate group"
      title={val || '메모 추가'}
    >
      {val
        ? <span className="text-gray-700">{val}</span>
        : <span className="text-gray-300 group-hover:text-gray-400">+ 메모</span>
      }
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export function AttendanceResultTable({
  records, employees,
  columnVisibility, onColumnVisibilityChange,
  onRowClick, onNameClick,
  noteMap, onNoteChange,
  onDeleteRecord,
  selectedKeys, onSelectionChange,
  otExemptIds,
  onExport,
}: Props) {
  const [showHolidayWork,  setShowHolidayWork]  = useState(false)
  const [showOver52h,      setShowOver52h]      = useState(false)
  const [timeView,         setTimeView]         = useState<'인정시간' | '실제값'>('인정시간')
  const [creditsOn,        setCreditsOn]        = useState(true)
  const [columnFilters,    setColumnFilters]    = useState<ColumnFiltersState>([])
  const [sorting,          setSorting]          = useState<SortingState>([
    { id: 'date', desc: true },
    { id: 'empId', desc: false },
  ])
  const [pagination,  setPagination]  = useState<PaginationState>({ pageIndex: 0, pageSize: 20 })
  const [showColMenu, setShowColMenu] = useState(false)
  // { columnId, rect } when a funnel button is clicked
  const [filterAnchor, setFilterAnchor] = useState<{ columnId: string; rect: DOMRect } | null>(null)

  const empMap = useMemo(() => {
    const src = employees ?? EMPLOYEES
    return new Map(src.map(e => [e.id, e]))
  }, [employees])

  const over52hEmployeeIds = useMemo(() => {
    const weekly = new Map<string, number>()
    for (const r of records) {
      const ci          = (r.effectiveClockIn ?? r.clockIn) ? parseTimeToMins((r.effectiveClockIn ?? r.clockIn)!) : null
      const co          = r.clockOut ? parseTimeToMins(r.clockOut) : null
      const elapsed     = (ci !== null && co !== null) ? Math.max(0, co - ci) : 0
      const breakMins   = compute4141BreakMins(elapsed)
      const wBMins      = Math.max(0, elapsed - breakMins)
      const leaveCredit = r.isUnpaidLeave ? 0 : (r.erpLeaveAmount ?? 0) * 8
      const h           = wBMins / 60 + leaveCredit
      if (h <= 0) continue
      const key = `${r.employeeId}||${weekStartUTC(r.date)}`
      weekly.set(key, (weekly.get(key) ?? 0) + h)
    }
    const ids = new Set<string>()
    for (const [key, h] of weekly) if (h >= 52) ids.add(key.split('||')[0])
    return ids
  }, [records])

  const holidayWorkerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of records) if (r.finalStatus === '휴일근무') ids.add(r.employeeId)
    return ids
  }, [records])

  const data = useMemo((): GridRow[] => {
    let src = records
    if (showHolidayWork) src = src.filter(r => holidayWorkerIds.has(r.employeeId))
    if (showOver52h)     src = src.filter(r => over52hEmployeeIds.has(r.employeeId))

    return src.map(r => {
      const emp        = empMap.get(r.employeeId)
      const empId      = emp?.rawId ?? r.employeeId.split('_')[0]
      const leaveAmt   = r.erpLeaveAmount ?? 0
      // 실제값: raw clockIn, 인정시간: 근무유형별 보정 출근시각 (오전반차 13:00, 오전반반차 10:00, 그 외 08:00 floor)
      const isExactMode        = timeView === '실제값'
      const isSlackInjected    = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
      const isErpLeaveApproved = r.leaveType ? !isSlackInjected : true
      // Button3(실제값): leaveType=null → std=480 → MAX(actualIn, 08:00) floor only, 연차보정 없음
      const effectiveIn        = isExactMode
        ? computeEffClockIn(r.clockIn, null, true)
        : computeEffClockIn(r.clockIn, r.leaveType, isErpLeaveApproved)
      const clockInMins        = effectiveIn ? parseTimeToMins(effectiveIn) : null
      const clockOutMins    = r.clockOut  ? parseTimeToMins(r.clockOut)  : null
      const isHoliday       = r.dayType !== 'WEEKDAY'
      // 4/1/4/1 슬라이딩 휴게: 분단위 연속값 (점심 +4h~+5h, 저녁 +9h~+10h)
      const elapsedMins     = (clockInMins !== null && clockOutMins !== null) ? Math.max(0, clockOutMins - clockInMins) : 0
      const displayBreakMins = isHoliday ? (r.breakMinutes ?? 0) : compute4141BreakMins(elapsedMins)
      // 인정시간+creditsOn+ERP상신(Slack 미주입)일 때만 연차 크레딧 합산
      const leaveCredit  = (!isExactMode && creditsOn && !r.isUnpaidLeave && !isSlackInjected)
        ? leaveAmt * 8
        : 0
      // 근로A = 총 경과시간(gross, 휴게 차감 전) / 최종근무 = (근로A − 휴게) + 연차크레딧
      const gasWorkAMins = elapsedMins
      const netWorkMins  = Math.max(0, gasWorkAMins - displayBreakMins)
      const finalWorkH   = isHoliday ? (r.holidayHours ?? 0) : netWorkMins / 60 + leaveCredit
      const leaveSource: string =
        isSlackInjected              ? 'Slack' :
        r.leaveType                  ? 'ERP' :
        ''
      // 🔍 임시 디버그 — 배영언 leaveSource 추적
      if (emp?.name === '배영언') {
        console.log(`[DEBUG 배영언] ${r.date} leaveType="${r.leaveType}" erpLeaveAmount=${r.erpLeaveAmount} isSlackInjected=${isSlackInjected} verificationNote=${JSON.stringify(r.verificationNote)} → leaveSource="${leaveSource}"`)
      }
      const displayStatus: string | null = r.finalStatus ?? null
      // ── 근태 태그 도출 ─────────────────────────────────────────────────
      const anomalyTags: string[] = []
      const flag = r.flag
      // 3종 체계(지각/근무시간미달/미태깅) — 조기퇴근은 근무시간미달로 통합.
      // EARLY_DEPARTURE/LATE_AND_EARLY_DEPARTURE는 재계산 전 캐시된 레코드에서만 남아있을 수 있음 (하위호환).
      if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') anomalyTags.push('미태깅')
      if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('지각')
      if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') anomalyTags.push('근무시간 미달')

      const attendanceStatus: '정상' | '비정상' = anomalyTags.length === 0 ? '정상' : '비정상'

      const normalTags: string[] = []
      if (r.finalStatus === '외근') normalTags.push('외근')
      if (r.finalStatus === '휴일근무') normalTags.push('휴일근로')
      if (r.overtimeHours > 0) normalTags.push('연장근로')
      if (normalTags.length === 0 && anomalyTags.length === 0 && r.clockIn !== null && r.dayType === 'WEEKDAY') normalTags.push('일반')
      // Zone 2 — 급여 지표 v2 (Virtual In + 10h 기준선, 버튼 간 완전 격리)
      // 초과근로 = 급여용연장의 절삭 전(1분단위) 값 — 둘 다 동일한 ERP가드를 거친 뒤
      // 절삭 유무만 다름. Button3(실제값)은 가드·절삭 모두 해제.
      // 직책자는 ERP 신청 여부와 무관하게 항상 인정 (기존 방침 유지).
      const systemOtMins   = isExactMode
        ? computeLeaderPayOtMins(r.clockIn, r.clockOut, null, true)   // leaveType=null → 08:00 floor, no backtrack, no truncation, no guard
        : (r.isLeader
          ? computeLeaderPayOtMins(r.clockIn, r.clockOut, r.leaveType, isErpLeaveApproved)
          : (r.erpOtApplied ? computeLeaderPayOtMins(effectiveIn, r.clockOut, r.leaveType, isErpLeaveApproved) : 0))
      const systemOtH      = systemOtMins / 60
      // 급여용 연장: Button1/2=ERP가드+30분절삭(직책자 노절삭), Button3=가드·절삭 모두 해제(초과근로와 동일)
      const gasPayOtMins   = isExactMode
        ? systemOtMins
        : (r.isLeader
          ? computeLeaderPayOtMins(r.clockIn, r.clockOut, r.leaveType, isErpLeaveApproved)
          : (r.erpOtApplied ? computePayOtMins(effectiveIn, r.clockOut, r.leaveType, isErpLeaveApproved) : 0))
      // Slack 주입 시 이론적 OT (ERP 승인으로 가정) — 표시 전용, 총계 미반영
      const isSlackLeave   = !!(r.leaveType && isSlackInjected)
      const slackOtH       = isSlackLeave
        ? (r.isLeader
          ? computeLeaderPayOtMins(r.clockIn, r.clockOut, r.leaveType, true) / 60
          : (r.erpOtApplied ? computePayOtMins(effectiveIn, r.clockOut, r.leaveType, true) / 60 : 0))
        : 0
      // 급여용 야간: Button1/2=직책자 절삭없음·일반 30분절삭, Button3=전사 노절삭
      const gasNightMins   = computeGasNightMins(r.clockOut, isExactMode ? true : (r.isLeader ?? false))
      const payrollOtH     = gasPayOtMins / 60
      const payrollNightH  = gasNightMins / 60
      // 급여용 휴일근로: 4+1 반복 패턴 휴게공제 — Button1/2=전사 30분절삭, Button3=전사 노절삭
      const payrollHolidayH = r.dayType !== 'WEEKDAY' && r.clockIn && r.clockOut
        ? computeHolidayPayMins(
            Math.max(0, parseTimeToMins(r.clockOut) - parseTimeToMins(r.clockIn)),
            isExactMode,
          ) / 60
        : 0
      const auditFlag  = (gasPayOtMins > 0 || gasNightMins > 0) && r.erpOtApplied !== true
      const isOtExempt = r.isLeader === true || otExemptIds?.has(r.employeeId) === true
      // payrollOtH는 미신청 시 0으로 강제되어 '미신청'을 절대 나타낼 수 없었음 — 실제
      // 연장근로 여부(r.overtimeHours, ERP 게이트 적용 전 원시값) 기준으로 판정.
      const erpOtStatus: '신청' | '미신청' | '—' =
        isOtExempt || r.overtimeHours === 0 ? '—' :
        r.erpOtApplied                      ? '신청' : '미신청'
      return {
        record: r, division: emp?.division ?? '—', team: emp?.team ?? '', empId,
        name: emp?.name ?? r.employeeId,
        date: r.date,
        clockIn:  effectiveIn ?? null,
        clockOut: r.clockOut ?? null,
        leaveAmt, leaveType: r.leaveType ?? null, leaveSource,
        gasWorkAMins, breakH: displayBreakMins / 60,
        finalWorkH, displayStatus,
        attendanceStatus, normalTags, anomalyTags,
        systemOtH, payrollOtH, slackOtH, isSlackLeave, payrollNightH, payrollHolidayH,
        erpOtStatus,
        auditFlag,
        note: noteMap?.get(`${r.employeeId}_${r.date}`) ?? '',
      }
    // Table view: exclude non-working days with no punches — they add no signal in a
    // row-based list. Non-working days with punches (휴일근무) are preserved.
    // The calendar/grid view is unaffected (uses records directly).
    }).filter(row => row.record.dayType === 'WEEKDAY' || row.record.clockIn != null || row.record.clockOut != null)
  }, [records, showHolidayWork, showOver52h, holidayWorkerIds, over52hEmployeeIds, empMap, noteMap, timeView, creditsOn])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns = useMemo<ColumnDef<GridRow, any>[]>(() => [
    // ── Zone 1: columns 1–12 (T.A.G. exact data) ────────────────────────────
    col.accessor('division', {
      id: 'division', header: '소속', size: 130, minSize: 80,
      filterFn: multiSelectFilter,
      cell: i => {
        const div  = i.getValue() as string
        const team = i.row.original.team
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-gray-700 text-xs font-medium">{div}</span>
            {team && team !== div && (
              <span className="text-gray-400 text-[10px]">{team}</span>
            )}
          </span>
        )
      },
    }),
    col.accessor('empId', {
      id: 'empId', header: '사번', size: 90, minSize: 70,
      cell: i => <span className="text-gray-500 font-mono text-[11px]">{i.getValue()}</span>,
    }),
    col.accessor('name', {
      id: 'name', header: '이름', size: 80, minSize: 60,
      cell: i => onNameClick
        ? <button
            onClick={e => { e.stopPropagation(); onNameClick(i.row.original.record.employeeId) }}
            className="font-medium text-gray-800 hover:text-blue-600 hover:underline underline-offset-2 text-left text-xs"
          >{i.getValue()}</button>
        : <span className="font-medium text-gray-800 text-xs">{i.getValue()}</span>,
    }),
    col.accessor('date', {
      id: 'date', header: '날짜', size: 100, minSize: 80,
      filterFn: 'includesString',
      cell: i => {
        const isH = i.row.original.record.dayType !== 'WEEKDAY'
        return <span className={`tabular-nums text-xs ${isH ? 'text-red-500 font-medium' : 'text-gray-600'}`}>
          {i.getValue()}
        </span>
      },
    }),
    col.accessor('clockIn', {
      id: 'clockIn', header: '출근', size: 78, minSize: 60,
      cell: i => {
        const effective = i.getValue() as string | null
        const raw = i.row.original.record.clockIn
        if (!effective) return <span className="text-gray-300">—</span>
        const wasClamped = raw && raw !== effective
        return (
          <span className="flex flex-col items-center gap-px">
            <span className="tabular-nums text-gray-600 text-xs">{effective}</span>
            {wasClamped && (
              <span className="tabular-nums text-[9px] text-gray-400 line-through">{raw}</span>
            )}
          </span>
        )
      },
    }),
    col.accessor('clockOut', {
      id: 'clockOut', header: '퇴근', size: 70, minSize: 55,
      cell: i => i.getValue()
        ? <span className="tabular-nums text-gray-600 text-xs">{i.getValue()}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('leaveAmt', {
      id: 'leaveAmt', header: () => <ColTip label="연차일수" tip="ERP 휴가 사용량 (0.25=반반차, 0.5=반차, 1=연차)" />, size: 75, minSize: 60,
      filterFn: numMultiSelectFilter,
      cell: i => i.getValue() > 0
        ? <span className="text-blue-700 font-semibold tabular-nums text-xs">{i.getValue()}일</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('leaveType', {
      id: 'leaveType', header: () => <ColTip label="연차코드" tip="ERP 원본 근태코드 (연차·오전반차·리프레쉬휴가 등)" />, size: 85, minSize: 65,
      filterFn: multiSelectFilter,
      cell: i => i.getValue()
        ? <span className="text-blue-600 text-[10px] font-medium">{i.getValue()}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('leaveSource', {
      id: 'leaveSource', header: () => <ColTip label="연차정보" tip="휴가 출처 — ERP: 정상 상신, Slack: ERP 미상신" />, size: 72, minSize: 55,
      filterFn: multiSelectFilter,
      cell: i => {
        const v = i.getValue() as string
        if (!v) return <span className="text-gray-300">—</span>
        return <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-50 text-gray-600 border border-gray-200">{v}</span>
      },
    }),
    col.accessor('gasWorkAMins', {
      id: 'gasWorkAMins', header: () => <ColTip label="근로A" tip="출근~퇴근 총 경과시간 (휴가·휴게 차감 전)" />, size: 72, minSize: 55,
      cell: i => i.getValue() > 0
        ? <span className="tabular-nums text-gray-600 text-xs">{fmtH(i.getValue() / 60)}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('breakH', {
      id: 'breakH', header: () => <ColTip label="휴게" tip="4/1/4/1 레일 스킵값 — 근로A 4h↑부터 점심 1h, 9h↑부터 저녁 1h 누적 (최대 2h)" />, size: 60, minSize: 48,
      filterFn: numMultiSelectFilter,
      cell: i => i.getValue() > 0
        ? <span className="tabular-nums text-gray-400 text-xs">{Math.round(i.getValue() * 60)}m</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('finalWorkH', {
      id: 'finalWorkH', header: () => <ColTip label="최종근무" tip="(근로A − 휴게) + 연차크레딧" />, size: 85, minSize: 70,
      cell: i => i.getValue() > 0
        ? <span className="tabular-nums text-xs font-semibold text-gray-800">{fmtH(i.getValue())}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('attendanceStatus', {
      id: 'attendanceStatus', header: () => <ColTip label="근태상태" tip="이상치 존재 여부 (정상 / 비정상)" />, size: 72, minSize: 60,
      filterFn: multiSelectFilter,
      cell: i => {
        const v = i.getValue() as '정상' | '비정상'
        return v === '정상'
          ? <span className="text-[10px] font-medium text-gray-400">정상</span>
          : <span className="text-[10px] font-semibold text-red-500">비정상</span>
      },
    }),
    col.accessor('normalTags', {
      id: 'normalTags', header: () => <ColTip label="정상정보" tip="정상 출근 유형 (일반 · 연장근로 · 외근 · 휴일근로)" />, size: 130, minSize: 80,
      filterFn: tagArrayFilter,
      cell: i => {
        const tags = i.getValue() as string[]
        if (!tags.length) return <span className="text-gray-200 text-[10px]">—</span>
        return (
          <span className="flex flex-wrap gap-0.5">
            {tags.map(t => (
              <span key={t} className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{t}</span>
            ))}
          </span>
        )
      },
    }),
    col.accessor('anomalyTags', {
      id: 'anomalyTags', header: () => <ColTip label="비정상정보" tip="이상치 유형 (지각 · 근무시간미달 · 미태깅)" />, size: 150, minSize: 90,
      filterFn: tagArrayFilter,
      cell: i => {
        const tags = i.getValue() as string[]
        if (!tags.length) return <span className="text-gray-200 text-[10px]">—</span>
        return (
          <span className="flex flex-wrap gap-0.5">
            {tags.map(t => {
              const cls = t === '지각'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-red-50 text-red-600 border-red-200'
              return (
                <span key={t} className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>{t}</span>
              )
            })}
          </span>
        )
      },
    }),
    // ── Zone 2: columns 13–16 (Payroll reference) ───────────────────────────
    col.accessor('systemOtH', {
      id: 'systemOtH', header: () => <ColTip label="초과근로" tip="MAX(0, 퇴근 − (Virtual In+10h)), 1분 단위 (급여용연장의 절삭 전 값, 직책자 ERP무관)" />, size: 80, minSize: 65,
      cell: i => i.getValue() > 0
        ? <span className="tabular-nums text-xs font-medium text-amber-600">{fmtH(i.getValue())}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('payrollOtH', {
      id: 'payrollOtH', header: () => <ColTip label="급여용연장" tip="초과근로를 30분 단위 절사 (직책자 노절삭, 실제값 버튼은 절삭 없음)" />, size: 90, minSize: 72,
      cell: i => {
        const row = i.row.original
        return i.getValue() > 0
          ? <span className="tabular-nums text-xs font-semibold text-red-600">{fmtH(i.getValue())}</span>
          : <span className="text-gray-300">—</span>
      },
    }),
    col.accessor('payrollNightH', {
      id: 'payrollNightH', header: () => <ColTip label="급여용야간" tip="22시 이후 근무시간, 30분 단위 절사 (직책자·실제값 버튼은 절삭 없음)" />, size: 90, minSize: 72,
      cell: i => i.getValue() > 0
        ? <span className="tabular-nums text-xs font-semibold text-indigo-600">{fmtH(i.getValue())}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('payrollHolidayH', {
      id: 'payrollHolidayH', header: () => <ColTip label="급여용휴일" tip="휴일 실근무시간(4+1 패턴 휴게공제), 30분 단위 절사 (직책자·실제값 버튼은 절삭 없음)" />, size: 90, minSize: 72,
      cell: i => i.getValue() > 0
        ? <span className="tabular-nums text-xs font-semibold text-emerald-600">{fmtH(i.getValue())}</span>
        : <span className="text-gray-300">—</span>,
    }),
    col.accessor('erpOtStatus', {
      id: 'erpOtApplied', header: () => <ColTip label="ERP연장신청" tip="ERP 연장근무 사전 신청 여부 및 신청 시간" />, size: 110, minSize: 85,
      filterFn: multiSelectFilter,
      cell: i => {
        const v = i.getValue() as '신청' | '미신청' | '—'
        if (v === '—') return <span className="text-gray-300 text-[10px]">—</span>
        if (v === '신청') return (
          <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-50 text-green-700 border-green-200">신청</span>
        )
        return (
          <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-red-50 text-red-600 border-red-200">미신청</span>
        )
      },
    }),
    col.accessor('note', {
      id: 'note', header: '메모', size: 180, minSize: 100,
      cell: i => (
        <MemoCell
          employeeId={i.row.original.record.employeeId}
          date={i.row.original.date}
          initialNote={i.getValue() ?? ''}
          onSave={(note) => onNoteChange?.(i.row.original.record.employeeId, i.row.original.date, note)}
        />
      ),
    }),
  ], [onNameClick, onNoteChange])

  const table = useReactTable({
    data, columns,
    state: { columnFilters, columnVisibility, sorting, pagination },
    onColumnFiltersChange:    setColumnFilters,
    onColumnVisibilityChange: onColumnVisibilityChange,
    onSortingChange:          setSorting,
    onPaginationChange:       setPagination,
    getCoreRowModel:          getCoreRowModel(),
    getFilteredRowModel:      getFilteredRowModel(),
    getSortedRowModel:        getSortedRowModel(),
    getPaginationRowModel:    getPaginationRowModel(),
    getFacetedRowModel:       getFacetedRowModel(),
    getFacetedUniqueValues:   getFacetedUniqueValues(),
    autoResetPageIndex:       false,
    columnResizeMode:         'onChange',
    enableColumnResizing:     true,
  })

  if (records.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400">
        처리된 근태 데이터가 없습니다.
      </div>
    )
  }

  const filteredCount = table.getFilteredRowModel().rows.length
  const totalCount    = data.length
  const { pageIndex, pageSize } = table.getState().pagination
  const pageStart = pageIndex * pageSize + 1
  const pageEnd   = Math.min((pageIndex + 1) * pageSize, filteredCount)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">

      {/* ── 인정시간 / 실제값 탭 ───────────────────────────────────────────── */}
      <div className="px-4 pt-2.5 pb-1.5 border-b border-gray-100 flex flex-col gap-1.5">
        {/* 탭 전환 */}
        <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-[11px] font-medium w-fit">
          {(['인정시간', '실제값'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setTimeView(tab)}
              className={`px-2.5 py-1 rounded-md transition-all ${
                timeView === tab
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* 크레딧 토글 — 인정시간 탭 바로 아래 */}
        {timeView === '인정시간' && (
          <button
            onClick={() => setCreditsOn(prev => !prev)}
            className={`w-fit px-1.5 py-px rounded text-[10px] leading-tight border transition-all ${
              creditsOn
                ? 'bg-indigo-50 border-indigo-300 text-indigo-600'
                : 'bg-white border-gray-200 text-gray-400'
            }`}
          >
            크레딧 {creditsOn ? 'ON' : 'OFF'}
          </button>
        )}
      </div>

      {/* ── Slim toolbar ──────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2 flex-wrap">

        <div className="flex-1" />

        {/* Clear all column filters */}
        {columnFilters.length > 0 && (
          <button
            onClick={() => { setColumnFilters([]); setFilterAnchor(null) }}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            필터 해제 ({columnFilters.length})
          </button>
        )}

        {/* Record count */}
        <span className="text-xs text-gray-400 tabular-nums">
          {filteredCount < totalCount ? `${filteredCount} / ${totalCount}건` : `${totalCount}건`}
        </span>

        {/* 엑셀 내보내기 — 테이블 내부 필터 적용된 데이터만 */}
        {onExport && (
          <button
            onClick={() => {
              const filtered = table.getSortedRowModel().rows.map(r => r.original)
              onExport(filtered)
            }}
            className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 flex items-center gap-1.5 transition-colors"
            title="현재 필터 적용된 데이터만 내보내기"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
            엑셀 ({filteredCount}건)
          </button>
        )}

        {/* 열 설정 — optional column selector */}
        <div className="relative">
          {(() => {
            const optionalCount = OPTIONAL_COL_GROUPS.reduce(
              (n, g) => n + g.cols.filter(c => columnVisibility[c.id] !== false).length,
              0,
            )
            return (
              <button
                onClick={() => setShowColMenu(v => !v)}
                className={`text-xs px-2.5 py-1 rounded-lg border flex items-center gap-1.5 transition-colors ${
                  optionalCount > 0
                    ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
                열 설정
                {optionalCount > 0 && (
                  <span className="min-w-[16px] h-4 flex items-center justify-center text-[10px] font-bold bg-blue-600 text-white rounded-full px-1">
                    {optionalCount}
                  </span>
                )}
              </button>
            )
          })()}
          {showColMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowColMenu(false)} />
              <div className="absolute right-0 top-full mt-1 z-40 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden w-52">
                <div className="px-3 pt-2.5 pb-1.5 border-b border-gray-100">
                  <p className="text-[11px] font-semibold text-gray-700">추가 열 표시</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">선택한 열이 표시됩니다</p>
                </div>
                {OPTIONAL_COL_GROUPS.map(group => (
                  <div key={group.label} className="px-2 pt-2 pb-1">
                    <p className="px-1 pb-0.5 text-[9px] font-bold text-gray-400 uppercase tracking-wider">{group.label}</p>
                    {group.cols.map(({ id, label }) => {
                      const col = table.getColumn(id)
                      if (!col) return null
                      return (
                        <label key={id}
                          className="flex items-center gap-2 px-1 py-1 hover:bg-gray-50 rounded cursor-pointer">
                          <input
                            type="checkbox"
                            checked={col.getIsVisible()}
                            onChange={col.getToggleVisibilityHandler()}
                            className="w-3.5 h-3.5 rounded border-gray-300 accent-blue-600 cursor-pointer"
                          />
                          <span className="text-xs text-gray-700">{label}</span>
                        </label>
                      )
                    })}
                  </div>
                ))}
                <div className="px-3 py-2 border-t border-gray-100">
                  <button
                    onClick={() => {
                      OPTIONAL_COL_GROUPS.forEach(g =>
                        g.cols.forEach(c => table.getColumn(c.id)?.toggleVisibility(false))
                      )
                    }}
                    className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    모두 숨기기
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      <div
        className="overflow-auto"
        style={{ maxHeight: 'calc(100vh - 270px)', minHeight: 200 }}
      >
        {/* Selection helpers (computed once per render outside header/row loops) */}
        {(() => {
          const visibleRows   = table.getRowModel().rows
          const visibleKeys   = visibleRows.map(row => `${row.original.record.employeeId}_${row.original.record.date}`)
          const allSelected   = onSelectionChange != null && visibleKeys.length > 0 && visibleKeys.every(k => selectedKeys?.has(k))
          const someSelected  = !allSelected && visibleKeys.some(k => selectedKeys?.has(k))

          function toggleAll() {
            if (!onSelectionChange) return
            const next = new Set(selectedKeys ?? [])
            if (allSelected) visibleKeys.forEach(k => next.delete(k))
            else             visibleKeys.forEach(k => next.add(k))
            onSelectionChange(next)
          }

          function toggleRow(key: string) {
            if (!onSelectionChange) return
            const next = new Set(selectedKeys ?? [])
            next.has(key) ? next.delete(key) : next.add(key)
            onSelectionChange(next)
          }

          return (
        <table
          className="text-xs border-collapse"
          style={{ width: table.getCenterTotalSize(), minWidth: '100%' }}
        >
          <thead className="sticky top-0 z-20">
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id} className="bg-gray-50 border-b border-gray-200">
                {onSelectionChange && (
                  <th className="w-8 px-2 text-center sticky left-0 bg-gray-50 z-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected }}
                      onChange={toggleAll}
                      className="w-3.5 h-3.5 cursor-pointer"
                    />
                  </th>
                )}
                {hg.headers.map(header => {
                  const canFilter    = FILTERABLE.has(header.column.id)
                  const isFiltered   = header.column.getIsFiltered()
                  const isFilterOpen = filterAnchor?.columnId === header.column.id

                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize(), position: 'relative' }}
                      className="px-2 py-2.5 text-[11px] text-gray-500 whitespace-nowrap select-none font-semibold"
                    >
                      <div className="flex items-center gap-0.5">
                        {/* Sort area */}
                        <div
                          className={`flex items-center gap-0.5 flex-1 min-w-0 ${header.column.getCanSort() ? 'cursor-pointer hover:text-gray-800' : ''}`}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getIsSorted() === 'asc'  && <span className="text-blue-500 text-[9px] ml-0.5">▲</span>}
                          {header.column.getIsSorted() === 'desc' && <span className="text-blue-500 text-[9px] ml-0.5">▼</span>}
                        </div>

                        {/* Funnel filter button */}
                        {canFilter && (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              if (isFilterOpen) {
                                setFilterAnchor(null)
                              } else {
                                setFilterAnchor({
                                  columnId: header.column.id,
                                  rect: (e.currentTarget as HTMLButtonElement).getBoundingClientRect(),
                                })
                              }
                            }}
                            className={`flex-shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors ${
                              isFiltered
                                ? 'text-blue-600'
                                : isFilterOpen
                                ? 'text-gray-600 bg-gray-100'
                                : 'text-gray-300 hover:text-gray-500'
                            }`}
                            title={`${COL_LABELS[header.column.id]} 필터`}
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24"
                              fill={isFiltered ? 'currentColor' : 'none'}
                              stroke="currentColor" strokeWidth={2}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round"
                                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4-2A1 1 0 018 17v-3.586L3.293 6.707A1 1 0 013 6V4z" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {/* Resize handle */}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          className={`absolute right-0 top-0 h-full w-[3px] cursor-col-resize select-none transition-colors ${
                            header.column.getIsResizing() ? 'bg-blue-400' : 'bg-transparent hover:bg-gray-300'
                          }`}
                        />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={table.getVisibleLeafColumns().length}
                  className="px-4 py-10 text-center text-gray-400"
                >
                  조건에 맞는 데이터가 없습니다
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row, i) => {
                const r     = row.original.record
                const flag  = r.flag
                const isHol = r.dayType !== 'WEEKDAY'
                const rowBg = flag === 'NO_CLOCK_OUT' ? 'bg-red-50'
                  : flag     ? 'bg-amber-50/40'
                  : isHol    ? 'bg-gray-50/50'
                  : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/20'
                return (
                  <tr
                    key={row.id}
                    onClick={() => onRowClick?.(r.employeeId, r.date)}
                    className={`${rowBg} border-b border-gray-100 last:border-0 hover:bg-blue-50/30 transition-colors ${onRowClick ? 'cursor-pointer' : ''}`}
                  >
                    {onSelectionChange && (
                      <td className="px-2 py-2 text-center w-8 sticky left-0 bg-inherit" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedKeys?.has(`${r.employeeId}_${r.date}`) ?? false}
                          onChange={() => toggleRow(`${r.employeeId}_${r.date}`)}
                          className="w-3.5 h-3.5 cursor-pointer"
                        />
                      </td>
                    )}
                    {row.getVisibleCells().map(cell => (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className="px-3 py-2 text-center whitespace-nowrap overflow-hidden"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
        )
      })()}
      </div>

      {/* ── Pagination ────────────────────────────────────────────────────── */}
      {table.getPageCount() > 1 && (
        <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-between gap-4">
          <span className="text-xs text-gray-400 tabular-nums">
            {pageStart}–{pageEnd} / {filteredCount}건
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}
              className="px-2 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">«</button>
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}
              className="px-2.5 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">이전</button>

            {(() => {
              const total = table.getPageCount()
              const cur   = table.getState().pagination.pageIndex
              const pages: (number | '…')[] = []
              for (let p = 0; p < total; p++) {
                if (p === 0 || p === total - 1 || (p >= cur - 2 && p <= cur + 2)) pages.push(p)
                else if (pages[pages.length - 1] !== '…') pages.push('…')
              }
              return pages.map((p, idx) =>
                p === '…' ? (
                  <span key={`e${idx}`} className="px-1 text-xs text-gray-300">…</span>
                ) : (
                  <button key={p} onClick={() => table.setPageIndex(p as number)}
                    className={`min-w-[28px] px-2 py-1 text-xs rounded border transition-colors ${
                      p === cur ? 'bg-blue-600 border-blue-600 text-white font-semibold' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}>{(p as number) + 1}</button>
                ),
              )
            })()}

            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}
              className="px-2.5 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">다음</button>
            <button onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()}
              className="px-2 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">»</button>
          </div>
        </div>
      )}

      {/* ── Portal: inline filter popup ───────────────────────────────────── */}
      {filterAnchor && (
        <FilterPopupPortal
          column={table.getColumn(filterAnchor.columnId)!}
          rect={filterAnchor.rect}
          onClose={() => setFilterAnchor(null)}
        />
      )}
    </div>
  )
}
