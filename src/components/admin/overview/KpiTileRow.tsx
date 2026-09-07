'use client'

export interface KpiSubRow {
  key: string
  value: string
  /** 메인(다크) 타일에서만 쓰는 색 톤 — 부정(빨강)/긍정(초록)/중립(회색) */
  tone?: 'neutral' | 'negative' | 'positive'
}

export interface KpiBreakdownItem {
  label: string
  value: string
  color: string
}

export interface KpiTileVM {
  key: string
  label: string
  isMain?: boolean
  value: string
  unit?: string
  /** 점선 키·값 목록(일반 타일) — 메인 타일에도 쓰이되 톤 색상이 적용된다 */
  subRows?: KpiSubRow[]
  footnote?: string
  /** 3열 분해 그리드(일간 "긴급 이상치" 전용) — 지정하면 subRows 대신 이걸 그린다 */
  breakdown3?: KpiBreakdownItem[]
  onClick?: () => void
}

// v3 디자인 토큰(admin-v3.css)으로 재스킨 — 카드 구조(다크 메인 타일/breakdown3/dotted
// subRows)는 .kc보다 정보 밀도가 높아서 그대로 두고, 색상만 --dark/--ink/--pos/--neg/--cau
// 토큰으로 교체.
const TONE_DARK: Record<NonNullable<KpiSubRow['tone']>, string> = {
  neutral: 'var(--ink-4)', negative: 'var(--neg)', positive: 'var(--pos)',
}

function Tile({ vm }: { vm: KpiTileVM }) {
  const dark = !!vm.isMain
  return (
    <button
      onClick={vm.onClick}
      disabled={!vm.onClick}
      className={`text-left rounded-xl border px-[18px] pt-[15px] pb-4 flex flex-col gap-[9px] transition-colors ${
        dark ? 'bg-[var(--dark)] border-[var(--dark)]' : 'bg-white border-[var(--line)] hover:border-[var(--ink-4)]'
      } ${vm.onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <p className={`text-[11px] font-bold flex items-center gap-1.5 ${dark ? 'text-[var(--ink-3)]' : 'text-[var(--ink-3)]'}`}>
        {vm.label}
        {dark && (
          <span className="text-[8.5px] font-extrabold px-1.5 py-px rounded tracking-wide bg-[var(--cau)] text-white">
            메인 데이터
          </span>
        )}
      </p>
      <p className={`text-[30px] font-extrabold tabular-nums leading-none ${dark ? 'text-white' : 'text-[var(--ink)]'}`}>
        {vm.value}{vm.unit && <span className="text-[13px] font-semibold text-[var(--ink-3)] ml-1">{vm.unit}</span>}
      </p>

      {vm.breakdown3 ? (
        <div className="grid grid-cols-3 gap-px bg-[var(--line)] rounded-[10px] overflow-hidden mt-0.5">
          {vm.breakdown3.map(b => (
            <div key={b.label} className="bg-white py-[9px] text-center">
              <p className="text-[10px] text-[var(--ink-3)]">{b.label}</p>
              <p className="text-[20px] font-extrabold tabular-nums" style={{ color: b.color }}>{b.value}</p>
            </div>
          ))}
        </div>
      ) : vm.subRows && vm.subRows.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-[18px] gap-y-1">
          {vm.subRows.map(row => (
            <div key={row.key} className="flex items-center gap-1 min-w-0">
              <span className={`text-[11px] whitespace-nowrap ${dark ? 'text-[var(--ink-3)]' : 'text-[var(--ink-3)]'}`}>{row.key}</span>
              <span className={`flex-1 border-b border-dotted ${dark ? 'border-[var(--ink-2)]' : 'border-[var(--line)]'} translate-y-[-2px]`} />
              <span
                className="text-[11px] font-extrabold whitespace-nowrap"
                style={{ color: dark ? TONE_DARK[row.tone ?? 'neutral'] : 'var(--ink)' }}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {vm.footnote && <p className={`text-[10.5px] ${dark ? 'text-[var(--ink-4)]' : 'text-[var(--ink-3)]'}`}>{vm.footnote}</p>}
    </button>
  )
}

/** 고정 3열 KPI — 일/주/월 어느 탭이든 이 틀은 그대로, 안의 값만 바뀐다(v9 핵심 규칙). */
export function KpiTileRow({ tiles }: { tiles: KpiTileVM[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {tiles.map(t => <Tile key={t.key} vm={t} />)}
    </div>
  )
}
