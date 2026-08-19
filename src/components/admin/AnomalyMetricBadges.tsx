/** 종합현황/조직도 공용 — 지각·근무시간미달·미태깅 3종 이상치 뱃지.
 *  색상은 두 화면이 원래부터 맞춰뒀던 규칙 그대로(지각=amber, 미달·미태깅=red). */
export interface DivisionAnomalyMetrics {
  late:     number
  shortage: number
  notag:    number
  leave:    number
}

export function emptyDivisionAnomalyMetrics(): DivisionAnomalyMetrics {
  return { late: 0, shortage: 0, notag: 0, leave: 0 }
}

export function AnomalyMetricBadges({
  m, size = 'sm', unit = '건', shortageLabel = '근무시간 미달',
}: {
  m: DivisionAnomalyMetrics
  size?: 'sm' | 'lg'
  /** lg일 때 값 옆에 붙는 단위 — 조직도(건) / 종합현황 일간뷰(명)처럼 맥락에 따라 다르다. */
  unit?: string
  /** 좁은 카드(조직도)는 "미달", 넓은 카드(종합현황)는 "근무시간 미달"로 쓴다. */
  shortageLabel?: string
}) {
  const items = [
    { label: '지각', value: m.late, color: size === 'lg' ? '#b4650a' : 'text-amber-600' },
    { label: shortageLabel, value: m.shortage, color: size === 'lg' ? '#c4291f' : 'text-red-600' },
    { label: '미태깅', value: m.notag, color: size === 'lg' ? '#c4291f' : 'text-red-600' },
  ]
  if (size === 'lg') {
    return (
      <div className="grid grid-cols-3 divide-x divide-gray-100">
        {items.map(it => (
          <div key={it.label} className="px-3 first:pl-0">
            <p className="text-xs text-gray-400 font-medium mb-0.5">{it.label}</p>
            <p className="text-2xl font-extrabold tabular-nums leading-tight" style={{ color: it.color as string }}>
              {it.value}<span className="text-xs font-semibold text-gray-300 ml-0.5">{unit}</span>
            </p>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5">
      {items.map(it => (
        <span key={it.label} className={`text-[10px] font-semibold whitespace-nowrap ${it.color as string}`}>
          {it.label} {it.value}
        </span>
      ))}
    </div>
  )
}
