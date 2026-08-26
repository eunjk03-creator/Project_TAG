'use client'
import {
  ComposedChart, Line, Bar, Cell, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { MONTHLY_ALLOCATION } from '@/utils/overviewAggregations'

export interface MonthlyLeavePoint {
  month: number
  label: string
  /** 그 달까지의 누적 사용률(%) — 아직 도래하지 않은 달은 null */
  cumulativePct: number | null
  /** 그 달에 새로 쓴 사용률(%) — 아직 도래하지 않은 달은 null */
  singlePct: number | null
  /** 누적 모드의 그 달 목표(%) — 미도래 달도 항상 존재(연간 벤치마크) */
  benchmarkPct: number
}

export interface LeaveTrendLegendRow { label: string; value: string }

/** 월 단위 전용 — 누적(라인+목표벤치마크) / 단월(막대+배분기준선) 두 모드.
 *  v9 핸드오프 스펙의 정보구조(레전드 4행 + 반대기준 스트립)는 유지하되, 칩 라벨 등
 *  픽셀 단위 오버레이는 recharts 기본 컴포넌트로 근사했다(툴팁으로 정확한 값 확인 가능). */
export function LeaveTrendChart({
  mode, onModeChange, points, legend, footnote, stripTitle, stripItems,
}: {
  mode: 'cumulative' | 'single'
  onModeChange: (m: 'cumulative' | 'single') => void
  points: MonthlyLeavePoint[]
  legend: LeaveTrendLegendRow[]
  footnote: string
  stripTitle: string
  stripItems: LeaveTrendLegendRow[]
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-[13px] px-5 py-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <p className="text-[12.5px] font-bold text-gray-800">
            {mode === 'cumulative' ? '연차 누적 사용률 추이 · 2026년' : '월별로 새로 쓴 연차 · 2026년'}
          </p>
          <p className="text-[10.5px] text-gray-400">
            {mode === 'cumulative' ? '실적(빨강) 대비 누적 목표 벤치마크(점선) · 미도래월은 회색' : '막대 = 그 달에 쓴 연차 비율 · 점선 = 월 배분 목표'}
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => onModeChange('cumulative')}
            className={`px-3.5 py-1 text-[11px] font-medium rounded-md transition-colors ${mode === 'cumulative' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
          >
            누적 기준
          </button>
          <button
            onClick={() => onModeChange('single')}
            className={`px-3.5 py-1 text-[11px] font-medium rounded-md transition-colors ${mode === 'single' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
          >
            단월 기준
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_268px] gap-5 mt-3 items-start">
        <div className="h-[208px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 9.5, fill: '#cbd5e1' }} tickFormatter={v => `${v}%`} width={34} />
              <Tooltip formatter={(v: unknown, name: unknown) => [`${Number(v ?? 0).toFixed(1)}%`, String(name ?? '')]} />
              {mode === 'cumulative' ? (
                <>
                  <Line dataKey="benchmarkPct" name="누적 목표" stroke="#0f172a" strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
                  <Line dataKey="cumulativePct" name="누적 실적" stroke="#dc2626" strokeWidth={2.5} dot={{ r: 3.5, fill: '#dc2626' }} connectNulls={false} />
                </>
              ) : (
                <>
                  <ReferenceLine y={MONTHLY_ALLOCATION} stroke="#0f172a" strokeDasharray="6 4" strokeWidth={2}
                    label={{ value: `월 배분 목표 ${MONTHLY_ALLOCATION.toFixed(1)}%`, position: 'insideTopRight', fontSize: 10, fill: '#0f172a' }} />
                  <Bar dataKey="singlePct" name="단월 사용률" radius={[5, 5, 0, 0]}>
                    {points.map((p, i) => (
                      <Cell key={i} fill={p.singlePct === null ? '#f1f5f9' : p.singlePct >= MONTHLY_ALLOCATION ? '#f59e0b' : '#dc2626'} />
                    ))}
                  </Bar>
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="space-y-0">
          {legend.map(row => (
            <div key={row.label} className="flex items-center justify-between py-1.5 border-b border-[#f6f8fa] last:border-b-0">
              <span className="text-[11px] text-gray-500">{row.label}</span>
              <span className="text-[14px] font-extrabold text-gray-900 tabular-nums">{row.value}</span>
            </div>
          ))}
          <p className="text-[10.5px] text-gray-400 mt-2 leading-relaxed">{footnote}</p>
        </div>
      </div>

      <div className="flex items-center gap-[18px] flex-wrap bg-[#f8fafc] rounded-[11px] px-3.5 py-[11px] mt-2">
        <span className="text-[11px] font-extrabold text-gray-700 shrink-0">{stripTitle}</span>
        {stripItems.map(it => (
          <span key={it.label} className="text-[10.5px] text-gray-400 whitespace-nowrap">
            {it.label} <span className="text-[12.5px] font-extrabold text-gray-800 ml-0.5">{it.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
