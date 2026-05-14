'use client'
import { useMemo } from 'react'
import type { ProcessedRecord, Employee } from '@/types/tag'
import { STATUS_COLORS } from '@/types/tag'
import { EMPLOYEES } from '@/data/orgChart'

interface Props {
  records: ProcessedRecord[]
  employees?: Employee[]
}

function fmtHours(hours: number): string {
  if (hours <= 0) return ''
  const totalMins = Math.round(hours * 60)
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

function getLeaveDay(leaveType: ProcessedRecord['leaveType']): number | null {
  if (leaveType === '연차') return 1.0
  if (leaveType === '오전반차' || leaveType === '오후반차') return 0.5
  return null
}

// K: "미상신" when leave type was inferred via Slack but not filed in ERP
function getLeaveAnomaly(r: ProcessedRecord): string {
  if (r.leaveType && r.verificationNote?.some(n => n.startsWith('✅ 슬랙 확인'))) return '미상신'
  return ''
}

const TH = 'px-3 py-2.5 font-semibold text-[11px] text-gray-500 whitespace-nowrap'
const TD = 'px-3 py-2 text-xs'

export function AttendanceResultTable({ records, employees }: Props) {
  const empMap = useMemo(() => {
    const src = employees ?? EMPLOYEES
    return new Map(src.map(e => [e.id, e]))
  }, [employees])

  if (records.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400">
        처리된 근태 데이터가 없습니다.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full text-xs border-collapse" style={{ minWidth: 1280 }}>
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className={`${TH} text-left`}>본부</th>         {/* A */}
            <th className={`${TH} text-left`}>사번</th>         {/* B */}
            <th className={`${TH} text-left`}>이름</th>         {/* C */}
            <th className={`${TH} text-left`}>근무일자</th>     {/* D */}
            <th className={`${TH} text-center`}>출근</th>       {/* E */}
            <th className={`${TH} text-center`}>퇴근</th>       {/* F */}
            <th className={`${TH} text-center`}>휴게</th>       {/* G */}
            <th className={`${TH} text-center`}>근무A</th>      {/* H: F–E–G */}
            <th className={`${TH} text-center`}>연차</th>       {/* I: 사용일수 */}
            <th className={`${TH} text-center`}>근무B</th>      {/* J: H+I×8h */}
            <th className={`${TH} text-center`}>연차특이</th>   {/* K */}
            <th className={`${TH} text-center`}>최종근태</th>   {/* L */}
            <th className={`${TH} text-left`}>메모</th>         {/* M */}
            <th className={`${TH} text-center`}>ERP미신청</th>  {/* N */}
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => {
            const emp = empMap.get(r.employeeId)
            const division = emp?.division ?? '—'
            const name     = emp?.name     ?? r.employeeId

            // H: total effective work time (regular + OT + holiday), in hours
            const workedH  = r.regularHours + r.overtimeHours + r.holidayHours
            const workedStr = fmtHours(workedH)

            // I: leave day count (1.0 / 0.5 / null)
            const leaveDay = getLeaveDay(r.leaveType)

            // J: 근무B = 근무A + 연차 * 8 h
            const workedBStr = fmtHours(workedH + (leaveDay ?? 0) * 8)

            // K, M, N
            const leaveAnomaly = getLeaveAnomaly(r)
            const memo         = r.verificationNote?.join(' / ') ?? ''
            const erpMissing   = r.finalStatus === 'OT미신청' ? 'ERP 미신청' : ''

            return (
              <tr
                key={`${r.employeeId}_${r.date}`}
                className={`border-b border-gray-100 last:border-0 transition-colors hover:bg-blue-50/20 ${
                  i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'
                }`}
              >
                {/* A: 본부 */}
                <td className={`${TD} text-gray-600 whitespace-nowrap`}>{division}</td>

                {/* B: 사번 */}
                <td className={`${TD} text-gray-500 font-mono whitespace-nowrap`}>{r.employeeId}</td>

                {/* C: 이름 */}
                <td className={`${TD} font-medium text-gray-800 whitespace-nowrap`}>{name}</td>

                {/* D: 근무일자 */}
                <td className={`${TD} text-gray-600 tabular-nums whitespace-nowrap`}>{r.date}</td>

                {/* E: 출근 */}
                <td className={`${TD} text-center tabular-nums whitespace-nowrap`}>
                  {r.clockIn ?? <span className="text-gray-300">—</span>}
                </td>

                {/* F: 퇴근 */}
                <td className={`${TD} text-center tabular-nums whitespace-nowrap`}>
                  {r.clockOut ?? <span className="text-gray-300">—</span>}
                </td>

                {/* G: 휴게 */}
                <td className={`${TD} text-center tabular-nums text-gray-500 whitespace-nowrap`}>
                  {r.breakMinutes > 0
                    ? `${r.breakMinutes}m`
                    : <span className="text-gray-300">—</span>}
                </td>

                {/* H: 근무A */}
                <td className={`${TD} text-center tabular-nums whitespace-nowrap`}>
                  {workedStr || <span className="text-gray-300">—</span>}
                </td>

                {/* I: 연차 사용일수 */}
                <td className={`${TD} text-center whitespace-nowrap`}>
                  {leaveDay !== null
                    ? <span className="text-blue-700 font-semibold">{leaveDay.toFixed(1)}</span>
                    : <span className="text-gray-300">—</span>}
                </td>

                {/* J: 근무B */}
                <td className={`${TD} text-center tabular-nums whitespace-nowrap`}>
                  {workedBStr || <span className="text-gray-300">—</span>}
                </td>

                {/* K: 연차특이사항 */}
                <td className={`${TD} text-center whitespace-nowrap`}>
                  {leaveAnomaly
                    ? <span className="text-amber-700 font-semibold">{leaveAnomaly}</span>
                    : <span className="text-gray-300">—</span>}
                </td>

                {/* L: 최종근태값 — color-coded via STATUS_COLORS */}
                <td className={`${TD} text-center whitespace-nowrap`}>
                  <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ${STATUS_COLORS[r.finalStatus]}`}>
                    {r.finalStatus}
                  </span>
                </td>

                {/* M: 메모 */}
                <td className={`${TD} text-gray-500 max-w-[260px] truncate`} title={memo}>
                  {memo || <span className="text-gray-300">—</span>}
                </td>

                {/* N: ERP 미신청 */}
                <td className={`${TD} text-center whitespace-nowrap`}>
                  {erpMissing
                    ? <span className="text-red-600 font-semibold text-[11px]">{erpMissing}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
