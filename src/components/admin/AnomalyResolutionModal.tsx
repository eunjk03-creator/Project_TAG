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

function isNoTagFlag(flag: string | null): boolean {
  return flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT'
}

// 표준 근무시간 기준값(정책 기본 소정근무 8h와 동일) — "8시간 자동 부여"가 채우는 값.
const STANDARD_CLOCK_IN  = '09:00'
const STANDARD_CLOCK_OUT = '18:00'

export function AnomalyResolutionModal({ targets, initial, onClose, onSave }: Props) {
  const [reason, setReason] = useState(initial?.reasonLabel ?? '')
  const [memo, setMemo]     = useState(initial?.memo ?? '')

  // Per-target time inputs — 미태깅(NO_CLOCK_IN/NO_CLOCK_OUT) 레코드에만 해당
  const [timeInputs, setTimeInputs] = useState<Record<string, { in: string; out: string }>>(() => {
    const init: Record<string, { in: string; out: string }> = {}
    for (const { record } of targets) {
      if (isNoTagFlag(record.flag)) {
        init[rk(record.employeeId, record.date)] = {
          in:  record.clockIn  ?? '',
          out: record.clockOut ?? '',
        }
      }
    }
    return init
  })

  const noTagTargets = targets.filter(t => isNoTagFlag(t.record.flag))
  const canSubmit    = reason.trim().length > 0

  // "미태깅 N건에 8시간 자동 부여" — 이미 찍힌 쪽(출근 또는 퇴근)은 그대로 두고, 비어있는
  // 쪽만 표준 시각(09:00/18:00, 정책 기본 소정근무 8h와 동일)으로 채운다. 실제 태그 시각을
  // 덮어쓰지 않으므로 NO_CLOCK_IN/NO_CLOCK_OUT 어느 쪽이든 안전하게 적용된다.
  function applyStandard8HourPreset() {
    setTimeInputs(prev => {
      const next = { ...prev }
      for (const { record } of noTagTargets) {
        const key = rk(record.employeeId, record.date)
        next[key] = {
          in:  record.clockIn  ?? STANDARD_CLOCK_IN,
          out: record.clockOut ?? STANDARD_CLOCK_OUT,
        }
      }
      return next
    })
    setReason(prev => prev.trim() ? prev : '미태깅 8시간 자동 인정')
  }

  function handleSave() {
    if (!canSubmit) return

    const overrides: Record<string, TimeOverride> = {}
    for (const { record } of targets) {
      if (isNoTagFlag(record.flag)) {
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
            {noTagTargets.length > 0 && (
              <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
                <p className="text-[11px] text-blue-500 flex items-center gap-1">
                  <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  미태깅 {noTagTargets.length}건 — 아래에서 누락 시간을 직접 입력하거나, 오른쪽 버튼으로 한 번에 채울 수 있습니다
                </p>
                <button
                  type="button"
                  onClick={applyStandard8HourPreset}
                  className="shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                >
                  미태깅 {noTagTargets.length}건에 8시간 자동 부여
                </button>
              </div>
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
                const key      = rk(record.employeeId, record.date)
                const isNoTag  = isNoTagFlag(record.flag)
                const needsIn  = isNoTag && record.clockIn  === null
                const needsOut = isNoTag && record.clockOut === null

                return (
                  <div key={i} className={`px-4 py-3 ${isNoTag ? 'bg-red-50/40' : 'bg-white'}`}>

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
                    {isNoTag && (needsIn || needsOut) && (
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

                    {/* 미태깅인데 프리셋 등으로 이미 양쪽 다 채워진 경우(수정 중) */}
                    {isNoTag && !needsIn && !needsOut && (
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
