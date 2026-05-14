'use client'
import { useState, useRef, useEffect, useMemo } from 'react'
import type { DateRange } from '@/types/tag'

// ── Data bounds (mock records span Jan 1 → Apr 29 2026) ──────────────────
const DATA_START = '2026-01-01'
const DATA_END   = '2026-04-29'

// ── Date helpers ──────────────────────────────────────────────────────────
function toDS(d: Date): string {
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  )
}
function addDays(s: string, n: number): string {
  const d = new Date(s + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return toDS(d)
}
function weekMonday(s: string): string {
  const d = new Date(s + 'T12:00:00')
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return toDS(d)
}
// Returns 1-5: which occurrence of a Monday this is within its month
function weekOfMonth(monday: string): number {
  return Math.ceil(new Date(monday + 'T12:00:00').getDate() / 7)
}
// "4/27~5/3"
function shortRange(monday: string): string {
  const fr = new Date(monday + 'T12:00:00')
  const to = new Date(monday + 'T12:00:00')
  to.setDate(to.getDate() + 6)
  const [fM, fD] = [fr.getMonth() + 1, fr.getDate()]
  const [tM, tD] = [to.getMonth() + 1, to.getDate()]
  return tM === fM ? `${fM}/${fD}~${tD}` : `${fM}/${fD}~${tM}/${tD}`
}
// "2026.04.27(월) ~ 05.03(일)"
const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']
function longRange(monday: string): string {
  const fr = new Date(monday + 'T12:00:00')
  const to = new Date(monday + 'T12:00:00')
  to.setDate(to.getDate() + 6)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${fr.getFullYear()}.${p(fr.getMonth() + 1)}.${p(fr.getDate())}(${DOW_KR[fr.getDay()]})` +
    ` ~ ${p(to.getMonth() + 1)}.${p(to.getDate())}(${DOW_KR[to.getDay()]})`
  )
}

// ── Static week catalogue ─────────────────────────────────────────────────
interface WeekInfo {
  monday: string
  sunday: string
  month:  number   // 1-12
  wom:    number   // week-of-month 1-5
}

function buildWeeks(): WeekInfo[] {
  const list: WeekInfo[] = []
  let mon = weekMonday(DATA_START)
  // weekMonday('2026-01-01') = '2025-12-29' (Dec 29 is a Monday before the data).
  // Advance to the first Monday that is within or after DATA_START.
  if (mon < DATA_START) mon = addDays(mon, 7)
  const cap = weekMonday(DATA_END)
  while (mon <= cap) {
    list.push({
      monday: mon,
      sunday: addDays(mon, 6),
      month:  new Date(mon + 'T12:00:00').getMonth() + 1,
      wom:    weekOfMonth(mon),
    })
    mon = addDays(mon, 7)
  }
  return list
}

const ALL_WEEKS   = buildWeeks()
const LAST_MON    = weekMonday(DATA_END)
const DATA_MONTHS = new Set(ALL_WEEKS.map(w => w.month))   // {1,2,3,4}
const MO_KR       = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

// ── Component ─────────────────────────────────────────────────────────────
export function WeeklySwitcher({
  value,
  onChange,
}: {
  value:    DateRange
  onChange: (r: DateRange) => void
}) {
  const selMon = weekMonday(value.from)

  const [activeMonth, setActiveMonth] = useState(
    () => new Date(selMon + 'T12:00:00').getMonth() + 1,
  )

  const stripRef  = useRef<HTMLDivElement>(null)
  const chipMap   = useRef(new Map<string, HTMLButtonElement>())

  // Keep activeMonth in sync when value changes externally
  useEffect(() => {
    const m = new Date(weekMonday(value.from) + 'T12:00:00').getMonth() + 1
    setActiveMonth(m)
  }, [value.from])

  // Scroll selected chip into the centre of the strip
  useEffect(() => {
    const strip = stripRef.current
    const chip  = chipMap.current.get(selMon)
    if (!strip || !chip) return
    const { offsetLeft: left, offsetWidth: w } = chip
    strip.scrollTo({
      left:     left - (strip.clientWidth / 2) + w / 2,
      behavior: 'smooth',
    })
  }, [selMon, activeMonth])

  const monthWeeks = useMemo(() => ALL_WEEKS.filter(w => w.month === activeMonth), [activeMonth])

  const curIdx  = ALL_WEEKS.findIndex(w => w.monday === selMon)
  const canPrev = curIdx > 0
  const canNext = selMon < LAST_MON

  function pickWeek(w: WeekInfo) {
    onChange({ from: w.monday, to: w.sunday })
  }

  function navWeek(delta: number) {
    const next = ALL_WEEKS[curIdx + delta]
    if (next) pickWeek(next)
  }

  function jumpMonth(m: number) {
    if (!DATA_MONTHS.has(m)) return
    setActiveMonth(m)
    const first = ALL_WEEKS.find(w => w.month === m)
    if (first) onChange({ from: first.monday, to: first.sunday })
  }

  return (
    <div className="flex flex-col gap-2 w-full min-w-0 select-none">

      {/* ── Row 1: Month quick-jump strip + selected range ───────────────── */}
      <div className="flex items-center gap-1">

        {/* 12 month buttons */}
        <div
          className="flex items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden shrink-0"
          style={{ scrollbarWidth: 'none' }}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
            const has    = DATA_MONTHS.has(m)
            const active = activeMonth === m
            return (
              <button
                key={m}
                onClick={() => jumpMonth(m)}
                disabled={!has}
                className={`shrink-0 px-2.5 py-1 text-[11px] font-bold rounded-md whitespace-nowrap transition-all ${
                  active
                    ? 'bg-blue-600 text-white shadow-sm shadow-blue-200'
                    : has
                    ? 'bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600'
                    : 'text-gray-300 cursor-default'
                }`}
              >
                {MO_KR[m - 1]}
              </button>
            )
          })}
        </div>

        {/* Selected date range label */}
        <span className="ml-auto pl-3 shrink-0 text-[11px] font-medium text-blue-600 tabular-nums whitespace-nowrap">
          {longRange(selMon)}
        </span>
      </div>

      {/* ── Row 2: Week carousel ─────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 min-w-0">

        {/* ◀ Prev week */}
        <button
          onClick={() => navWeek(-1)}
          disabled={!canPrev}
          aria-label="이전 주"
          className="shrink-0 w-6 h-[30px] flex items-center justify-center rounded bg-white border border-gray-200 text-gray-400 hover:border-blue-400 hover:text-blue-600 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Scrollable chip strip */}
        <div
          ref={stripRef}
          className="flex gap-2 overflow-x-auto flex-1 pb-0.5 [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: 'none', scrollBehavior: 'smooth' }}
        >
          {monthWeeks.map(w => {
            const isSel  = w.monday === selMon
            const isFut  = w.monday > DATA_END
            const isLast = w.monday === LAST_MON

            return (
              <button
                key={w.monday}
                ref={el => { el ? chipMap.current.set(w.monday, el) : chipMap.current.delete(w.monday) }}
                onClick={() => !isFut && pickWeek(w)}
                disabled={isFut}
                className={`relative shrink-0 flex flex-col items-center justify-center gap-0.5 rounded-xl border transition-all duration-150 ${
                  isSel
                    ? 'bg-blue-600 border-blue-600 shadow-md shadow-blue-200/70 scale-[1.04]'
                    : isFut
                    ? 'bg-gray-50 border-dashed border-gray-200 cursor-not-allowed opacity-50'
                    : 'bg-white border-gray-200 hover:border-blue-400 hover:bg-blue-50/40 hover:shadow-sm cursor-pointer'
                }`}
                style={{ minWidth: 70, padding: '5px 10px' }}
              >
                {/* "최신" badge on the last real week */}
                {isLast && (
                  <span className="absolute -top-[7px] -right-[4px] text-[7px] font-extrabold bg-blue-500 text-white px-[5px] py-[1px] rounded-full leading-none pointer-events-none">
                    최신
                  </span>
                )}

                {/* Week number */}
                <span className={`text-sm font-extrabold leading-none ${
                  isSel ? 'text-white' : isFut ? 'text-gray-300' : 'text-gray-800'
                }`}>
                  {w.wom}주
                </span>

                {/* Date range sub-label */}
                <span className={`text-[9px] leading-none tabular-nums mt-[3px] ${
                  isSel ? 'text-blue-100' : isFut ? 'text-gray-200' : 'text-gray-400'
                }`}>
                  {shortRange(w.monday)}
                </span>
              </button>
            )
          })}
        </div>

        {/* ▶ Next week */}
        <button
          onClick={() => navWeek(1)}
          disabled={!canNext}
          aria-label="다음 주"
          className="shrink-0 w-6 h-[30px] flex items-center justify-center rounded bg-white border border-gray-200 text-gray-400 hover:border-blue-400 hover:text-blue-600 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
          </svg>
        </button>

      </div>
    </div>
  )
}
