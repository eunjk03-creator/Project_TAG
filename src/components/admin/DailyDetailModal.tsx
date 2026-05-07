'use client'
import { useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import { processRecord } from '@/hooks/useAttendanceLogic'
import type { ProcessedRecord, Employee, PolicySettings } from '@/types/tag'

const FLAG_LABEL: Record<string, string> = {
  LATE: '지각',
  NO_CLOCK_OUT: '퇴근 미태깅',
  UNAPPROVED_OT: 'OT 미신청',
  EARLY_DEPARTURE: '조기퇴근',
}

const FLAG_BADGE: Record<string, string> = {
  LATE: 'bg-orange-50 text-orange-700 border-orange-200',
  NO_CLOCK_OUT: 'bg-red-50 text-red-700 border-red-200',
  UNAPPROVED_OT: 'bg-amber-50 text-amber-700 border-amber-200',
  EARLY_DEPARTURE: 'bg-blue-50 text-blue-700 border-blue-200',
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

/** Deterministic mock Slack messages based on employee + date + flag */
function getSlackMessages(
  emp: Employee,
  date: string,
  flag: ProcessedRecord['flag'],
): { time: string; channel: string; text: string }[] {
  if (flag === 'LATE') {
    return [{ time: '08:47', channel: '#general', text: '오늘 지하철 지연으로 조금 늦겠습니다. 09:20 전후 도착 예정입니다.' }]
  }
  if (flag === 'UNAPPROVED_OT') {
    return [{ time: '18:52', channel: '#dev-ops', text: '오늘 배포 작업으로 야근할 예정입니다. 20:00~21:00 사이 완료 목표.' }]
  }
  if (flag === 'EARLY_DEPARTURE') {
    return [{ time: '14:30', channel: '#general', text: '오늘 병원 예약이 있어 15:30 조기 퇴근합니다.' }]
  }
  // seeded pseudo-random: some normal days have incidental activity
  const seed = emp.id.charCodeAt(5) * 31 + date.charCodeAt(8) * 17
  if (seed % 7 === 0) {
    return [{ time: '10:15', channel: '#general', text: '오전 미팅 완료. 오늘 재택 병행 예정입니다.' }]
  }
  return []
}

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
  icon, label, statusDot, children,
}: {
  icon: string
  label: string
  statusDot: 'ok' | 'warn' | 'info'
  children: ReactNode
}) {
  const dot = { ok: 'bg-green-400', warn: 'bg-red-400', info: 'bg-gray-300' }[statusDot]
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-base">{icon}</span>
        <span className="text-xs font-semibold text-gray-700">{label}</span>
        <span className={`ml-auto w-2 h-2 rounded-full shrink-0 ${dot}`} />
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

type Props = {
  employee: Employee
  record: ProcessedRecord
  policy: PolicySettings
  onClose: () => void
  onApprove: () => void
}

export function DailyDetailModal({ employee, record, policy, onClose, onApprove }: Props) {
  const [isEditing, setIsEditing] = useState(false)
  const [editIn,  setEditIn]  = useState(record.clockIn?.startsWith('+') ? record.clockIn.slice(1) : (record.clockIn ?? ''))
  const [editOut, setEditOut] = useState(record.clockOut?.startsWith('+') ? record.clockOut.slice(1) : (record.clockOut ?? ''))
  const [editSaved,  setEditSaved]  = useState(false)
  const [isApproved, setIsApproved] = useState(false)

  /** Re-run business logic on edited times for live preview */
  const editedRecord = useMemo(() => {
    if (!isEditing && !editSaved) return null
    const rawIn  = editIn  ? editIn  : null
    const rawOut = editOut ? editOut : null
    const modified = {
      employeeId:   record.employeeId,
      date:         record.date,
      dayType:      record.dayType,
      dayLabel:     record.dayLabel,
      clockIn:      rawIn,
      clockOut:     rawOut,
      erpOtApplied: record.erpOtApplied,
    }
    return processRecord(modified, policy)
  }, [isEditing, editSaved, editIn, editOut, record, policy])

  const display = editedRecord ?? record

  const slackMessages = useMemo(
    () => getSlackMessages(employee, record.date, record.flag),
    [employee, record.date, record.flag],
  )

  const orgPath = [employee.division, employee.team, employee.part].filter(Boolean).join(' / ')

  // Standard shift end = flexEnd + standardHours + lunch break
  const stdEndMins = parseTimeToMins(policy.flexEnd)
    + policy.standardHours * 60
    + (parseTimeToMins(policy.lunchEnd) - parseTimeToMins(policy.lunchStart))
  const stdEnd = minsToHHMM(stdEndMins)

  // Net time display: clockIn ~ clockOut
  const clockRange = display.clockIn && display.clockOut
    ? `${display.clockIn} ~ ${display.clockOut}`
    : display.clockIn
    ? `${display.clockIn} ~ 미태깅`
    : '미태깅'

  const capsStatus: 'ok' | 'warn' =
    !display.clockIn || !display.clockOut ? 'warn' : 'ok'

  const erpStatus: 'ok' | 'warn' =
    display.overtimeHours > 0 && !record.erpOtApplied ? 'warn' : 'ok'

  function handleSave() {
    setEditSaved(true)
    setIsEditing(false)
  }

  function handleCancelEdit() {
    setIsEditing(false)
    setEditIn(record.clockIn?.startsWith('+') ? record.clockIn.slice(1) : (record.clockIn ?? ''))
    setEditOut(record.clockOut?.startsWith('+') ? record.clockOut.slice(1) : (record.clockOut ?? ''))
    setEditSaved(false)
  }

  function handleApprove() {
    setIsApproved(true)
    onApprove()
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
              <span className="text-xs text-gray-400 font-mono">{employee.id}</span>
              {display.flag && !isApproved && (
                <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${FLAG_BADGE[display.flag]}`}>
                  ⚠ {FLAG_LABEL[display.flag]}
                </span>
              )}
              {isApproved && (
                <span className="text-xs px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold">
                  ✓ 승인완료
                </span>
              )}
              {editSaved && !isEditing && (
                <span className="text-xs px-2 py-0.5 rounded-full border bg-blue-50 text-blue-600 border-blue-200 font-medium">
                  수정 반영됨
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
                  display.effectiveClockIn && display.effectiveClockIn !== display.clockIn
                    ? `유연시작 → ${display.effectiveClockIn}`
                    : undefined
                }
                tone={!display.clockIn || !display.clockOut ? 'warn' : 'neutral'}
              />
              <SummaryCard
                label="실 근로시간"
                value={fmt(display.regularHours + display.overtimeHours)}
                sub={`기본 ${fmt(display.regularHours)}`}
                tone="neutral"
              />
              <SummaryCard
                label="연장 / 야간"
                value={fmt(display.overtimeHours)}
                sub={`야간 ${fmt(display.nightHours)}`}
                tone={display.overtimeHours > 0 ? 'amber' : 'neutral'}
              />
            </div>
          </section>

          {/* 다중소스 검증 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">다중소스 검증</p>
            <div className="space-y-2.5">

              {/* CAPS */}
              <SourceBlock icon="🏢" label="CAPS (출입태그)" statusDot={capsStatus}>
                <div className="flex items-center gap-3 flex-wrap">
                  <span>
                    입실{' '}
                    {display.clockIn
                      ? <strong className="text-gray-800">{display.clockIn}</strong>
                      : <span className="text-red-500 font-medium">미태깅</span>}
                  </span>
                  <span className="text-gray-300">/</span>
                  <span>
                    퇴실{' '}
                    {display.clockOut
                      ? <strong className="text-gray-800">{display.clockOut}</strong>
                      : <span className="text-red-500 font-medium">미태깅</span>}
                  </span>
                </div>
                {display.effectiveClockIn && display.effectiveClockIn !== display.clockIn && (
                  <p className="text-xs text-blue-500 mt-1">
                    유연시작 정책 적용 → 실질 시작 {display.effectiveClockIn}
                  </p>
                )}
                {capsStatus === 'warn' && (
                  <p className="text-xs text-red-500 mt-1 font-medium">
                    태그 누락 — 보안팀 출입 로그 교차 확인 권장
                  </p>
                )}
              </SourceBlock>

              {/* ERP */}
              <SourceBlock icon="📋" label="ERP (인사시스템)" statusDot={erpStatus}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20 shrink-0">연장근무 신청</span>
                    {record.erpOtApplied
                      ? <span className="text-emerald-600 font-semibold">✓ 신청됨</span>
                      : display.overtimeHours > 0
                      ? <span className="text-red-500 font-semibold">✗ 미신청</span>
                      : <span className="text-gray-400">해당없음</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20 shrink-0">연차 / 반차</span>
                    <span className="text-gray-400">없음</span>
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

              {/* Slack */}
              <SourceBlock
                icon="💬"
                label="Slack (메신저)"
                statusDot={slackMessages.length > 0 ? 'info' : 'info'}
              >
                {slackMessages.length > 0 ? (
                  <div className="space-y-1.5">
                    {slackMessages.map((msg, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <span className="text-[10px] text-gray-400 font-mono shrink-0 mt-0.5 w-10">{msg.time}</span>
                        <span className="text-xs text-blue-500 font-medium shrink-0">{msg.channel}</span>
                        <span className="text-gray-600 text-xs">{msg.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-gray-400 text-xs">해당일 관련 메시지 없음</span>
                )}
              </SourceBlock>
            </div>
          </section>

          {/* 공제 내역 */}
          <section>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">휴게 공제 내역</p>
            <div className="bg-gray-50 rounded-xl px-4 py-2">
              <BreakRow
                label="점심 휴게"
                window={`${policy.lunchStart} ~ ${policy.lunchEnd} (60분)`}
                applied={display.lunchDeducted}
                note="점심 구간 외 근무 또는 조기퇴근"
              />
              <BreakRow
                label="저녁 유예"
                window={`표준 퇴근 후 ${policy.dinnerGraceMinutes}분 무급`}
                applied={display.dinnerDeducted}
                note="표준 퇴근 이전 퇴근"
              />
            </div>
          </section>

          {/* 로그 수정 (expandable) */}
          {isEditing && (
            <section>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">로그 수정</p>
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-4">
                <p className="text-xs text-blue-600">
                  시간 수정 시 실시간으로 근태 계산이 갱신됩니다. 저장은 관리자 검토 후 최종 반영됩니다.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">출근 시각</label>
                    <input
                      type="time"
                      value={editIn}
                      onChange={e => setEditIn(e.target.value)}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1.5">퇴근 시각</label>
                    <input
                      type="time"
                      value={editOut}
                      onChange={e => setEditOut(e.target.value)}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    />
                  </div>
                </div>

                {/* Live recalculation preview */}
                {editedRecord && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-blue-700 bg-blue-100/60 rounded-lg px-3 py-2">
                    <span className="text-gray-500">재산정 →</span>
                    <span>실근로 {fmt(editedRecord.regularHours + editedRecord.overtimeHours)}</span>
                    <span className="text-gray-300">|</span>
                    <span>연장 {fmt(editedRecord.overtimeHours)}</span>
                    <span className="text-gray-300">|</span>
                    <span>야간 {fmt(editedRecord.nightHours)}</span>
                    {editedRecord.flag
                      ? <><span className="text-gray-300">|</span><span className="text-orange-600">{FLAG_LABEL[editedRecord.flag]}</span></>
                      : <><span className="text-gray-300">|</span><span className="text-emerald-600">이상없음</span></>}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
                  >
                    저장
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="px-4 py-1.5 bg-white text-gray-500 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                  >
                    취소
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 bg-gray-50/40 shrink-0">
          <p className="text-xs text-gray-400">
            {editSaved && !isEditing && (
              <span className="text-blue-600 font-medium">수정 내역 반영됨 — 관리자 확인 대기</span>
            )}
            {!editSaved && !isEditing && record.flag && !isApproved && (
              <span>이상치 감지됨 — 아래 버튼으로 조치하세요</span>
            )}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {!isEditing && (
              <button
                onClick={() => { setIsEditing(true); setEditSaved(false) }}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 active:scale-95 transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                로그 수정
              </button>
            )}
            <button
              onClick={isApproved ? undefined : handleApprove}
              disabled={isApproved || !record.flag}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg transition-all ${
                isApproved
                  ? 'bg-emerald-100 text-emerald-700 border border-emerald-200 cursor-default'
                  : !record.flag
                  ? 'bg-gray-100 text-gray-400 border border-gray-200 cursor-default'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95'
              }`}
            >
              {isApproved
                ? <><span>✓</span><span>승인됨</span></>
                : <><span>이상치 승인</span></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
