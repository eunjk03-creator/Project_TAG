'use client'
import { useMemo } from 'react'
import type { ProcessedRecord, Employee } from '@/types/tag'

type Status = 'N' | 'OT' | 'L' | 'A' | 'H' | 'APPROVED' | 'WEEKEND' | 'ABSENT'

// Pixel widths for the 4 left-sticky columns
const W_NAME  = 128
const W_TOTAL = 62
const W_OT    = 52
const W_ANOM  = 44
// Each date column — wide enough for stacked HH:MM times + whitespace-nowrap
const W_DATE  = 62

const STATUS_CFG: Record<Exclude<Status, 'WEEKEND' | 'ABSENT'>, { cls: string; desc: string }> = {
  N:        { cls: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200', desc: '정상' },
  OT:       { cls: 'bg-amber-100 text-amber-700 hover:bg-amber-200',       desc: '연장근로' },
  L:        { cls: 'bg-orange-100 text-orange-600 hover:bg-orange-200',    desc: '지각' },
  A:        { cls: 'bg-red-100 text-red-600 hover:bg-red-200',             desc: '이상치' },
  H:        { cls: 'bg-violet-100 text-violet-600 hover:bg-violet-200',    desc: '휴일근무' },
  APPROVED: { cls: 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200', desc: '승인됨' },
}

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

// Shadow that separates the last sticky column from the scrollable date columns
const STICKY_SEP = '3px 0 6px -2px rgba(0,0,0,0.10)'

function getStatus(
  rec: ProcessedRecord | undefined,
  date: string,
  isApproved: boolean,
): Status {
  if (!rec) {
    const dow = new Date(date + 'T12:00').getDay()
    return dow === 0 || dow === 6 ? 'WEEKEND' : 'ABSENT'
  }
  // Only mark as holiday-work (H) when the employee actually clocked in
  if (rec.dayType !== 'WEEKDAY') return rec.clockIn !== null ? 'H' : 'WEEKEND'
  if (isApproved && rec.flag !== null) return 'APPROVED'
  if (rec.flag === 'LATE') return 'L'
  if (rec.flag !== null) return 'A'
  if (rec.overtimeHours > 0) return 'OT'
  return 'N'
}

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

type Props = {
  employees: Employee[]
  records: ProcessedRecord[]
  dates: string[]
  onNameClick: (id: string) => void
  onCellClick: (employeeId: string, date: string) => void
  approvedKeys: Set<string>
}

export function EmployeeCalendarGrid({
  employees,
  records,
  dates,
  onNameClick,
  onCellClick,
  approvedKeys,
}: Props) {
  const lookup = useMemo(() => {
    const map: Record<string, Record<string, ProcessedRecord>> = {}
    for (const r of records) {
      if (!map[r.employeeId]) map[r.employeeId] = {}
      map[r.employeeId][r.date] = r
    }
    return map
  }, [records])

  const empStats = useMemo(() => {
    const stats: Record<string, { total: number; ot: number; anomalies: number }> = {}
    for (const emp of employees) {
      const recs = records.filter(r => r.employeeId === emp.id)
      stats[emp.id] = {
        total: recs.reduce((s, r) => s + r.regularHours + r.overtimeHours, 0),
        ot: recs.reduce((s, r) => s + r.overtimeHours, 0),
        anomalies: recs.filter(
          r => r.flag !== null && !approvedKeys.has(`${r.employeeId}_${r.date}`),
        ).length,
      }
    }
    return stats
  }, [employees, records, approvedKeys])

  // When the date range spans multiple calendar months, show M/D in column headers
  const isMultiMonth = dates.length > 1 && dates[0].slice(0, 7) !== dates[dates.length - 1].slice(0, 7)

  if (employees.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-400">
        조건에 맞는 직원이 없습니다
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
      {/* Legend */}
      <div className="flex items-center gap-4 px-5 py-2 border-b border-gray-100 bg-gray-50/50 shrink-0">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider shrink-0">범례</span>
        <div className="flex items-center gap-3 flex-wrap">
          {(['N', 'OT', 'L', 'A', 'H', 'APPROVED'] as const).map(s => {
            const cfg = STATUS_CFG[s]
            const baseClass = cfg.cls.replace(/ hover:\S+/g, '')
            return (
              <span key={s} className="flex items-center gap-1">
                <span className={`inline-block w-2.5 h-2.5 rounded ${baseClass}`} />
                <span className="text-[10px] text-gray-400">{cfg.desc}</span>
              </span>
            )
          })}
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded bg-gray-100" />
            <span className="text-[10px] text-gray-400">기록없음</span>
          </span>
        </div>
        <span className="ml-auto text-[10px] text-gray-400 hidden sm:block shrink-0">
          셀을 클릭하면 상세를 볼 수 있습니다
        </span>
      </div>

      {/* Scrollable grid — both axes, scrollbar always at viewport bottom */}
      <div className="w-full flex-1 min-h-0 overflow-auto">
        <table className="min-w-max border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-gray-200">

              {/* ── Sticky col 1: 이름/조직  (left+top sticky → z-40 corner) ── */}
              <th
                className="sticky z-40 bg-gray-50 px-4 py-3 text-left text-[11px] font-semibold text-gray-500"
                style={{ left: 0, top: 0, width: W_NAME, minWidth: W_NAME }}
              >
                이름 / 조직
              </th>

              {/* ── Sticky col 2: 총근로 ── */}
              <th
                className="sticky z-40 bg-gray-50 py-3 text-center text-[11px] font-semibold text-gray-600 border-l border-gray-200"
                style={{ left: W_NAME, top: 0, width: W_TOTAL, minWidth: W_TOTAL }}
              >
                총근로
              </th>

              {/* ── Sticky col 3: 연장 ── */}
              <th
                className="sticky z-40 bg-gray-50 py-3 text-center text-[11px] font-semibold text-amber-500 border-l border-gray-200"
                style={{ left: W_NAME + W_TOTAL, top: 0, width: W_OT, minWidth: W_OT }}
              >
                연장
              </th>

              {/* ── Sticky col 4: 이상치 ── */}
              <th
                className="sticky z-40 bg-gray-50 py-3 text-center text-[11px] font-semibold text-red-400 border-l border-gray-200"
                style={{
                  left: W_NAME + W_TOTAL + W_OT,
                  top: 0,
                  width: W_ANOM,
                  minWidth: W_ANOM,
                  boxShadow: STICKY_SEP,
                }}
              >
                이상
              </th>

              {/* ── Date columns: vertical sticky only (top-0), no left ── */}
              {dates.map(date => {
                const d = new Date(date + 'T12:00')
                const dow = d.getDay()
                const isWknd = dow === 0 || dow === 6
                return (
                  <th
                    key={date}
                    className={`sticky top-0 z-30 pt-2 pb-1.5 text-center border-l border-gray-100 whitespace-nowrap ${
                      isWknd ? 'bg-slate-50' : 'bg-gray-50'
                    }`}
                    style={{ width: W_DATE, minWidth: W_DATE }}
                  >
                    <div className={`text-[11px] font-bold leading-none ${isWknd ? 'text-slate-400' : 'text-gray-600'}`}>
                      {isMultiMonth ? `${d.getMonth() + 1}/${d.getDate()}` : d.getDate()}
                    </div>
                    <div className={`text-[9px] mt-0.5 leading-none font-medium ${isWknd ? 'text-slate-300' : 'text-gray-300'}`}>
                      {DOW_KR[dow]}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {employees.map((emp, rowIdx) => {
              const empRecs = lookup[emp.id] ?? {}
              const s = empStats[emp.id] ?? { total: 0, ot: 0, anomalies: 0 }
              const isEven = rowIdx % 2 === 0
              const baseBg = isEven ? 'bg-white' : 'bg-gray-50'

              return (
                <tr
                  key={emp.id}
                  className={`group transition-colors hover:bg-blue-50/30 ${isEven ? '' : 'bg-gray-50/40'}`}
                >
                  {/* ── Sticky col 1: 이름/조직 ── */}
                  <td
                    className={`sticky z-20 px-4 py-2 border-b border-gray-100 transition-colors group-hover:bg-blue-50 ${baseBg}`}
                    style={{ left: 0, width: W_NAME, minWidth: W_NAME }}
                  >
                    <button onClick={() => onNameClick(emp.id)} className="text-left block w-full">
                      <p className="text-[11px] font-semibold text-gray-800 hover:text-blue-600 transition-colors leading-tight truncate" style={{ maxWidth: W_NAME - 32 }}>
                        {emp.name}
                      </p>
                      <p className="text-[10px] text-gray-400 mt-0.5 leading-tight truncate" style={{ maxWidth: W_NAME - 32 }}>
                        {emp.division}
                      </p>
                    </button>
                  </td>

                  {/* ── Sticky col 2: 총근로 ── */}
                  <td
                    className={`sticky z-20 py-2 text-center font-semibold text-gray-700 border-b border-l border-gray-200 text-[11px] transition-colors group-hover:bg-blue-50 ${baseBg}`}
                    style={{ left: W_NAME, width: W_TOTAL, minWidth: W_TOTAL }}
                  >
                    {fmt(s.total)}
                  </td>

                  {/* ── Sticky col 3: 연장 ── */}
                  <td
                    className={`sticky z-20 py-2 text-center border-b border-l border-gray-200 text-[11px] transition-colors group-hover:bg-blue-50 ${baseBg}`}
                    style={{ left: W_NAME + W_TOTAL, width: W_OT, minWidth: W_OT }}
                  >
                    {s.ot > 0 ? (
                      <span className="text-amber-600 font-semibold">{fmt(s.ot)}</span>
                    ) : (
                      <span className="text-gray-200">—</span>
                    )}
                  </td>

                  {/* ── Sticky col 4: 이상치 ── */}
                  <td
                    className={`sticky z-20 py-2 text-center border-b border-l border-gray-200 text-[11px] transition-colors group-hover:bg-blue-50 ${baseBg}`}
                    style={{
                      left: W_NAME + W_TOTAL + W_OT,
                      width: W_ANOM,
                      minWidth: W_ANOM,
                      boxShadow: STICKY_SEP,
                    }}
                  >
                    {s.anomalies > 0 ? (
                      <span className="text-red-500 font-bold">{s.anomalies}</span>
                    ) : (
                      <span className="text-gray-300">0</span>
                    )}
                  </td>

                  {/* ── Date cells ── */}
                  {dates.map(date => {
                    const rec = empRecs[date]
                    const key = `${emp.id}_${date}`
                    const isApproved = approvedKeys.has(key)
                    const status = getStatus(rec, date, isApproved)
                    const cfg = status in STATUS_CFG ? STATUS_CFG[status as keyof typeof STATUS_CFG] : null
                    const d = new Date(date + 'T12:00')
                    const isWknd = d.getDay() === 0 || d.getDay() === 6

                    return (
                      <td
                        key={date}
                        className={`py-1 px-0.5 text-center border-b border-l border-gray-100 whitespace-nowrap ${
                          isWknd ? 'bg-slate-50/60' : ''
                        }`}
                        style={{ width: W_DATE, minWidth: W_DATE }}
                      >
                        {cfg && rec ? (
                          <button
                            onClick={() => onCellClick(emp.id, date)}
                            title={`${emp.name} · ${date}\n출근: ${rec.clockIn ?? '미태깅'} / 퇴근: ${rec.clockOut ?? '미태깅'}\n클릭하여 상세보기`}
                            className={`w-full inline-flex flex-col items-center justify-center rounded py-0.5 px-0.5 transition-colors cursor-pointer leading-none ${cfg.cls}`}
                          >
                            {status === 'APPROVED' && (
                              <span className="text-[7px] font-bold mb-px opacity-80">✓</span>
                            )}
                            <span className="text-[8px] font-medium tabular-nums">{rec.clockIn ?? '—'}</span>
                            <span className="text-[8px] font-medium tabular-nums opacity-75">{rec.clockOut ?? '—'}</span>
                          </button>
                        ) : status === 'WEEKEND' ? (
                          <span className="text-slate-200 text-xs select-none">·</span>
                        ) : (
                          <span className="text-gray-200 text-xs select-none">—</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
