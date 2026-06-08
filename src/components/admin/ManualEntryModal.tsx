'use client'
import { useState } from 'react'
import type { Employee } from '@/types/tag'

export interface ManualEntryPayload {
  clockIn:        string | null
  clockOut:       string | null
  attendanceType: string        // '재택근무' | '출장' | '휴일근무' | '기타'
  memo:           string
}

interface Props {
  employee: Employee
  date:     string
  /** Pre-filled values when editing an existing manual entry */
  initial?: {
    clockIn?:        string | null
    clockOut?:       string | null
    attendanceType?: string
    memo?:           string
  }
  onClose:   () => void
  onSave:    (payload: ManualEntryPayload) => void
  onDelete?: () => void
}

const TYPES = ['재택근무', '출장', '휴일근무', '연장근무', '기타'] as const

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

function fmtDate(dateStr: string) {
  const d = new Date(dateStr + 'T12:00')
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`
}

export function ManualEntryModal({ employee, date, initial, onClose, onSave, onDelete }: Props) {
  const [clockIn,        setClockIn]        = useState(initial?.clockIn  ?? '')
  const [clockOut,       setClockOut]       = useState(initial?.clockOut ?? '')
  const [attendanceType, setAttendanceType] = useState(initial?.attendanceType ?? '재택근무')
  const [memo,           setMemo]           = useState(initial?.memo ?? '')

  const orgPath = [employee.division, employee.team, employee.part].filter(Boolean).join(' / ')

  function handleSave() {
    onSave({
      clockIn:        clockIn  || null,
      clockOut:       clockOut || null,
      attendanceType,
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
              {TYPES.map(t => (
                <button key={t} onClick={() => setAttendanceType(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    attendanceType === t
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                  }`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* 출퇴근 시간 */}
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
