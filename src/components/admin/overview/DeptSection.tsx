'use client'
import { DeptCard, type DeptCardVM } from './DeptCard'

export interface DeptSectionSummaryItem { label: string; value: string }

/** 사업부/지원부 구획 하나 — 좌측 accent 바 + 구획명 + {n}개·{m}명, 우측 기간별 요약 3항목. */
export function DeptSection({
  label, accent, cards, summary,
}: {
  label: string
  accent: string
  cards: DeptCardVM[]
  summary: DeptSectionSummaryItem[]
}) {
  const headcount = cards.reduce((s, c) => s + c.headcount, 0)
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="w-1 h-[15px] rounded-full shrink-0" style={{ background: accent }} />
          <span className="text-[13px] font-extrabold text-gray-900">{label}</span>
          <span className="text-[11px] text-gray-400">{cards.length}개 · {headcount}명</span>
        </div>
        <div className="flex items-center gap-4">
          {summary.map(s => (
            <span key={s.label} className="text-[11px] text-gray-500">
              {s.label} <span className="font-extrabold text-gray-900 ml-1">{s.value}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-[11px] items-stretch">
        {cards.map(c => <DeptCard key={c.division} vm={c} />)}
      </div>
    </div>
  )
}
