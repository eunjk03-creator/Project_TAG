'use client'

/** 요약 타일 한 칸 — 클릭하면 해당 상세 아코디언이 펼쳐지며 스크롤된다. */
export function KpiTile({
  label, value, unit, color, sub, onClick, wide,
}: {
  label: string; value: string | number; unit?: string; color: string; sub?: string
  onClick: () => void; wide?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left bg-white border border-gray-100 rounded-xl px-4 py-3.5 shadow-sm hover:shadow
        hover:-translate-y-px transition-all ${wide ? 'col-span-2' : ''}`}
    >
      <p className="text-xs font-semibold text-gray-400 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        {label}
      </p>
      <p className="text-3xl font-extrabold tabular-nums mt-1 leading-tight" style={{ color }}>
        {value}{unit && <span className="text-sm font-semibold text-gray-300 ml-1">{unit}</span>}
      </p>
      {sub && <p className="text-[11px] text-gray-400 mt-1 truncate">{sub}</p>}
    </button>
  )
}
