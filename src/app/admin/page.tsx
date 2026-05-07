'use client'
import { useState, useMemo } from 'react'
import { ALL_RECORDS } from '@/data/mockData'
import { EMPLOYEES } from '@/data/orgChart'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { usePolicy } from '@/context/PolicyContext'
import { useOrgFilter } from '@/context/OrgFilterContext'
import { EmployeeCalendarGrid } from '@/components/admin/EmployeeCalendarGrid'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useDateRange } from '@/context/DateRangeContext'
import { exportCsv, exportGridCsv } from '@/utils/exportCsv'
import { DailyDetailModal } from '@/components/admin/DailyDetailModal'
import { OrgFilterBar } from '@/components/admin/OrgFilterBar'

const FLAG_LABEL: Record<string, string> = {
  LATE: '지각',
  NO_CLOCK_OUT: '퇴근 미태깅',
  UNAPPROVED_OT: 'OT 미신청',
  EARLY_DEPARTURE: '조기퇴근',
}

const FLAG_COLOR: Record<string, string> = {
  LATE: 'text-amber-600 bg-amber-50 border-amber-200',
  NO_CLOCK_OUT: 'text-red-600 bg-red-50 border-red-200',
  UNAPPROVED_OT: 'text-orange-600 bg-orange-50 border-orange-200',
  EARLY_DEPARTURE: 'text-blue-600 bg-blue-50 border-blue-200',
}

const DAY_ALIASES: Record<string, string> = {
  '월요일': '월', '화요일': '화', '수요일': '수', '목요일': '목',
  '금요일': '금', '토요일': '토', '일요일': '일',
}

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function getOrgPath(emp: (typeof EMPLOYEES)[0]): string {
  const parts = [emp.division, emp.team]
  if (emp.part) parts.push(emp.part)
  return parts.join(' / ')
}

type View = 'grid' | 'table'

