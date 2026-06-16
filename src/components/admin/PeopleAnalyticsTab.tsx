'use client'

import { useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts'
import type { ProcessedRecord, Employee } from '@/types/tag'
import { computeWorkA, computeDisplayBreakMins, parseTimeToMins } from '@/utils/attendanceCalc'

interface Props {
  records:   ProcessedRecord[]
  employees: Employee[]
  dateFrom:  string
  dateTo:    string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function weekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function computeFinalWorkH(r: ProcessedRecord): number {
  const leaveCredit = (r.isUnpaidLeave ? 0 : (r.erpLeaveAmount ?? 0)) * 8
  const effIn = r.effectiveClockIn ?? r.clockIn
  if (!effIn || !r.clockOut) return leaveCredit
  const ci = parseTimeToMins(effIn)
  const co = parseTimeToMins(r.clockOut)
  if (ci === null || co === null) return leaveCredit
  const wAMins = Math.round(computeWorkA(effIn, r.clockOut) * 60)
  const brk    = computeDisplayBreakMins(wAMins, ci, co, r.leaveType ?? undefined)
  return Math.max(0, wAMins - brk) / 60 + leaveCredit
}

function minsToHHMM(m: number): string {
  const hh = Math.floor(m / 60)
  const mm  = m % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const i = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - i) + sorted[hi] * (i - lo)
}

// ── Sub-components ─────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${accent ?? 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

function ChartBox({ title, sub, children, fullWidth }: {
  title: string; sub?: string; children: React.ReactNode; fullWidth?: boolean
}) {
  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-4 ${fullWidth ? 'col-span-2' : ''}`}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {sub && <p className="text-xs text-gray-400">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

const CHART_H = 220
const TH = 'px-3 py-2.5 text-xs font-semibold whitespace-nowrap'
const TD = 'px-3 py-1.5 text-xs tabular-nums'

// ── Main ───────────────────────────────────────────────────────────────────

export function PeopleAnalyticsTab({ records, employees }: Props) {
  const empDivMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of employees) if (e.division) m.set(e.id, e.division)
    return m
  }, [employees])

  const workdayRecs = useMemo(
    () => records.filter(r => r.dayType === 'WEEKDAY'),
    [records],
  )

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let totalWorkH = 0, totalOtH = 0, lateCnt = 0, days = 0
    const empWeekH = new Map<string, Map<string, number>>()

    for (const r of workdayRecs) {
      const h = computeFinalWorkH(r)
      totalWorkH += h
      totalOtH   += Math.max(0, h - 8)
      days++
      const f = r.flag ?? ''
      if (f === 'LATE' || f === 'LATE_AND_EARLY_DEPARTURE' || f === 'LATE_AND_ANOMALY') lateCnt++
      const wk = weekMonday(r.date)
      if (!empWeekH.has(r.employeeId)) empWeekH.set(r.employeeId, new Map())
      const wm = empWeekH.get(r.employeeId)!
      wm.set(wk, (wm.get(wk) ?? 0) + h)
    }

    const allWeekH: number[] = []
    for (const [, wm] of empWeekH) for (const [, h] of wm) allWeekH.push(h)
    const avgWeeklyH = allWeekH.length > 0 ? allWeekH.reduce((a, b) => a + b, 0) / allWeekH.length : 0

    return {
      totalWorkH,
      totalOtH,
      lateRate:  days > 0 ? lateCnt / days * 100 : 0,
      avgWeeklyH,
    }
  }, [workdayRecs])

  // ── Monthly trends ─────────────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    type Agg = { workH: number; otH: number; nightH: number; holidayH: number; lateCnt: number; days: number }
    const map = new Map<string, Agg>()

    for (const r of records) {
      const ym = r.date.slice(0, 7)
      if (!map.has(ym)) map.set(ym, { workH: 0, otH: 0, nightH: 0, holidayH: 0, lateCnt: 0, days: 0 })
      const agg = map.get(ym)!
      if (r.dayType === 'WEEKDAY') {
        const h = computeFinalWorkH(r)
        agg.workH  += h
        agg.otH    += Math.max(0, h - 8)
        agg.nightH += r.nightHours ?? 0
        agg.days++
        const f = r.flag ?? ''
        if (f === 'LATE' || f === 'LATE_AND_EARLY_DEPARTURE' || f === 'LATE_AND_ANOMALY') agg.lateCnt++
      }
      if (r.finalStatus === '휴일근무') agg.holidayH += r.holidayHours ?? 0
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ym, a]) => ({
        month:    `${parseInt(ym.slice(5))}월`,
        workH:    Math.round(a.workH - a.otH),
        otH:      Math.round(a.otH),
        nightH:   Math.round(a.nightH),
        holidayH: Math.round(a.holidayH),
        lateRate: a.days > 0 ? +(a.lateCnt / a.days * 100).toFixed(1) : 0,
      }))
  }, [records])

  // ── Weekly hours distribution histogram ───────────────────────────────────
  const weeklyDist = useMemo(() => {
    const empWeekH = new Map<string, Map<string, number>>()
    for (const r of workdayRecs) {
      const wk = weekMonday(r.date)
      if (!empWeekH.has(r.employeeId)) empWeekH.set(r.employeeId, new Map())
      const wm = empWeekH.get(r.employeeId)!
      wm.set(wk, (wm.get(wk) ?? 0) + computeFinalWorkH(r))
    }
    const bins = [
      { label: '~40h', min: 0,  max: 40,       count: 0 },
      { label: '40~45h', min: 40, max: 45,      count: 0 },
      { label: '45~50h', min: 45, max: 50,      count: 0 },
      { label: '50~52h', min: 50, max: 52,      count: 0 },
      { label: '52h 초과', min: 52, max: Infinity, count: 0 },
    ]
    for (const [, wm] of empWeekH) {
      for (const [, h] of wm) {
        const b = bins.find(x => h >= x.min && h < x.max)
        if (b) b.count++
      }
    }
    return bins.map(({ label, count }) => ({ label, count }))
  }, [workdayRecs])

  // ── Division average weekly hours ──────────────────────────────────────────
  const divWeeklyAvg = useMemo(() => {
    const divEmpW = new Map<string, Map<string, Map<string, number>>>()
    for (const r of workdayRecs) {
      const div = empDivMap.get(r.employeeId) ?? '미분류'
      const wk  = weekMonday(r.date)
      if (!divEmpW.has(div)) divEmpW.set(div, new Map())
      const em = divEmpW.get(div)!
      if (!em.has(r.employeeId)) em.set(r.employeeId, new Map())
      const wm = em.get(r.employeeId)!
      wm.set(wk, (wm.get(wk) ?? 0) + computeFinalWorkH(r))
    }
    const result: { division: string; avgH: number }[] = []
    for (const [div, em] of divEmpW) {
      const all: number[] = []
      for (const [, wm] of em) for (const [, h] of wm) all.push(h)
      result.push({
        division: div,
        avgH: all.length > 0 ? +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1) : 0,
      })
    }
    return result.sort((a, b) => b.avgH - a.avgH)
  }, [workdayRecs, empDivMap])

  // ── Division clock-in/out distribution ────────────────────────────────────
  const clockStats = useMemo(() => {
    const divTimes = new Map<string, { ins: number[]; outs: number[] }>()
    for (const r of workdayRecs) {
      const effIn = r.effectiveClockIn ?? r.clockIn
      if (!effIn || !r.clockOut) continue
      const ciM = parseTimeToMins(effIn)
      const coM = parseTimeToMins(r.clockOut)
      if (ciM === null || coM === null) continue
      const div = empDivMap.get(r.employeeId) ?? '미분류'
      if (!divTimes.has(div)) divTimes.set(div, { ins: [], outs: [] })
      const t = divTimes.get(div)!
      t.ins.push(ciM)
      t.outs.push(coM < ciM ? coM + 1440 : coM)
    }
    return Array.from(divTimes.entries())
      .map(([division, { ins, outs }]) => ({
        division,
        inQ1:  Math.round(pct(ins,  25)),
        inMed: Math.round(pct(ins,  50)),
        inQ3:  Math.round(pct(ins,  75)),
        outQ1:  Math.round(pct(outs, 25)),
        outMed: Math.round(pct(outs, 50)),
        outQ3:  Math.round(pct(outs, 75)),
      }))
      .sort((a, b) => a.inMed - b.inMed)
  }, [workdayRecs, empDivMap])

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-400">
        <p className="text-sm">근태 데이터를 먼저 업로드해주세요.</p>
      </div>
    )
  }

  const noMonthly = monthlyData.length === 0
  const divH = Math.max(200, divWeeklyAvg.length * 36)

  return (
    <div className="p-6 space-y-6">

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard
          label="총 근무시간"
          value={`${Math.round(kpis.totalWorkH).toLocaleString()}h`}
          sub="연장 포함 합산"
        />
        <KpiCard
          label="총 연장근로시간"
          value={`${Math.round(kpis.totalOtH).toLocaleString()}h`}
          sub="8h 초과분 합산"
          accent="text-amber-600"
        />
        <KpiCard
          label="지각률"
          value={`${kpis.lateRate.toFixed(1)}%`}
          sub="지각 / 전체 출근일"
          accent={kpis.lateRate > 5 ? 'text-red-600' : undefined}
        />
        <KpiCard
          label="평균 주당 근무시간"
          value={`${kpis.avgWeeklyH.toFixed(1)}h`}
          sub="1인 1주 평균"
          accent={kpis.avgWeeklyH > 52 ? 'text-red-600' : undefined}
        />
      </div>

      {/* ── Row 2: 월별 추이 ── */}
      <div className="grid grid-cols-2 gap-4">

        <ChartBox title="월별 근무 & 초과 추이" sub="전체 인원 합산 (h)">
          {noMonthly ? <Empty /> : (
            <ResponsiveContainer width="100%" height={CHART_H}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v, n) => [`${Number(v)}h`, String(n) === 'workH' ? '정규 근무' : '연장 근무']}
                />
                <Legend
                  formatter={(v: string) => v === 'workH' ? '정규 근무' : '연장 근무'}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="workH" stackId="a" fill="#93c5fd" name="workH" />
                <Bar dataKey="otH"   stackId="a" fill="#f59e0b" name="otH"   />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartBox>

        <ChartBox title="월별 야간 & 휴일 근무" sub="전체 인원 합산 (h)">
          {noMonthly ? <Empty /> : (
            <ResponsiveContainer width="100%" height={CHART_H}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v, n) => [`${Number(v)}h`, String(n) === 'nightH' ? '야간 근무' : '휴일 근무']}
                />
                <Legend
                  formatter={(v: string) => v === 'nightH' ? '야간 근무' : '휴일 근무'}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="nightH"   fill="#8b5cf6" name="nightH"   />
                <Bar dataKey="holidayH" fill="#10b981" name="holidayH" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartBox>
      </div>

      {/* ── Row 3: 지각률 + 주당 근무 분포 ── */}
      <div className="grid grid-cols-2 gap-4">

        <ChartBox title="월별 지각률 추이" sub="지각 건수 / 전체 출근일 (%)">
          {noMonthly ? <Empty /> : (
            <ResponsiveContainer width="100%" height={CHART_H}>
              <LineChart data={monthlyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="%" />
                <Tooltip formatter={(v) => [`${Number(v)}%`, '지각률']} />
                <ReferenceLine
                  y={5}
                  stroke="#fca5a5"
                  strokeDasharray="4 4"
                  label={{ value: '5%', fontSize: 10, fill: '#ef4444' }}
                />
                <Line
                  dataKey="lateRate"
                  stroke="#ef4444"
                  dot={{ r: 3 }}
                  strokeWidth={2}
                  name="지각률"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartBox>

        <ChartBox title="주당 근무시간 분포" sub="1인 × 1주 합산 기준 (건수)">
          {weeklyDist.every(d => d.count === 0) ? <Empty /> : (
            <ResponsiveContainer width="100%" height={CHART_H}>
              <BarChart data={weeklyDist} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => [`${Number(v)}건`, '주-인원 수']} />
                <Bar dataKey="count" name="주-인원 수" radius={[3, 3, 0, 0]}>
                  {weeklyDist.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={
                        entry.label === '52h 초과' ? '#ef4444' :
                        entry.label === '50~52h'   ? '#f97316' :
                        '#60a5fa'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartBox>
      </div>

      {/* ── Row 4: 부서별 평균 주당 근무시간 ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-gray-900">부서별 평균 주당 근무시간</h3>
          <p className="text-xs text-gray-400">1인 1주 평균 (h)</p>
        </div>
        {divWeeklyAvg.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={divH}>
            <BarChart
              data={divWeeklyAvg}
              layout="vertical"
              margin={{ top: 4, right: 40, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 'auto']} unit="h" />
              <YAxis dataKey="division" type="category" tick={{ fontSize: 11 }} width={84} />
              <Tooltip formatter={(v) => [`${Number(v)}h`, '평균 주당 근무']} />
              <ReferenceLine x={40} stroke="#94a3b8" strokeDasharray="4 4"
                label={{ value: '40h', fontSize: 10, fill: '#94a3b8', position: 'top' }} />
              <ReferenceLine x={52} stroke="#fca5a5" strokeDasharray="4 4"
                label={{ value: '52h', fontSize: 10, fill: '#ef4444', position: 'top' }} />
              <Bar dataKey="avgH" name="평균 주당 근무" radius={[0, 3, 3, 0]}>
                {divWeeklyAvg.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.avgH > 52 ? '#ef4444' : entry.avgH > 45 ? '#f97316' : '#60a5fa'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Row 5: 부서별 출퇴근 시간 분포 ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-gray-900">부서별 출퇴근 시간 분포</h3>
          <p className="text-xs text-gray-400">Q1 / 중앙값 / Q3 — 실제 태그 기준</p>
        </div>
        {clockStats.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-center">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={`${TH} text-left text-gray-700`}>본부</th>
                  <th className={`${TH} text-blue-700 bg-blue-50`}>출근 Q1</th>
                  <th className={`${TH} text-blue-900 bg-blue-50`}>출근 중앙값</th>
                  <th className={`${TH} text-blue-700 bg-blue-50`}>출근 Q3</th>
                  <th className={`${TH} text-gray-300`}>·</th>
                  <th className={`${TH} text-purple-700 bg-purple-50`}>퇴근 Q1</th>
                  <th className={`${TH} text-purple-900 bg-purple-50`}>퇴근 중앙값</th>
                  <th className={`${TH} text-purple-700 bg-purple-50`}>퇴근 Q3</th>
                </tr>
              </thead>
              <tbody>
                {clockStats.map(row => (
                  <tr key={row.division} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className={`${TD} text-left font-medium text-gray-800`}>{row.division}</td>
                    <td className={`${TD} text-blue-500`}>{minsToHHMM(row.inQ1)}</td>
                    <td className={`${TD} font-semibold text-blue-900`}>{minsToHHMM(row.inMed)}</td>
                    <td className={`${TD} text-blue-500`}>{minsToHHMM(row.inQ3)}</td>
                    <td className={`${TD} text-gray-300`}>·</td>
                    <td className={`${TD} text-purple-500`}>{minsToHHMM(row.outQ1)}</td>
                    <td className={`${TD} font-semibold text-purple-900`}>{minsToHHMM(row.outMed)}</td>
                    <td className={`${TD} text-purple-500`}>{minsToHHMM(row.outQ3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  )
}

function Empty() {
  return <p className="text-xs text-gray-400 py-8 text-center">데이터 없음</p>
}
