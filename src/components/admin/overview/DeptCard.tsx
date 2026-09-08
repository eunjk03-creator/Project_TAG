'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'

export type DeptCardSeverity = 'normal' | 'warning' | 'action' | 'nodata'

export interface DeptCardCell {
  label: string
  value: string
  color?: string
}

export interface DeptCardPersonRow {
  key: string
  name: string
  /** 여러 날짜가 합쳐진 뷰(복수 기간 선택)에서 "이 줄이 몇 일자 건인지" 표시 — 단일 기간
   *  선택 시엔 안 씀(그 하루뿐이라 표시할 필요 없음, 2026-09-08 추가) */
  date?: string
  /** 밴드 칩(주간 위험군) · 날짜 칩(휴일근로) · 입사연도 칩(연차) 등 */
  tag?: { text: string; bg: string; fg: string }
  /** 일간 전용 3열 숫자(지각/미달/미태) */
  cols?: (string | number)[]
  /** 그 외 상태의 단일 값 컬럼 (예: "51h 20m · 62만원", "7/20일 · 35%") */
  value?: string
  valueRed?: boolean
}

/** 부문 카드 1장의 콘텐츠 전체 — 심각도/기준값 계산은 overview 페이지가 하고, 이 컴포넌트는
 *  v9 디자인 핸드오프의 6층 구조(accent바/헤드+진행바/분해칸/목록헤더/목록/푸터)만 그린다. */
export interface DeptCardVM {
  division: string
  headcount: number
  severity: DeptCardSeverity
  mainValue: string
  mainUnit?: string
  progressPct: number
  progressMarkerPct?: number
  /** true면 진행바+마커를 안 그림(일 뷰: 이상치 총건수만 보여줄 때 %진행바가 의미 없음) */
  hideProgress?: boolean
  captionLeft: string
  captionRight: string
  cells: DeptCardCell[]
  listHeaderLabel: string
  listSortLabel: string
  listColumnHeaders?: string[]
  rows: DeptCardPersonRow[]
  footerLabel: string
  footerValue: string
}

// v3 디자인 토큰 매핑 — normal=pos, warning=cau, action=neg (README "색은 의미에 고정" 규칙)
// nodata(회색)는 "이상 없음"과 별개 상태 — 해당 기간에 원본 데이터 자체가 없어서 판정이
// 불가능한 경우(예: 아직 업로드 안 된 오늘)에 쓴다. 이걸 action(빨강)으로 두면 실제로는
// 아무 문제 없는데 "전원 결근"처럼 보이는 오탐이 생긴다(2026-09-07 발견).
const BAND: Record<DeptCardSeverity, string> = { normal: '#eaebec', warning: '#d17600', action: '#e5342f', nodata: '#eaebec' }
const MAIN_COLOR: Record<DeptCardSeverity, string> = { normal: '#00b13c', warning: '#d17600', action: '#e5342f', nodata: '#b8bac0' }
const BADGE: Record<DeptCardSeverity, { bg: string; fg: string; label: string }> = {
  normal:  { bg: '#f1f2f4', fg: '#8b8d94', label: '정상' },
  warning: { bg: '#fff4e5', fg: '#d17600', label: '주의' },
  action:  { bg: '#ffeded', fg: '#e5342f', label: '조치 필요' },
  nodata:  { bg: '#f1f2f4', fg: '#b8bac0', label: '데이터 없음' },
}

