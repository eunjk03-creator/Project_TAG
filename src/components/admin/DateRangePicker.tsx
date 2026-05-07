'use client'
import { useState, useRef, useEffect } from 'react'
import type { DateRange } from '@/types/tag'

export type { DateRange }

const DATA_END = '2026-04-29'

function addDays(d: string, n: number): string {
  const date = new Date(d + 'T00:00:00')
  date.setDate(date.getDate() + n)
  return date.toISOString().split('T')[0]
}

function weekStart(d: string): string {
  const date = new Date(d + 'T00:00:00')
  const dow = date.getDay()
  date.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1))
  return date.toISOString().split('T')[0]
}

const PRESETS = [
  { label: '오늘',     from: DATA_END,                         to: DATA_END },
  { label: '이번 주',  from: weekStart(DATA_END),              to: DATA_END },
  { label: '이번 달',  from: DATA_END.slice(0, 7) + '-01',    to: DATA_END },
  { label: '최근 7일', from: addDays(DATA_END, -6),            to: DATA_END },
  { label: '최근 30일',from: addDays(DATA_END, -29),           to: DATA_END },
] as const

function getDisplayLabel(value: DateRange): string {
  const preset = PRESETS.find(p => p.from === value.from && p.to === value.to)
  if (preset) return preset.label

  const [fy, fm, fd] = value.from.split('-')
  const [ty, tm, td] = value.to.split('-')
  if (value.from === value.to) return `${fm}/${fd}`
  if (fy === ty) return `${fm}/${fd} ~ ${tm}/${td}`
  return `${value.from} ~ ${value.to}`
}

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange
  onChange: (r: DateRange) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange>(value)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  useEffect(() => { setDraft(value) }, [value])

  function applyPreset(p: { from: string; to: string }) {
    onChange(p)
    setOpen(false)
  }

  function applyCustom() {
    const range = draft.from <= draft.to ? draft : { from: draft.to, to: draft.from }
    if (!range.from || !range.to) return
    onChange(range)
    setOpen(false)
  }

  const isActivePreset = (p: { from: string; to: string }) =>
    value.from === p.from && value.to === p.to

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all whitespace-nowrap ${
          open
            ? 'bg-blue-50 border-blue-300 text-blue-700'
            : 'bg-white border-gray-200 text-gray-700 hover:border-blue-300'
        }`}
      >
        <svg className="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span>{getDisplayLabel(value)}</span>
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute left-0 top-full mt-2 z-[200] bg-white border border-gray-200 rounded-2xl shadow-2xl shadow-gray-200/80 w-72 overflow-hidden">

          {/* Quick presets */}
          <div className="px-4 pt-4 pb-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2.5">
              빠른 선택
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  className={`py-1.5 text-xs rounded-lg border font-medium transition-all ${
                    isActivePreset(p)
                      ? 'bg-blue-600 text-white border-blue-600 shadow-sm shadow-blue-200'
                      : 'text-gray-600 border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-gray-100 mx-4" />

          {/* Custom range */}
          <div className="px-4 py-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2.5">
              직접 입력
            </p>
            <div className="space-y-2">
              <div>
                <label className="block text-[11px] text-gray-500 mb-1 font-medium">시작</label>
                <input
                  type="date"
                  value={draft.from}
                  onChange={e => setDraft(d => ({ ...d, from: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 mb-1 font-medium">종료</label>
                <input
                  type="date"
                  value={draft.to}
                  onChange={e => setDraft(d => ({ ...d, to: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Apply footer */}
          <div className="px-4 pb-4">
            <button
              onClick={applyCustom}
              className="w-full py-2 bg-blue-600 text-white text-xs font-semibold rounded-xl hover:bg-blue-700 active:scale-[0.98] transition-all shadow-sm shadow-blue-200"
            >
              적용
            </button>
          </div>

        </div>
      )}
    </div>
  )
}
