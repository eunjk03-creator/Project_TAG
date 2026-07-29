'use client'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useManagementMetrics } from '@/hooks/useManagementMetrics'
import { usePeriodRange, type PeriodGranularity } from '@/hooks/usePeriodRange'
import {
  buildDivisionAnomalyRollup, buildEmployeeAnomalyRollup, computeNormalRate,
  buildLeaveUsageRollup, buildTodayLeaveList,
  buildDailyOvertimeSeries, buildTodayOvertimeList,
} from '@/utils/overviewAggregations'
import type { Employee } from '@/types/tag'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PIE_COLORS = ['#3b82f6', '#e5e7eb'] // 정상(blue) / 이상(gray)

// ── Small shared UI bits ────────────────────────────────────────────────────

function CardShell({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-sm">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-400 text-center py-6">{text}</p>
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const { isLiveData } = useAttendanceSource()
  const { resolutions } = useAttendanceData()
  const period = usePeriodRange()

  const { records, employees, finalAttrMap, globalExclusionIds } =
    useProcessedAttendance(period.from, period.to)

  const visibleEmployees = useMemo(
    () => employees.filter(e => !globalExclusionIds.has(e.id)),
    [employees, globalExclusionIds],
  )
  const visibleIds = useMemo(() => new Set(visibleEmployees.map(e => e.id)), [visibleEmployees])
  const visibleRecords = useMemo(
    () => records.filter(r => visibleIds.has(r.employeeId)),
    [records, visibleIds],
  )
  const empMap = useMemo(
    () => new Map<string, Employee>(visibleEmployees.map(e => [e.id, e])),
    [visibleEmployees],
  )

  const approvedKeys = useMemo(() => new Set(Object.keys(resolutions)), [resolutions])
  const { metrics, total } = useManagementMetrics(
    visibleRecords, visibleEmployees, approvedKeys, period.from, period.to, finalAttrMap,
  )

  const today = todayStr()

  // ── 이상치 ──────────────────────────────────────────────────────────────
  const empAnomaly = useMemo(() => buildEmployeeAnomalyRollup(visibleRecords, empMap), [visibleRecords, empMap])
  const divAnomaly = useMemo(() => buildDivisionAnomalyRollup(visibleRecords, empMap), [visibleRecords, empMap])
  const normalRate = useMemo(() => computeNormalRate(visibleRecords), [visibleRecords])
  const anomalyTotals = useMemo(
    () => divAnomaly.reduce((s, r) => ({ late: s.late + r.late, shortage: s.shortage + r.shortage, notag: s.notag + r.notag, total: s.total + r.total }),
      { late: 0, shortage: 0, notag: 0, total: 0 }),
    [divAnomaly],
  )

  // ── 휴가 사용 ────────────────────────────────────────────────────────────
  const divLeave  = useMemo(() => buildLeaveUsageRollup(visibleRecords, empMap, 'division'), [visibleRecords, empMap])
  const empLeave  = useMemo(() => buildLeaveUsageRollup(visibleRecords, empMap, 'employee'),  [visibleRecords, empMap])
  const todayLeave = useMemo(() => buildTodayLeaveList(records, empMap, today), [records, empMap, today])
  const totalLeaveDays = useMemo(() => divLeave.reduce((s, r) => s + r.days, 0), [divLeave])

  // ── 초과근무 ────────────────────────────────────────────────────────────
  const dailyOt   = useMemo(() => buildDailyOvertimeSeries(visibleRecords, period.from, period.to), [visibleRecords, period.from, period.to])
  const todayOt   = useMemo(() => buildTodayOvertimeList(records, empMap, today), [records, empMap, today])
  const totalOtH  = total.otHours

  if (!isLiveData) {
    return (
      <div className="p-8">
        <EmptyNote text="데이터를 먼저 업로드해주세요." />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* ── Header: 기간 선택 ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">종합 현황</h1>
          <p className="text-xs text-gray-400 mt-0.5">이상치 · 휴가 · 초과근무를 한눈에</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {(['day', 'week', 'month'] as PeriodGranularity[]).map(g => (
              <button
                key={g}
                onClick={() => period.setGranularity(g)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  period.granularity === g ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {g === 'day' ? '일' : g === 'week' ? '주' : '월'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-1">
            <button onClick={() => period.shift(-1)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-50">
              ‹
            </button>
            <span className="text-xs font-medium text-gray-700 px-1.5 min-w-[120px] text-center tabular-nums">{period.label}</span>
            <button onClick={() => period.shift(1)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-md hover:bg-gray-50">
              ›
            </button>
          </div>
          <button
            onClick={period.goToday}
            className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            오늘
          </button>
        </div>
      </div>

      {/* ── 이상치 카드 ── */}
      <CardShell icon="⚠️" title="이상치 (지각·근무시간미달·미태깅)">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex items-center gap-4 bg-blue-600 rounded-xl px-5 py-4 text-white">
            <div className="w-20 h-20 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[{ value: normalRate.normal }, { value: Math.max(0, normalRate.total - normalRate.normal) }]}
                    dataKey="value" innerRadius={26} outerRadius={38} startAngle={90} endAngle={-270} stroke="none"
                  >
                    {PIE_COLORS.map((c, i) => <Cell key={i} fill={i === 0 ? '#ffffff' : 'rgba(255,255,255,0.25)'} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-[11px] opacity-80">정상 출근율</p>
              <p className="text-2xl font-bold tabular-nums">{normalRate.pct.toFixed(1)}%</p>
              <p className="text-[11px] opacity-70 tabular-nums">({normalRate.normal}/{normalRate.total})</p>
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl px-5 py-4 flex flex-col justify-center gap-2">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide">이상 건수 합계</p>
            <div className="flex items-center gap-4">
              <div><span className="text-lg font-bold text-amber-600 tabular-nums">{anomalyTotals.late}</span><span className="text-[11px] text-gray-400 ml-1">지각</span></div>
              <div><span className="text-lg font-bold text-red-600 tabular-nums">{anomalyTotals.shortage}</span><span className="text-[11px] text-gray-400 ml-1">미달</span></div>
              <div><span className="text-lg font-bold text-purple-600 tabular-nums">{anomalyTotals.notag}</span><span className="text-[11px] text-gray-400 ml-1">미태깅</span></div>
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl px-5 py-4">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">부서별 TOP3</p>
            {divAnomaly.length === 0 ? <p className="text-xs text-gray-300">이상 없음</p> : (
              <ul className="space-y-1">
                {divAnomaly.slice(0, 3).map(r => (
                  <li key={r.key} className="flex items-center justify-between text-xs">
                    <span className="text-gray-600 truncate">{r.label}</span>
                    <span className="font-semibold text-gray-800 tabular-nums">{r.total}건</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {empAnomaly.length === 0 ? <EmptyNote text="이 기간엔 이상치가 없습니다." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-gray-400">
                  <th className="text-left py-2 font-medium">부서</th>
                  <th className="text-left py-2 font-medium">이름</th>
                  <th className="text-right py-2 font-medium">지각</th>
                  <th className="text-right py-2 font-medium">근무시간 미달</th>
                  <th className="text-right py-2 font-medium">미태깅</th>
                  <th className="text-right py-2 font-medium">총합계</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {empAnomaly.map(r => (
                  <tr key={r.key} className="hover:bg-gray-50/70">
                    <td className="py-1.5 text-gray-500">{r.division}</td>
                    <td className="py-1.5 font-medium text-gray-800">{r.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.late || '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.shortage || '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.notag || '—'}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardShell>

      {/* ── 휴가 사용 카드 ── */}
      <CardShell icon="🏖️" title="휴가 사용내역">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-gray-50 rounded-xl px-5 py-4">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">
              부서별 사용일수 (합계 {totalLeaveDays.toFixed(1)}일)
            </p>
            {divLeave.length === 0 ? <p className="text-xs text-gray-300">사용 내역 없음</p> : (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={divLeave} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f3f4f6" />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v: unknown) => [`${Number(v ?? 0).toFixed(1)}일`, '사용일수']} />
                    <Bar dataKey="days" fill="#10b981" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="bg-gray-50 rounded-xl px-5 py-4">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">오늘 휴가 중</p>
            {todayLeave.length === 0 ? <p className="text-xs text-gray-300 py-4 text-center">오늘은 휴가 인원이 없습니다.</p> : (
              <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                {todayLeave.map(e => (
                  <li key={e.employeeId} className="flex items-center justify-between text-xs">
                    <span className="text-gray-700">{e.name} <span className="text-gray-300 text-[10px]">{e.division}</span></span>
                    <span className="text-emerald-600 font-medium">{e.leaveType}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {empLeave.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-gray-400">
                  <th className="text-left py-2 font-medium">부서</th>
                  <th className="text-left py-2 font-medium">이름</th>
                  <th className="text-right py-2 font-medium">사용일수</th>
                  <th className="text-right py-2 font-medium">건수</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {empLeave.map(r => (
                  <tr key={r.key} className="hover:bg-gray-50/70">
                    <td className="py-1.5 text-gray-500">{r.division}</td>
                    <td className="py-1.5 font-medium text-gray-800">{r.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.days.toFixed(1)}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardShell>

      {/* ── 초과근무 카드 ── */}
      <CardShell icon="⏱️" title="초과근무 (연장근로)">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-gray-50 rounded-xl px-5 py-4">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">
              일자별 초과근무 인원 (기간 합계 {fmtH(totalOtH)})
            </p>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyOt} margin={{ top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} angle={dailyOt.length > 10 ? -45 : 0} textAnchor={dailyOt.length > 10 ? 'end' : 'middle'} height={dailyOt.length > 10 ? 40 : 20} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: unknown) => [`${Number(v ?? 0)}명`, '초과근무']} />
                  <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl px-5 py-4">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">오늘 초과근무</p>
            {todayOt.length === 0 ? <p className="text-xs text-gray-300 py-4 text-center">배정된 초과근무가 없습니다.</p> : (
              <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                {todayOt.map(e => (
                  <li key={e.employeeId} className="flex items-center justify-between text-xs">
                    <span className="text-gray-700">{e.name} <span className="text-gray-300 text-[10px]">{e.division}</span></span>
                    <span className="text-blue-600 font-semibold tabular-nums">{fmtH(e.hours)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-gray-400">
                <th className="text-left py-2 font-medium">부서</th>
                <th className="text-right py-2 font-medium">인원</th>
                <th className="text-right py-2 font-medium">연장/야간/휴일 합계</th>
                <th className="text-right py-2 font-medium">주52h 초과</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {metrics.map(m => (
                <tr key={m.division} className="hover:bg-gray-50/70">
                  <td className="py-1.5 text-gray-700 font-medium">{m.division}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.headcount}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtH(m.otHours)}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.weeklyOver45 > 0 ? `${m.weeklyOver45}명` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardShell>
    </div>
  )
}

function fmtH(hours: number): string {
  if (!hours) return '0h'
  const m = Math.round(hours * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}
