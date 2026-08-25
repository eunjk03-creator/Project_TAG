'use client'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

export type DeptCardSeverity = 'normal' | 'warning' | 'action'

export interface DeptCardCell {
  label: string
  value: string
  color?: string
}

export interface DeptCardPersonRow {
  key: string
  name: string
  /** 밴드 칩(주간 위험군) · 날짜 칩(휴일근로) · 입사연도 칩(연차) 등 */
  tag?: { text: string; bg: string; fg: string }
  /** 일간 전용 3열 숫자(지각/미달/미태) */
  cols?: (string | number)[]
  /** 그 외 상태의 단일 값 컬럼 (예: "51h 20m · 62만원", "7/20일 · 35%") */
  value?: string
  valueRed?: boolean
}

/** 부문 카드 1장의 콘텐츠 전체 — 심각도/기준값 계산은 overview 페이지가 하고, 이 컴포넌트는
 *  v9 디자인 핸드오프의 6층 구조(accent바/헤드+진행바/분해칸/목록헤더/목록/푸터)만 그린다. */
export interface DeptCardVM {
  division: string
  headcount: number
  severity: DeptCardSeverity
  mainValue: string
  mainUnit?: string
  progressPct: number
  progressMarkerPct?: number
  captionLeft: string
  captionRight: string
  cells: DeptCardCell[]
  listHeaderLabel: string
  listSortLabel: string
  listColumnHeaders?: string[]
  rows: DeptCardPersonRow[]
  footerLabel: string
  footerValue: string
}

const BAND: Record<DeptCardSeverity, string> = { normal: '#e2e8f0', warning: '#f59e0b', action: '#dc2626' }
const MAIN_COLOR: Record<DeptCardSeverity, string> = { normal: '#16a34a', warning: '#d97706', action: '#dc2626' }
const BADGE: Record<DeptCardSeverity, { bg: string; fg: string; label: string }> = {
  normal:  { bg: '#f1f5f9', fg: '#94a3b8', label: '정상' },
  warning: { bg: '#fffbeb', fg: '#b45309', label: '주의' },
  action:  { bg: '#fef2f6', fg: '#b91c1c', label: '조치 필요' },
}

export function DeptCard({ vm }: { vm: DeptCardVM }) {
  const [open, setOpen] = useState(true)
  const badge = BADGE[vm.severity]

  return (
    <section className="bg-white border border-gray-100 rounded-[13px] overflow-hidden flex flex-col hover:border-gray-300 transition-colors">
      <div className="h-[3px] shrink-0" style={{ background: BAND[vm.severity] }} />

      <div className="px-[15px] pt-[13px] pb-3 shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-extrabold text-gray-900 truncate">{vm.division}</span>
          <span className="text-[10px] text-gray-400 shrink-0">{vm.headcount}명</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[25px] font-extrabold tabular-nums leading-none" style={{ color: MAIN_COLOR[vm.severity] }}>
            {vm.mainValue}{vm.mainUnit && <span className="text-[11.5px] font-semibold ml-0.5">{vm.mainUnit}</span>}
          </span>
          <span className="flex-1" />
          <span className="text-[9.5px] font-bold px-[7px] py-0.5 rounded shrink-0" style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>
        </div>
        <div className="relative h-[5px] rounded-full bg-[#eef2f6] mt-2 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, vm.progressPct))}%`, background: MAIN_COLOR[vm.severity] }} />
          {vm.progressMarkerPct !== undefined && (
            <div className="absolute -top-0.5 w-0.5 h-[9px] bg-[#0f172a] rounded-sm" style={{ left: `${Math.max(0, Math.min(100, vm.progressMarkerPct))}%` }} />
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[9.5px] text-gray-400 truncate">{vm.captionLeft}</span>
          <span className="text-[9.5px] text-gray-400 shrink-0">{vm.captionRight}</span>
        </div>
      </div>

      <div className="flex gap-px bg-[#f1f5f9] shrink-0">
        {vm.cells.map((c, i) => (
          <div key={i} className="flex-1 bg-white py-[7px] text-center">
            <p className="text-[9px] text-gray-400">{c.label}</p>
            <p className="text-[13px] font-extrabold tabular-nums" style={{ color: c.value === '—' || c.value === '0' ? '#e2e8f0' : (c.color ?? '#0f172a') }}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between px-[15px] py-2 bg-[#fafbfc] shrink-0 text-left"
      >
        <span className="text-[10px] font-bold text-gray-500">{vm.listHeaderLabel}</span>
        <span className="flex items-center gap-1 text-[10px] text-gray-400">
          {vm.listSortLabel}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="flex-1">
          {vm.listColumnHeaders && (
            <div className="flex items-center px-[15px] py-1 bg-white text-[9.5px] text-gray-400">
              <span className="flex-1">{vm.listColumnHeaders[0]}</span>
              {vm.listColumnHeaders.slice(1).map((h, i) => <span key={i} className="w-[26px] text-center">{h}</span>)}
            </div>
          )}
          {vm.rows.length === 0 ? (
            <p className="text-[11px] text-gray-200 text-center py-3">해당 없음</p>
          ) : vm.rows.map(r => (
            <div key={r.key} className="flex items-center px-[15px] py-[7px] border-b border-[#f8fafc] last:border-b-0 gap-1.5">
              <span className="text-[11px] font-bold text-gray-800 truncate">{r.name}</span>
              {r.tag && (
                <span className="text-[9.5px] font-semibold px-1 rounded shrink-0" style={{ background: r.tag.bg, color: r.tag.fg }}>{r.tag.text}</span>
              )}
              <span className="flex-1" />
              {r.cols ? (
                r.cols.map((v, i) => (
                  <span key={i} className="w-[26px] text-center text-[11px] font-extrabold tabular-nums" style={{ color: !v || v === '—' ? '#e2e8f0' : undefined }}>
                    {v || '—'}
                  </span>
                ))
              ) : (
                <span className={`text-[10.5px] font-bold tabular-nums shrink-0 ${r.valueRed ? 'text-red-600' : 'text-gray-600'}`}>{r.value}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-[15px] py-2 bg-[#fafbfc] border-t border-[#f1f5f9] shrink-0">
        <span className="text-[10px] text-gray-400">{vm.footerLabel}</span>
        <span className="text-[10.5px] font-extrabold text-gray-700">{vm.footerValue}</span>
      </div>
    </section>
  )
}
