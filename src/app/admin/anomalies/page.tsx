'use client'
import { useState, useMemo } from 'react'
import { ALL_RECORDS } from '@/data/mockData'
import { EMPLOYEES } from '@/data/orgChart'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { usePolicy } from '@/context/PolicyContext'
import { useOrgFilter } from '@/context/OrgFilterContext'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange } from '@/context/DateRangeContext'
import type { SieveFlag } from '@/types/tag'

const FLAG_LABEL: Record<string, string> = {
  LATE: '지각',
  NO_CLOCK_OUT: '퇴근 미태깅',
  UNAPPROVED_OT: 'OT 미신청',
  EARLY_DEPARTURE: '조기퇴근',
}

const FLAG_COLOR: Record<string, string> = {
  LATE: 'text-amber-700 bg-amber-50 border-amber-200',
  NO_CLOCK_OUT: 'text-red-700 bg-red-50 border-red-200',
  UNAPPROVED_OT: 'text-orange-700 bg-orange-50 border-orange-200',
  EARLY_DEPARTURE: 'text-blue-700 bg-blue-50 border-blue-200',
}

const FLAG_ROW: Record<string, string> = {
  LATE: 'bg-amber-50/50',
  NO_CLOCK_OUT: 'bg-red-50',
  UNAPPROVED_OT: 'bg-orange-50/40',
  EARLY_DEPARTURE: 'bg-blue-50/30',
}

