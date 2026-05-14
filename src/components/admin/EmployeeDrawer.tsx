'use client'
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { usePolicy } from '@/context/PolicyContext'
import { useDateRange } from '@/context/DateRangeContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import {
  useEmployeeExceptions,
  DEFAULT_EXCEPTION,
  type EmployeeException,
  type EmployeeAttributeOverrides,
} from '@/context/EmployeeExceptionsContext'
import { FINAL_STATUS_CATEGORY } from '@/types/tag'

// ── Helpers ───────────────────────────────────────────────────────────────

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
  const [, tm] = to.split('-').map(Number)
  if (fm === tm) return `${fy}년 ${fm}월`
  return `${fy}년 ${fm}월 ~ ${tm}월`
}

// ── Sub-components ────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  colorCls = 'bg-gray-50',
  labelCls = 'text-gray-400',
  valueCls = 'text-gray-800',
}: {
  label: string
  value: string
  colorCls?: string
  labelCls?: string
  valueCls?: string
}) {
  return (
    <div className={`${colorCls} rounded-xl p-3`}>
      <p className={`text-xs mb-1 ${labelCls}`}>{label}</p>
      <p className={`text-lg font-bold tabular-nums ${valueCls}`}>{value}</p>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">
      {children}
    </p>
  )
}

