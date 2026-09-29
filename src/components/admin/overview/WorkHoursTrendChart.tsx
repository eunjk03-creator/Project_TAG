'use client'
// 월간 뷰 전용 — 인당 근로시간 월별 추이. 누적/단월 두 모드.
// 막대 = 소정근로(회색) 위에 초과분(빨강)을 쌓는다. 막대 위 라벨: 빨강 "+초과", 회색 "총시간".
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts'
import type { MonthlyHoursPoint } from '@/utils/overviewAggregations'

export type HoursBasis = 'cumulative' | 'single'

export interface HoursStripItem { label: string; value: string; tone?: 'neg' | 'pos' | 'ink' }

export function WorkHoursTrendChart({
  year, mode, onModeChange, points, stripItems,
}: {
  year: number
  mode: HoursBasis
  onModeChange: (m: HoursBasis) => void
  points: MonthlyHoursPoint[]
  stripItems: HoursStripItem[]
}) {
  const cum = mode === 'cumulative'
  const data = points.map(p => {
    const sch = cum ? p.cumScheduledHours : p.scheduledHours
    const act = cum ? p.cumAvgHours : p.avgHours
    if (act === null) return { label: p.label, base: 0, over: 0, future: 4, overLabel: '', totalLabel: '' }
    const over = Math.max(0, act - sch)
    return {
      label: p.label,
      base: Math.min(act, sch),
      over,
      future: 0,
      overLabel: over > 0 ? `+${over.toFixed(1)}` : '',
      totalLabel: `${Math.round(act).toLocaleString()}h`,
    }
  })

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl px-4 pt-3.5 pb-3 flex flex-col">
      <div className="flex items-center gap-2 min-h-[34px] mb-2.5">
        <div>
          <p className="text-[12.5px] font-extrabold text-[var(--ink)]">
            {cum ? '인당 누적 근로시간' : '월별 인당 평균 근로시간'} · {year}년
          </p>
          <p className="text-[10px] text-[var(--ink-3)]">
            {cum
              ? '1월부터 쌓은 인당 근로시간 · 회색 = 누적 소정근로, 빨강 = 누적 초과분'
              : '그 달 인당 평균 · 회색 = 그 달 소정근로(근무일 × 8h), 빨강 = 초과분'}
          </p>
        </div>
        <span className="flex-1" />
        <Segmented value={mode} onChange={onModeChange} />
      </div>

      <div className="flex items-center gap-2.5 text-[9.5px] text-[var(--ink-3)] mb-2">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-[3px] bg-[var(--line)]" />{cum ? '누적 소정근로' : '소정근로'}</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-[3px] bg-[var(--neg)]" />초과분 (연장)</span>
      </div>

      <div className="h-[190px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 28, right: 4, left: -18, bottom: 0 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f2f4" />
            <XAxis dataKey="label" tick={{ fontSize: 9.5, fill: '#8b8d94' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 9, fill: '#b8bac0' }} width={38} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={(v: unknown, name: unknown) => [`${Number(v ?? 0).toFixed(1)}h`, name === 'base' ? '소정근로' : name === 'over' ? '초과분' : '']}
            />
            <Bar dataKey="future" stackId="h" fill="#f1f2f4" isAnimationActive={false} />
            <Bar dataKey="base" stackId="h" fill="#d4d4d8" isAnimationActive={false} />
            <Bar dataKey="over" stackId="h" fill="#e5342f" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="totalLabel" position="top" offset={4} style={{ fontSize: 9, fontWeight: 700, fill: '#71717a' }} />
              <LabelList dataKey="overLabel" position="top" offset={16} style={{ fontSize: 9.5, fontWeight: 800, fill: '#e5342f' }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 bg-[var(--canvas)] rounded-[9px] px-[11px] py-2 flex gap-3.5 flex-wrap text-[10.5px]">
        {stripItems.map(s => (
          <span key={s.label} className="text-[var(--ink-3)]">
            {s.label}{' '}
            <b className={`font-extrabold ${s.tone === 'neg' ? 'text-[var(--neg)]' : s.tone === 'pos' ? 'text-[var(--pos)]' : 'text-[var(--ink)]'}`}>{s.value}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

function Segmented({ value, onChange }: { value: HoursBasis; onChange: (v: HoursBasis) => void }) {
  return (
    <div className="flex border border-[var(--line)] rounded-[7px] overflow-hidden">
      {(['cumulative', 'single'] as const).map(v => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-[11px] py-1 text-[10.5px] transition-colors ${value === v ? 'bg-[var(--ink)] text-white font-bold' : 'text-[var(--ink-3)] font-semibold'}`}
        >
          {v === 'cumulative' ? '누적' : '단월'}
        </button>
      ))}
    </div>
  )
}