export function DeptCard({ vm, note, onSaveNote }: {
  vm: DeptCardVM
  /** 이번에 보고 있는 기간(day/week)에 저장된 이 부서의 인사이트 메모 */
  note?: string
  onSaveNote?: (text: string) => Promise<void>
}) {
  const [open, setOpen] = useState(true)
  const [noteDraft, setNoteDraft] = useState(note ?? '')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteSaved, setNoteSaved] = useState(false)
  const badge = BADGE[vm.severity]

  // DeptCard 인스턴스는 division 기준으로 재사용되고 기간(period)만 바뀔 수 있어서, note prop이
  // 바뀌면(다른 주/날짜로 이동) 편집 중이던 draft도 그 기간 값으로 다시 맞춰준다.
  useEffect(() => { setNoteDraft(note ?? '') }, [note])

  async function handleSaveNote() {
    if (!onSaveNote) return
    setNoteSaving(true)
    try {
      await onSaveNote(noteDraft)
      setNoteSaved(true)
      setTimeout(() => setNoteSaved(false), 1500)
    } finally {
      setNoteSaving(false)
    }
  }

  return (
    <section className="bg-white border border-[var(--line)] rounded-[13px] overflow-hidden flex flex-col min-h-[400px] hover:border-[var(--ink-4)] transition-colors">
      <div className="h-[3px] shrink-0" style={{ background: BAND[vm.severity] }} />

      <div className="px-[15px] pt-[13px] pb-3 shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-extrabold text-[var(--ink)] truncate">{vm.division}</span>
          <span className="text-[10px] text-[var(--ink-3)] shrink-0">{vm.headcount}명</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[25px] font-extrabold tabular-nums leading-none" style={{ color: MAIN_COLOR[vm.severity] }}>
            {vm.mainValue}{vm.mainUnit && <span className="text-[11.5px] font-semibold ml-0.5">{vm.mainUnit}</span>}
          </span>
          <span className="flex-1" />
          <span className="text-[9.5px] font-bold px-[7px] py-0.5 rounded shrink-0" style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>
        </div>
        {!vm.hideProgress && (
          <div className="relative h-[5px] rounded-full bg-[var(--line-2)] mt-2 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, vm.progressPct))}%`, background: MAIN_COLOR[vm.severity] }} />
            {vm.progressMarkerPct !== undefined && (
              <div className="absolute -top-0.5 w-0.5 h-[9px] bg-[var(--ink)] rounded-sm" style={{ left: `${Math.max(0, Math.min(100, vm.progressMarkerPct))}%` }} />
            )}
          </div>
        )}
        <div className="flex items-center justify-between mt-1">
          <span className="text-[9.5px] text-[var(--ink-3)] truncate">{vm.captionLeft}</span>
          <span className="text-[9.5px] text-[var(--ink-3)] shrink-0">{vm.captionRight}</span>
        </div>
      </div>

      <div className="flex gap-px bg-[var(--line-2)] shrink-0">
        {vm.cells.map((c, i) => (
          <div key={i} className="flex-1 bg-white py-[7px] text-center">
            <p className="text-[9px] text-[var(--ink-3)]">{c.label}</p>
            <p className="text-[13px] font-extrabold tabular-nums" style={{ color: c.value === '—' || c.value === '0' ? 'var(--ink-4)' : (c.color ?? 'var(--ink)') }}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between px-[15px] py-2 bg-[#fafbfc] shrink-0 text-left"
      >
        <span className="text-[10px] font-bold text-[var(--ink-3)]">{vm.listHeaderLabel}</span>
        <span className="flex items-center gap-1 text-[10px] text-[var(--ink-3)]">
          {vm.listSortLabel}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {vm.listColumnHeaders && (
            <div className="sticky top-0 flex items-center px-[15px] py-1 bg-white text-[9.5px] text-[var(--ink-3)]">
              <span className="flex-1">{vm.listColumnHeaders[0]}</span>
              {vm.listColumnHeaders.slice(1).map((h, i) => <span key={i} className="w-[26px] text-center">{h}</span>)}
            </div>
          )}
          {vm.rows.length === 0 ? (
            <p className="text-[11px] text-[var(--ink-4)] text-center py-3">해당 없음</p>
          ) : vm.rows.map(r => (
            <div key={r.key} className="flex items-center px-[15px] py-[7px] border-b border-[var(--line-2)] last:border-b-0 gap-1.5">
              <Link
                href={`/admin/employees/${r.key.split('_')[0]}`}
                className="text-[11px] font-bold text-[var(--ink)] truncate hover:underline hover:text-[var(--pri)]"
              >
                {r.name}
              </Link>
              {r.date && (
                <span className="text-[9.5px] text-[var(--ink-4)] tabular-nums shrink-0">{r.date.slice(5)}</span>
              )}
              {r.tag && (
                <span className="text-[9.5px] font-semibold px-1 rounded shrink-0" style={{ background: r.tag.bg, color: r.tag.fg }}>{r.tag.text}</span>
              )}
              <span className="flex-1" />
              {r.cols ? (
                r.cols.map((v, i) => (
                  <span key={i} className="w-[26px] text-center text-[11px] font-extrabold tabular-nums" style={{ color: !v || v === '—' ? 'var(--ink-4)' : undefined }}>
                    {v || '—'}
                  </span>
                ))
              ) : (
                <span className={`text-[10.5px] font-bold tabular-nums shrink-0 ${r.valueRed ? 'text-[var(--neg)]' : 'text-[var(--ink-2)]'}`}>{r.value}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-[15px] py-2 bg-[#fafbfc] border-t border-[var(--line-2)] shrink-0">
        <span className="text-[10px] text-[var(--ink-3)]">{vm.footerLabel}</span>
        <span className="text-[10.5px] font-extrabold text-[var(--ink-2)]">{vm.footerValue}</span>
      </div>

      {onSaveNote && (
        <div className="px-[15px] py-[10px] border-t border-[var(--line-2)] shrink-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9.5px] font-bold text-[var(--ink-3)]">인사이트 메모</span>
            <div className="flex items-center gap-1.5">
              {noteSaved && <span className="text-[9.5px] text-[var(--pos)]">✓ 저장됨</span>}
              <button
                onClick={handleSaveNote}
                disabled={noteSaving || noteDraft === (note ?? '')}
                className="text-[9.5px] font-semibold px-[7px] py-0.5 rounded border border-[var(--line)] text-[var(--ink-2)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {noteSaving ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
          <textarea
            value={noteDraft}
            onChange={e => setNoteDraft(e.target.value)}
            placeholder="이 기간 현황에 대한 설명을 적어두세요"
            rows={2}
            className="w-full text-[10.5px] leading-snug border border-[var(--line)] rounded-md px-2 py-1.5 resize-none focus:outline-none focus:border-[var(--pri)]"
          />
        </div>
      )}
    </section>
  )
}
