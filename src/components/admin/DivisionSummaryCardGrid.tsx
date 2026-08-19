'use client'
import { sortByDivisionOrder } from '@/data/orgChart'
import { AnomalyMetricBadges, emptyDivisionAnomalyMetrics } from './AnomalyMetricBadges'
import type { AnomalyRow, LeaveUsageRow, HolidayWorkRow } from '@/utils/overviewAggregations'

interface DivisionHeadcount {
  division: string
  headcount: number
}

/**
 * 종합현황 Zone2 "🏢 조직도 카드 뷰" — 조직도 페이지의 DivisionCard와 달리 roster(팀 트리)
 * API에 의존하지 않고, 종합현황이 이미 계산해 갖고 있는 division 롤업만으로 렌더링한다.
 * (roster를 그대로 가져다 쓰면 조회 전용이던 조직도가 종합현황과 강결합돼버리기 때문 —
 * 팀 단위 드릴다운이 필요하면 조직도 페이지로 넘어가서 보면 된다.)
 */
export function DivisionSummaryCardGrid({
  divisions, divAnomaly, divLeave, divHoliday, showHolidayBadge,
}: {
  divisions:  DivisionHeadcount[]
  divAnomaly: AnomalyRow[]
  divLeave:   LeaveUsageRow[]
  divHoliday: HolidayWorkRow[]
  /** 휴일근무 배지 표시 여부 — 일간뷰에선 그날이 휴일일 때만, 주/월간뷰에선 항상 표시. */
  showHolidayBadge: boolean
}) {
  const anomalyByDiv = new Map(divAnomaly.map(r => [r.label, r]))
  const leaveByDiv   = new Map(divLeave.map(r => [r.label, r]))
  const holidayByDiv = new Map(divHoliday.map(r => [r.label, r]))
  const byName = new Map(divisions.map(d => [d.division, d]))
  const ordered = sortByDivisionOrder(divisions.map(d => d.division))

  if (ordered.length === 0) {
    return <p className="text-xs text-gray-300 text-center py-6">데이터가 없습니다.</p>
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      {ordered.map(name => {
        const d = byName.get(name)
        if (!d) return null
        const a = anomalyByDiv.get(name)
        const leaveCount = leaveByDiv.get(name)?.count ?? 0
        const holidayCount = holidayByDiv.get(name)?.count ?? 0
        return (
          <section key={name} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-gray-800 text-white">
              <span className="text-sm font-semibold truncate">{name}</span>
              <span className="flex items-center gap-2 shrink-0">
                {leaveCount > 0 && <span className="text-[11px] font-medium text-violet-300">휴가 {leaveCount}</span>}
                <span className="text-xs font-medium text-gray-300 tabular-nums">{d.headcount}명</span>
              </span>
            </div>
            <div className="px-4 py-2.5 bg-gray-50/60">
              <AnomalyMetricBadges m={a ? { ...a, leave: 0 } : emptyDivisionAnomalyMetrics()} shortageLabel="미달" />
              {showHolidayBadge && holidayCount > 0 && (
                <p className="text-[10px] font-semibold text-purple-500 mt-1.5">휴일근무 {holidayCount}명</p>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
