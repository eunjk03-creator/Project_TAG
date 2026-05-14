'use client'
import { useState, useRef, useEffect, useMemo } from 'react'
import type { DateRange } from '@/types/tag'

const DATA_START  = '2026-01-01'
const DATA_END    = '2026-04-29'
const DATA_MONTHS = [1, 2, 3, 4]
const MO_KR  = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']
const DOW_KR = ['일','월','화','수','목','금','토']

function toDS(d: Date): string {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
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
function weekOfMonth(monday: string): number {
  return Math.ceil(new Date(monday + 'T12:00:00').getDate() / 7)
}

interface WeekInfo { monday: string; sunday: string; month: number; wom: number }
function buildWeeks(): WeekInfo[] {
  const list: WeekInfo[] = []
  let mon = weekMonday(DATA_START)
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
const ALL_WEEKS = buildWeeks()

export function DateRangePicker({
  value,
  onChange,
}: {
  value:    DateRange
  onChange: (r: DateRange) => void
}) {
  const [open,   setOpen]   = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null) // first-clicked date
  const [hover,  setHover]  = useState<string | null>(null)
  const [cal,    setCal]    = useState({ year: 2026, month: 4 })

  const trigRef = useRef<HTMLButtonElement>(null)
  const popRef  = useRef<HTMLDivElement>(null)

  // Each time popup opens: reset selection state, jump calendar to value.from month
  useEffect(() => {
    if (!open) return
    const d = new Date(value.from + 'T12:00:00')
    setCal({ year: d.getFullYear(), month: d.getMonth() + 1 })
    setAnchor(null)
    setHover(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Outside-click + Escape
  useEffect(() => {
    if (!open) return
    function onMD(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node) &&
          !trigRef.current?.contains(e.target as Node))
        setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMD)
    document.addEventListener('keydown',   onKey)
    return () => {
      document.removeEventListener('mousedown', onMD)
      document.removeEventListener('keydown',   onKey)
    }
  }, [open])

  // Right panel = left + 1 month
  const rCal = cal.month === 12
    ? { year: cal.year + 1, month: 1 }
    : { year: cal.year,     month: cal.month + 1 }

  function prevMonth() {
    setCal(c => c.month === 1
      ? { year: c.year - 1, month: 12 }
      : { ...c, month: c.month - 1 })
  }
  function nextMonth() {
    setCal(c => c.month === 12
      ? { year: c.year + 1, month: 1 }
      : { ...c, month: c.month + 1 })
  }

  // Live range preview: follows hover after anchor is set
  const hiFrom = useMemo(() => {
    if (!anchor) return value.from
    if (hover)   return anchor <= hover ? anchor : hover
    return anchor
  }, [anchor, hover, value.from])

  const hiTo = useMemo(() => {
    if (!anchor) return value.to
    if (hover)   return anchor <= hover ? hover : anchor
    return anchor
  }, [anchor, hover, value.to])

  function clickDay(ds: string) {
    if (!anchor) {
      setAnchor(ds)
    } else {
      const from = anchor <= ds ? anchor : ds
      const to   = anchor <= ds ? ds     : anchor
      onChange({ from, to })
      setOpen(false)
    }
  }

  function presetMonth(m: number) {
    const from = `2026-${String(m).padStart(2, '0')}-01`
    const raw  = toDS(new Date(2026, m, 0))
    onChange({ from, to: raw > DATA_END ? DATA_END : raw })
    setOpen(false)
  }

  function presetWeek(w: WeekInfo) {
    onChange({ from: w.monday, to: w.sunday })
    setOpen(false)
  }

  // ── Single month grid ──────────────────────────────────────────────────
  function renderCalMonth(year: number, month: number) {
    const dow0 = new Date(year, month - 1, 1).getDay()
    const days = new Date(year, month, 0).getDate()
    const cells: (string | null)[] = Array(dow0).fill(null)
    for (let d = 1; d <= days; d++)
      cells.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    while (cells.length % 7 !== 0) cells.push(null)

    const sameDay = hiFrom === hiTo

    return (
      <div className="min-w-[196px]" onMouseLeave={() => anchor && setHover(null)}>
        <p className="text-xs font-bold text-center text-gray-700 mb-2">
          {year}년 {month}월
        </p>

        <div className="grid grid-cols-7">
          {DOW_KR.map((d, i) => (
            <div key={d} className="h-7 flex items-center justify-center">
              <span className={`text-[9px] font-semibold ${
                i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'
              }`}>{d}</span>
            </div>
          ))}

          {cells.map((ds, idx) => {
            if (!ds) return <div key={`_${idx}`} className="h-8" />
            const dis    = ds < DATA_START || ds > DATA_END
            const isS    = ds === hiFrom
            const isE    = ds === hiTo
            const inR    = !sameDay && ds > hiFrom && ds < hiTo
            const dow    = new Date(ds + 'T12:00:00').getDay()
            const dayNum = new Date(ds + 'T12:00:00').getDate()
            const hasBand = !dis && !sameDay && (inR || isS || isE)

            return (
              <div key={ds} className="relative h-8 flex items-center justify-center">
                {/* Continuous range band — left/right half on endpoints, full width in between */}
                {hasBand && (
                  <div
                    className="absolute inset-y-1 bg-blue-100 pointer-events-none"
                    style={{ left: isS ? '50%' : 0, right: isE ? '50%' : 0 }}
                  />
                )}
                <button
                  disabled={dis}
                  onClick={() => !dis && clickDay(ds)}
                  onMouseEnter={() => anchor && !dis && setHover(ds)}
                  className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center
                    text-[11px] font-medium transition-colors
                    ${dis
                      ? 'text-gray-200 cursor-not-allowed'
                      : (isS || isE)
                        ? 'bg-blue-600 text-white font-bold hover:bg-blue-700 cursor-pointer'
                        : inR
                          ? 'text-blue-700 hover:bg-blue-200 cursor-pointer'
                          : `cursor-pointer hover:bg-gray-100 ${
                              dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700'
                            }`
                    }`}
                >
                  {dayNum}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="relative inline-block">

      {/* ── Trigger button ── */}
      <button
        ref={trigRef}
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium
          transition-all shadow-sm select-none ${
          open
            ? 'border-blue-500 bg-blue-50 text-blue-700'
            : 'border-gray-200 bg-white text-gray-700 hover:border-blue-400 hover:bg-blue-50/40'
        }`}
      >
        <span>📅</span>
        <span className="tabular-nums">{value.from}</span>
        <span className="text-gray-400 font-normal">~</span>
        <span className="tabular-nums">{value.to}</span>
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ml-0.5 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* ── Popup ── */}
      {open && (
        <div
          ref={popRef}
          className="absolute top-full left-0 mt-1.5 z-[200] bg-white rounded-2xl border
            border-gray-200 shadow-2xl overflow-hidden"
          style={{ width: 528 }}
        >

          {/* Section B — Quick Presets */}
          <div className="flex items-start gap-4 px-4 pt-4 pb-3 border-b border-gray-100">

            {/* Month presets */}
            <div className="shrink-0">
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                월별
              </p>
              <div className="flex gap-1.5">
                {DATA_MONTHS.map(m => {
                  const from   = `2026-${String(m).padStart(2, '0')}-01`
                  const active = value.from === from
                  return (
                    <button
                      key={m}
                      onClick={() => presetMonth(m)}
                      className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-all ${
                        active
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'bg-gray-100 text-gray-600 hover:bg-blue-50 hover:text-blue-600'
                      }`}
                    >
                      {MO_KR[m - 1]}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="w-px self-stretch bg-gray-200 shrink-0" />

            {/* Week presets — horizontally scrollable */}
            <div className="flex-1 min-w-0">
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                주별
              </p>
              <div
                className="flex gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden"
                style={{ scrollbarWidth: 'none' }}
              >
                {ALL_WEEKS.map(w => {
                  const active = value.from === w.monday && value.to === w.sunday
                  return (
                    <button
                      key={w.monday}
                      onClick={() => presetWeek(w)}
                      className={`shrink-0 px-2 py-1 text-[10px] font-bold rounded-md transition-all ${
                        active
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'bg-gray-100 text-gray-600 hover:bg-blue-50 hover:text-blue-600'
                      }`}
                    >
                      {w.month}월{w.wom}주
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Section A — Dual-month calendar */}
          <div className="p-4">
            <div className="flex items-center mb-3">
              <button
                onClick={prevMonth}
                className="w-7 h-7 flex items-center justify-center rounded-lg
                  hover:bg-gray-100 text-gray-500 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <p className="flex-1 text-center text-[11px] font-medium text-gray-400">
                {anchor ? '종료일을 클릭하세요' : '시작일을 클릭하세요'}
              </p>
              <button
                onClick={nextMonth}
                className="w-7 h-7 flex items-center justify-center rounded-lg
                  hover:bg-gray-100 text-gray-500 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <div className="flex gap-8 justify-between">
              {renderCalMonth(cal.year,  cal.month)}
              {renderCalMonth(rCal.year, rCal.month)}
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 pb-4 pt-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-[11px] font-medium text-gray-500 tabular-nums">
              {anchor
                ? `📌 ${anchor} → 종료일을 선택하세요`
                : `✅ ${value.from} ~ ${value.to}`}
            </span>
            <button
              onClick={() => { setAnchor(null); setOpen(false) }}
              className="px-3 py-1 text-[11px] font-semibold rounded-lg bg-gray-100
                text-gray-600 hover:bg-gray-200 transition-colors"
            >
              닫기
            </button>
          </div>

        </div>
      )}
    </div>
  )
}
