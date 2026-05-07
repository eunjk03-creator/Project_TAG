'use client'
import { useState, useEffect, useMemo } from 'react'
import { EMPLOYEES } from '@/data/orgChart'
import { ALL_RECORDS } from '@/data/mockData'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { usePolicy } from '@/context/PolicyContext'
import { useDateRange } from '@/context/DateRangeContext'
import {
  useEmployeeExceptions,
  DEFAULT_EXCEPTION,
  type EmployeeException,
} from '@/context/EmployeeExceptionsContext'

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

function fmtPeriodLabel(from: string, to: string): string {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  if (fy === ty && fm === tm) return `${fy}년 ${fm}월`
  if (fy === ty) return `${fy}년 ${fm}월 ~ ${tm}월`
  return `${from} ~ ${to}`
}

function Toggle({
  label,
  desc,
  value,
  onChange,
}: {
  label: string
  desc: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{desc}</p>
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative shrink-0 inline-flex items-center h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
          value ? 'bg-blue-600' : 'bg-gray-200'
        }`}
      >
        <span
          className={`inline-block w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
            value ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}

export function EmployeeDrawer() {
  const { selectedId, closeDrawer, getException, saveException } = useEmployeeExceptions()
  const { policy } = usePolicy()
  const { dateRange } = useDateRange()
  const [draft, setDraft] = useState<EmployeeException>(DEFAULT_EXCEPTION)
  const [saved, setSaved] = useState(false)

  const emp = selectedId ? EMPLOYEES.find(e => e.id === selectedId) : null

  // Compute stats for the selected employee using the global date range
  const { processed } = useAttendanceLogic(ALL_RECORDS, policy, dateRange.from, dateRange.to)

  const empStats = useMemo(() => {
    if (!selectedId) return { totalHours: 0, overtimeHours: 0, nightHours: 0, anomalies: 0 }
    const recs = processed.filter(r => r.employeeId === selectedId)
    const regularHours = recs.reduce((s, r) => s + r.regularHours, 0)
    const overtimeHours = recs.reduce((s, r) => s + r.overtimeHours, 0)
    const nightHours = recs.reduce((s, r) => s + r.nightHours, 0)
    return {
      totalHours: regularHours + overtimeHours,
      overtimeHours,
      nightHours,
      anomalies: recs.filter(r => r.flag !== null).length,
    }
  }, [processed, selectedId])

  useEffect(() => {
    if (selectedId) {
      setDraft(getException(selectedId))
      setSaved(false)
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  function update<K extends keyof EmployeeException>(key: K, value: EmployeeException[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  function handleSave() {
    if (!selectedId) return
    saveException(selectedId, draft)
    setSaved(true)
  }

  const orgPath = emp ? [emp.division, emp.team, emp.part].filter(Boolean).join(' / ') : ''
  const hasExceptions = draft.bypassOtLimits || draft.flexibleCoreTime

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-200 ${
          selectedId ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={closeDrawer}
      />

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 h-full w-80 bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out ${
          selectedId ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-semibold text-gray-800">개인 예외 설정</h2>
          <button
            onClick={closeDrawer}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {emp ? (
            <>
              {/* Profile */}
              <div className="px-5 py-5 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-12 h-12 rounded-full ${avatarColor(emp.name)} flex items-center justify-center shrink-0`}
                  >
                    <span className="text-white text-lg font-bold">{emp.name[0]}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-base font-bold text-gray-900">{emp.name}</p>
                      {hasExceptions && (
                        <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-600 border border-blue-200 rounded font-medium">
                          예외 적용
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{emp.jobTitle}</p>
                  </div>
                </div>
                <div className="mt-4 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400 w-8 shrink-0">사번</span>
                    <span className="font-mono text-gray-600">{emp.id}</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-gray-400 w-8 shrink-0">조직</span>
                    <span className="text-gray-600 leading-relaxed">{orgPath}</span>
                  </div>
                </div>
              </div>

              {/* Dynamic Stats */}
              <div className="px-5 py-4 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  기간 통계 — {fmtPeriodLabel(dateRange.from, dateRange.to)}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 mb-1">총 근로</p>
                    <p className="text-lg font-bold text-gray-800">{fmt(empStats.totalHours)}</p>
                  </div>
                  <div className="bg-amber-50 rounded-xl p-3">
                    <p className="text-xs text-amber-500 mb-1">연장근로</p>
                    <p className="text-lg font-bold text-amber-600">{fmt(empStats.overtimeHours)}</p>
                  </div>
                  <div className="bg-indigo-50 rounded-xl p-3">
                    <p className="text-xs text-indigo-400 mb-1">야간근로</p>
                    <p className="text-lg font-bold text-indigo-600">{fmt(empStats.nightHours)}</p>
                  </div>
                  <div
                    className={`rounded-xl p-3 ${empStats.anomalies > 0 ? 'bg-red-50' : 'bg-gray-50'}`}
                  >
                    <p className={`text-xs mb-1 ${empStats.anomalies > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                      이상치
                    </p>
                    <p
                      className={`text-lg font-bold ${empStats.anomalies > 0 ? 'text-red-600' : 'text-gray-800'}`}
                    >
                      {empStats.anomalies}건
                    </p>
                  </div>
                </div>
              </div>

              {/* Exception Rules */}
              <div className="px-5 py-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  예외 적용 기준
                </p>
                <p className="text-xs text-gray-400 mb-3">
                  개인 설정은 저장 후 다음 산정 시 반영됩니다.
                </p>
                <Toggle
                  label="매니저 역할 (OT 한도 제외)"
                  desc="연장근로 한도 초과 및 OT 미신청 이상치 감지에서 제외됩니다."
                  value={draft.bypassOtLimits}
                  onChange={v => update('bypassOtLimits', v)}
                />
                <Toggle
                  label="유연 코어타임 (예외 출근 허용)"
                  desc="지각 기준이 적용되지 않으며 LATE 이상치가 발생하지 않습니다."
                  value={draft.flexibleCoreTime}
                  onChange={v => update('flexibleCoreTime', v)}
                />
                <div className="mt-4">
                  <label className="text-xs font-medium text-gray-500 block mb-1.5">
                    관리자 메모
                  </label>
                  <textarea
                    rows={3}
                    value={draft.note}
                    onChange={e => update('note', e.target.value)}
                    placeholder="예외 적용 사유, 계약 조건 등 메모 입력..."
                    className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none placeholder-gray-300 text-gray-700"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-40 text-sm text-gray-400">
              직원을 선택해주세요
            </div>
          )}
        </div>

        {/* Footer */}
        {emp && (
          <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
            {saved && (
              <p className="text-xs text-green-600 font-medium text-center animate-pulse">
                ✓ 저장됐습니다
              </p>
            )}
            <button
              onClick={handleSave}
              className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
            >
              저장하기
            </button>
          </div>
        )}
      </div>
    </>
  )
}
