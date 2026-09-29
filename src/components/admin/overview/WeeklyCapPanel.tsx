'use client'
// 월간 뷰 전용 — 근로시간 2칸 + 52h 필터 2칸 + 사원별 주 인정근로시간 표.
import { useState } from 'react'
import { WEEKLY_CAP_HOURS, type WeeklyCapRow, type MonthWeek } from '@/utils/overviewAggregations'

const fmtHM = (h: number) => {
  const m = Math.round((h % 1) * 60)
  return `${Math.floor(h)}h${m ? String(m).padStart(2, '0') : ''}`
}

function weekCell(h: number | null) {
  if (h === null) return { bg: 'var(--line-2)', fg: 'var(--ink-4)', text: '—', bold: false }
  if (h > WEEKLY_CAP_HOURS) return { bg: 'var(--neg)', fg: '#ffffff', text: fmtHM(h), bold: true }
  if (h >= 48) return { bg: 'var(--cau-bg)', fg: 'var(--cau)', text: fmtHM(h), bold: false }
  return { bg: 'var(--line-2)', fg: 'var(--ink-3)', text: fmtHM(h), bold: false }
}

type Filter = 'run' | 'avg'

export function WeeklyCapPanel({
  monthLabel, weeks, rows, avgOverCount, runOverCount,
  monthAvgHours, scheduledHours, weeklyAvgHours,
}: {
  monthLabel: string            // "8월"
  weeks: MonthWeek[]
  rows: WeeklyCapRow[]          // buildWeeklyCapRows().rows
  avgOverCount: number
  runOverCount: number
  monthAvgHours: number         // 그 달 인당 평균 인정근로
  scheduledHours: number        // 그 달 소정근로
  weeklyAvgHours: number        // 인당 주 평균 인정근로
}) {
  const [filter, setFilter] = useState<Filter>('run')
  const visible = rows.filter(r => (filter === 'avg' ? r.isAvgOver : r.isRunOver))
  const monthDiff = monthAvgHours - scheduledHours
  const cols = `minmax(0,1fr) repeat(${weeks.length},56px) 64px 76px`

  const filters: { id: Filter; label: string; count: number; hint: string }[] = [
    { id: 'avg', label: `${weeks.length}주 평균 52h 초과`, count: avgOverCount, hint: `${weeks.length}주 평균이 52h를 넘은 사람` },
    { id: 'run', label: '2주 이상 연속 초과', count: runOverCount, hint: '평균에 가려지는 사람 포함' },
  ]

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl px-4 pt-3.5 pb-3">
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        <div>
          <p className="text-[12.5px] font-extrabold text-[var(--ink)]">주 52시간 초과자 · {monthLabel} {weeks.length}주</p>
          <p className="text-[10px] text-[var(--ink-3)]">인정근무시간 기준 · 주는 일~토 · 칸 = 그 주 인정근무시간</p>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-2.5 text-[9.5px] text-[var(--ink-3)]">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-[3px] bg-[var(--neg)]" />52h 초과</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-[3px] bg-[var(--cau-bg)]" />48–52h</span>
        </div>
      </div>

      <div className="grid gap-1.5 mb-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
        <div className="bg-[var(--canvas)] rounded-[9px] px-2.5 py-[7px] flex flex-col gap-0.5">
          <span className="text-[9.5px] font-bold text-[var(--ink-3)]">{monthLabel} 평균 근로시간</span>
          <span className="text-[17px] font-extrabold text-[var(--ink)] tabular-nums">
            {monthAvgHours.toFixed(1)}<span className="text-[10.5px] font-semibold text-[var(--ink-3)]"> 시간</span>
          </span>
          <span className="text-[9.5px] text-[var(--ink-3)]">
            기준 {scheduledHours}시간 대비{' '}
            <b className={`font-extrabold ${monthDiff >= 0 ? 'text-[var(--neg)]' : 'text-[var(--pos)]'}`}>
              {Math.abs(monthDiff).toFixed(1)}시간 {monthDiff >= 0 ? '초과' : '미달'}
            </b>
          </span>
        </div>
        <div className="bg-[var(--canvas)] rounded-[9px] px-2.5 py-[7px] flex flex-col gap-0.5">
          <span className="text-[9.5px] font-bold text-[var(--ink-3)]">인당 주 평균 근로시간</span>
          <span className="text-[17px] font-extrabold text-[var(--ink)] tabular-nums">
            {weeklyAvgHours.toFixed(1)}<span className="text-[10.5px] font-semibold text-[var(--ink-3)]"> 시간</span>
          </span>
          <span className="text-[9.5px] text-[var(--ink-3)]">
            1인당 <b className="font-extrabold text-[var(--ink)]">{Math.max(0, weeklyAvgHours - 40).toFixed(1)}시간</b> 연장근로
          </span>
        </div>
        {filters.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`text-left rounded-[9px] px-2.5 py-[7px] flex flex-col gap-0.5 border-[1.5px] bg-white transition-colors ${filter === f.id ? 'border-[var(--ink)]' : 'border-[var(--line)] hover:border-[var(--ink-4)]'}`}
          >
            <span className="text-[9.5px] font-bold text-[var(--ink-3)]">{f.label}</span>
            <span className="text-[17px] font-extrabold text-[var(--neg)] tabular-nums">
              {f.count}<span className="text-[10.5px] font-semibold text-[var(--ink-3)]"> 명</span>
            </span>
            <span className={`text-[9.5px] ${filter === f.id ? 'text-[var(--ink)]' : 'text-[var(--ink-3)]'}`}>{f.hint}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-[5px] items-center px-0.5 pb-[5px] text-[9px] text-[var(--ink-3)] border-b border-[var(--line-2)]" style={{ gridTemplateColumns: cols }}>
        <span>{filters.find(f => f.id === filter)!.label} · {visible.length}명</span>
        {weeks.map(w => <span key={w.from} className="text-center">{w.label}</span>)}
        <span className="text-right">{weeks.length}주 평균</span>
        <span />
      </div>

      {visible.length === 0 ? (
        <p className="text-[11px] text-[var(--ink-3)] text-center py-5">해당하는 사람이 없습니다.</p>
      ) : visible.map(r => (
        <div key={r.employeeId} className="grid gap-[5px] items-center px-0.5 py-[3px]" style={{ gridTemplateColumns: cols }}>
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[11px] font-bold text-[var(--ink)]">{r.name}</span>
            <span className="text-[9.5px] text-[var(--ink-3)] truncate">{r.division}</span>
          </div>
          {r.weekHours.map((h, i) => {
            const c = weekCell(h)
            return (
              <span key={i} className={`h-[22px] rounded-[5px] flex items-center justify-center text-[10px] tabular-nums ${c.bold ? 'font-extrabold' : 'font-semibold'}`}
                style={{ background: c.bg, color: c.fg }}>
                {c.text}
              </span>
            )
          })}
          <span className={`text-right text-[11px] font-extrabold tabular-nums ${r.isAvgOver ? 'text-[var(--neg)]' : 'text-[var(--ink)]'}`}>{fmtHM(r.avgHours)}</span>
          <span className="flex justify-end">
            <span className="inline-flex items-center text-[9.5px] font-extrabold text-[var(--neg)] border-[1.5px] border-[var(--neg)] rounded-[5px] px-[5px] py-px bg-white">
              {r.isAvgOver ? '평균 초과' : `연속 ${r.maxRun}주`}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}
