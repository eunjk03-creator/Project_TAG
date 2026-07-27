'use client'
import { useState } from 'react'
import type { Employee, DayType } from '@/types/tag'
import { erpLeaveTypeToAmount } from '@/utils/attendanceCalc'

export interface ManualEntryPayload {
  clockIn:        string | null
  clockOut:       string | null
  attendanceType: string        // '재택근무' | '출장' | '휴일근무' | '연장근무' | '연차' | '기타'
  /** attendanceType === '연차'일 때의 서브유형: '연차'|'오전반차'|'오후반차'|'오전반반차'|'오후반반차'. 그 외엔 null. */
  leaveType:      string | null
  memo:           string
}

interface Props {
  employee: Employee
  date:     string
  /** 평일이 아니면(주말/공휴일) 연차 옵션을 숨김 — 연차는 근무일에서만 의미가 있음 */
  dayType?: DayType
  /** Pre-filled values when editing an existing manual entry */
  initial?: {
    clockIn?:        string | null
    clockOut?:       string | null
    attendanceType?: string
    leaveType?:      string | null
    memo?:           string
  }
  onClose:   () => void
  onSave:    (payload: ManualEntryPayload) => void
  onDelete?: () => void
}

const TYPES = ['일반근무', '재택근무', '출장', '휴일근무', '연장근무', '연차', '기타'] as const

const LEAVE_SUBTYPES = ['연차', '오전반차', '오후반차', '오전반반차', '오후반반차'] as const

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

function fmtDate(dateStr: string) {
  const d = new Date(dateStr + 'T12:00')
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`
}

export function ManualEntryModal({ employee, date, dayType, initial, onClose, onSave, onDelete }: Props) {
  const [clockIn,        setClockIn]        = useState(initial?.clockIn  ?? '')
  const [clockOut,       setClockOut]       = useState(initial?.clockOut ?? '')
  const [attendanceType, setAttendanceType] = useState(initial?.attendanceType ?? '일반근무')
  const [leaveType,      setLeaveType]      = useState(initial?.leaveType ?? '연차')
  const [memo,           setMemo]           = useState(initial?.memo ?? '')

  const isLeave        = attendanceType === '연차'
  const isFullDayLeave  = isLeave && leaveType === '연차'
  const allowLeave      = !dayType || dayType === 'WEEKDAY'  // 평일에만 연차 등록 허용

  const orgPath = [employee.division, employee.team, employee.part].filter(Boolean).join(' / ')

  function handleSave() {
    onSave({
      clockIn:        isFullDayLeave ? null : (clockIn  || null),
      clockOut:       isFullDayLeave ? null : (clockOut || null),
      attendanceType,
      leaveType:      isLeave ? leaveType : null,
      memo,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                  수기 입력
                </span>
              </div>
              <h2 className="text-base font-bold text-gray-900">{employee.name}</h2>
              <p className="text-xs text-gray-400 mt-0.5">{orgPath} · {fmtDate(date)}</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 text-gray-400 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* 근태 유형 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-2">근태 유형</label>
            <div className="flex flex-wrap gap-2">
              {TYPES.map(t => {
                const disabled = t === '연차' && !allowLeave
                return (
                  <button key={t}
                    onClick={() => !disabled && setAttendanceType(t)}
                    disabled={disabled}
                    title={disabled ? '연차는 평일에만 등록할 수 있습니다' : undefined}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      disabled
                        ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
                        : attendanceType === t
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}>
                    {t}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 연차 서브유형 */}
          {isLeave && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-2">연차 종류</label>
              <div className="flex flex-wrap gap-2">
                {LEAVE_SUBTYPES.map(lt => (
                  <button key={lt} onClick={() => setLeaveType(lt)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      leaveType === lt
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}>
                    {lt} <span className={leaveType === lt ? 'text-blue-100' : 'text-gray-400'}>({erpLeaveTypeToAmount(lt)}일)</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 출퇴근 시간 — 전일 연차는 근무하지 않으므로 숨김 */}
          {!isFullDayLeave && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">출근 시간</label>
                <input type="time" value={clockIn} onChange={e => setClockIn(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">퇴근 시간</label>
                <input type="time" value={clockOut} onChange={e => setClockOut(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
            </div>
          )}

          {/* 메모 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">메모 (선택)</label>
            <textarea value={memo} onChange={e => setMemo(e.target.value)}
              placeholder="예: 반일 재택, 오후 출근 등"
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none" />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center gap-2">
          {onDelete && (
            <button onClick={onDelete}
              className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              삭제
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            취소
          </button>
          <button onClick={handleSave}
            className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
