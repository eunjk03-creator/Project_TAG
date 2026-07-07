'use client'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ProcessedRecord, Employee, PolicySettings, EditHistoryEntry } from '@/types/tag'
import { FINAL_STATUS_CATEGORY } from '@/types/tag'
import { useSlack } from '@/context/SlackContext'

// 3종 체계(지각/근무시간미달/미태깅) — EARLY_DEPARTURE는 캐시된 레코드 하위호환용 라벨
const FLAG_LABEL: Record<string, string> = {
  LATE:               '지각',
  NO_CLOCK_IN:        '출근 미태깅',
  NO_CLOCK_OUT:       '퇴근 미태깅',
  ATTENDANCE_ANOMALY: '근무시간 미달',
  EARLY_DEPARTURE:    '근무시간 미달',
}

const FLAG_BADGE: Record<string, string> = {
  LATE:               'bg-orange-50 text-orange-700 border-orange-200',
  NO_CLOCK_IN:        'bg-red-50 text-red-700 border-red-200',
  NO_CLOCK_OUT:       'bg-red-50 text-red-700 border-red-200',
  ATTENDANCE_ANOMALY: 'bg-blue-50 text-blue-700 border-blue-200',
  EARLY_DEPARTURE:    'bg-blue-50 text-blue-700 border-blue-200',
}

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500',
  'bg-pink-500', 'bg-indigo-500', 'bg-rose-500', 'bg-teal-500',
]

function avatarColor(name: string) {
  return AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length]
}

