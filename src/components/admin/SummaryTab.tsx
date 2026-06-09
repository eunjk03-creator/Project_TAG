'use client'
import { useMemo, useState } from 'react'
import type { ProcessedRecord, Employee } from '@/types/tag'

// ── Types ──────────────────────────────────────────────────────────────────

interface Week {
  label: string   // '1주차'
  start: string   // '2026-06-01'
  end:   string   // '2026-06-07'
  range: string   // '6/1~6/7'
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function shortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function fmtH(h: number): string {
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(2)}h`
}

function generateWeeks(from: string, to: string): Week[] {
  const weeks: Week[] = []
  const fromDate = new Date(from + 'T12:00')
  const toDate   = new Date(to   + 'T12:00')

  // Roll back to Monday on-or-before 'from'
  let cur = new Date(fromDate)
  const dow = cur.getDay() // 0=Sun
  if (dow !== 1) cur.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1))
  if (cur < fromDate) cur = new Date(fromDate)

  let n = 1
  while (cur <= toDate) {
    const start = new Date(cur)
    // Sunday of this week
    const curDow = start.getDay()
    const daysToSun = curDow === 0 ? 0 : 7 - curDow
    const end = new Date(start)
    end.setDate(end.getDate() + daysToSun)
    const actualEnd = end > toDate ? new Date(toDate) : end

    weeks.push({
      label: `${n}주차`,
      start: isoDate(start),
      end:   isoDate(actualEnd),
      range: `${shortDate(isoDate(start))}~${shortDate(isoDate(actualEnd))}`,
    })

    const next = new Date(actualEnd)
    next.setDate(next.getDate() + 1)
    cur = next
    n++
  }
  return weeks
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  records:   ProcessedRecord[]
  employees: Employee[]
  dateFrom:  string
  dateTo:    string
}

export function SummaryTab({ records, employees, dateFrom, dateTo }: Props) {
  const weeks = useMemo(() => generateWeeks(dateFrom, dateTo), [dateFrom, dateTo])
  const [selectedWeek, setSelectedWeek] = useState<Week | null>(null)

  const empMap = useMemo(
    () => new Map(employees.map(e => [e.id, e])),
    [employees],
  )

  const scopedRecords = useMemo(() => {
    if (!selectedWeek) return records
    return records.filter(r => r.date >= selectedWeek.start && r.date <= selectedWeek.end)
  }, [records, selectedWeek])

  // ── 섹션 1: 휴일근무 현황 ────────────────────────────────────────────────

  const holidayData = useMemo(() => {
    const hrs = scopedRecords.filter(r => r.finalStatus === '휴일근무')

    const dates = [...new Set(hrs.map(r => r.date))].sort()

    type DivRow = {
      division:   string
      empIds:     Set<string>
      dateCounts: Record<string, number>
      totalHours: number
    }
    const divMap = new Map<string, DivRow>()

    for (const r of hrs) {
      const div = empMap.get(r.employeeId)?.division ?? '—'
      if (!divMap.has(div)) {
        divMap.set(div, { division: div, empIds: new Set(), dateCounts: {}, totalHours: 0 })
      }
      const row = divMap.get(div)!
      row.empIds.add(r.employeeId)
      row.dateCounts[r.date] = (row.dateCounts[r.date] ?? 0) + 1
      row.totalHours += r.holidayHours
    }

    // Sort rows by division; build names per div
    const rows = [...divMap.values()]
      .sort((a, b) => a.division.localeCompare(b.division))
      .map(row => ({
        ...row,
        names: [...row.empIds]
          .map(id => empMap.get(id)?.name ?? id)
          .sort(),
      }))

    const totalEmpIds  = new Set(hrs.map(r => r.employeeId))
    const totalHours   = hrs.reduce((s, r) => s + r.holidayHours, 0)
    const totalPerDate: Record<string, number> = {}
    for (const d of dates) totalPerDate[d] = hrs.filter(r => r.date === d).length

    return { dates, rows, totalEmpIds, totalHours, totalPerDate }
  }, [scopedRecords, empMap])

  // ── 섹션 2: 주 52시간 초과자 ────────────────────────────────────────────

  const over52Data = useMemo(() => {
    if (!selectedWeek) return null

    type Agg = { baseH: number; holidayH: number }
    const empAgg = new Map<string, Agg>()

    for (const r of scopedRecords) {
      if (!empAgg.has(r.employeeId)) empAgg.set(r.employeeId, { baseH: 0, holidayH: 0 })
      const a = empAgg.get(r.employeeId)!
      a.baseH    += r.regularHours + r.overtimeHours
      a.holidayH += r.holidayHours
    }

    type DivRow = { division: string; noHoliday: string[]; withHoliday: string[] }
    const divMap = new Map<string, DivRow>()

    for (const [empId, agg] of empAgg) {
      const total = agg.baseH + agg.holidayH
      if (agg.baseH <= 52 && total <= 52) continue
      const div  = empMap.get(empId)?.division ?? '—'
      const name = empMap.get(empId)?.name ?? empId
      if (!divMap.has(div)) divMap.set(div, { division: div, noHoliday: [], withHoliday: [] })
      const row = divMap.get(div)!
      if (agg.baseH > 52) row.noHoliday.push(name)
      else                row.withHoliday.push(name)
    }

    const rows = [...divMap.values()].sort((a, b) => a.division.localeCompare(b.division))
    return {
      rows,
      totalNo:   rows.reduce((s, r) => s + r.noHoliday.length,   0),
      totalWith: rows.reduce((s, r) => s + r.withHoliday.length, 0),
    }
  }, [scopedRecords, empMap, selectedWeek])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 py-5 space-y-6 overflow-auto">

      {/* 주차 선택 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setSelectedWeek(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            !selectedWeek
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
          }`}
        >
          전체
        </button>
        {weeks.map(w => (
          <button
            key={w.label}
            onClick={() => setSelectedWeek(selectedWeek?.label === w.label ? null : w)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              selectedWeek?.label === w.label
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
            }`}
          >
            {w.label}&nbsp;<span className="opacity-60">{w.range}</span>
          </button>
        ))}
      </div>

      {/* ── 섹션1: 휴일근무 현황 ── */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">
          휴일근무 현황
          {selectedWeek && (
            <span className="ml-2 text-xs font-normal text-gray-400">{selectedWeek.range}</span>
          )}
        </h3>

        {holidayData.rows.length === 0 ? (
          <div className="text-sm text-gray-400 py-8 text-center rounded-xl border border-dashed border-gray-200">
            {selectedWeek ? `${selectedWeek.range} 기간에 휴일근무 기록이 없습니다` : '휴일근무 기록이 없습니다'}
          </div>
        ) : (
          <div className="overflow-auto rounded-xl border border-gray-200">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">부서</th>
                  <th className="px-3 py-2.5 text-center font-semibold whitespace-nowrap">인원</th>
                  {holidayData.dates.map(d => (
                    <th key={d} className="px-3 py-2.5 text-center font-semibold whitespace-nowrap">
                      {shortDate(d)}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-center font-semibold whitespace-nowrap">근무합</th>
                  <th className="px-3 py-2.5 text-left font-semibold min-w-[160px]">대상자</th>
                </tr>
              </thead>
              <tbody>
                {holidayData.rows.map((row, i) => (
                  <tr key={row.division}
                    className={`border-b border-gray-100 last:border-0 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}`}
                  >
                    <td className="px-3 py-2 font-medium text-gray-700 whitespace-nowrap">{row.division}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{row.empIds.size}명</td>
                    {holidayData.dates.map(d => (
                      <td key={d} className="px-3 py-2 text-center text-gray-600">
                        {row.dateCounts[d] ? `${row.dateCounts[d]}건` : '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-center font-semibold text-blue-700 whitespace-nowrap">
                      {fmtH(row.totalHours)}
                    </td>
                    <td className="px-3 py-2 text-gray-600 leading-relaxed">{row.names.join(', ')}</td>
                  </tr>
                ))}
                <tr className="bg-gray-100 border-t-2 border-gray-300 font-semibold text-gray-700">
                  <td className="px-3 py-2">합계</td>
                  <td className="px-3 py-2 text-center">{holidayData.totalEmpIds.size}명</td>
                  {holidayData.dates.map(d => (
                    <td key={d} className="px-3 py-2 text-center">{holidayData.totalPerDate[d]}건</td>
                  ))}
                  <td className="px-3 py-2 text-center text-blue-700">{fmtH(holidayData.totalHours)}</td>
                  <td className="px-3 py-2" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 섹션2: 주 52시간 초과자 (주차 선택 시만) ── */}
      {selectedWeek && over52Data && (
        <section>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            주 52시간 초과자
            <span className="ml-2 text-xs font-normal text-gray-400">{selectedWeek.range}</span>
          </h3>

          {over52Data.rows.length === 0 ? (
            <div className="text-sm text-gray-400 py-8 text-center rounded-xl border border-dashed border-gray-200">
              52시간 초과자가 없습니다
            </div>
          ) : (
            <div className="overflow-auto rounded-xl border border-gray-200">
              <table className="text-xs w-full border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="px-3 py-2.5 text-left font-semibold border-b border-gray-200" rowSpan={2}>부서</th>
                    <th className="px-3 py-2.5 text-center font-semibold border-b border-gray-100 border-r border-gray-200" colSpan={2}>인원</th>
                    <th className="px-3 py-2.5 text-center font-semibold border-b border-gray-100" colSpan={2}>대상자</th>
                  </tr>
                  <tr className="bg-gray-50 border-b border-gray-200 text-gray-500">
                    <th className="px-3 py-2 text-center font-medium">휴일근로 미포함</th>
                    <th className="px-3 py-2 text-center font-medium border-r border-gray-200">휴일근로 포함</th>
                    <th className="px-3 py-2 text-center font-medium">미포함</th>
                    <th className="px-3 py-2 text-center font-medium">포함</th>
                  </tr>
                </thead>
                <tbody>
                  {over52Data.rows.map((row, i) => (
                    <tr key={row.division}
                      className={`border-b border-gray-100 last:border-0 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}`}
                    >
                      <td className="px-3 py-2 font-medium text-gray-700 whitespace-nowrap">{row.division}</td>
                      <td className="px-3 py-2 text-center text-gray-700 font-medium">
                        {row.noHoliday.length || '—'}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-700 font-medium border-r border-gray-200">
                        {row.withHoliday.length || '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {row.noHoliday.join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {row.withHoliday.join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-100 border-t-2 border-gray-300 font-semibold text-gray-700">
                    <td className="px-3 py-2">합계</td>
                    <td className="px-3 py-2 text-center">{over52Data.totalNo || '—'}</td>
                    <td className="px-3 py-2 text-center border-r border-gray-200">{over52Data.totalWith || '—'}</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

    </div>
  )
}
