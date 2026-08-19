'use client'
import { sortByDivisionOrder } from '@/data/orgChart'
import { AnomalyMetricBadges, emptyDivisionAnomalyMetrics } from './AnomalyMetricBadges'
import { AnomalyPersonTable, type AnomalyPersonRow } from './AnomalyPersonTable'
import type { AnomalyRow, DivisionLeaveBreakdown, OffsiteRow, HolidayWorkRow } from '@/utils/overviewAggregations'

interface DivisionHeadcount {
  division: string
  headcount: number
}

function LeaveDetailLine({ leave, offsiteCount }: { leave?: DivisionLeaveBreakdown; offsiteCount: number }) {
  const parts: string[] = []
  if (leave?.annual)  parts.push(`연차 ${leave.annual}`)
  if (leave?.half)     parts.push(`반차 ${leave.half}`)
  if (leave?.quarter)  parts.push(`반반차 ${leave.quarter}`)
  if (leave?.other)    parts.push(`기타 ${leave.other}`)
  if (offsiteCount)    parts.push(`외근 ${offsiteCount}`)
  if (parts.length === 0) return null
  return <p className="text-[10px] font-medium text-violet-500 mt-1.5">{parts.join(' · ')}</p>
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-300 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

/**
 * 종합현황 Zone2 "이상치" 탭 — 조직도 페이지의 DivisionCard와 달리 roster(팀 트리) API에
 * 의존하지 않고, 종합현황이 이미 계산해 갖고 있는 division 롤업만으로 렌더링한다.
 * (roster를 그대로 가져다 쓰면 조회 전용이던 조직도가 종합현황과 강결합돼버리기 때문 —
 * 팀 단위 드릴다운이 필요하면 "조직도" 탭이나 조직도 페이지로 넘어가서 보면 된다.)
 *
 * 카드별 명단 펼침 여부(expandedList)는 부모가 들고 있다 — "전체 펼치기/접기"를
 * 페이지 레벨에서 한 번에 제어할 수 있게 하기 위해서.
 */
export function DivisionSummaryCardGrid({
  divisions, divAnomaly, empAnomaly, divLeaveBreakdown, divOffsite, divHoliday, showHolidayBadge,
  expandedList, onToggleList,
}: {
  divisions:  DivisionHeadcount[]
  divAnomaly: AnomalyRow[]
  /** division 컬럼이 있는 flat 개인별 이상치 목록 — 카드별 명단 토글용으로 division 단위로 재그룹핑한다. */
  empAnomaly: AnomalyRow[]
  divLeaveBreakdown: DivisionLeaveBreakdown[]
  divOffsite: OffsiteRow[]
  divHoliday: HolidayWorkRow[]
  /** 휴일근무 배지 표시 여부 — 일간뷰에선 그날이 휴일일 때만, 주/월간뷰에선 항상 표시. */
  showHolidayBadge: boolean
  /** 명단이 펼쳐진 division 이름 집합 — "전체 펼치기/접기"를 위해 부모(overview 페이지)가 관리. */
  expandedList: Set<string>
  onToggleList: (division: string) => void
}) {
  const anomalyByDiv = new Map(divAnomaly.map(r => [r.label, r]))
  const leaveByDiv    = new Map(divLeaveBreakdown.map(r => [r.division, r]))
  const offsiteByDiv  = new Map(divOffsite.map(r => [r.label, r.count]))
  const holidayByDiv = new Map(divHoliday.map(r => [r.label, r]))
  const byName = new Map(divisions.map(d => [d.division, d]))
  const ordered = sortByDivisionOrder(divisions.map(d => d.division))

  const personRowsByDiv = new Map<string, AnomalyPersonRow[]>()
  for (const r of empAnomaly) {
    const div = r.division ?? '—'
    const list = personRowsByDiv.get(div) ?? []
    list.push({ key: r.key, name: r.label, late: r.late, shortage: r.shortage, notag: r.notag, total: r.total })
    personRowsByDiv.set(div, list)
  }

  if (ordered.length === 0) {
    return <p className="text-xs text-gray-300 text-center py-6">데이터가 없습니다.</p>
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      {ordered.map(name => {
        const d = byName.get(name)
        if (!d) return null
        const a = anomalyByDiv.get(name)
        const holidayCount = holidayByDiv.get(name)?.count ?? 0
        const hasAnomaly = !!a && a.total > 0
        const isExpanded = expandedList.has(name)
        return (
          <section key={name} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-gray-800 text-white">
              <span className="text-sm font-semibold truncate">{name}</span>
              <span className="text-xs font-medium text-gray-300 tabular-nums shrink-0">{d.headcount}명</span>
            </div>
            <div className="px-4 py-2.5 bg-gray-50/60">
              <AnomalyMetricBadges m={a ? { ...a, leave: 0 } : emptyDivisionAnomalyMetrics()} shortageLabel="미달" />
              <LeaveDetailLine leave={leaveByDiv.get(name)} offsiteCount={offsiteByDiv.get(name) ?? 0} />
              {showHolidayBadge && holidayCount > 0 && (
                <p className="text-[10px] font-semibold text-purple-500 mt-1">휴일근무 {holidayCount}명</p>
              )}
            </div>
            {hasAnomaly && (
              <button
                onClick={() => onToggleList(name)}
                className="w-full flex items-center justify-center py-1 text-gray-300 hover:bg-gray-50"
              >
                <ChevronIcon open={isExpanded} />
              </button>
            )}
            {hasAnomaly && isExpanded && (
              <div className="px-3 py-2.5 border-t border-gray-100">
                <AnomalyPersonTable rows={personRowsByDiv.get(name) ?? []} pageSize={5} />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