function fmt(h: number): string {
  if (h === 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function parseTimeToMins(hhmm: string): number {
  const isNext = hhmm.startsWith('+')
  const clean = isNext ? hhmm.slice(1) : hhmm
  const [h, m] = clean.split(':').map(Number)
  return h * 60 + m + (isNext ? 1440 : 0)
}

function minsToHHMM(mins: number): string {
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const ERP_LEAVE_TYPES = new Set(['연차', '오전반차', '오후반차', '오전반반차', '오후반반차'])

/**
 * Formats the ERP leave display string based on the numerical erpLeaveAmount.
 * Korean ERP uses '연차' as a generic code regardless of amount; the actual
 * granularity (full / half / quarter day) is encoded in the '일수' column.
 */
function formatErpLeave(leaveType: string, amount: number | undefined): string {
  if (ERP_LEAVE_TYPES.has(leaveType) && amount != null && amount > 0) {
    if (amount <= 0.25) return `반반차 (${amount}일)`
    if (amount <  1.0)  return `반차 (${amount}일)`
    return `연차 (${amount}일)`
  }
  return leaveType
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const yyyy = d.getFullYear()
  const mo   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  const hh   = String(d.getHours()).padStart(2, '0')
  const mm   = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}`
}

function fmtTime(t: string | null) { return t ?? '미태깅' }


// ── Sub-components ──────────────────────────────────────────

function SummaryCard({
  label, value, sub, tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'warn' | 'amber' | 'green'
}) {
  const tones = {
    neutral: 'bg-gray-50 text-gray-800',
    warn:    'bg-red-50 text-red-700',
    amber:   'bg-amber-50 text-amber-700',
    green:   'bg-emerald-50 text-emerald-700',
  }
  return (
    <div className={`rounded-xl p-3.5 ${tones[tone]}`}>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-sm font-bold leading-snug break-all">{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function SourceBlock({
  icon, label, statusDot, editButton, children,
}: {
  icon: string
  label: string
  statusDot: 'ok' | 'warn' | 'info'
  editButton?: ReactNode
  children: ReactNode
}) {
  const dot = { ok: 'bg-green-400', warn: 'bg-red-400', info: 'bg-gray-300' }[statusDot]
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-base">{icon}</span>
        <span className="text-xs font-semibold text-gray-700">{label}</span>
        <div className="ml-auto flex items-center gap-2">
          {editButton}
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        </div>
      </div>
      <div className="text-sm text-gray-600 space-y-0.5">{children}</div>
    </div>
  )
}

function BreakRow({
  label, window: win, applied, note,
}: {
  label: string
  window: string
  applied: boolean
  note?: string
}) {
  return (
    <div className="flex items-center justify-between text-xs py-1.5 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`font-medium ${applied ? 'text-gray-700' : 'text-gray-400'}`}>{label}</span>
        <span className="text-gray-400">{win}</span>
      </div>
      {applied
        ? <span className="flex items-center gap-1 text-emerald-600 font-semibold"><span>✓</span><span>공제 적용</span></span>
        : <span className="text-gray-400">{note ?? '미적용'}</span>}
    </div>
  )
}

// ── Main Modal ──────────────────────────────────────────────

export type SavePayload = {
  newClockIn:      string | null
  newClockOut:     string | null
  newErpOtApplied: boolean | null  // null = not edited, preserve existing
  newErpLeaveType: string  | null  // null = not edited, preserve existing
  finalStatus:     string | null
  finalReason:     string
  auditEntry:      EditHistoryEntry
}

type Props = {
  employee:             Employee
  record:               ProcessedRecord
  policy:               PolicySettings
  initialEditHistory?:  EditHistoryEntry[]
  initialApproved?:     boolean
  initialErpLeaveType?: string | null
  showExactTime?:       boolean
  onClose:              () => void
  onSave:               (payload: SavePayload) => void
  onDelete?:            () => void
}

export function DailyDetailModal({ employee, record, policy, initialEditHistory, initialApproved, initialErpLeaveType, showExactTime = false, onClose, onSave, onDelete }: Props) {
  // ── Audit / approval state ────────────────────────────────────────────
  const [editHistory, setEditHistory] = useState<EditHistoryEntry[]>(initialEditHistory ?? [])
  const isApproved = initialApproved ?? false

  // ── CAPS granular edit ────────────────────────────────────────────────
  const [isEditingCaps, setIsEditingCaps] = useState(false)
  const [capsIn,        setCapsIn]        = useState(record.clockIn?.replace(/^\+/, '')  ?? '')
  const [capsOut,       setCapsOut]       = useState(record.clockOut?.replace(/^\+/, '') ?? '')

  // ── ERP granular edit ─────────────────────────────────────────────────
  const [isEditingErp, setIsEditingErp] = useState(false)
  const [erpOtEdit,    setErpOtEdit]    = useState<string>(
    record.erpOtApplied ? '신청됨' : record.overtimeHours > 0 ? '미신청' : '해당없음',
  )

  // 연차 항목 배열: null/없음 → [], 단일/복합 → 파싱
  const parseLeaveEntries = (raw: string | null | undefined): string[] => {
    if (!raw || raw === '없음') return []
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }
  const [erpLeaveEntries, setErpLeaveEntries] = useState<string[]>(() => {
    // override가 명시적으로 저장된 경우 → override 값 사용 (원본 ERP 무시)
    if (initialErpLeaveType != null) return parseLeaveEntries(initialErpLeaveType)
    // override 없음 → 원본 ERP 데이터로 초기화 (편집 시작점)
    return record.leaveType ? [record.leaveType] : []
  })
  const [addingLeaveType, setAddingLeaveType] = useState('오전반차')

  // 화면 표시용 — 배열 → '없음' or joined string (저장 전 참조용)
  const erpLeaveEdit = erpLeaveEntries.length === 0 ? '없음' : erpLeaveEntries.join(',')

  function leaveAmount(type: string): number {
    if (type === '오전반반차' || type === '오후반반차') return 0.25
    if (type === '연차') return 1.0
    return 0.5
  }
  const totalLeaveAmount = erpLeaveEntries.reduce((s, t) => s + leaveAmount(t), 0)

  // 소명 완료 체크박스 (이상 건에서만 표시)
  const [markSoMyeong, setMarkSoMyeong] = useState(initialApproved ?? false)
  const [finalReason,  setFinalReason]  = useState('')

  const { exceptions: slackExceptions } = useSlack()
  // 동일 직원+날짜의 모든 슬랙 항목을 시간순으로 정렬
  const slackEntriesForDay = slackExceptions
    .filter(e => e.empId === employee.id && e.date === record.date)
    .sort((a, b) => a.rawText.localeCompare(b.rawText))
  const slackException = slackEntriesForDay[0] ?? null  // 레거시 호환

  // verificationNote entries written by applySlack (e.g. "✅ 슬랙 확인: 지각 면제 (외근·행사)")
  const slackVNotes = record.verificationNote?.filter(n => n.startsWith('✅ 슬랙 확인')) ?? []

  const orgPath = [employee.division, employee.team, employee.part].filter(Boolean).join(' / ')

  const stdEndMins = parseTimeToMins(policy.flexEnd)
    + policy.standardHours * 60
    + (parseTimeToMins(policy.lunchEnd) - parseTimeToMins(policy.lunchStart))
  const stdEnd = minsToHHMM(stdEndMins)

  const clockRange = record.clockIn && record.clockOut
    ? `${record.clockIn} ~ ${record.clockOut}`
    : record.clockIn
    ? `${record.clockIn} ~ 미태깅`
    : '미태깅'

  const capsStatus: 'ok' | 'warn' = !record.clockIn || !record.clockOut ? 'warn' : 'ok'
  const erpStatus:  'ok' | 'warn' = record.overtimeHours > 0 && !record.erpOtApplied ? 'warn' : 'ok'

  const hasSaved = editHistory.length > 0

  // ── Handlers ──────────────────────────────────────────────────────────

  function handleSave() {
    const origIn     = record.clockIn?.replace(/^\+/, '')  ?? ''
    const origOut    = record.clockOut?.replace(/^\+/, '') ?? ''
    const origErpOt  = record.erpOtApplied ? '신청됨' : record.overtimeHours > 0 ? '미신청' : '해당없음'
    const actionLog: string[] = []

    if (isEditingCaps) {
      if (capsIn  !== origIn)  actionLog.push(`[CAPS] 입실 ${origIn  || '미태깅'} → ${capsIn  || '미태깅'}`)
      if (capsOut !== origOut) actionLog.push(`[CAPS] 퇴실 ${origOut || '미태깅'} → ${capsOut || '미태깅'}`)
    }

    if (isEditingErp) {
      if (erpOtEdit   !== origErpOt) actionLog.push(`[ERP] 연장근무 ${origErpOt} → ${erpOtEdit}`)
      const origLeaveStr = parseLeaveEntries(initialErpLeaveType).join(', ') || '없음'
      const newLeaveStr  = erpLeaveEntries.join(', ') || '없음'
      if (newLeaveStr !== origLeaveStr) actionLog.push(`[ERP] 연차/반차 ${origLeaveStr} → ${newLeaveStr}`)
    }

    if (markSoMyeong) actionLog.push('[소명] 이상 소명 완료 처리')

    const newClockIn      = isEditingCaps ? (capsIn  || null) : record.clockIn
    const newClockOut     = isEditingCaps ? (capsOut || null) : record.clockOut
    const newErpOtApplied = isEditingErp  ? erpOtEdit === '신청됨' : null
    const newErpLeaveType = isEditingErp  ? erpLeaveEdit : null

    const auditEntry: EditHistoryEntry = {
      timestamp: new Date().toISOString(),
      adminName: 'HR Admin',
      oldValue:  { clockIn: record.clockIn,  clockOut: record.clockOut  },
      newValue:  { clockIn: newClockIn,       clockOut: newClockOut      },
      action:    actionLog.length > 0 ? actionLog.join(' / ') : undefined,
      reason:    finalReason.trim(),
    }

    // Optimistically update local history so the list refreshes immediately
    setEditHistory(prev => [...prev, auditEntry])

    const finalStatus = markSoMyeong ? '소명완료' : null
    onSave({ newClockIn, newClockOut, newErpOtApplied, newErpLeaveType, finalStatus, finalReason: finalReason.trim(), auditEntry })
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-start gap-4 px-6 py-5 border-b border-gray-100 shrink-0">
          <div className={`w-12 h-12 rounded-full ${avatarColor(employee.name)} flex items-center justify-center shrink-0`}>
            <span className="text-white text-lg font-bold">{employee.name[0]}</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-gray-900">{employee.name}</h2>
              <span className="text-xs text-gray-400 font-mono">{employee.rawId ?? employee.id}</span>
              {record.flag && !isApproved && (
                <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${FLAG_BADGE[record.flag]}`}>
                  ⚠ {FLAG_LABEL[record.flag]}
                </span>
              )}
              {isApproved && (
                <span className="text-xs px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold">
                  ✓ 승인완료
                </span>
              )}
              {hasSaved && (
                <span className="text-xs px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-600 border-emerald-200 font-medium">
                  ✓ 수정 반영됨
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5 truncate">{orgPath} · {employee.jobTitle}</p>
            <p className="text-sm font-semibold text-gray-700 mt-1">
              {record.date}
              <span className="ml-2 text-xs font-normal text-gray-400">{record.dayLabel}</span>
              {record.dayType !== 'WEEKDAY' && (
                <span className="ml-2 text-xs text-violet-500 font-medium">휴일근무</span>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors text-lg leading-none shrink-0"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* T.A.G. 최종 근태 상태 */}
          <section>
            {(() => {
              const cat = FINAL_STATUS_CATEGORY[record.finalStatus]
              const styles = {
                NORMAL:       { bg: 'bg-emerald-50', text: 'text-emerald-700', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
                ANOMALY:      { bg: 'bg-red-50',     text: 'text-red-700',     badge: 'bg-red-100 text-red-700 border-red-200' },
                HOLIDAY_WORK: { bg: 'bg-violet-50',  text: 'text-violet-700',  badge: 'bg-violet-100 text-violet-700 border-violet-200' },
                NON_WORKING:  { bg: 'bg-gray-50',    text: 'text-gray-500',    badge: 'bg-gray-100 text-gray-500 border-gray-200' },
              }
              const catLabels = { NORMAL: '정상 근무', ANOMALY: '근태 이상', HOLIDAY_WORK: '휴일근무', NON_WORKING: '비근무일' }
              const s = styles[cat]
              return (
                <div className={`rounded-xl p-4 flex items-center gap-4 ${s.bg}`}>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[10px] font-semibold uppercase tracking-wider mb-0.5 opacity-60 ${s.text}`}>
                      T.A.G. 판정 · {catLabels[cat]}
                    </p>
                    <p className={`text-xl font-bold leading-tight ${s.text}`}>{record.finalStatus}</p>
                  </div>
                  <span className={`shrink-0 text-[10px] px-2.5 py-1 rounded-full border font-semibold ${s.badge}`}>
                    {cat}
                  </span>
                </div>
              )
            })()}
          </section>

          {/* 근무 요약 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">근무 요약</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <SummaryCard
                label="배정 시프트"
                value={`${policy.flexStart} ~ ${stdEnd}`}
                sub={`유연시작 ${policy.flexStart}~${policy.flexEnd}`}
              />
              <SummaryCard
                label="기록 시간"
                value={clockRange}
                sub={
                  record.effectiveClockIn && record.effectiveClockIn !== record.clockIn
                    ? `유연시작 → ${record.effectiveClockIn}`
                    : undefined
                }
                tone={!record.clockIn || !record.clockOut ? 'warn' : 'neutral'}
              />
              {(() => {
                const rawOtH  = (record.rawOvertimeMinutes ?? 0) / 60
                const dispOtH = showExactTime ? rawOtH : record.overtimeHours
                const hasDiff = record.rawOvertimeMinutes !== undefined &&
                  record.rawOvertimeMinutes !== record.overtimeHours * 60
                return (
                  <>
                    <SummaryCard
                      label={showExactTime ? '실 근로 (실제)' : '실 근로 (인정)'}
                      value={fmt(record.regularHours + dispOtH)}
                      sub={hasDiff && !showExactTime
                        ? `실제 ${fmt(record.regularHours + rawOtH)}`
                        : hasDiff && showExactTime
                        ? `인정 ${fmt(record.regularHours + record.overtimeHours)}`
                        : `기본 ${fmt(record.regularHours)}`
                      }
                      tone="neutral"
                    />
                    <SummaryCard
                      label={showExactTime ? '연장 (실제) / 야간' : '연장 (인정) / 야간'}
                      value={fmt(dispOtH)}
                      sub={hasDiff && !showExactTime
                        ? `실제 ${fmt(rawOtH)} · 야간 ${fmt(record.nightHours)}`
                        : hasDiff && showExactTime
                        ? `인정 ${fmt(record.overtimeHours)} · 야간 ${fmt(record.nightHours)}`
                        : `야간 ${fmt(record.nightHours)}`
                      }
                      tone={dispOtH > 0 ? 'amber' : 'neutral'}
                    />
                  </>
                )
              })()}
            </div>
          </section>

          {/* 다중소스 검증 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">다중소스 검증</p>
            <div className="space-y-2.5">

              <SourceBlock
                icon="🏢"
                label="CAPS (출입태그)"
                statusDot={capsStatus}
                editButton={
                  <button
                    onClick={() => {
                      if (isEditingCaps) {
                        setCapsIn(record.clockIn?.replace(/^\+/, '')  ?? '')
                        setCapsOut(record.clockOut?.replace(/^\+/, '') ?? '')
                      }
                      setIsEditingCaps(p => !p)
                    }}
                    className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition-colors"
                  >
                    ✏️ {isEditingCaps ? '취소' : '수정'}
                  </button>
                }
              >
                {isEditingCaps ? (
                  <div className="flex items-center gap-4 flex-wrap mt-0.5">
                    <label className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500 w-6 shrink-0">입실</span>
                      <input
                        type="time"
                        value={capsIn}
                        onChange={e => setCapsIn(e.target.value)}
                        className="text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500 w-6 shrink-0">퇴실</span>
                      <input
                        type="time"
                        value={capsOut}
                        onChange={e => setCapsOut(e.target.value)}
                        className="text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span>
                        입실{' '}
                        {record.clockIn
                          ? <strong className="text-gray-800">{record.clockIn}</strong>
                          : <span className="text-red-500 font-medium">미태깅</span>}
                      </span>
                      <span className="text-gray-300">/</span>
                      <span>
                        퇴실{' '}
                        {record.clockOut
                          ? <strong className="text-gray-800">{record.clockOut}</strong>
                          : <span className="text-red-500 font-medium">미태깅</span>}
                      </span>
                    </div>
                    {record.effectiveClockIn && record.effectiveClockIn !== record.clockIn && (
                      <p className="text-xs text-blue-500 mt-1">
                        유연시작 정책 적용 → 실질 시작 {record.effectiveClockIn}
                      </p>
                    )}
                    {capsStatus === 'warn' && (
                      <p className="text-xs text-red-500 mt-1 font-medium">
                        태그 누락 — 보안팀 출입 로그 교차 확인 권장
                      </p>
                    )}
                  </>
                )}
              </SourceBlock>

              {/* ── ERP 연차·휴가 정보 ── */}
              <SourceBlock
                icon="📋"
                label="ERP 연차·휴가"
                statusDot="ok"
                editButton={
                  <button
                    onClick={() => {
                      if (isEditingErp) {
                        setErpLeaveEntries(
                          initialErpLeaveType != null
                            ? parseLeaveEntries(initialErpLeaveType)
                            : (record.leaveType ? [record.leaveType] : [])
                        )
                      }
                      setIsEditingErp(p => !p)
                    }}
                    className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition-colors"
                  >
                    ✏️ {isEditingErp ? '취소' : '수정'}
                  </button>
                }
              >
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-gray-500 w-20 shrink-0 pt-0.5">연차 / 반차</span>
                    <div className="flex-1 space-y-1.5">
                      {isEditingErp ? (
                        <>
                          {/* 등록된 항목 chips */}
                          {erpLeaveEntries.map((entry, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2.5 py-0.5 font-medium">
                                {entry}
                                <span className="text-blue-400 ml-1">({leaveAmount(entry)}일)</span>
                              </span>
                              <button
                                onClick={() => setErpLeaveEntries(prev => prev.filter((_, idx) => idx !== i))}
                                className="text-red-400 hover:text-red-600 text-xs font-bold"
                              >✕</button>
                            </div>
                          ))}

                          {/* 항목 추가 행 */}
                          <div className="flex items-center gap-1.5">
                            <select
                              value={addingLeaveType}
                              onChange={e => setAddingLeaveType(e.target.value)}
                              className="text-xs border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            >
                              <option value="연차">연차 (1.0일)</option>
                              <option value="오전반차">오전반차 (0.5일)</option>
                              <option value="오후반차">오후반차 (0.5일)</option>
                              <option value="오전반반차">오전반반차 (0.25일)</option>
                              <option value="오후반반차">오후반반차 (0.25일)</option>
                              <option value="생일반차">생일반차 (0.5일)</option>
                              <option value="출장">출장</option>
                              <option value="재택근무">재택근무</option>
                            </select>
                            <button
                              onClick={() => {
                                if (!erpLeaveEntries.includes(addingLeaveType))
                                  setErpLeaveEntries(prev => [...prev, addingLeaveType])
                              }}
                              className="text-xs bg-blue-500 text-white px-2 py-1 rounded-lg hover:bg-blue-600 transition-colors"
                            >+ 추가</button>
                            {erpLeaveEntries.length > 0 && (
                              <button
                                onClick={() => setErpLeaveEntries([])}
                                className="text-xs text-red-400 hover:text-red-600 underline"
                              >전체 삭제</button>
                            )}
                          </div>

                          {/* 합계 */}
                          {erpLeaveEntries.length > 0 && (
                            <div className="text-xs text-gray-500 pt-0.5">
                              합계: <span className="font-semibold text-blue-700">{totalLeaveAmount}일</span>
                            </div>
                          )}
                        </>
                      ) : (
                        erpLeaveEntries.length > 0 ? (
                          <span className="flex items-center gap-1.5 flex-wrap">
                            {erpLeaveEntries.map((entry, i) => (
                              <span key={i} className="text-blue-700 font-semibold">{entry}</span>
                            ))}
                            <span className="text-gray-400 text-xs">({totalLeaveAmount}일)</span>
                            {record.rawLeaveCode && (
                              <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                                {record.rawLeaveCode}
                              </span>
                            )}
                          </span>
                        ) : <span className="text-gray-400">없음</span>
                      )}
                    </div>
                  </div>
                </div>
              </SourceBlock>

              {/* ── ERP 연장근무 신청 ── */}
              <SourceBlock
                icon="⏱️"
                label="ERP 연장근무 신청"
                statusDot={erpStatus}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20 shrink-0">신청 여부</span>
                    {record.erpOtApplied
                      ? <span className="text-emerald-600 font-semibold">✓ 신청됨</span>
                      : record.overtimeHours > 0
                      ? <span className="text-red-500 font-semibold">✗ 미신청</span>
                      : <span className="text-gray-400">해당없음</span>
                    }
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20 shrink-0">표준 퇴근</span>
                    <span className="text-gray-700">{stdEnd}</span>
                    <span className="text-xs text-gray-400">
                      (유예 +{policy.dinnerGraceMinutes}분 → OT 인정 기준 {minsToHHMM(stdEndMins + policy.dinnerGraceMinutes)})
                    </span>
                  </div>
                </div>
              </SourceBlock>

              <SourceBlock
                icon="💬"
                label="Slack (메신저)"
                statusDot={slackEntriesForDay.length > 0 ? 'ok' : 'info'}
              >
                {slackEntriesForDay.length > 0 ? (
                  <div className="space-y-3">
                    {slackEntriesForDay.map((ex, idx) => (
                      <div key={idx} className="space-y-1.5">
                        {/* 복수 메시지일 때 순서 표시 */}
                        {slackEntriesForDay.length > 1 && (
                          <p className="text-[10px] font-semibold text-gray-400">
                            메시지 {idx + 1}/{slackEntriesForDay.length}
                          </p>
                        )}
                        {/* Raw message bubble */}
                        <div className="bg-white rounded-lg border border-gray-100 px-3 py-2.5">
                          <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                            {ex.rawText}
                          </p>
                        </div>
                        {/* 분류 뱃지 */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] text-gray-400">분류</span>
                          <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold
                            bg-emerald-50 text-emerald-700 border border-emerald-200">
                            {ex.note}
                          </span>
                        </div>
                      </div>
                    ))}
                    {/* 처리 결과 notes */}
                    {slackVNotes.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {slackVNotes.map((n, i) => (
                          <span key={i} className="text-[10px] font-semibold text-emerald-600">{n}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-gray-400 text-xs">연동된 슬랙 메시지가 없습니다.</span>
                )}
              </SourceBlock>
            </div>
          </section>

          {/* 상태 계산 과정 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">상태 계산 과정</p>
            <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-2 text-xs">
              {/* ERP 연차 */}
              {record.leaveType && (
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 shrink-0 w-5">①</span>
                  <span>
                    <span className="font-medium text-blue-700">ERP 연차</span>
                    {' '}인식 →{' '}
                    <span className="font-semibold">{record.rawLeaveCode ?? record.leaveType}</span>
                    {record.erpLeaveAmount ? ` (${record.erpLeaveAmount}일)` : ''}
                  </span>
                </div>
              )}
              {/* CAPS 체류 */}
              {(record.clockIn || record.clockOut) && (
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 shrink-0 w-5">{record.leaveType ? '②' : '①'}</span>
                  <span>
                    <span className="font-medium text-gray-700">출입태그</span>
                    {' '}{record.clockIn ?? '미태깅'} ~ {record.clockOut ?? '미태깅'}
                  </span>
                </div>
              )}
              {/* 이상치 플래그 */}
              {record.flag && (
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 shrink-0 w-5">⚠</span>
                  <span className="text-red-600 font-medium">
                    이상 감지: {
                      record.flag === 'LATE' ? '지각' :
                      record.flag === 'NO_CLOCK_IN' ? '출근 미태깅' :
                      record.flag === 'NO_CLOCK_OUT' ? '퇴근 미태깅' :
                      // 3종 체계: 마감선을 1분이라도 못 채우면 근무시간 미달 (여유 없음, 조기퇴근 폐지)
                      record.flag === 'EARLY_DEPARTURE' ? '근무시간 미달' :
                      record.flag === 'ATTENDANCE_ANOMALY' ? '근무시간 미달' :
                      record.flag === 'LATE_AND_EARLY_DEPARTURE' ? '지각 + 근무시간 미달' :
                      record.flag === 'LATE_AND_ANOMALY' ? '지각 + 근무시간 미달' :
                      record.flag
                    }
                  </span>
                </div>
              )}
              {/* Slack */}
              {slackEntriesForDay.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 shrink-0 w-5">💬</span>
                  <span>
                    <span className="font-medium text-violet-700">Slack</span>
                    {' '}→ {slackEntriesForDay.map(e => e.note).join(', ')}
                  </span>
                </div>
              )}
              {/* verificationNote */}
              {(record.verificationNote ?? []).filter(n => !n.startsWith('✅')).map((n, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-gray-400 shrink-0 w-5">→</span>
                  <span className="text-gray-600">{n}</span>
                </div>
              ))}
              {/* 최종 상태 */}
              <div className="flex items-start gap-2 pt-1 border-t border-gray-200">
                <span className="text-gray-400 shrink-0 w-5">✓</span>
                <span>
                  <span className="font-medium text-gray-700">최종 판정</span>
                  {' → '}
                  <span className={`font-bold ${
                    record.flag ? 'text-red-600' : 'text-emerald-600'
                  }`}>{record.finalStatus}</span>
                </span>
              </div>
            </div>
          </section>

          {/* 최종 근태 판정 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">최종 근태 판정</p>
            <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3.5">
              {/* 자동 계산 결과 (읽기 전용) */}
              <div className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
                <span className="text-xs font-semibold text-gray-500">자동 계산 결과</span>
                <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                  record.flag
                    ? 'bg-red-50 text-red-700 border border-red-200'
                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                }`}>
                  {record.finalStatus}
                </span>
              </div>
              {/* 소명 완료 체크박스 — 이상 플래그가 있는 건에만 표시 */}
              {record.flag && (
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={markSoMyeong}
                    onChange={e => setMarkSoMyeong(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-gray-700">이상 소명 완료로 처리</span>
                  {markSoMyeong && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                      소명완료
                    </span>
                  )}
                </label>
              )}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                  수정 사유 <span className="text-gray-400 font-normal">(선택)</span>
                </label>
                <textarea
                  value={finalReason}
                  onChange={e => setFinalReason(e.target.value)}
                  placeholder="예) 사옥 정전으로 인한 캡스 미태깅"
                  rows={2}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-gray-300 resize-none"
                />
              </div>
            </div>
          </section>

          {/* 휴게 공제 내역 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">휴게 공제 내역</p>
            <div className="bg-gray-50 rounded-xl px-4 py-2">
              <BreakRow
                label="점심 휴게"
                window={`${policy.lunchStart} ~ ${policy.lunchEnd} (60분)`}
                applied={record.lunchDeducted}
                note="점심 구간 외 근무 또는 조기퇴근"
              />
              <BreakRow
                label="저녁 유예"
                window={`표준 퇴근 후 ${policy.dinnerGraceMinutes}분 무급`}
                applied={record.dinnerDeducted}
                note="표준 퇴근 이전 퇴근"
              />
            </div>
          </section>

          {/* ── 수정 이력 (Audit Trail) ── */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                수정 이력 (Audit Trail)
              </p>
              {hasSaved && (
                <span className="text-[10px] font-semibold text-blue-500 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full">
                  {editHistory.length}건
                </span>
              )}
            </div>

            {!hasSaved ? (
              <div className="flex items-center justify-center gap-2 bg-gray-50 rounded-xl px-4 py-4 text-xs text-gray-400">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                수정 내역 없음
              </div>
            ) : (
              <ul className="rounded-xl border border-gray-100 bg-gray-50/50 px-4 py-3 space-y-2.5">
                {editHistory.map((entry, i) => {
                  // Prefer pre-computed smart log; fall back to deriving from old/new times
                  let displayAction: string
                  if (entry.action) {
                    displayAction = entry.action
                  } else {
                    const changes: string[] = []
                    if (entry.oldValue.clockIn  !== entry.newValue.clockIn)
                      changes.push(`입실 ${fmtTime(entry.oldValue.clockIn)} → ${fmtTime(entry.newValue.clockIn)}`)
                    if (entry.oldValue.clockOut !== entry.newValue.clockOut)
                      changes.push(`퇴실 ${fmtTime(entry.oldValue.clockOut)} → ${fmtTime(entry.newValue.clockOut)}`)
                    displayAction = changes.join(', ')
                  }
                  return (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className="text-gray-300 shrink-0 mt-px">•</span>
                      <span className="text-gray-600 leading-relaxed">
                        <span className="font-mono text-gray-400">[{formatTimestamp(entry.timestamp)}]</span>
                        {' '}
                        <span className="font-semibold text-gray-700">{entry.adminName}</span>
                        {displayAction && (
                          <>
                            {' — '}
                            <span className="font-mono text-blue-600">{displayAction}</span>
                          </>
                        )}
                        {entry.reason && (
                          <span className="text-gray-400"> · {entry.reason}</span>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

        </div>

        {/* ── Footer ── */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 bg-gray-50/40 shrink-0">
          <p className="text-xs text-gray-400">
            {hasSaved && (
              <span className="text-emerald-600 font-medium">모든 수정 사항이 실시간으로 반영되었습니다</span>
            )}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {onDelete && (
              <button
                onClick={onDelete}
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 active:scale-95 transition-all"
              >
                삭제
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 active:scale-95 transition-all"
            >
              닫기
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 active:scale-95 transition-all shadow-sm shadow-blue-200"
            >
              저장 및 처리완료
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
