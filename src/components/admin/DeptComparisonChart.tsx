'use client'
import type { DivisionMetrics } from '@/hooks/useManagementMetrics'

function fmtH(h: number): string {
  if (h <= 0) return '—'
  const m  = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

type MetricCfg = {
  label:    string
  val:      (m: DivisionMetrics) => number
  fmt:      (v: number) => string
  barCls:   string
  badgeCls: string
}

const METRICS: MetricCfg[] = [
  {
    label:    '1인 평균 근로',
    val:      m => m.headcount > 0 ? m.totalHours / m.headcount : 0,
    fmt:      fmtH,
    barCls:   'bg-blue-500',
    badgeCls: 'bg-blue-50 text-blue-700',
  },
  {
    label:    '1인 평균 연장',
    val:      m => m.avgOtPerPerson,
    fmt:      fmtH,
    barCls:   'bg-amber-500',
    badgeCls: 'bg-amber-50 text-amber-700',
  },
  {
    label:    '이상치',
    val:      m => m.anomalies,
    fmt:      v => v > 0 ? `${v}건` : '없음',
    barCls:   'bg-red-400',
    badgeCls: 'bg-red-50 text-red-700',
  },
  {
    label:    '가동률',
    val:      m => m.workloadIntensity,
    fmt:      v => `${v.toFixed(1)}%`,
    barCls:   'bg-emerald-500',
    badgeCls: 'bg-emerald-50 text-emerald-700',
  },
]

const BU_PALETTE = [
  { barCls: 'bg-blue-500',    dotCls: 'bg-blue-500',    txtCls: 'text-blue-700'    },
  { barCls: 'bg-violet-500',  dotCls: 'bg-violet-500',  txtCls: 'text-violet-700'  },
  { barCls: 'bg-emerald-500', dotCls: 'bg-emerald-500', txtCls: 'text-emerald-700' },
  { barCls: 'bg-orange-400',  dotCls: 'bg-orange-400',  txtCls: 'text-orange-700'  },
  { barCls: 'bg-pink-500',    dotCls: 'bg-pink-500',    txtCls: 'text-pink-700'    },
]

type Props = {
  metrics:     DivisionMetrics[]
  selectedBUs: string[]
  expanded:    boolean
  onToggle:    () => void
  onClose:     () => void
}

export function DeptComparisonChart({ metrics, selectedBUs, expanded, onToggle, onClose }: Props) {
  const rows = metrics.filter(m => selectedBUs.includes(m.division))
  if (rows.length < 2) return null

  return (
    <div className="fixed bottom-0 left-52 right-0 z-[100] bg-white border-t border-gray-200 shadow-[0_-4px_24px_rgba(0,0,0,0.10)]">

      {/* ── Header (always visible) ── */}
      <div className="px-5 h-11 flex items-center gap-3">

        {/* Collapse / expand toggle */}
        <button
          onClick={onToggle}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title={expanded ? '최소화' : '펼치기'}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? '' : 'rotate-180'}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <span className="text-xs font-bold text-gray-700 shrink-0">부서 비교</span>

        {/* BU chips */}
        <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
          {rows.map((m, i) => {
            const p = BU_PALETTE[i % BU_PALETTE.length]
            return (
              <span key={m.division} className="flex items-center gap-1 text-[11px] font-semibold text-gray-600">
                <span className={`w-2 h-2 rounded-sm shrink-0 ${p.dotCls}`} />
                {m.division}
              </span>
            )
          })}
        </div>

        {!expanded && (
          <span className="text-[10px] text-gray-400 shrink-0">펼쳐서 분석 보기</span>
        )}

        <button
          onClick={onClose}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors text-sm"
          title="비교 닫기"
        >
          ✕
        </button>
      </div>

      {/* ── Chart body (collapsible) ── */}
      <div className={`grid transition-all duration-300 ease-in-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-5 pb-4 border-t border-gray-100">
            <div className="grid grid-cols-4 gap-5 pt-3">
              {METRICS.map(cfg => {
                const values = rows.map(m => cfg.val(m))
                const maxVal = Math.max(...values, 0.001)

                return (
                  <div key={cfg.label}>
                    <p className="text-[11px] font-semibold text-gray-500 mb-2">{cfg.label}</p>
                    <div className="flex items-end gap-2 h-[72px]">
                      {rows.map((m, bi) => {
                        const raw = cfg.val(m)
                        const pct = (raw / maxVal) * 100
                        const p   = BU_PALETTE[bi % BU_PALETTE.length]
                        return (
                          <div key={m.division} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                            <span className={`text-[10px] font-bold tabular-nums px-1 py-0.5 rounded whitespace-nowrap ${cfg.badgeCls}`}>
                              {cfg.fmt(raw)}
                            </span>
                            <div className="w-full flex items-end" style={{ height: 36 }}>
                              <div
                                className={`w-full rounded-t transition-all duration-500 ${p.barCls}`}
                                style={{ height: raw > 0 ? `${Math.max(pct, 8)}%` : '0%' }}
                              />
                            </div>
                            <span className={`text-[9px] font-semibold truncate w-full text-center leading-tight ${p.txtCls}`}>
                              {m.division.replace(/본부$/, '')}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
