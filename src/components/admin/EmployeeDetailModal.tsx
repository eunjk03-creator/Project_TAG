'use client'
import { useEffect, useMemo, useState } from 'react'
import type { ProcessedRecord } from '@/types/tag'
import { FINAL_STATUS_CATEGORY } from '@/types/tag'
import type { RosterRow } from '@/hooks/useEmployeeRoster'

interface DeptOption { id: string; name: string; level: number; parentId: string | null }

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
  /** 조직정보 저장 성공 시 호출 — 부모가 roster/masterActive를 다시 받아오도록 함 */
  onSaved?:    () => void
}

/** 상시인력 명단에서 사람 클릭 시 뜨는 상세 모달 — 사이드 드로어가 아니라 중앙 모달로,
 *  조직정보 + 기간통계 + 일자별 개인 데이터(clockIn/clockOut/연차/상태)까지 한 화면에서 본다.
 *  헤더의 "수정" 버튼으로 부서/직책/계약형태/재직상태/입사일/퇴직일을 직접 고쳐 저장할 수 있음 —
 *  이 필드들은 조직도 시트 동기화 전에는 수기로 고칠 방법이 아예 없었음. */
export function EmployeeDetailModal({ row, records, periodLabel, onClose, onSaved }: EmployeeDetailModalProps) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date))

  const totalHours    = records.reduce((s, r) => s + r.regularHours + r.overtimeHours, 0)
  const overtimeHours = records.reduce((s, r) => s + r.overtimeHours, 0)
  const nightHours    = records.reduce((s, r) => s + r.nightHours,    0)
  const anomalies     = records.filter(r => FINAL_STATUS_CATEGORY[r.finalStatus] === 'ANOMALY').length

  const statusInfo = MASTER_STATUS_LABEL[row.status] ?? { label: row.status, cls: 'bg-gray-100 text-gray-500 border-gray-200' }
  const orgPath = [row.division, row.team].filter(Boolean).join(' / ')

  // ── 조직정보 수정 ──────────────────────────────────────────────────────
  const [depts, setDepts] = useState<DeptOption[]>([])
  useEffect(() => {
    fetch('/api/departments')
      .then(r => r.json())
      .then((d: DeptOption[]) => { if (Array.isArray(d)) setDepts(d) })
      .catch(() => {})
  }, [])
  const divisions = useMemo(() => depts.filter(d => !d.parentId), [depts])

  const [isEditing, setIsEditing]     = useState(false)
  const [saving, setSaving]           = useState(false)
  const [divisionId, setDivisionId]   = useState('')
  const [teamId, setTeamId]           = useState('')
  const [jobTitleDraft, setJobTitleDraft]         = useState('')
  const [contractTypeDraft, setContractTypeDraft] = useState('FULL_TIME')
  const [statusDraft, setStatusDraft]             = useState('ACTIVE')
  const [hireDateDraft, setHireDateDraft]         = useState('')
  const [resignedDateDraft, setResignedDateDraft] = useState('')
  const teams = useMemo(() => depts.filter(d => d.parentId === divisionId), [depts, divisionId])

  function startEdit() {
    const dept = row.departmentId ? depts.find(d => d.id === row.departmentId) : undefined
    if (dept?.parentId)       { setDivisionId(dept.parentId); setTeamId(dept.id) }
    else if (dept)             { setDivisionId(dept.id);       setTeamId('') }
    else                        { setDivisionId('');            setTeamId('') }
    setJobTitleDraft(row.jobTitle ?? '')
    setContractTypeDraft(row.contractType || 'FULL_TIME')
    setStatusDraft(row.status || 'ACTIVE')
    setHireDateDraft(row.hireDate ?? '')
    setResignedDateDraft(row.resignedDate ?? '')
    setIsEditing(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const departmentId = teamId || divisionId || null
      const res = await fetch(`/api/employee-master/${row.rawId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:         row.name,
          departmentId,
          jobTitle:     jobTitleDraft,
          contractType: contractTypeDraft,
          status:       statusDraft,
          hireDate:     hireDateDraft || null,
          resignedDate: statusDraft === 'RESIGNED' ? (resignedDateDraft || null) : null,
        }),
      })
      if (!res.ok) {
        alert('저장에 실패했습니다. 다시 시도해주세요.')
        return
      }
      onSaved?.()
      onClose()
    } finally {
      setSaving(false)
    }
  }

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
              {!isEditing && (
                <>
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${statusInfo.cls}`}>
                    {statusInfo.label}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
                    {CONTRACT_TYPE_LABEL[row.contractType] ?? row.contractType}
                  </span>
                </>
              )}
            </div>

            {!isEditing ? (
              <>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  {orgPath}{row.jobTitle ? ` · ${row.jobTitle}` : ''}
                </p>
                {row.hireDate && (
                  <p className="text-xs text-gray-400 mt-0.5">입사일 {row.hireDate}</p>
                )}
              </>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-2 max-w-lg">
                <select
                  value={divisionId}
                  onChange={e => { setDivisionId(e.target.value); setTeamId('') }}
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white"
                >
                  <option value="">본부 선택 안함</option>
                  {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <select
                  value={teamId}
                  onChange={e => setTeamId(e.target.value)}
                  disabled={!divisionId || teams.length === 0}
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white disabled:opacity-40"
                >
                  <option value="">팀 선택 안함</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <input
                  type="text"
                  value={jobTitleDraft}
                  onChange={e => setJobTitleDraft(e.target.value)}
                  placeholder="직책"
                  className="text-xs border border-gray-200 rounded px-2 py-1"
                />
                <select
                  value={contractTypeDraft}
                  onChange={e => setContractTypeDraft(e.target.value)}
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white"
                >
                  {Object.entries(CONTRACT_TYPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <select
                  value={statusDraft}
                  onChange={e => setStatusDraft(e.target.value)}
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white"
                >
                  {Object.entries(MASTER_STATUS_LABEL).map(([value, info]) => (
                    <option key={value} value={value}>{info.label}</option>
                  ))}
                </select>
                <div />
                <label className="flex items-center gap-1.5 text-xs text-gray-400">
                  입사일
                  <input
                    type="date"
                    value={hireDateDraft}
                    onChange={e => setHireDateDraft(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1 flex-1"
                  />
                </label>
                {statusDraft === 'RESIGNED' && (
                  <label className="flex items-center gap-1.5 text-xs text-gray-400">
                    퇴직일
                    <input
                      type="date"
                      value={resignedDateDraft}
                      onChange={e => setResignedDateDraft(e.target.value)}
                      className="text-xs border border-gray-200 rounded px-2 py-1 flex-1"
                    />
                  </label>
                )}
              </div>
            )}
          </div>

          {isEditing ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setIsEditing(false)}
                disabled={saving}
                className="px-2.5 py-1 text-[11px] font-semibold text-gray-500 bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-40"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
              >
                {saving ? '저장 중…' : '저장'}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={startEdit}
                title="조직정보 수정"
                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M16.862 4.487a1.5 1.5 0 012.122 2.122L9.75 15.842l-3.375.75.75-3.375 9.737-9.73z" />
                </svg>
              </button>
              <button
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
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
