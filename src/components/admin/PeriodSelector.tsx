'use client'
import type { PeriodGranularity, PeriodRange } from '@/hooks/usePeriodRange'

const GRANULARITIES: PeriodGranularity[] = ['day', 'week', 'month']

/** 종합현황/조직도 공용 기간 선택기 — 일/주/월 pill + ◀▶ 이동 + 오늘. */
export function PeriodSelector({ period }: { period: PeriodRange }) {
  return (
    <div className="flex items-center gap-2">
      {/* v3 .pillseg 톤으로 재스킨(admin-v3.css) — 조직도 페이지와 공용 컴포넌트라 여기 색만
          바뀌면 그쪽도 자연히 같이 반영됨(이번 라운드에서 조직도 페이지 자체는 안 건드림). */}
      <div className="flex border border-[var(--line)] rounded-lg overflow-hidden">
        {GRANULARITIES.map(g => (
          <button
            key={g}
            onClick={() => period.setGranularity(g)}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
              period.granularity === g ? 'bg-[var(--line-2)] text-[var(--ink)]' : 'text-[var(--ink-3)] hover:text-[var(--ink-2)]'
            }`}
          >
            {g === 'day' ? '일' : g === 'week' ? '주' : '월'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 bg-white border border-[var(--line)] rounded-lg px-1">
        <button onClick={() => period.shift(-1)} className="w-7 h-7 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--ink)] rounded-md hover:bg-[var(--line-2)]">
          ‹
        </button>
        <span className="text-xs font-medium text-[var(--ink-2)] px-1.5 min-w-[120px] text-center tabular-nums">{period.label}</span>
        <button onClick={() => period.shift(1)} className="w-7 h-7 flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--ink)] rounded-md hover:bg-[var(--line-2)]">
          ›
        </button>
      </div>
      <button
        onClick={period.goToday}
        className="px-3 py-1.5 text-xs font-semibold text-[var(--ink-2)] border border-[var(--line)] rounded-lg hover:bg-[var(--line-2)] transition-colors"
      >
        오늘
      </button>
    </div>
  )
}