const ALL_FLAGS: SieveFlag[] = ['LATE', 'NO_CLOCK_OUT', 'UNAPPROVED_OT', 'EARLY_DEPARTURE']

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`
}

function getOrgPath(emp: (typeof EMPLOYEES)[0]): string {
  const parts = [emp.division, emp.team]
  if (emp.part) parts.push(emp.part)
  return parts.join(' / ')
}

function memoKey(employeeId: string, date: string) {
  return `${employeeId}_${date}`
}

export default function AnomaliesPage() {
  const { policy } = usePolicy()
  const { division, team } = useOrgFilter()
  const { openDrawer } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()
  const [activeFlags, setActiveFlags] = useState<Set<SieveFlag>>(new Set(ALL_FLAGS))
  const [memos, setMemos] = useState<Record<string, string>>({})
  const [resolved, setResolved] = useState<Set<string>>(new Set())

  const { processed, flagCounts } = useAttendanceLogic(
    ALL_RECORDS,
    policy,
    dateRange.from,
    dateRange.to,
  )

  const scopedEmployeeIds = useMemo(() => {
    let emps = EMPLOYEES
    if (division) emps = emps.filter(e => e.division === division)
    if (team) emps = emps.filter(e => e.team === team)
    return new Set(emps.map(e => e.id))
  }, [division, team])

  const anomalyRecords = useMemo(
    () =>
      processed
        .filter(r =>
          scopedEmployeeIds.has(r.employeeId) &&
          r.flag !== null &&
          activeFlags.has(r.flag),
        )
        .sort((a, b) => b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId)),
    [processed, scopedEmployeeIds, activeFlags],
  )

  function toggleFlag(flag: SieveFlag) {
    setActiveFlags(prev => {
      const next = new Set(prev)
      next.has(flag) ? next.delete(flag) : next.add(flag)
      return next
    })
  }

  function toggleResolved(key: string) {
    setResolved(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const totalAnomalies = Object.values(flagCounts).reduce((a, b) => a + b, 0)
  const resolvedCount = resolved.size

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 shrink-0">
        <div className="shrink-0">
          <h1 className="text-base font-bold text-gray-900">이상치 관리</h1>
          <p className="text-xs text-gray-400">
            {totalAnomalies}건 감지 · {resolvedCount}건 처리완료
          </p>
        </div>
        <div className="ml-auto shrink-0">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {/* Flag type filter chips */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400 font-medium">유형 필터:</span>
          {ALL_FLAGS.map(flag => {
            const count = flagCounts[flag as keyof typeof flagCounts] ?? 0
            const isActive = activeFlags.has(flag)
            return (
              <button
                key={flag}
                onClick={() => toggleFlag(flag)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                  isActive
                    ? FLAG_COLOR[flag!]
                    : 'text-gray-400 border-gray-200 bg-white'
                }`}
              >
                {FLAG_LABEL[flag!]}
                <span className={`font-bold ${isActive ? '' : 'text-gray-400'}`}>{count}</span>
              </button>
            )
          })}
        </div>

        {/* Anomaly table */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">
              이상치 목록
              <span className="ml-2 text-xs font-normal text-gray-400">{anomalyRecords.length}건</span>
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-gray-500 border-b border-gray-200">
                  <th className="px-3 py-3 text-left font-medium">조직경로</th>
                  <th className="px-3 py-3 text-left font-medium">사번</th>
                  <th className="px-3 py-3 text-left font-medium">이름</th>
                  <th className="px-3 py-3 text-center font-medium">근무일자</th>
                  <th className="px-3 py-3 text-center font-medium">근무일명칭</th>
                  <th className="px-3 py-3 text-center font-medium">출근</th>
                  <th className="px-3 py-3 text-center font-medium">퇴근</th>
                  <th className="px-3 py-3 text-center font-medium">기본</th>
                  <th className="px-3 py-3 text-center font-medium text-amber-600">연장</th>
                  <th className="px-3 py-3 text-center font-medium text-indigo-600">야간</th>
                  <th className="px-3 py-3 text-center font-medium">총합</th>
                  <th className="px-3 py-3 text-left font-medium">인정</th>
                  <th className="px-3 py-3 text-left font-medium min-w-[180px]">메모 / 처리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {anomalyRecords.map((r, i) => {
                  const emp = EMPLOYEES.find(e => e.id === r.employeeId)
                  const isHoliday = r.dayType !== 'WEEKDAY'
                  const totalHours = r.regularHours + r.overtimeHours
                  const key = memoKey(r.employeeId, r.date)
                  const isResolved = resolved.has(key)
                  const rowBg = isResolved
                    ? 'bg-green-50/50'
                    : FLAG_ROW[r.flag!] ?? ''

                  return (
                    <tr key={i} className={`${rowBg} hover:brightness-95 transition-all`}>
                      <td className="px-3 py-2.5 text-gray-400 max-w-[160px] truncate">
                        {emp ? getOrgPath(emp) : r.employeeId}
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 font-mono tracking-tight">
                        {r.employeeId}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => openDrawer(r.employeeId)}
                          className="font-medium text-gray-800 hover:text-blue-600 hover:underline underline-offset-2 transition-colors text-left"
                        >
                          {emp?.name ?? r.employeeId}
                        </button>
                      </td>
                      <td className={`px-3 py-2.5 text-center ${isHoliday ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
                        {r.date}
                      </td>
                      <td className={`px-3 py-2.5 text-center ${isHoliday ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
                        {r.dayLabel ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">
                        {r.clockIn !== null ? r.clockIn : <span className="text-red-400">미태깅</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">
                        {r.clockOut !== null ? r.clockOut : <span className="text-red-400">미태깅</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{fmt(r.regularHours)}</td>
                      <td className="px-3 py-2.5 text-center">
                        {r.overtimeHours > 0
                          ? <span className="text-amber-600 font-semibold">{fmt(r.overtimeHours)}</span>
                          : <span className="text-gray-200">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {r.nightHours > 0
                          ? <span className="text-indigo-500">{fmt(r.nightHours)}</span>
                          : <span className="text-gray-200">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center font-medium text-gray-700">
                        {fmt(totalHours)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block text-xs px-1.5 py-0.5 rounded border font-medium ${FLAG_COLOR[r.flag!]}`}>
                          {FLAG_LABEL[r.flag!]}
                        </span>
                      </td>
                      {/* Memo / Action cell */}
                      <td className="px-3 py-2 min-w-[180px]">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            placeholder={isResolved ? '처리완료' : '메모 입력...'}
                            value={memos[key] ?? ''}
                            onChange={e =>
                              setMemos(prev => ({ ...prev, [key]: e.target.value }))
                            }
                            disabled={isResolved}
                            className="flex-1 text-xs bg-transparent border-0 border-b border-gray-200 focus:outline-none focus:border-blue-400 placeholder-gray-300 py-0.5 disabled:opacity-40"
                          />
                          <button
                            onClick={() => toggleResolved(key)}
                            className={`shrink-0 text-xs px-2 py-0.5 rounded-lg border transition-colors ${
                              isResolved
                                ? 'bg-green-100 text-green-700 border-green-200'
                                : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200'
                            }`}
                          >
                            {isResolved ? '완료' : '처리'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {anomalyRecords.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-4 py-12 text-center text-gray-400">
                      선택된 기간 · 범위에 이상치가 없습니다
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
