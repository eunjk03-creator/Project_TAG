'use client'
import { useMemo, useState } from 'react'
import type { ProcessedRecord, Employee } from '@/types/tag'
import { DIVISION_ORDER } from '@/data/orgChart'
import { computeWorkA, computeWorkB, computeBreakH, computeFinalWork } from '@/utils/attendanceCalc'

// ── Types ──────────────────────────────────────────────────────────────────

interface Week {
  label: string
  start: string
  end:   string
  range: string
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

  let cur = new Date(fromDate)
  const dow = cur.getDay()
  if (dow !== 1) cur.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1))
  if (cur < fromDate) cur = new Date(fromDate)

  let n = 1
  while (cur <= toDate) {
    const start = new Date(cur)
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

// ── Style constants ────────────────────────────────────────────────────────

// Section accent bar colors
const SECTION_ACCENTS = {
  holiday:  'bg-amber-400',
  over52:   'bg-red-400',
  divAnomaly: 'bg-violet-400',
  empAnomaly: 'bg-rose-400',
}

// Anomaly column: header bg / header text / value text
const ANOMALY_COL = {
  late:     { hBg: 'bg-amber-50',  hTxt: 'text-amber-900',  vTxt: 'text-amber-700'  },
  early:    { hBg: 'bg-orange-50', hTxt: 'text-orange-900', vTxt: 'text-orange-700' },
  shortage: { hBg: 'bg-sky-50',    hTxt: 'text-sky-900',    vTxt: 'text-sky-700'    },
  notag:    { hBg: 'bg-rose-50',   hTxt: 'text-rose-900',   vTxt: 'text-rose-700'   },
  mixed:    { hBg: 'bg-violet-50', hTxt: 'text-violet-900', vTxt: 'text-violet-600' },
  total:    { hBg: 'bg-slate-200', hTxt: 'text-slate-900',  vTxt: 'text-slate-900'  },
}

function SectionTitle({ accent, title, sub }: { accent: string; title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className={`w-1 h-4 rounded-full ${accent} shrink-0`} />
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {sub && <span className="text-xs font-normal text-gray-400">{sub}</span>}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-sm text-gray-400 py-8 text-center rounded-xl border border-dashed border-gray-200">
      {text}
    </div>
  )
}

const TH_BASE  = 'px-3 py-2.5 text-center font-semibold whitespace-nowrap text-xs'
const TH_LEFT  = 'px-3 py-2.5 text-left  font-semibold whitespace-nowrap text-xs'
const TD_BASE  = 'px-3 py-2   text-center text-xs tabular-nums'
const TD_LEFT  = 'px-3 py-2   text-left   text-xs'
const TOTAL_ROW = 'bg-slate-100 border-t-2 border-slate-300'

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

  // ── 섹션1: 휴일근무 현황 ─────────────────────────────────────────────────

  const holidayData = useMemo(() => {
    const hrs = scopedRecords.filter(r => r.finalStatus === '휴일근무')
    const dates = [...new Set(hrs.map(r => r.date))].sort()

    type DivRow = { division: string; empIds: Set<string>; dateCounts: Record<string, number>; totalHours: number }
    const divMap = new Map<string, DivRow>()

    for (const r of hrs) {
      const div = empMap.get(r.employeeId)?.division ?? '—'
      if (!divMap.has(div)) divMap.set(div, { division: div, empIds: new Set(), dateCounts: {}, totalHours: 0 })
      const row = divMap.get(div)!
      row.empIds.add(r.employeeId)
      row.dateCounts[r.date] = (row.dateCounts[r.date] ?? 0) + 1
      row.totalHours += r.holidayHours
    }

    const rows = [...divMap.values()]
      .sort((a, b) => {
        const ai = DIVISION_ORDER.indexOf(a.division), bi = DIVISION_ORDER.indexOf(b.division)
        if (ai === -1 && bi === -1) return a.division.localeCompare(b.division, 'ko')
        return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
      })
      .map(row => ({ ...row, names: [...row.empIds].map(id => empMap.get(id)?.name ?? id).sort() }))

    const totalEmpIds  = new Set(hrs.map(r => r.employeeId))
    const totalHours   = hrs.reduce((s, r) => s + r.holidayHours, 0)
    const totalPerDate: Record<string, number> = {}
    for (const d of dates) totalPerDate[d] = hrs.filter(r => r.date === d).length

    return { dates, rows, totalEmpIds, totalHours, totalPerDate }
  }, [scopedRecords, empMap])

  // ── 섹션2: 주 52시간 초과자 ──────────────────────────────────────────────

  const over52Data = useMemo(() => {
    if (!selectedWeek) return null

    type Agg = { baseH: number; holidayH: number }
    const empAgg = new Map<string, Agg>()

    for (const r of scopedRecords) {
      if (!empAgg.has(r.employeeId)) empAgg.set(r.employeeId, { baseH: 0, holidayH: 0 })
      const a = empAgg.get(r.employeeId)!
      if (r.dayType === 'WEEKDAY') {
        const workA      = computeWorkA(r.effectiveClockIn ?? r.clockIn, r.clockOut)
        const workB      = computeWorkB(workA, r.erpLeaveAmount ?? 0, r.isUnpaidLeave ?? false)
        const finalWorkH = computeFinalWork(workB, computeBreakH(workB))
        a.baseH += finalWorkH
      } else {
        a.holidayH += r.holidayHours
      }
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

    const rows = [...divMap.values()].sort((a, b) => {
      const ai = DIVISION_ORDER.indexOf(a.division), bi = DIVISION_ORDER.indexOf(b.division)
      if (ai === -1 && bi === -1) return a.division.localeCompare(b.division, 'ko')
      return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
    })
    return {
      rows,
      totalNo:   rows.reduce((s, r) => s + r.noHoliday.length,   0),
      totalWith: rows.reduce((s, r) => s + r.withHoliday.length, 0),
    }
  }, [scopedRecords, empMap, selectedWeek])

  function divSort<T extends { division: string }>(arr: T[]): T[] {
    return [...arr].sort((a, b) => {
      const ai = DIVISION_ORDER.indexOf(a.division), bi = DIVISION_ORDER.indexOf(b.division)
      if (ai === -1 && bi === -1) return a.division.localeCompare(b.division, 'ko')
      return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
    })
  }

  // ── 섹션3: 부서별 이상치 ─────────────────────────────────────────────────

  type AnomalyCounts = { late: number; early: number; shortage: number; notag: number; mixed: number; total: number }

  function flagToCategories(flag: string): Array<keyof Omit<AnomalyCounts, 'total'>> {
    if (flag === 'LATE')                     return ['late']
    if (flag === 'EARLY_DEPARTURE')          return ['early']
    if (flag === 'LATE_AND_EARLY_DEPARTURE') return ['late', 'early']
    if (flag === 'ATTENDANCE_ANOMALY')       return ['shortage']
    if (flag === 'LATE_AND_ANOMALY')         return ['late', 'shortage']
    if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') return ['notag']
    return ['mixed']
  }

  const divAnomalyData = useMemo(() => {
    type DivRow = AnomalyCounts & { division: string }
    const divMap = new Map<string, DivRow>()

    for (const r of scopedRecords) {
      if (!r.flag) continue
      const div = empMap.get(r.employeeId)?.division ?? '—'
      if (!divMap.has(div)) divMap.set(div, { division: div, late: 0, early: 0, shortage: 0, notag: 0, mixed: 0, total: 0 })
      const row = divMap.get(div)!
      for (const cat of flagToCategories(r.flag)) row[cat]++
      row.total++
    }

    const rows = divSort([...divMap.values()]).filter(r => r.total >= 10)
    const totals = rows.reduce<AnomalyCounts>(
      (s, r) => ({ late: s.late + r.late, early: s.early + r.early, shortage: s.shortage + r.shortage, notag: s.notag + r.notag, mixed: s.mixed + r.mixed, total: s.total + r.total }),
      { late: 0, early: 0, shortage: 0, notag: 0, mixed: 0, total: 0 },
    )
    return { rows, totals }
  }, [scopedRecords, empMap])

  // ── 섹션4: 개인별 근태이상 ───────────────────────────────────────────────

  const empAnomalyData = useMemo(() => {
    type EmpRow = AnomalyCounts & { division: string; name: string }
    const empMap2 = new Map<string, EmpRow>()

    for (const r of scopedRecords) {
      if (!r.flag) continue
      const emp  = empMap.get(r.employeeId)
      const div  = emp?.division ?? '—'
      const name = emp?.name ?? r.employeeId
      if (!empMap2.has(r.employeeId)) empMap2.set(r.employeeId, { division: div, name, late: 0, early: 0, shortage: 0, notag: 0, mixed: 0, total: 0 })
      const row = empMap2.get(r.employeeId)!
      for (const cat of flagToCategories(r.flag)) row[cat]++
      row.total++
    }

    const rows = divSort(
      [...empMap2.values()]
        .filter(r => r.total >= 3)
        .sort((a, b) => {
          const di = DIVISION_ORDER.indexOf(a.division) - DIVISION_ORDER.indexOf(b.division)
          return di !== 0 ? di : a.name.localeCompare(b.name, 'ko')
        }),
    )
    const totals = rows.reduce<AnomalyCounts>(
      (s, r) => ({ late: s.late + r.late, early: s.early + r.early, shortage: s.shortage + r.shortage, notag: s.notag + r.notag, mixed: s.mixed + r.mixed, total: s.total + r.total }),
      { late: 0, early: 0, shortage: 0, notag: 0, mixed: 0, total: 0 },
    )
    return { rows, totals }
  }, [scopedRecords, empMap])

  // ── Anomaly table renderer ─────────────────────────────────────────────

  function AnomalyValue({ v, col }: { v: number; col: keyof typeof ANOMALY_COL }) {
    const { vTxt } = ANOMALY_COL[col]
    if (v === 0) return <span className="text-gray-300">—</span>
    return <span className={`font-semibold ${vTxt}`}>{v}</span>
  }

  const ANOMALY_HEADERS = [
    { key: 'late'     as const, label: '지각'         },
    { key: 'early'    as const, label: '조기퇴근'     },
    { key: 'shortage' as const, label: '근무시간 미달' },
    { key: 'notag'    as const, label: '미태깅'       },
    { key: 'mixed'    as const, label: '혼합'         },
    { key: 'total'    as const, label: '총합계'       },
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 py-5 space-y-8 overflow-auto">

      {/* 주차 선택 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setSelectedWeek(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            !selectedWeek ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
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
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            {w.label}&nbsp;<span className="opacity-60">{w.range}</span>
          </button>
        ))}
      </div>

      {/* ── 섹션1: 휴일근무 현황 ── */}
      <section>
        <SectionTitle
          accent={SECTION_ACCENTS.holiday}
          title="휴일근무 현황"
          sub={selectedWeek?.range}
        />

        {holidayData.rows.length === 0 ? (
          <EmptyState text={selectedWeek ? `${selectedWeek.range} 기간에 휴일근무 기록이 없습니다` : '휴일근무 기록이 없습니다'} />
        ) : (
          <div className="overflow-auto rounded-xl border border-gray-200">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={`${TH_LEFT} bg-gray-100 border-r border-gray-200`}>부서</th>
                  <th className={`${TH_BASE} bg-gray-100 border-r border-gray-200`}>인원</th>
                  {holidayData.dates.map(d => (
                    <th key={d} className={`${TH_BASE} bg-amber-50 text-amber-900 border-r border-amber-100`}>
                      {shortDate(d)}
                    </th>
                  ))}
                  <th className={`${TH_BASE} bg-amber-100 text-amber-900 border-r border-amber-200`}>근무합</th>
                  <th className={`${TH_LEFT} bg-gray-100 min-w-[160px]`}>대상자</th>
                </tr>
              </thead>
              <tbody>
                {holidayData.rows.map((row, i) => (
                  <tr key={row.division} className={`border-b border-gray-100 last:border-0 ${i % 2 === 1 ? 'bg-gray-50/60' : 'bg-white'}`}>
                    <td className={`${TD_LEFT} border-r border-gray-100 font-semibold text-gray-800`}>{row.division}</td>
                    <td className={`${TD_BASE} border-r border-gray-100 text-gray-700`}>{row.empIds.size}명</td>
                    {holidayData.dates.map(d => (
                      <td key={d} className={`${TD_BASE} border-r border-amber-50 ${row.dateCounts[d] ? 'text-gray-800 font-medium' : 'text-gray-300'}`}>
                        {row.dateCounts[d] || '—'}
                      </td>
                    ))}
                    <td className={`${TD_BASE} border-r border-amber-100 font-bold text-amber-700`}>{fmtH(row.totalHours)}</td>
                    <td className={`${TD_LEFT} text-gray-500 leading-relaxed`}>{row.names.join(', ')}</td>
                  </tr>
                ))}
                <tr className={TOTAL_ROW}>
                  <td className={`${TD_LEFT} border-r border-slate-200 font-bold text-gray-900`}>합계</td>
                  <td className={`${TD_BASE} border-r border-slate-200 font-semibold text-gray-800`}>{holidayData.totalEmpIds.size}명</td>
                  {holidayData.dates.map(d => (
                    <td key={d} className={`${TD_BASE} border-r border-slate-200 font-semibold text-gray-800`}>{holidayData.totalPerDate[d]}</td>
                  ))}
                  <td className={`${TD_BASE} border-r border-slate-200 font-bold text-amber-700`}>{fmtH(holidayData.totalHours)}</td>
                  <td className={TD_LEFT} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 섹션2: 주 52시간 초과자 ── */}
      {selectedWeek && over52Data && (
        <section>
          <SectionTitle
            accent={SECTION_ACCENTS.over52}
            title="주 52시간 초과자"
            sub={selectedWeek.range}
          />

          {over52Data.rows.length === 0 ? (
            <EmptyState text="52시간 초과자가 없습니다" />
          ) : (
            <div className="overflow-auto rounded-xl border border-gray-200">
              <table className="text-xs w-full border-collapse">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className={`${TH_LEFT} bg-gray-100 border-r border-gray-200`} rowSpan={2}>부서</th>
                    <th className={`${TH_BASE} bg-orange-50 text-orange-900 border-b border-orange-100`} colSpan={2}>초과 인원</th>
                    <th className={`${TH_BASE} bg-red-50 text-red-900 border-b border-red-100`} colSpan={2}>대상자</th>
                  </tr>
                  <tr className="border-b border-gray-200">
                    <th className={`${TH_BASE} bg-orange-50 text-orange-800 border-r border-orange-100`}>휴일 미포함</th>
                    <th className={`${TH_BASE} bg-orange-50 text-orange-800 border-r border-orange-200`}>휴일 포함</th>
                    <th className={`${TH_BASE} bg-red-50 text-red-800 border-r border-red-100`}>미포함</th>
                    <th className={`${TH_BASE} bg-red-50 text-red-800`}>포함</th>
                  </tr>
                </thead>
                <tbody>
                  {over52Data.rows.map((row, i) => (
                    <tr key={row.division} className={`border-b border-gray-100 last:border-0 ${i % 2 === 1 ? 'bg-gray-50/60' : 'bg-white'}`}>
                      <td className={`${TD_LEFT} border-r border-gray-100 font-semibold text-gray-800`}>{row.division}</td>
                      <td className={`${TD_BASE} border-r border-orange-100 ${row.noHoliday.length ? 'font-bold text-orange-700' : 'text-gray-300'}`}>
                        {row.noHoliday.length || '—'}
                      </td>
                      <td className={`${TD_BASE} border-r border-orange-200 ${row.withHoliday.length ? 'font-bold text-red-700' : 'text-gray-300'}`}>
                        {row.withHoliday.length || '—'}
                      </td>
                      <td className={`${TD_LEFT} border-r border-red-100 text-gray-600`}>{row.noHoliday.join(', ') || '—'}</td>
                      <td className={`${TD_LEFT} text-gray-600`}>{row.withHoliday.join(', ') || '—'}</td>
                    </tr>
                  ))}
                  <tr className={TOTAL_ROW}>
                    <td className={`${TD_LEFT} border-r border-slate-200 font-bold text-gray-900`}>합계</td>
                    <td className={`${TD_BASE} border-r border-slate-200 font-bold ${over52Data.totalNo ? 'text-orange-700' : 'text-gray-400'}`}>
                      {over52Data.totalNo || '—'}
                    </td>
                    <td className={`${TD_BASE} border-r border-slate-200 font-bold ${over52Data.totalWith ? 'text-red-700' : 'text-gray-400'}`}>
                      {over52Data.totalWith || '—'}
                    </td>
                    <td className={TD_LEFT} /><td className={TD_LEFT} />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── 섹션3: 부서별 이상치 ── */}
      <section>
        <SectionTitle
          accent={SECTION_ACCENTS.divAnomaly}
          title="부서별 이상치 현황"
          sub={selectedWeek?.range}
        />
        <p className="text-xs text-gray-400 mb-3 -mt-1">이상치 합계 10건 이상 부서만 표시</p>

        {divAnomalyData.rows.length === 0 ? (
          <EmptyState text="이상치 10건 이상 부서가 없습니다" />
        ) : (
          <div className="overflow-auto rounded-xl border border-gray-200">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={`${TH_LEFT} bg-gray-100 border-r border-gray-200`}>부서</th>
                  {ANOMALY_HEADERS.map(({ key, label }) => (
                    <th key={key} className={`${TH_BASE} ${ANOMALY_COL[key].hBg} ${ANOMALY_COL[key].hTxt} border-r border-gray-100 last:border-r-0`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {divAnomalyData.rows.map((row, i) => (
                  <tr key={row.division} className={`border-b border-gray-100 last:border-0 ${i % 2 === 1 ? 'bg-gray-50/60' : 'bg-white'}`}>
                    <td className={`${TD_LEFT} border-r border-gray-100 font-semibold text-gray-800`}>{row.division}</td>
                    {ANOMALY_HEADERS.map(({ key }) => (
                      <td key={key} className={`${TD_BASE} border-r border-gray-100 last:border-r-0`}>
                        <AnomalyValue v={row[key]} col={key} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className={TOTAL_ROW}>
                  <td className={`${TD_LEFT} border-r border-slate-200 font-bold text-gray-900`}>합계</td>
                  {ANOMALY_HEADERS.map(({ key }) => (
                    <td key={key} className={`${TD_BASE} border-r border-slate-200 last:border-r-0 font-bold ${ANOMALY_COL[key].vTxt}`}>
                      {divAnomalyData.totals[key] || '—'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 섹션4: 개인별 근태이상 ── */}
      <section>
        <SectionTitle
          accent={SECTION_ACCENTS.empAnomaly}
          title="개인별 근태이상"
          sub={selectedWeek?.range}
        />
        <p className="text-xs text-gray-400 mb-3 -mt-1">이상치 합계 3건 이상 대상자만 표시</p>

        {empAnomalyData.rows.length === 0 ? (
          <EmptyState text="이상치 3건 이상 대상자가 없습니다" />
        ) : (
          <div className="overflow-auto rounded-xl border border-gray-200">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={`${TH_LEFT} bg-gray-100 border-r border-gray-100`}>부서</th>
                  <th className={`${TH_LEFT} bg-gray-100 border-r border-gray-200`}>이름</th>
                  {ANOMALY_HEADERS.map(({ key, label }) => (
                    <th key={key} className={`${TH_BASE} ${ANOMALY_COL[key].hBg} ${ANOMALY_COL[key].hTxt} border-r border-gray-100 last:border-r-0`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {empAnomalyData.rows.map((row, i) => (
                  <tr key={`${row.division}-${row.name}`} className={`border-b border-gray-100 last:border-0 ${i % 2 === 1 ? 'bg-gray-50/60' : 'bg-white'}`}>
                    <td className={`${TD_LEFT} border-r border-gray-100 text-gray-500`}>{row.division}</td>
                    <td className={`${TD_LEFT} border-r border-gray-200 font-semibold text-gray-800`}>{row.name}</td>
                    {ANOMALY_HEADERS.map(({ key }) => (
                      <td key={key} className={`${TD_BASE} border-r border-gray-100 last:border-r-0`}>
                        <AnomalyValue v={row[key]} col={key} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className={TOTAL_ROW}>
                  <td className={`${TD_LEFT} border-r border-slate-200 font-bold text-gray-900`} colSpan={2}>합계</td>
                  {ANOMALY_HEADERS.map(({ key }) => (
                    <td key={key} className={`${TD_BASE} border-r border-slate-200 last:border-r-0 font-bold ${ANOMALY_COL[key].vTxt}`}>
                      {empAnomalyData.totals[key] || '—'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  )
}
