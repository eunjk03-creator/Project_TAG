'use client'
import { useState } from 'react'

export type CardSeverity = 'normal' | 'warning' | 'action'

export interface DivisionCardPerson {
  employeeId: string
  name: string
  count: number
  hours: number
}

/** 카드 하나가 필요로 하는 값 전부 — 심각도/기준값 판정은 overview 페이지(page.tsx)가
 *  이미 갖고 있는 다른 지표들(전사 평균, 한도값 등)과 같이 계산해서 넘긴다. 이 컴포넌트는
 *  순수 표시만 담당(디자인 핸드오프 turn 7a/7b/7c 기준). */
export interface DivisionCardVM {
  division:     string
  headcount:    number
  severity:     CardSeverity
  bigValue:     string   // 이미 포맷된 문자열 (예: "85.0", "46h 40m")
  bigUnit?:     string   // day는 '%', week/month는 fmtH가 이미 단위를 포함해서 비움
  progressPct:  number   // 0~100, 진행 막대 채움 비율
  captionLeft:  string
  captionRight: string
  late: number; shortage: number; notag: number
  totalAnomaly: number
  people:       DivisionCardPerson[]  // 이상치 건수 내림차순, 이미 budget 적용됨
  /** 기존 휴가 세부분류(연차/반차/반반차/외근) 한 줄 요약 — 새 카드에 자리가 좁아 한 줄로 축약. */
  leaveNote?:   string
  holidayNote?: string
}

const SEVERITY_BAND: Record<CardSeverity, string> = { normal: '#e2e8f0', warning: '#f59e0b', action: '#dc2626' }
const SEVERITY_BIG:  Record<CardSeverity, string> = { normal: '#16a34a', warning: '#d97706', action: '#dc2626' }
const SEVERITY_BADGE: Record<CardSeverity, { bg: string; fg: string; label: string }> = {
  normal:  { bg: '#f1f5f9', fg: '#94a3b8', label: '정상' },
  warning: { bg: '#fffbeb', fg: '#b45309', label: '주의' },
  action:  { bg: '#fef2f6', fg: '#b91c1c', label: '조치 필요' },
}

const PAGE_SIZE = 3

function ThreeWayCounter({ late, shortage, notag }: { late: number; shortage: number; notag: number }) {
  const items = [
    { label: '지각', value: late, color: '#d97706' },
    { label: '미달', value: shortage, color: '#dc2626' },
    { label: '미태깅', value: notag, color: '#7c3aed' },
  ]
  return (
    <div className="grid grid-cols-3 gap-px bg-gray-100 rounded-md overflow-hidden">
      {items.map(it => (
        <div key={it.label} className="bg-white py-1.5 text-center">
          <p className="text-[9px] text-gray-400">{it.label}</p>
          <p className="text-[13px] font-extrabold tabular-nums" style={{ color: it.value > 0 ? it.color : '#e2e8f0' }}>
            {it.value > 0 ? it.value : '—'}
          </p>
        </div>
      ))}
    </div>
  )
}

function PersonRows({ people, page }: { people: DivisionCardPerson[]; page: number }) {
  const slice = people.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  const rows: (DivisionCardPerson | null)[] = [...slice]
  while (rows.length < PAGE_SIZE) rows.push(null)
  return (
    <div className="flex-1">
      {rows.map((p, i) => (
        <div key={p?.employeeId ?? `empty-${i}`} className="flex items-center justify-between px-3.5 py-1.5 border-b border-gray-50 last:border-b-0">
          {p ? (
            <>
              <span className="text-[11px] font-semibold text-gray-700 truncate">{p.name} <span className="text-[10px] text-gray-400 font-normal">{p.count}건</span></span>
              <span className="text-[10px] text-gray-500 tabular-nums shrink-0">{fmtHoursShort(p.hours)}</span>
            </>
          ) : (
            <span className="text-[11px] text-gray-200">—</span>
          )}
        </div>
      ))}
    </div>
  )
}

