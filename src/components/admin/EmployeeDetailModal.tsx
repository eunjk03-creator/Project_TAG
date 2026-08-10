'use client'
import type { ProcessedRecord } from '@/types/tag'
import { FINAL_STATUS_CATEGORY } from '@/types/tag'
import type { RosterRow } from '@/hooks/useEmployeeRoster'

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500',
  'bg-pink-500', 'bg-indigo-500', 'bg-rose-500', 'bg-teal-500',
]
function avatarColor(name: string) {
  return AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length]
}

function fmt(h: number): string {
  if (!h) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

const CONTRACT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: '정규직', CONTRACT: '계약직', DISPATCHED: '파견', INTERN: '인턴/수습', EXECUTIVE: '임원', OTHER: '기타',
}
const MASTER_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ACTIVE:   { label: '재직', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  ON_LEAVE: { label: '휴직', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  RESIGNED: { label: '퇴사', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
}
const STATUS_BADGE_CLS: Record<string, string> = {
  NORMAL:       'bg-emerald-50 text-emerald-700 border-emerald-200',
  ANOMALY:      'bg-red-50 text-red-700 border-red-200',
  HOLIDAY_WORK: 'bg-violet-50 text-violet-700 border-violet-200',
  NON_WORKING:  'bg-gray-100 text-gray-400 border-gray-200',
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className="text-lg font-bold tabular-nums text-gray-800">{value}</p>
    </div>
  )
}

interface EmployeeDetailModalProps {
  row:         RosterRow
  records:     ProcessedRecord[]  // 이 사람의 레코드만, 선택 기간 범위
  periodLabel: string
  onClose:     () => void
}

/** 상시인력 명단에서 사람 클릭 시 뜨는 상세 모달 — 사이드 드로어가 아니라 중앙 모달로,
 *  조직정보 + 기간통계 + 일자별 개인 데이터(clockIn/clockOut/연차/상태)까지 한 화면에서 본다. */
export function EmployeeDetailModal({ row, records, periodLabel, onClose }: EmployeeDetailModalProps) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date))

  const totalHours    = records.reduce((s, r) => s + r.regularHours + r.overtimeHours, 0)
  const overtimeHours = records.reduce((s, r) => s + r.overtimeHours, 0)
  const nightHours    = records.reduce((s, r) => s + r.nightHours,    0)
  const anomalies     = records.filter(r => FINAL_STATUS_CATEGORY[r.finalStatus] === 'ANOMALY').length

  const statusInfo = MASTER_STATUS_LABEL[row.status] ?? { label: row.status, cls: 'bg-gray-100 text-gray-500 border-gray-200' }
  const orgPath = [row.division, row.team].filter(Boolean).join(' / ')

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-start gap-4 px-6 py-5 border-b border-gray-100 shrink-0">
          <div className={`w-12 h-12 rounded-full ${avatarColor(row.name)} flex items-center justify-center shrink-0`}>
            <span className="text-white text-lg font-bold">{row.name[0]}</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-gray-900">{row.name}</h2>
              <span className="text-xs text-gray-400 font-mono">{row.rawId}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${statusInfo.cls}`}>
                {statusInfo.label}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
                {CONTRACT_TYPE_LABEL[row.contractType] ?? row.contractType}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5 truncate">
              {orgPath}{row.jobTitle ? ` · ${row.jobTitle}` : ''}
            </p>
            {row.hireDate && (
              <p className="text-xs text-gray-400 mt-0.5">입사일 {row.hireDate}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* ── Period summary ── */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">
              선택 기간 통계 — {periodLabel}
            </p>
            <div className="grid grid-cols-4 gap-2">
              <StatCard label="총 근로" value={fmt(totalHours)} />
              <StatCard label="연장근로" value={fmt(overtimeHours)} />
              <StatCard label="야간근로" value={fmt(nightHours)} />
              <StatCard label="이상치" value={`${anomalies}건`} />
            </div>
          </div>

          {/* ── Day-by-day ── */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">
              일자별 기록 — {sorted.length}건
            </p>
            {sorted.length === 0 ? (
              <p className="text-xs text-gray-300 text-center py-8">해당 기간에 레코드가 없습니다.</p>
            ) : (
              <div className="overflow-x-auto border border-gray-100 rounded-xl">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100 text-gray-400">
                      <th className="text-left px-3 py-2 font-medium">날짜</th>
                      <th className="text-left px-3 py-2 font-medium">출근</th>
                      <th className="text-left px-3 py-2 font-medium">퇴근</th>
                      <th className="text-left px-3 py-2 font-medium">연차/휴가</th>
                      <th className="text-right px-3 py-2 font-medium">연장</th>
                      <th className="text-left px-3 py-2 font-medium">상태</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sorted.map((r, i) => (
                      <tr key={`${r.date}_${i}`} className="hover:bg-gray-50/70">
                        <td className="px-3 py-2 text-gray-700 tabular-nums">
                          {r.date}<span className="ml-1.5 text-[10px] text-gray-400">{r.dayLabel}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-600 tabular-nums">{r.clockIn ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-600 tabular-nums">{r.clockOut ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-500">
                          {r.leaveType ? `${r.leaveType}${r.erpLeaveAmount ? ` (${r.erpLeaveAmount}일)` : ''}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                          {r.overtimeHours ? fmt(r.overtimeHours) : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${STATUS_BADGE_CLS[FINAL_STATUS_CATEGORY[r.finalStatus]]}`}>
                            {r.finalStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
