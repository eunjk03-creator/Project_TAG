'use client'
import { useMemo } from 'react'
import type { ProcessedRecord, Employee, RiskThresholds } from '@/types/tag'
import type { DivisionMetrics } from '@/hooks/useManagementMetrics'
import { SectionComparisonChart } from './SectionComparisonChart'

export type Section = 'total' | 'overtime' | 'anomaly'

interface Props {
  openSections:     Set<Section>
  onToggle:         (s: Section) => void
  metrics:          DivisionMetrics[]
  total:            Omit<DivisionMetrics, 'division'>
  processedRecords: ProcessedRecord[]
  employees:        Employee[]
  approvedKeys:     Set<string>
  riskThresholds:   RiskThresholds
  selectedBUs:      string[]
  onBUsChange:      (bus: string[]) => void
}

function fmtH(h: number): string {
  if (h <= 0) return '—'
  const m  = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

const ChevronDown = ({ open }: { open: boolean }) => (
  <svg
    className={`ml-auto w-4 h-4 text-gray-400 transition-transform duration-200 shrink-0 ${open ? 'rotate-180' : ''}`}
    fill="none" stroke="currentColor" viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
  </svg>
)

export function MetricDeepDive({
  openSections, onToggle,
  metrics, total,
  processedRecords, employees,
  approvedKeys, riskThresholds,
  selectedBUs, onBUsChange,
}: Props) {

  const derived = useMemo(() => {
    const empDiv: Record<string, string> = {}
    for (const e of employees) empDiv[e.id] = e.division

    const empTotals: Record<string, number> = {}
    const empOt:     Record<string, number> = {}
    for (const r of processedRecords) {
      empTotals[r.employeeId] = (empTotals[r.employeeId] ?? 0) + r.regularHours + r.overtimeHours
      empOt[r.employeeId]     = (empOt[r.employeeId]     ?? 0) + r.overtimeHours
    }

    const highestTotal: Record<string, number> = {}
    const otOverCount:  Record<string, number> = {}
    for (const e of employees) {
      const div = e.division
      const tot = empTotals[e.id] ?? 0
      const ot  = empOt[e.id]     ?? 0
      if (highestTotal[div] === undefined || tot > highestTotal[div]) highestTotal[div] = tot
      if (ot > riskThresholds.otRedH) otOverCount[div] = (otOverCount[div] ?? 0) + 1
    }

    const missedTag:      Record<string, number> = {}  // NO_CLOCK_IN + NO_CLOCK_OUT
    const lateCount:      Record<string, number> = {}  // LATE + compound flags
    const earlyCount:     Record<string, number> = {}  // EARLY_DEPARTURE + LATE_AND_EARLY_DEPARTURE
    const shortWorkCount: Record<string, number> = {}  // ATTENDANCE_ANOMALY + LATE_AND_ANOMALY
    const compoundCount:  Record<string, number> = {}  // LATE_AND_EARLY_DEPARTURE + LATE_AND_ANOMALY
    for (const r of processedRecords) {
      if (approvedKeys.has(`${r.employeeId}_${r.date}`)) continue
      const div = empDiv[r.employeeId]
      if (!div || !r.flag) continue
      const f = r.flag
      if (f === 'LATE' || f === 'LATE_AND_EARLY_DEPARTURE' || f === 'LATE_AND_ANOMALY')
        lateCount[div] = (lateCount[div] ?? 0) + 1
      if (f === 'EARLY_DEPARTURE' || f === 'LATE_AND_EARLY_DEPARTURE')
        earlyCount[div] = (earlyCount[div] ?? 0) + 1
      if (f === 'ATTENDANCE_ANOMALY' || f === 'LATE_AND_ANOMALY')
        shortWorkCount[div] = (shortWorkCount[div] ?? 0) + 1
      if (f === 'NO_CLOCK_IN' || f === 'NO_CLOCK_OUT')
        missedTag[div] = (missedTag[div] ?? 0) + 1
      if (f === 'LATE_AND_EARLY_DEPARTURE' || f === 'LATE_AND_ANOMALY')
        compoundCount[div] = (compoundCount[div] ?? 0) + 1
    }

    return {
      highestTotal, otOverCount,
      missedTag, lateCount, earlyCount, shortWorkCount, compoundCount,
      severeCount: shortWorkCount,
      totalOtOver:    Object.values(otOverCount).reduce((s, v) => s + v, 0),
      totalMissed:    Object.values(missedTag).reduce((s, v) => s + v, 0),
      totalLate:      Object.values(lateCount).reduce((s, v) => s + v, 0),
      totalEarly:     Object.values(earlyCount).reduce((s, v) => s + v, 0),
      totalShortWork: Object.values(shortWorkCount).reduce((s, v) => s + v, 0),
      totalCompound:  Object.values(compoundCount).reduce((s, v) => s + v, 0),
      totalSevere:    Object.values(shortWorkCount).reduce((s, v) => s + v, 0),
    }
  }, [processedRecords, employees, approvedKeys, riskThresholds.otRedH])

  function handleRow(div: string) {
    if (selectedBUs.includes(div)) onBUsChange(selectedBUs.filter(b => b !== div))
    else onBUsChange([...selectedBUs, div])
  }

  const isOpenTotal    = openSections.has('total')
  const isOpenOvertime = openSections.has('overtime')
  const isOpenAnomaly  = openSections.has('anomaly')

  const avgTotal = total.headcount > 0 ? total.totalHours / total.headcount : 0

  return (
    <div className="space-y-3">

      {/* ── 총 근로시간 ──────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3.5">
          <button onClick={() => onToggle('total')} className="w-full flex items-center gap-3 text-left">
            <div className="shrink-0 w-1 h-5 rounded-full bg-blue-500" />
            <span className={`text-sm font-semibold ${isOpenTotal ? 'text-gray-900' : 'text-gray-600'}`}>
              총 근로시간
            </span>
            <span className="text-xs text-gray-400 tabular-nums">
              {fmtH(total.totalHours)} · 1인 평균 {fmtH(avgTotal)}
            </span>
            <ChevronDown open={isOpenTotal} />
          </button>
        </div>

        <div className={`grid transition-all duration-300 ease-in-out ${isOpenTotal ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="border-t border-gray-100">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500">
                    <th className="text-left   px-4 py-2.5">본부명</th>
                    <th className="text-center px-4 py-2.5">인원</th>
                    <th className="text-center px-4 py-2.5">총 근로시간</th>
                    <th className="text-center px-4 py-2.5">1인 평균</th>
                    <th className="text-center px-4 py-2.5">최대 개인</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m, i) => {
                    const active = selectedBUs.includes(m.division)
                    const avg    = m.headcount > 0 ? m.totalHours / m.headcount : 0
                    const top    = derived.highestTotal[m.division] ?? 0
                    return (
                      <tr
                        key={m.division}
                        onClick={() => handleRow(m.division)}
                        className={`border-b border-gray-100 cursor-pointer transition-colors select-none ${
                          active      ? 'bg-blue-50 hover:bg-blue-100' :
                          i % 2 === 0 ? 'bg-white hover:bg-gray-50' :
                                        'bg-gray-50/40 hover:bg-gray-100/60'
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={`shrink-0 w-3.5 h-3.5 rounded border-2 flex items-center justify-center text-[8px] font-bold transition-all duration-150 ${
                              active ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-300 text-transparent'
                            }`}>✓</span>
                            <span className={`font-medium ${active ? 'text-blue-700' : 'text-gray-800'}`}>{m.division}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center text-gray-600 tabular-nums">{m.headcount}명</td>
                        <td className="px-4 py-2.5 text-center font-semibold tabular-nums text-gray-700">{fmtH(m.totalHours)}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          <span className={avg > riskThresholds.totalAmberH ? 'text-amber-600 font-bold' : 'text-gray-600'}>
                            {fmtH(avg)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-center tabular-nums text-gray-600">{fmtH(top)}</td>
                      </tr>
                    )
                  })}
                  <tr className="bg-gray-100 border-t-2 border-gray-300 font-semibold text-[12px]">
                    <td className="px-4 py-2.5 text-gray-700">전체</td>
                    <td className="px-4 py-2.5 text-center text-gray-700 tabular-nums">{total.headcount}명</td>
                    <td className="px-4 py-2.5 text-center text-gray-700 tabular-nums">{fmtH(total.totalHours)}</td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      <span className={avgTotal > riskThresholds.totalAmberH ? 'text-amber-600' : 'text-gray-700'}>
                        {fmtH(avgTotal)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-400">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {selectedBUs.length >= 2 && (
              <div className="px-4 pb-5">
                <SectionComparisonChart
                  section="total"
                  metrics={metrics}
                  selectedBUs={selectedBUs}
                  riskThresholds={riskThresholds}
                  highestTotal={derived.highestTotal}
                  otOverCount={derived.otOverCount}
                  missedTag={derived.missedTag}
                  lateCount={derived.lateCount}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 연장근로 ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3.5">
          <button onClick={() => onToggle('overtime')} className="w-full flex items-center gap-3 text-left">
            <div className="shrink-0 w-1 h-5 rounded-full bg-amber-500" />
            <span className={`text-sm font-semibold ${isOpenOvertime ? 'text-gray-900' : 'text-gray-600'}`}>
              연장근로
            </span>
            <span className="text-xs text-gray-400 tabular-nums">
              {fmtH(total.otHours)} · 1인 평균 {fmtH(total.avgOtPerPerson)}
            </span>
            <ChevronDown open={isOpenOvertime} />
          </button>
        </div>

        <div className={`grid transition-all duration-300 ease-in-out ${isOpenOvertime ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="border-t border-gray-100">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500">
                    <th className="text-left   px-4 py-2.5">본부명</th>
                    <th className="text-center px-4 py-2.5">인원</th>
                    <th className="text-center px-4 py-2.5">총 연장근로</th>
                    <th className="text-center px-4 py-2.5">1인 평균 연장</th>
                    <th className="text-center px-4 py-2.5 text-orange-500">{`>${riskThresholds.otRedH}h 초과인원`}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m, i) => {
                    const active = selectedBUs.includes(m.division)
                    const over   = derived.otOverCount[m.division] ?? 0
                    return (
                      <tr
                        key={m.division}
                        onClick={() => handleRow(m.division)}
                        className={`border-b border-gray-100 cursor-pointer transition-colors select-none ${
                          active      ? 'bg-amber-50 hover:bg-amber-100' :
                          i % 2 === 0 ? 'bg-white hover:bg-gray-50' :
                                        'bg-gray-50/40 hover:bg-gray-100/60'
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={`shrink-0 w-3.5 h-3.5 rounded border-2 flex items-center justify-center text-[8px] font-bold transition-all duration-150 ${
                              active ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-300 text-transparent'
                            }`}>✓</span>
                            <span className={`font-medium ${active ? 'text-amber-700' : 'text-gray-800'}`}>{m.division}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center text-gray-600 tabular-nums">{m.headcount}명</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          <span className={m.otHours > 0 ? 'text-amber-600 font-semibold' : 'text-gray-300'}>
                            {fmtH(m.otHours)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          <span className={
                            m.avgOtPerPerson > riskThresholds.otRedH   ? 'text-red-600 font-bold' :
                            m.avgOtPerPerson > riskThresholds.otAmberH ? 'text-amber-600 font-semibold' :
                            m.avgOtPerPerson > 0                        ? 'text-gray-600' :
                                                                          'text-gray-300'
                          }>
                            {fmtH(m.avgOtPerPerson)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          {over > 0
                            ? <span className={`font-bold ${over >= 3 ? 'text-red-600' : 'text-orange-500'}`}>{over}명</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="bg-gray-100 border-t-2 border-gray-300 font-semibold text-[12px]">
                    <td className="px-4 py-2.5 text-gray-700">전체</td>
                    <td className="px-4 py-2.5 text-center text-gray-700 tabular-nums">{total.headcount}명</td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      <span className="text-amber-600">{fmtH(total.otHours)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      <span className={total.avgOtPerPerson > riskThresholds.otRedH ? 'text-red-600' : 'text-gray-700'}>
                        {fmtH(total.avgOtPerPerson)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      {derived.totalOtOver > 0
                        ? <span className={derived.totalOtOver >= 3 ? 'text-red-600' : 'text-orange-500'}>{derived.totalOtOver}명</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {selectedBUs.length >= 2 && (
              <div className="px-4 pb-5">
                <SectionComparisonChart
                  section="overtime"
                  metrics={metrics}
                  selectedBUs={selectedBUs}
                  riskThresholds={riskThresholds}
                  highestTotal={derived.highestTotal}
                  otOverCount={derived.otOverCount}
                  missedTag={derived.missedTag}
                  lateCount={derived.lateCount}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 이상치 ───────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3.5">
          <button onClick={() => onToggle('anomaly')} className="w-full flex items-center gap-3 text-left">
            <div className="shrink-0 w-1 h-5 rounded-full bg-red-400" />
            <span className={`text-sm font-semibold ${isOpenAnomaly ? 'text-gray-900' : 'text-gray-600'}`}>
              이상치
            </span>
            <span className="text-xs text-gray-400 tabular-nums">
              {total.anomalies}건 · 미태깅 {derived.totalMissed} · 지각 {derived.totalLate} · 조기퇴근 {derived.totalEarly} · 근태이상 {derived.totalSevere}
            </span>
            <ChevronDown open={isOpenAnomaly} />
          </button>
        </div>

        <div className={`grid transition-all duration-300 ease-in-out ${isOpenAnomaly ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="border-t border-gray-100">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500">
                    <th className="text-left   px-4 py-2.5">부서</th>
                    <th className="text-center px-3 py-2.5 text-amber-600">지각</th>
                    <th className="text-center px-3 py-2.5 text-orange-500">조기퇴근</th>
                    <th className="text-center px-3 py-2.5 text-red-600">근무시간미달</th>
                    <th className="text-center px-3 py-2.5 text-red-500">미태깅</th>
                    <th className="text-center px-3 py-2.5 text-purple-500">혼합</th>
                    <th className="text-center px-3 py-2.5 text-gray-700">총합계</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m, i) => {
                    const active    = selectedBUs.includes(m.division)
                    const late      = derived.lateCount[m.division]      ?? 0
                    const early     = derived.earlyCount[m.division]     ?? 0
                    const shortWork = derived.shortWorkCount[m.division] ?? 0
                    const missed    = derived.missedTag[m.division]      ?? 0
                    const compound  = derived.compoundCount[m.division]  ?? 0
                    return (
                      <tr
                        key={m.division}
                        onClick={() => handleRow(m.division)}
                        className={`border-b border-gray-100 cursor-pointer transition-colors select-none ${
                          active      ? 'bg-red-50 hover:bg-red-100' :
                          i % 2 === 0 ? 'bg-white hover:bg-gray-50' :
                                        'bg-gray-50/40 hover:bg-gray-100/60'
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={`shrink-0 w-3.5 h-3.5 rounded border-2 flex items-center justify-center text-[8px] font-bold transition-all duration-150 ${
                              active ? 'bg-red-400 border-red-400 text-white' : 'border-gray-300 text-transparent'
                            }`}>✓</span>
                            <span className={`font-medium ${active ? 'text-red-700' : 'text-gray-800'}`}>{m.division}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums">
                          {late > 0 ? <span className="text-amber-600 font-semibold">{late}건</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums">
                          {early > 0 ? <span className="text-orange-500 font-semibold">{early}건</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums">
                          {shortWork > 0 ? <span className="text-red-600 font-semibold">{shortWork}건</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums">
                          {missed > 0 ? <span className="text-red-500 font-semibold">{missed}건</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums">
                          {compound > 0 ? <span className="text-purple-500 font-semibold">{compound}건</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums">
                          {m.anomalies > 0 ? <span className="text-gray-800 font-bold">{m.anomalies}건</span> : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="bg-gray-100 border-t-2 border-gray-300 font-semibold text-[12px]">
                    <td className="px-4 py-2.5 text-gray-700">전체</td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {derived.totalLate > 0 ? <span className="text-amber-600">{derived.totalLate}건</span> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {derived.totalEarly > 0 ? <span className="text-orange-500">{derived.totalEarly}건</span> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {derived.totalShortWork > 0 ? <span className="text-red-600">{derived.totalShortWork}건</span> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {derived.totalMissed > 0 ? <span className="text-red-500">{derived.totalMissed}건</span> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {derived.totalCompound > 0 ? <span className="text-purple-500">{derived.totalCompound}건</span> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {total.anomalies > 0 ? <span className="text-gray-800">{total.anomalies}건</span> : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                  {derived.totalCompound > 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-2 text-[10px] text-gray-400 border-t border-gray-100">
                        ※ 혼합: 지각+조기퇴근 또는 지각+근무시간미달 동시 해당 건수. 각 항목에 중복 집계됩니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {selectedBUs.length >= 2 && (
              <div className="px-4 pb-5">
                <SectionComparisonChart
                  section="anomaly"
                  metrics={metrics}
                  selectedBUs={selectedBUs}
                  riskThresholds={riskThresholds}
                  highestTotal={derived.highestTotal}
                  otOverCount={derived.otOverCount}
                  missedTag={derived.missedTag}
                  lateCount={derived.lateCount}
                  earlyCount={derived.earlyCount}
                  severeCount={derived.severeCount}
                />
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
