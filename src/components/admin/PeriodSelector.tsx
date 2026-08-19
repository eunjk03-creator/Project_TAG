'use client'
import type { PeriodGranularity, PeriodRange } from '@/hooks/usePeriodRange'

const GRANULARITIES: PeriodGranularity[] = ['day', 'week', 'month']

/** 종합현황/조직도 공용 기간 선택기 — 일/주/월 pill + ◀▶ 이동 + 오늘. */
export function PeriodSelector({ period }: { period: PeriodRange }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex bg-gray-100 rounded-lg p-0.5">
        {GRANULARITIES.map(g => (
          <button
            key={g}
            onClick={() => period.setGranularity(g)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              period.granularity === g ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {g === 'day' ? '일' : g === 'week' ? '주' : '월'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-1">
        <button onClick={() => period.shift(-1)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-50">
          ‹
        </button>
        <span className="text-xs font-medium text-gray-700 px-1.5 min-w-[120px] text-center tabular-nums">{period.label}</span>
        <button onClick={() => period.shift(1)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-50">
          ›
        </button>
      </div>
      <button
        onClick={period.goToday}
        className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
      >
        오늘
      </button>
    </div>
  )
}
