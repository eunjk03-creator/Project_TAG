'use client'

/** 전사 요약 히어로 카드(좌 300px, 다크) — 디자인 핸드오프 turn 7a/7b/7c 기준.
 *  일=전사 정상출근율, 주·월=전사 초과근무 합계. 하단에 구분선 + 기간별 이상치 합계. */
export function HeroCard({
  label, value, unit, sub, footerLabel, footerValue, onFooterClick,
}: {
  label: string; value: string; unit?: string; sub: string
  footerLabel: string; footerValue: number; onFooterClick: () => void
}) {
  return (
    <div className="bg-[#0f172a] rounded-xl px-4 py-4 text-white flex flex-col justify-center w-full sm:w-[300px] shrink-0">
      <p className="text-[11px] font-semibold text-[#64748b]">{label}</p>
      <p className="text-[36px] font-extrabold tabular-nums leading-none mt-1">
        {value}{unit && <span className="text-[15px] font-semibold text-[#64748b] ml-1.5">{unit}</span>}
      </p>
      <p className="text-[11px] text-[#94a3b8] mt-2">{sub}</p>
      <div className="h-px bg-[#1e293b] my-3" />
      <button onClick={onFooterClick} className="flex items-center justify-between text-left hover:opacity-80 transition-opacity">
        <span className="text-[11px] text-[#64748b]">{footerLabel}</span>
        <span className="text-xl font-extrabold tabular-nums">{footerValue}<span className="text-[11px] text-[#64748b] font-semibold ml-1">건</span></span>
      </button>
    </div>
  )
}

const RANK_COLORS = ['#dc2626', '#ef4444', '#f59e0b', '#fbbf24', '#fcd34d']
const OTHER_COLOR = '#e2e8f0'

export interface DistributionRow { label: string; value: number }

/** 부서 분산 패널(우, 가변) — 전사 총 건수가 어느 부서로 흩어지는지, 카드 그리드와
 *  같은 소스(divAnomaly, 이미 총계 내림차순)에서 상위 5개 + "그 외 N개"로 계산한다. */
export function DistributionPanel({ rows }: { rows: DistributionRow[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0)
  const top5 = rows.slice(0, 5)
  const restRows = rows.slice(5)
  const restCount = restRows.length
  const restTotal = restRows.reduce((s, r) => s + r.value, 0)

  const bars = [
    ...top5.map((r, i) => ({ label: r.label, value: r.value, color: RANK_COLORS[i] })),
    ...(restCount > 0 ? [{ label: `그 외 ${restCount}개`, value: restTotal, color: OTHER_COLOR }] : []),
  ]
  const maxValue = Math.max(1, ...bars.map(b => b.value))

  return (
    <div className="bg-white border border-gray-100 rounded-xl px-4 py-3.5 flex-1 min-w-0">
      <p className="text-xs font-bold text-gray-800">
        전사 {total}건이 부서로 흩어지는 모양
        <span className="text-[10.5px] font-normal text-gray-300 ml-1.5">상위 5개 부문 + 나머지</span>
      </p>
      {total === 0 ? (
        <p className="text-[11px] text-gray-300 text-center py-5">이 기간에 감지된 이상치가 없습니다.</p>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {bars.map(b => (
            <div key={b.label} className="flex items-center gap-2">
              <span className="text-[11.5px] font-bold text-gray-700 w-[104px] truncate shrink-0">{b.label}</span>
              <div className="flex-1 h-[15px] rounded bg-[#f6f8fa] overflow-hidden">
                <div className="h-full rounded" style={{ width: `${(b.value / maxValue) * 100}%`, background: b.color }} />
              </div>
              <span className="text-xs font-extrabold text-gray-800 w-[38px] text-right tabular-nums shrink-0">{b.value}</span>
              <span className="text-[10.5px] text-gray-300 w-[34px] text-right tabular-nums shrink-0">
                {total > 0 ? Math.round((b.value / total) * 100) : 0}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
