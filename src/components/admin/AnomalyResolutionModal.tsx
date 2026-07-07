'use client'
import { useState } from 'react'
import type { ProcessedRecord, Employee, ResolutionData } from '@/types/tag'

export type { ResolutionData }  // re-export so existing importers don't break

// 3종 체계(지각/근무시간미달/미태깅) — EARLY_DEPARTURE는 캐시된 레코드 하위호환용 라벨
const FLAG_LABEL: Record<string, string> = {
  LATE:               '지각',
  NO_CLOCK_IN:        '출근 미태깅',
  NO_CLOCK_OUT:       '퇴근 미태깅',
  ATTENDANCE_ANOMALY: '근무시간 미달',
  EARLY_DEPARTURE:    '근무시간 미달',
}

const FLAG_BADGE: Record<string, string> = {
  LATE:               'text-amber-700 bg-amber-50 border-amber-300',
  NO_CLOCK_IN:        'text-red-700 bg-red-50 border-red-300',
  NO_CLOCK_OUT:       'text-red-700 bg-red-50 border-red-300',
  ATTENDANCE_ANOMALY: 'text-sky-700 bg-sky-50 border-sky-300',
  EARLY_DEPARTURE:    'text-sky-700 bg-sky-50 border-sky-300',
}

export type ResolutionTarget = {
  record: ProcessedRecord
  employee: Employee | undefined
}

export type TimeOverride = {
  clockIn: string | null
  clockOut: string | null
}

type Props = {
  targets: ResolutionTarget[]
  initial?: ResolutionData
  onClose: () => void
  onSave: (data: ResolutionData, timeOverrides: Record<string, TimeOverride>) => void
}

function rk(employeeId: string, date: string) {
  return `${employeeId}_${date}`
}

export function AnomalyResolutionModal({ targets, initial, onClose, onSave }: Props) {
  const [reason, setReason] = useState(initial?.reasonLabel ?? '')
  const [memo, setMemo]     = useState(initial?.memo ?? '')

  // Per-target time inputs — only relevant for NO_CLOCK_OUT records
  const [timeInputs, setTimeInputs] = useState<Record<string, { in: string; out: string }>>(() => {
    const init: Record<string, { in: string; out: string }> = {}
    for (const { record } of targets) {
      if (record.flag === 'NO_CLOCK_OUT') {
        init[rk(record.employeeId, record.date)] = {
          in:  record.clockIn  ?? '',
          out: record.clockOut ?? '',
        }
      }
    }
    return init
  })

  const noClockOutCount = targets.filter(t => t.record.flag === 'NO_CLOCK_OUT').length
  const canSubmit       = reason.trim().length > 0

  function handleSave() {
    if (!canSubmit) return

    const overrides: Record<string, TimeOverride> = {}
    for (const { record } of targets) {
      if (record.flag === 'NO_CLOCK_OUT') {
        const key = rk(record.employeeId, record.date)
        const t   = timeInputs[key]
        if (t) {
          overrides[key] = {
            clockIn:  t.in.trim()  || null,
            clockOut: t.out.trim() || null,
          }
        }
      }
    }

    onSave({ reasonLabel: reason.trim(), memo }, overrides)
  }

  function updateTime(key: string, field: 'in' | 'out', value: string) {
    setTimeInputs(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }

  const isBulk = targets.length > 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal card */}
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col overflow-hidden">

        {/* ── Header ── */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-gray-900">
                {isBulk ? '일괄 처리' : '이상치 처리'}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {isBulk
                  ? `${targets.length}건에 공통 사유를 적용합니다`
                  : '소명 사유를 입력하고 처리를 완료합니다'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              {isBulk && (
                <span className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold">
                  {targets.length}
                </span>
              )}
              <button onClick={onClose} className="text-gray-300 hover:text-gray-500 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">

          {/* Common reason — required */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">
              공통 처리 사유 <span className="text-red-400">*</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="예) 사옥 정전으로 인한 출입게이트 오류"
              rows={3}
              autoFocus
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-white text-gray-700 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
            {noClockOutCount > 0 && (
              <p className="text-[11px] text-blue-500 mt-1.5 flex items-center gap-1">
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                미태깅 {noClockOutCount}건 — 아래에서 누락 시간을 직접 입력할 수 있습니다
              </p>
            )}
          </div>

          {/* Optional memo */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">
              담당자 메모{' '}
              <span className="text-gray-300 font-normal">(선택)</span>
            </label>
            <textarea
              value={memo}
              onChange={e => setMemo(e.target.value)}
              placeholder="추가 메모를 입력하세요..."
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-white text-gray-700 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>

          {/* Target list */}
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">
              처리 대상{' '}
              <span className="text-gray-400 font-normal">{targets.length}건</span>
            </p>
            <div className="rounded-xl border border-gray-200 overflow-hidden divide-y divide-gray-100">
              {targets.map(({ record, employee }, i) => {
                const key          = rk(record.employeeId, record.date)
                const isNoClockOut = record.flag === 'NO_CLOCK_OUT'
                const needsIn      = isNoClockOut && record.clockIn  === null
                const needsOut     = isNoClockOut && record.clockOut === null

                return (
                  <div key={i} className={`px-4 py-3 ${isNoClockOut ? 'bg-red-50/40' : 'bg-white'}`}>

                    {/* Row 1: identity + flag + date */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-800">
                        {employee?.name ?? record.employeeId}
                      </span>
                      {employee?.division && (
                        <span className="text-[10px] text-gray-400">{employee.division}</span>
                      )}
                      {record.flag && (
                        <span className={`inline-block text-[10px] px-1.5 py-px rounded-full border font-semibold ${FLAG_BADGE[record.flag]}`}>
                          {FLAG_LABEL[record.flag]}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-400 ml-auto">{record.date}</span>
                    </div>

                    {/* Row 2 (NO_CLOCK_OUT only): inline time inputs */}
                    {isNoClockOut && (needsIn || needsOut) && (
                      <div className="mt-2.5 flex items-center gap-4">
                        {needsIn && (
                          <label className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-500 w-6 shrink-0">출근</span>
                            <input
                              type="text"
                              value={timeInputs[key]?.in ?? ''}
                              onChange={e => updateTime(key, 'in', e.target.value)}
                              placeholder="08:55"
                              maxLength={5}
                              className="w-16 px-2 py-1 text-xs font-mono text-center border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300"
                            />
                          </label>
                        )}
                        {needsOut && (
                          <label className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-500 w-6 shrink-0">퇴근</span>
                            <input
                              type="text"
                              value={timeInputs[key]?.out ?? ''}
                              onChange={e => updateTime(key, 'out', e.target.value)}
                              placeholder="18:30"
                              maxLength={5}
                              className="w-16 px-2 py-1 text-xs font-mono text-center border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300"
                            />
                          </label>
                        )}
                      </div>
                    )}

                    {/* NO_CLOCK_OUT but both times already present (editing) */}
                    {isNoClockOut && !needsIn && !needsOut && (
                      <p className="text-[10px] text-gray-400 mt-1.5">
                        출근 {record.clockIn} · 퇴근 {record.clockOut}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="px-6 pb-6 pt-4 border-t border-gray-100 flex items-center gap-3 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-sm font-medium text-gray-500 bg-gray-100 rounded-xl hover:bg-gray-200 active:scale-[0.98] transition-all"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={!canSubmit}
            className="flex-1 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-blue-200"
          >
            저장 및 처리완료
          </button>
        </div>
      </div>
    </div>
  )
}