export default function AdminDashboard() {
  const { policy } = usePolicy()
  const { division, team } = useOrgFilter()
  const { openDrawer, exceptions } = useEmployeeExceptions()
  const { dateRange, setDateRange } = useDateRange()

  const [view, setView] = useState<View>('grid')
  const [search, setSearch] = useState('')
  const [modalCell, setModalCell] = useState<{ employeeId: string; date: string } | null>(null)
  const [approvedKeys, setApprovedKeys] = useState<Set<string>>(new Set())

  // ── Org-filtered employees ────────────────────────────────
  const scopedEmployees = useMemo(() => {
    let emps = EMPLOYEES
    if (division) emps = emps.filter(e => e.division === division)
    if (team) emps = emps.filter(e => e.team === team)
    return emps
  }, [division, team])

  const scopedEmployeeIds = useMemo(
    () => new Set(scopedEmployees.map(e => e.id)),
    [scopedEmployees],
  )

  // ── Date range → column array for the grid ───────────────
  const gridDates = useMemo(() => {
    const dates: string[] = []
    const cur = new Date(dateRange.from + 'T00:00:00')
    const end = new Date(dateRange.to + 'T00:00:00')
    while (cur <= end) {
      dates.push(cur.toISOString().split('T')[0])
      cur.setDate(cur.getDate() + 1)
    }
    return dates
  }, [dateRange.from, dateRange.to])

  // ── Single data pipeline (grid + table share the same range) ──
  const { processed: allProcessed, flagCounts } = useAttendanceLogic(
    ALL_RECORDS, policy, dateRange.from, dateRange.to,
  )

  const scopedRecords = useMemo(
    () => allProcessed.filter(r => scopedEmployeeIds.has(r.employeeId)),
    [allProcessed, scopedEmployeeIds],
  )

  const stats = useMemo(() => {
    const regH = scopedRecords.reduce((s, r) => s + r.regularHours, 0)
    const otH  = scopedRecords.reduce((s, r) => s + r.overtimeHours, 0)
    const ngH  = scopedRecords.reduce((s, r) => s + r.nightHours, 0)
    return {
      totalHours: regH + otH,
      overtimeHours: otH,
      nightHours: ngH,
      anomalies: scopedRecords.filter(r => r.flag !== null).length,
    }
  }, [scopedRecords])

  // ── Table search ──────────────────────────────────────────
  const searchQuery = DAY_ALIASES[search.trim().toLowerCase()] ?? search.trim().toLowerCase()

  const filteredRecords = useMemo(() => {
    if (!searchQuery) return scopedRecords
    return scopedRecords.filter(r => {
      const emp = EMPLOYEES.find(e => e.id === r.employeeId)
      return (
        emp?.name.toLowerCase().includes(searchQuery) ||
        r.employeeId.toLowerCase().includes(searchQuery) ||
        r.dayLabel?.toLowerCase().includes(searchQuery) ||
        r.date.includes(searchQuery)
      )
    })
  }, [scopedRecords, searchQuery])

  const tableRows = useMemo(
    () =>
      [...filteredRecords]
        .sort((a, b) => b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId))
        .slice(0, 500),
    [filteredRecords],
  )

  // ── Modal helpers ─────────────────────────────────────────
  const modalEmployee = useMemo(
    () => (modalCell ? EMPLOYEES.find(e => e.id === modalCell.employeeId) ?? null : null),
    [modalCell],
  )
  const modalRecord = useMemo(
    () =>
      modalCell
        ? scopedRecords.find(r => r.employeeId === modalCell.employeeId && r.date === modalCell.date) ?? null
        : null,
    [modalCell, scopedRecords],
  )

  function handleCellClick(employeeId: string, date: string) {
    setModalCell({ employeeId, date })
  }

  function handleModalApprove() {
    if (!modalCell) return
    setApprovedKeys(prev => new Set([...prev, `${modalCell.employeeId}_${modalCell.date}`]))
  }

  // ── Export ────────────────────────────────────────────────
  function handleExport() {
    if (view === 'grid') {
      exportGridCsv(
        scopedEmployees,
        scopedRecords,
        gridDates,
        `근태그리드_${dateRange.from}~${dateRange.to}.csv`,
      )
    } else {
      exportCsv(
        scopedRecords,
        EMPLOYEES,
        `근태기록_${dateRange.from}~${dateRange.to}.csv`,
      )
    }
  }

  // ── Misc ──────────────────────────────────────────────────
  const scopeLabel = team ?? division ?? '전체'
  const totalFlags = Object.values(flagCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Top bar ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3 shrink-0">
        <div className="shrink-0">
          <h1 className="text-base font-bold text-gray-900">근태 현황</h1>
          <p className="text-xs text-gray-400">{scopeLabel} · {scopedEmployees.length}명</p>
        </div>

        {/* Search — table view only */}
        {view === 'table' && (
          <div className="flex-1 relative max-w-xs ml-2">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="이름, 사번, 요일 검색..."
              className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-300"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 text-xs"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* View toggle */}
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-xs font-medium">
            <button
              onClick={() => setView('grid')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                view === 'grid'
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              그리드
            </button>
            <button
              onClick={() => setView('table')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                view === 'table'
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              테이블
            </button>
          </div>

          {/* Export */}
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            내보내기
          </button>
        </div>
      </div>

      {/* ── Org filter bar ── */}
      <OrgFilterBar />

      {/* ── Main content ── */}
      <div className="flex-1 min-h-0 flex flex-col">

        {/* KPI Cards — always pinned above the scroll area */}
        <div className="px-6 pt-5 pb-4 shrink-0">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs text-gray-500">총 근로시간</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{fmt(stats.totalHours)}</p>
            <p className="text-xs text-gray-400 mt-1">
              {dateRange.from} ~ {dateRange.to}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs text-gray-500">연장근로</p>
            <p className="text-3xl font-bold text-amber-500 mt-1">{fmt(stats.overtimeHours)}</p>
            <p className="text-xs text-gray-400 mt-1">
              총 대비 {stats.totalHours > 0
                ? ((stats.overtimeHours / stats.totalHours) * 100).toFixed(1)
                : 0}%
            </p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs text-gray-500">야간근로</p>
            <p className="text-3xl font-bold text-indigo-500 mt-1">{fmt(stats.nightHours)}</p>
            <p className="text-xs text-gray-400 mt-1">22:00 ~ 익일 06:00</p>
          </div>
          <div
            className={`rounded-xl border p-5 ${
              stats.anomalies > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'
            }`}
          >
            <p className="text-xs text-gray-500">이상치</p>
            <p className={`text-3xl font-bold mt-1 ${stats.anomalies > 0 ? 'text-red-600' : 'text-gray-900'}`}>
              {stats.anomalies}건
            </p>
            <p className="text-xs text-gray-400 mt-1">현재 범위 기준</p>
          </div>
        </div>
        </div>{/* end KPI pin zone */}

        {/* ── Grid view: fills remaining height, table scrolls on both axes ── */}
        {view === 'grid' && (
          <div className="flex-1 min-h-0 flex flex-col px-6 pb-6">
            <EmployeeCalendarGrid
              employees={scopedEmployees}
              records={scopedRecords}
              dates={gridDates}
              onNameClick={openDrawer}
              onCellClick={handleCellClick}
              approvedKeys={approvedKeys}
            />
          </div>
        )}

        {/* ── Table view: single scrollable column ── */}
        {view === 'table' && (
          <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-700">상세 근태 기록</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {filteredRecords.length}건
                    {search && ` · 검색: "${search}"`}
                    {tableRows.length < filteredRecords.length &&
                      ` · 최신 ${tableRows.length}건 표시`}
                  </p>
                </div>
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    검색 초기화
                  </button>
                )}
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {tableRows.map((r, i) => {
                      const emp = EMPLOYEES.find(e => e.id === r.employeeId)
                      const isHoliday = r.dayType !== 'WEEKDAY'
                      const totalHours = r.regularHours + r.overtimeHours
                      const rowBg = r.flag === 'NO_CLOCK_OUT'
                        ? 'bg-red-50'
                        : r.flag
                        ? 'bg-amber-50/40'
                        : isHoliday
                        ? 'bg-gray-50/50'
                        : ''
                      return (
                        <tr key={i} className={`${rowBg} hover:bg-blue-50/20 transition-colors`}>
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
                            {exceptions[r.employeeId] &&
                              (exceptions[r.employeeId].bypassOtLimits ||
                                exceptions[r.employeeId].flexibleCoreTime) && (
                                <span className="ml-1.5 text-xs text-blue-500">•</span>
                              )}
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
                            {r.flag !== null ? (
                              <span className={`inline-block text-xs px-1.5 py-0.5 rounded border font-medium ${FLAG_COLOR[r.flag]}`}>
                                {FLAG_LABEL[r.flag]}
                              </span>
                            ) : r.erpOtApplied && r.overtimeHours > 0 ? (
                              <span className="text-xs text-green-600 font-medium">인정</span>
                            ) : (
                              <span className="text-gray-200">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {tableRows.length === 0 && (
                      <tr>
                        <td colSpan={12} className="px-4 py-10 text-center text-gray-400">
                          조건에 맞는 데이터가 없습니다
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Anomaly flag summary */}
            {totalFlags > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-3">전체 이상치 현황</h2>
                <div className="flex flex-wrap gap-3">
                  {(Object.entries(flagCounts) as [string, number][]).map(([flag, count]) => (
                    <div
                      key={flag}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${FLAG_COLOR[flag]}`}
                    >
                      {FLAG_LABEL[flag]}
                      <span className="font-bold">{count}건</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Daily Detail Modal ── */}
      {modalCell && modalEmployee && modalRecord && (
        <DailyDetailModal
          employee={modalEmployee}
          record={modalRecord}
          policy={policy}
          onClose={() => setModalCell(null)}
          onApprove={handleModalApprove}
        />
      )}
    </div>
  )
}