function AttrToggleRow({
  label,
  badge,
  badgeCls,
  desc,
  value,
  onChange,
  children,
}: {
  label: string
  badge?: string
  badgeCls?: string
  desc: string
  value: boolean
  onChange: (v: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="py-3.5 border-b border-gray-50 last:border-0">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-gray-800 truncate">{label}</span>
          {badge && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${badgeCls}`}>
              {badge}
            </span>
          )}
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
      <p className="text-[11px] text-gray-400 leading-relaxed">{desc}</p>
      {value && children && (
        <div className="mt-2">{children}</div>
      )}
    </div>
  )
}

// ── Main drawer ───────────────────────────────────────────────────────────

export function EmployeeDrawer() {
  const {
    selectedId, closeDrawer,
    getException, saveException,
    getEmployeeAttr, setEmployeeAttr,
    employeeAttrMap,
  } = useEmployeeExceptions()

  const { policy }     = usePolicy()
  const { dateRange }  = useDateRange()
  const { employees, rawRecords } = useAttendanceSource()

  const emp = useMemo(
    () => selectedId ? employees.find(e => e.id === selectedId) ?? null : null,
    [selectedId, employees],
  )

  // ── Draft state: memo & attrs ───────────────────────────────────────────
  const [memoDraft, setMemoDraft] = useState<EmployeeException>(DEFAULT_EXCEPTION)
  const [memoDraftSaved, setMemoDraftSaved] = useState(false)

  // Attrs are read live from context (no local draft — instant save on toggle)
  const attrs: EmployeeAttributeOverrides = selectedId ? getEmployeeAttr(selectedId) : {}

  function patchAttr(patch: Partial<EmployeeAttributeOverrides>) {
    if (!selectedId) return
    setEmployeeAttr(selectedId, patch)
  }

  // Sync memo draft when drawer opens for a new employee
  useEffect(() => {
    if (selectedId) {
      setMemoDraft(getException(selectedId))
      setMemoDraftSaved(false)
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  function saveMemo() {
    if (!selectedId) return
    saveException(selectedId, memoDraft)
    setMemoDraftSaved(true)
  }

  // ── Reactive stats (re-computes when attrs change) ──────────────────────
  const { processed } = useAttendanceLogic(
    rawRecords, policy, dateRange.from, dateRange.to,
    new Set(), new Map(), employeeAttrMap,
  )

  const empStats = useMemo(() => {
    if (!selectedId) return { totalHours: 0, overtimeHours: 0, nightHours: 0, anomalies: 0 }
    const recs = processed.filter(r => r.employeeId === selectedId)
    const regularHours  = recs.reduce((s, r) => s + r.regularHours,  0)
    const overtimeHours = recs.reduce((s, r) => s + r.overtimeHours, 0)
    const nightHours    = recs.reduce((s, r) => s + r.nightHours,    0)
    const anomalies     = recs.filter(r => FINAL_STATUS_CATEGORY[r.finalStatus] === 'ANOMALY').length
    return { totalHours: regularHours + overtimeHours, overtimeHours, nightHours, anomalies }
  }, [processed, selectedId])

  const orgPath = emp ? [emp.division, emp.team, emp.part].filter(Boolean).join(' / ') : ''

  const hasAttrOverrides = !!(attrs.isLeader || attrs.isParentalLeave || attrs.isShortenedHours || attrs.isEasyLogis)
  const hasExceptions = hasAttrOverrides || memoDraft.bypassOtLimits || memoDraft.flexibleCoreTime

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
        className={`fixed right-0 top-0 h-full w-[340px] bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out ${
          selectedId ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-semibold text-gray-800">개인 예외 설정</h2>
          <button
            onClick={closeDrawer}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {emp ? (
            <>
              {/* ── Profile ── */}
              <div className="px-5 py-5 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-full ${avatarColor(emp.name)} flex items-center justify-center shrink-0`}>
                    <span className="text-white text-lg font-bold">{emp.name[0]}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-base font-bold text-gray-900">{emp.name}</p>
                      {hasExceptions && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 border border-blue-200 rounded font-semibold">
                          예외 적용
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{emp.jobTitle}</p>
                  </div>
                </div>
                <div className="mt-3.5 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400 w-8 shrink-0">사번</span>
                    <span className="font-mono text-gray-600">{emp.rawId ?? emp.id}</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-gray-400 w-8 shrink-0">조직</span>
                    <span className="text-gray-600 leading-relaxed">{orgPath}</span>
                  </div>
                </div>
              </div>

              {/* ── Period summary ── */}
              <div className="px-5 py-4 border-b border-gray-100">
                <SectionLabel>선택 기간 통계 — {fmtPeriodLabel(dateRange.from, dateRange.to)}</SectionLabel>
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="총 근로" value={fmt(empStats.totalHours)} />
                  <StatCard
                    label="연장근로"
                    value={fmt(empStats.overtimeHours)}
                    colorCls="bg-amber-50"
                    labelCls="text-amber-500"
                    valueCls="text-amber-600"
                  />
                  <StatCard
                    label="야간근로"
                    value={fmt(empStats.nightHours)}
                    colorCls="bg-indigo-50"
                    labelCls="text-indigo-400"
                    valueCls="text-indigo-600"
                  />
                  <StatCard
                    label="이상치"
                    value={`${empStats.anomalies}건`}
                    colorCls={empStats.anomalies > 0 ? 'bg-red-50' : 'bg-gray-50'}
                    labelCls={empStats.anomalies > 0 ? 'text-red-400' : 'text-gray-400'}
                    valueCls={empStats.anomalies > 0 ? 'text-red-600' : 'text-gray-800'}
                  />
                </div>
              </div>

              {/* ── Attribute toggles ── */}
              <div className="px-5 py-4 border-b border-gray-100">
                <SectionLabel>개인 예외 규칙</SectionLabel>
                <p className="text-[11px] text-gray-400 -mt-1 mb-3 leading-relaxed">
                  토글 즉시 반영 — 배지/통계가 실시간으로 업데이트됩니다.
                </p>

                <AttrToggleRow
                  label="직책자"
                  badge="isLeader"
                  badgeCls="bg-violet-100 text-violet-600"
                  desc="지각·조기퇴근 이상치 면제. OT 미신청 감지에서 제외됩니다."
                  value={!!attrs.isLeader}
                  onChange={v => patchAttr({ isLeader: v })}
                />

                <AttrToggleRow
                  label="육아휴직자"
                  badge="isParentalLeave"
                  badgeCls="bg-pink-100 text-pink-600"
                  desc="출퇴근 미기록 이상치 및 조기퇴근 판정을 면제합니다."
                  value={!!attrs.isParentalLeave}
                  onChange={v => patchAttr({ isParentalLeave: v })}
                />

                <AttrToggleRow
                  label="단축근로"
                  badge="isShortenedHours"
                  badgeCls="bg-amber-100 text-amber-600"
                  desc="일 표준근로시간을 단축 적용합니다. OT 기준 및 조기퇴근 판정이 함께 조정됩니다."
                  value={!!attrs.isShortenedHours}
                  onChange={v => patchAttr({ isShortenedHours: v })}
                >
                  <div className="flex items-center gap-2 bg-amber-50 rounded-lg px-3 py-2">
                    <span className="text-xs text-amber-700 font-medium shrink-0">일 근무시간</span>
                    <input
                      type="number"
                      min={1} max={7} step={0.5}
                      value={attrs.shortenedHoursValue ?? 6}
                      onChange={e => patchAttr({ shortenedHoursValue: Number(e.target.value) })}
                      className="w-16 px-2 py-1 text-sm border border-amber-200 rounded-lg
                        focus:outline-none focus:ring-2 focus:ring-amber-400 text-right bg-white"
                    />
                    <span className="text-xs text-amber-600 font-medium shrink-0">h / 일</span>
                  </div>
                </AttrToggleRow>

                <AttrToggleRow
                  label="10시 출근자"
                  badge="isTenAMStarter"
                  badgeCls="bg-sky-100 text-sky-600"
                  desc="출근 기준을 10:00으로 설정. 지각 판정 · OT 시작 기준(20:00+)이 함께 이동합니다."
                  value={!!attrs.isTenAMStarter}
                  onChange={v => patchAttr({ isTenAMStarter: v })}
                />

                <AttrToggleRow
                  label="파견자"
                  badge="isDispatchedWorker"
                  badgeCls="bg-teal-100 text-teal-600"
                  desc="CAPS 태깅 미기록(출퇴근 누락) 이상치 감지를 면제합니다."
                  value={!!attrs.isDispatchedWorker}
                  onChange={v => patchAttr({ isDispatchedWorker: v })}
                />

                <AttrToggleRow
                  label="이지로지스"
                  badge="isEasyLogis"
                  badgeCls="bg-indigo-100 text-indigo-600"
                  desc="이지로지스 계열사 특별 규칙 적용. 모든 이상치 플래그를 억제합니다."
                  value={!!attrs.isEasyLogis}
                  onChange={v => patchAttr({ isEasyLogis: v })}
                />
              </div>

              {/* ── Legacy drawer toggles ── */}
              <div className="px-5 py-4">
                <SectionLabel>기타 예외 설정</SectionLabel>

                <div className="flex items-start justify-between gap-4 py-3.5 border-b border-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">매니저 역할 (OT 한도 제외)</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                      연장근로 한도 초과 및 OT 미신청 이상치 감지에서 제외됩니다.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={memoDraft.bypassOtLimits}
                    onClick={() => { setMemoDraft(p => ({ ...p, bypassOtLimits: !p.bypassOtLimits })); setMemoDraftSaved(false) }}
                    className={`relative shrink-0 inline-flex items-center h-6 w-11 rounded-full transition-colors duration-200 ${
                      memoDraft.bypassOtLimits ? 'bg-blue-600' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                      memoDraft.bypassOtLimits ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>

                <div className="flex items-start justify-between gap-4 py-3.5 border-b border-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">유연 코어타임 (예외 출근 허용)</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                      지각 기준이 적용되지 않으며 LATE 이상치가 발생하지 않습니다.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={memoDraft.flexibleCoreTime}
                    onClick={() => { setMemoDraft(p => ({ ...p, flexibleCoreTime: !p.flexibleCoreTime })); setMemoDraftSaved(false) }}
                    className={`relative shrink-0 inline-flex items-center h-6 w-11 rounded-full transition-colors duration-200 ${
                      memoDraft.flexibleCoreTime ? 'bg-blue-600' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                      memoDraft.flexibleCoreTime ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>

                <div className="mt-4">
                  <label className="text-xs font-medium text-gray-500 block mb-1.5">관리자 메모</label>
                  <textarea
                    rows={3}
                    value={memoDraft.note}
                    onChange={e => { setMemoDraft(p => ({ ...p, note: e.target.value })); setMemoDraftSaved(false) }}
                    placeholder="예외 적용 사유, 계약 조건 등 메모 입력..."
                    className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2
                      focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none
                      placeholder-gray-300 text-gray-700"
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

        {/* Footer — save memo */}
        {emp && (
          <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
            {memoDraftSaved && (
              <p className="text-xs text-green-600 font-medium text-center">✓ 메모가 저장됐습니다</p>
            )}
            <button
              onClick={saveMemo}
              className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg
                hover:bg-blue-700 active:scale-95 transition-all"
            >
              메모 저장
            </button>
          </div>
        )}
      </div>
    </>
  )
}
