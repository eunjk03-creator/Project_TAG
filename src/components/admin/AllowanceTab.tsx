'use client'
import { useMemo, useState } from 'react'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { DIVISION_ORDER } from '@/data/orgChart'
import type { Employee, ProcessedRecord } from '@/types/tag'

// ── Format helpers ────────────────────────────────────────────────────────

function fmtH(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function fmtW(amount: number): string {
  if (amount === 0) return '—'
  return `₩ ${Math.round(amount).toLocaleString('ko-KR')}`
}

// ── Types ──────────────────────────────────────────────────────────────────

type SectionKey = 'ot' | 'holiday' | 'late'

interface EmpRow {
  emp: Employee
  otByMonth:      Record<string, number>  // mm → hours
  holidayByMonth: Record<string, number>  // mm → hours
  lateByMonth:    Record<string, number>  // mm → count
  totalOt:        number
  totalHoliday:   number
  totalLate:      number
  isLeader:       boolean
}

// ── Component ──────────────────────────────────────────────────────────────

export function AllowanceTab() {
  const { processedRecords: serverProcessed, employees } = useAttendanceSource()
  const { employeeAttrMap } = useEmployeeExceptions()

  const [half, setHalf] = useState<'H1' | 'H2'>(() =>
    new Date().getMonth() + 1 >= 7 ? 'H2' : 'H1'
  )
  const [expanded, setExpanded] = useState<Set<SectionKey>>(new Set())
  const [hourlyRates, setHourlyRates] = useState<Record<string, string>>({})

  const months: string[] = half === 'H1'
    ? ['01', '02', '03', '04', '05', '06']
    : ['07', '08', '09', '10', '11', '12']

  const monthLabels: Record<string, string> = {
    '01': '1월', '02': '2월', '03': '3월', '04': '4월', '05': '5월', '06': '6월',
    '07': '7월', '08': '8월', '09': '9월', '10': '10월', '11': '11월', '12': '12월',
  }

  function toggleSection(key: SectionKey) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Build per-employee aggregated rows
  const rows = useMemo<EmpRow[]>(() => {
    const records = serverProcessed ?? []

    // Filter records to current half-year
    const periodRecords = records.filter(r => {
      const mm = r.date.slice(5, 7)
      return months.includes(mm)
    })

    // Build lookup: empId → records
    const recsByEmp = new Map<string, ProcessedRecord[]>()
    for (const r of periodRecords) {
      const bucket = recsByEmp.get(r.employeeId)
      if (bucket) bucket.push(r)
      else recsByEmp.set(r.employeeId, [r])
    }

    const result: EmpRow[] = []

    for (const emp of employees) {
      const attrs = employeeAttrMap.get(emp.id)

      // Exclude global exclusions and resigned employees
      if (attrs?.isGlobalExclusion) continue
      if (attrs?.isResigned) continue

      const isLeader = attrs?.isLeader === true

      const empRecords = recsByEmp.get(emp.id) ?? []

      const otByMonth:      Record<string, number> = {}
      const holidayByMonth: Record<string, number> = {}
      const lateByMonth:    Record<string, number> = {}

      for (const mm of months) {
        otByMonth[mm]      = 0
        holidayByMonth[mm] = 0
        lateByMonth[mm]    = 0
      }

      for (const r of empRecords) {
        const mm = r.date.slice(5, 7)
        if (!months.includes(mm)) continue

        // OT: weekday only
        if (r.dayType === 'WEEKDAY') {
          const otH = isLeader
            ? (r.rawOvertimeMinutes ?? 0) / 60
            : r.overtimeHours
          otByMonth[mm] = (otByMonth[mm] ?? 0) + otH
        }

        // Holiday hours (all day types)
        holidayByMonth[mm] = (holidayByMonth[mm] ?? 0) + r.holidayHours

        // Late count
        if (
          r.flag === 'LATE' ||
          r.flag === 'LATE_AND_EARLY_DEPARTURE' ||
          r.flag === 'LATE_AND_ANOMALY'
        ) {
          lateByMonth[mm] = (lateByMonth[mm] ?? 0) + 1
        }
      }

      const totalOt      = Object.values(otByMonth).reduce((s, v) => s + v, 0)
      const totalHoliday = Object.values(holidayByMonth).reduce((s, v) => s + v, 0)
      const totalLate    = Object.values(lateByMonth).reduce((s, v) => s + v, 0)

      result.push({
        emp,
        otByMonth,
        holidayByMonth,
        lateByMonth,
        totalOt,
        totalHoliday,
        totalLate,
        isLeader,
      })
    }

    // Sort: DIVISION_ORDER index, then name localeCompare
    result.sort((a, b) => {
      const ai = DIVISION_ORDER.indexOf(a.emp.division)
      const bi = DIVISION_ORDER.indexOf(b.emp.division)
      const divCmp =
        ai === -1 && bi === -1 ? a.emp.division.localeCompare(b.emp.division, 'ko') :
        ai === -1 ? 1 :
        bi === -1 ? -1 :
        ai - bi
      if (divCmp !== 0) return divCmp
      return a.emp.name.localeCompare(b.emp.name, 'ko')
    })

    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverProcessed, employees, employeeAttrMap, half])

  // Section header colSpan helpers
  const otColSpan      = expanded.has('ot')      ? months.length + 1 : 1
  const holidayColSpan = expanded.has('holiday')  ? months.length + 1 : 1
  const lateColSpan    = expanded.has('late')     ? months.length + 1 : 1

  const halfLabel = half === 'H1' ? '상반기' : '하반기'

  const BADGE_LEADER = 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200'

  // Track division groups for visual separation
  let lastDivision = ''

  // Total colspan for empty state
  const totalCols = 4 + 1 + 1 + otColSpan + 1 + holidayColSpan + lateColSpan

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header bar ── */}
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">수당 집계</h2>
          <p className="text-xs text-gray-400">반기별 연장근로·휴일근로·지각 집계 및 수당 산출</p>
        </div>

        {/* Half selector */}
        <div className="ml-auto flex items-center bg-gray-100 rounded-lg p-0.5 text-xs font-medium">
          <button
            onClick={() => setHalf('H1')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              half === 'H1' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            상반기 (1–6월)
          </button>
          <button
            onClick={() => setHalf('H2')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              half === 'H2' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            하반기 (7–12월)
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
        <table className="text-xs w-full border-collapse">
          <thead>
            {/* ── Row 1: section labels ── */}
            <tr className="bg-gray-50 border-b border-gray-200">
              {/* Fixed columns — rowSpan=2 */}
              <th rowSpan={2} className="sticky left-0 z-10 bg-gray-50 text-left px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap min-w-[80px]">이름</th>
              <th rowSpan={2} className="text-left px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap min-w-[90px]">부서</th>
              <th rowSpan={2} className="text-left px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap min-w-[70px]">직책</th>
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap min-w-[110px]">통상시급<br /><span className="text-[10px] font-normal text-gray-400">(선택)</span></th>

              {/* 연장+휴일 합계 수당 — rowSpan=2 */}
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-gray-900 bg-gray-100 border-r border-gray-300 whitespace-nowrap min-w-[120px]">
                {halfLabel}<br />연장+휴일수당
              </th>

              {/* 연장근무수당 — rowSpan=2 */}
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-blue-700 bg-blue-50 border-r border-blue-200 whitespace-nowrap min-w-[110px]">
                {halfLabel}<br />연장근무수당
              </th>

              {/* 연장근로시간 section — collapsible */}
              <th
                colSpan={otColSpan}
                onClick={() => toggleSection('ot')}
                className="cursor-pointer px-3 py-2.5 font-semibold text-blue-600 bg-blue-50/60 border-r border-blue-200 text-center whitespace-nowrap select-none hover:bg-blue-100 transition-colors"
              >
                {halfLabel} 연장근로시간 {expanded.has('ot') ? '▼' : '▶'}
              </th>

              {/* 휴일근무수당 — rowSpan=2 */}
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-amber-700 bg-amber-50 border-r border-amber-200 whitespace-nowrap min-w-[110px]">
                {halfLabel}<br />휴일근무수당
              </th>

              {/* 휴일근로시간 section — collapsible */}
              <th
                colSpan={holidayColSpan}
                onClick={() => toggleSection('holiday')}
                className="cursor-pointer px-3 py-2.5 font-semibold text-amber-600 bg-amber-50/60 border-r border-amber-200 text-center whitespace-nowrap select-none hover:bg-amber-100 transition-colors"
              >
                {halfLabel} 휴일근로시간 {expanded.has('holiday') ? '▼' : '▶'}
              </th>

              {/* 지각 section — collapsible */}
              <th
                colSpan={lateColSpan}
                onClick={() => toggleSection('late')}
                className="cursor-pointer px-3 py-2.5 font-semibold text-red-600 bg-red-50/60 text-center whitespace-nowrap select-none hover:bg-red-100 transition-colors"
              >
                {halfLabel} 지각 {expanded.has('late') ? '▼' : '▶'}
              </th>
            </tr>

            {/* ── Row 2: sub-column labels ── */}
            <tr className="bg-gray-50 border-b border-gray-200">
              {/* 연장근로시간 sub-columns */}
              <th className="px-3 py-2 font-medium text-blue-600 bg-blue-50/60 border-r border-blue-100 text-center whitespace-nowrap min-w-[70px]">총시간</th>
              {expanded.has('ot') && months.map(mm => (
                <th key={`ot-${mm}`} className="px-2 py-2 font-medium text-blue-500 bg-blue-50/40 border-r border-blue-100 text-center whitespace-nowrap min-w-[56px]">{monthLabels[mm]}</th>
              ))}

              {/* 휴일근로시간 sub-columns */}
              <th className="px-3 py-2 font-medium text-amber-600 bg-amber-50/60 border-r border-amber-100 text-center whitespace-nowrap min-w-[70px]">총시간</th>
              {expanded.has('holiday') && months.map(mm => (
                <th key={`hol-${mm}`} className="px-2 py-2 font-medium text-amber-500 bg-amber-50/40 border-r border-amber-100 text-center whitespace-nowrap min-w-[56px]">{monthLabels[mm]}</th>
              ))}

              {/* 지각 sub-columns */}
              <th className="px-3 py-2 font-medium text-red-600 bg-red-50/60 border-r border-red-100 text-center whitespace-nowrap min-w-[56px]">총횟수</th>
              {expanded.has('late') && months.map(mm => (
                <th key={`late-${mm}`} className="px-2 py-2 font-medium text-red-500 bg-red-50/40 border-r border-red-100 text-center whitespace-nowrap min-w-[48px]">{monthLabels[mm]}</th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={totalCols} className="px-6 py-10 text-center text-gray-400">
                  데이터가 없습니다. CSV를 업로드하면 집계됩니다.
                </td>
              </tr>
            ) : rows.map((row) => {
              const { emp, otByMonth, holidayByMonth, lateByMonth, totalOt, totalHoliday, totalLate, isLeader } = row
              const rate             = parseFloat(hourlyRates[emp.id] ?? '0') || 0
              const otAllowance      = rate > 0 ? totalOt      * rate : 0
              const holidayAllowance = rate > 0 ? totalHoliday * rate : 0
              const totalAllowance   = otAllowance + holidayAllowance

              const isDivisionStart = emp.division !== lastDivision
              lastDivision = emp.division

              return (
                <tr
                  key={emp.id}
                  className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                    isDivisionStart ? 'border-t-2 border-t-gray-200' : ''
                  }`}
                >
                  {/* 이름 */}
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-gray-100 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{emp.name}</span>
                      {isLeader && <span className={BADGE_LEADER}>직책</span>}
                    </div>
                  </td>

                  {/* 부서 */}
                  <td className="px-3 py-2 border-r border-gray-100 text-gray-600 whitespace-nowrap">
                    <div className="leading-tight">
                      <div>{emp.division}</div>
                      {emp.team !== emp.division && (
                        <div className="text-[10px] text-gray-400">{emp.team}</div>
                      )}
                    </div>
                  </td>

                  {/* 직책명 */}
                  <td className="px-3 py-2 border-r border-gray-100 text-gray-600 whitespace-nowrap">
                    {emp.jobTitle ?? '—'}
                  </td>

                  {/* 통상시급 입력 */}
                  <td className="px-2 py-1.5 border-r border-gray-100">
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={hourlyRates[emp.id] ?? ''}
                      onChange={e => setHourlyRates(prev => ({ ...prev, [emp.id]: e.target.value }))}
                      placeholder="시급 입력"
                      className="w-24 text-right text-xs px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder-gray-300"
                    />
                  </td>

                  {/* 연장+휴일 합산 수당 */}
                  <td className="px-3 py-2 border-r border-gray-300 text-right font-bold text-gray-900 bg-gray-50 tabular-nums whitespace-nowrap">
                    {fmtW(totalAllowance)}
                  </td>

                  {/* 연장근무수당 */}
                  <td className="px-3 py-2 border-r border-blue-200 text-right font-semibold text-blue-700 bg-blue-50/40 tabular-nums whitespace-nowrap">
                    {fmtW(otAllowance)}
                  </td>

                  {/* 연장근로시간 총 */}
                  <td className="px-3 py-2 border-r border-blue-100 text-center text-blue-700 font-medium tabular-nums bg-blue-50/20 whitespace-nowrap">
                    {fmtH(totalOt)}
                  </td>
                  {/* 연장근로시간 월별 */}
                  {expanded.has('ot') && months.map(mm => (
                    <td key={`ot-${mm}`} className="px-2 py-2 border-r border-blue-100 text-center text-blue-600 tabular-nums bg-blue-50/10 whitespace-nowrap">
                      {fmtH(otByMonth[mm] ?? 0)}
                    </td>
                  ))}

                  {/* 휴일근무수당 */}
                  <td className="px-3 py-2 border-r border-amber-200 text-right font-semibold text-amber-700 bg-amber-50/40 tabular-nums whitespace-nowrap">
                    {fmtW(holidayAllowance)}
                  </td>

                  {/* 휴일근로시간 총 */}
                  <td className="px-3 py-2 border-r border-amber-100 text-center text-amber-700 font-medium tabular-nums bg-amber-50/20 whitespace-nowrap">
                    {fmtH(totalHoliday)}
                  </td>
                  {/* 휴일근로시간 월별 */}
                  {expanded.has('holiday') && months.map(mm => (
                    <td key={`hol-${mm}`} className="px-2 py-2 border-r border-amber-100 text-center text-amber-600 tabular-nums bg-amber-50/10 whitespace-nowrap">
                      {fmtH(holidayByMonth[mm] ?? 0)}
                    </td>
                  ))}

                  {/* 지각 총횟수 */}
                  <td className="px-3 py-2 border-r border-red-100 text-center text-red-700 font-medium tabular-nums bg-red-50/20 whitespace-nowrap">
                    {totalLate > 0 ? `${totalLate}회` : '—'}
                  </td>
                  {/* 지각 월별 */}
                  {expanded.has('late') && months.map(mm => (
                    <td key={`late-${mm}`} className="px-2 py-2 border-r border-red-100 text-center text-red-600 tabular-nums bg-red-50/10 whitespace-nowrap">
                      {(lateByMonth[mm] ?? 0) > 0 ? `${lateByMonth[mm]}회` : '—'}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Footnote ── */}
      <p className="text-[11px] text-gray-400">
        * 통상시급은 페이지 새로고침 시 초기화됩니다.
        수당 = 시간 × 통상시급. 직책자(직책 뱃지)는 rawOvertimeMinutes 기준(절사 없음)으로 연장근로 집계.
      </p>
    </div>
  )
}