function fmtHoursShort(hours: number): string {
  if (!hours) return '0h'
  const m = Math.round(hours * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function DivisionCard({ vm }: { vm: DivisionCardVM }) {
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(vm.people.length / PAGE_SIZE))
  const clampedPage = Math.min(page, totalPages - 1)
  const isEmpty = vm.totalAnomaly === 0
  const badge = isEmpty ? SEVERITY_BADGE.normal : SEVERITY_BADGE[vm.severity]

  return (
    <section
      className="bg-white border border-gray-100 rounded-xl overflow-hidden flex flex-col h-[255px] hover:border-gray-300 transition-colors"
      style={{ opacity: isEmpty ? 0.5 : 1 }}
    >
      <div className="h-[3px] shrink-0" style={{ background: isEmpty ? SEVERITY_BAND.normal : SEVERITY_BAND[vm.severity] }} />

      <div className="px-3.5 pt-2.5 pb-2.5 shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-extrabold text-gray-900 truncate">{vm.division}</span>
          <span className="text-[10px] text-gray-400 shrink-0">{vm.headcount}명</span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xl font-extrabold tabular-nums leading-none" style={{ color: isEmpty ? '#94a3b8' : SEVERITY_BIG[vm.severity] }}>
            {vm.bigValue}{vm.bigUnit && <span className="text-[11px] font-semibold ml-0.5">{vm.bigUnit}</span>}
          </span>
          <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded" style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>
        </div>
        <div className="h-[5px] rounded-full bg-[#eef2f6] mt-1.5 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, vm.progressPct)}%`, background: isEmpty ? SEVERITY_BAND.normal : SEVERITY_BIG[vm.severity] }} />
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[9.5px] text-gray-400 truncate">{vm.captionLeft}</span>
          <span className="text-[9.5px] text-gray-400 shrink-0">{vm.captionRight}</span>
        </div>
      </div>

      <ThreeWayCounter late={vm.late} shortage={vm.shortage} notag={vm.notag} />

      <PersonRows people={vm.people} page={clampedPage} />

      <div className="flex items-center justify-between px-3.5 py-1.5 bg-gray-50/70 shrink-0">
        <button
          onClick={() => setPage(p => Math.max(0, p - 1))}
          disabled={clampedPage === 0}
          className="text-[10px] font-medium text-gray-400 disabled:text-gray-200 hover:text-gray-600 disabled:hover:text-gray-200"
        >
          ‹ 이전
        </button>
        <span className="text-[10px] text-gray-300 tabular-nums">{clampedPage + 1} / {totalPages}</span>
        <button
          onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
          disabled={clampedPage >= totalPages - 1}
          className="text-[10px] font-medium text-gray-500 disabled:text-gray-200 hover:text-gray-700 disabled:hover:text-gray-200"
        >
          다음 ›
        </button>
      </div>

      {(vm.leaveNote || vm.holidayNote) && (
        <p className="px-3.5 py-1 text-[9.5px] text-violet-500 bg-violet-50/50 truncate shrink-0">
          {[vm.leaveNote, vm.holidayNote].filter(Boolean).join(' · ')}
        </p>
      )}
    </section>
  )
}

/**
 * 종합현황 Zone2 "이상치" 탭 — 디자인 핸드오프(turn 7a/7b/7c) 기준 카드 그리드.
 * 카드 높이 고정(255px) + 상위 인원 3행 고정 + 카드 내 페이저. 심각도/기준값 판정은
 * overview 페이지가 이미 다른 전사 지표와 함께 계산해 DivisionCardVM으로 넘겨준다 —
 * 이 컴포넌트는 그 값을 그대로 그리는 순수 표시 레이어.
 */
export function DivisionSummaryCardGrid({ cards }: { cards: DivisionCardVM[] }) {
  // 핸드오프 스펙: "정렬 — 이상치 합계 내림차순" (조직도 순서가 아니라 문제 큰 부서가 먼저).
  const ordered = [...cards].sort((a, b) => b.totalAnomaly - a.totalAnomaly)

  if (ordered.length === 0) {
    return <p className="text-xs text-gray-300 text-center py-6">데이터가 없습니다.</p>
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
      {ordered.map(vm => <DivisionCard key={vm.division} vm={vm} />)}
    </div>
  )
}
