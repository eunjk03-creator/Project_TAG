'use client'
import { useState, useMemo, useCallback } from 'react'
import type { Employee } from '@/types/tag'
import {
  useEmployeeExceptions,
  type ExceptionRule,
  type RuleType,
} from '@/context/EmployeeExceptionsContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { PaginationBar } from './PaginationBar'

const RULES_PAGE_SIZE = 20

// ── Config ────────────────────────────────────────────────────────────────

export const RULE_BADGE: Record<RuleType, { label: string; cls: string; desc: string }> = {
  manager_exemption: {
    label: '직책자',
    desc:  'Manager Exemption',
    cls:   'bg-violet-100 text-violet-700',
  },
  shortened_hours: {
    label: '단축근로',
    desc:  'Shortened Hours',
    cls:   'bg-amber-100 text-amber-700',
  },
  ten_am_starter: {
    label: '10시 출근',
    desc:  '10 AM Flex Start',
    cls:   'bg-sky-100 text-sky-700',
  },
  dispatched_worker: {
    label: '파견자',
    desc:  'Dispatched Worker',
    cls:   'bg-teal-100 text-teal-700',
  },
  parental_leave: {
    label: '육아휴직',
    desc:  'Parental Leave',
    cls:   'bg-pink-100 text-pink-700',
  },
  fixed_schedule_a: {
    label: '특수근무A',
    desc:  'Fixed Schedule 08:00~16:00',
    cls:   'bg-orange-100 text-orange-700',
  },
  fixed_schedule_b: {
    label: '특수근무B',
    desc:  'Fixed Schedule 08:30~12:30',
    cls:   'bg-rose-100 text-rose-700',
  },
  pregnant_reduced: {
    label: '임산부',
    desc:  'Pregnant Reduced Hours',
    cls:   'bg-fuchsia-100 text-fuchsia-700',
  },
  easy_logis: {
    label: '이지로지스',
    desc:  'Easy Logis — suppress all anomalies',
    cls:   'bg-indigo-100 text-indigo-700',
  },
  global_exclusion: {
    label: '전체제외',
    desc:  'Global Exclusion',
    cls:   'bg-gray-200 text-gray-600',
  },
  resigned: {
    label: '퇴사자',
    desc:  'Resigned Employee',
    cls:   'bg-red-100 text-red-700',
  },
}

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-violet-100 text-violet-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
]
function avatarCls(name: string) {
  return AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length]
}

// ── Toggle ────────────────────────────────────────────────────────────────

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full cursor-pointer transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
        ${on ? 'bg-blue-600' : 'bg-gray-200'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform
        ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`}
      />
    </button>
  )
}

// ── Add Employee Modal (multi-select) ─────────────────────────────────────

interface ModalDraft {
  employees:      Employee[]
  ruleType:       RuleType
  excludeFromOt:  boolean
  shortenedHours: number
  validFrom:      string
  validTo:        string
}

function AddModal({
  allEmployees,
  existingIds,
  onAdd,
  onClose,
}: {
  allEmployees: Employee[]
  existingIds:  Set<string>
  onAdd:        (rule: Omit<ExceptionRule, 'id'>) => void
  onClose:      () => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ModalDraft>({
    employees:      [],
    ruleType:       'manager_exemption',
    excludeFromOt:  true,
    shortenedHours: 6,
    validFrom:      '',
    validTo:        '',
  })

  function patch(p: Partial<ModalDraft>) { setDraft(prev => ({ ...prev, ...p })) }

  const selectedIds = useMemo(
    () => new Set(draft.employees.map(e => e.id)),
    [draft.employees],
  )

  // Candidates: exclude already-added rules (existingIds) but show selected ones with a checkmark
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '' && draft.employees.length > 0) return []  // hide dropdown once something is selected and query cleared
    return allEmployees
      .filter(e => !existingIds.has(e.id))
      .filter(e =>
        q === '' ||
        e.name.includes(q) ||
        e.id.includes(q) ||
        e.division.toLowerCase().includes(q) ||
        e.team.toLowerCase().includes(q)
      )
      .slice(0, 8)
  }, [query, existingIds, allEmployees, draft.employees.length])

  function toggleEmployee(e: Employee) {
    if (selectedIds.has(e.id)) {
      patch({ employees: draft.employees.filter(s => s.id !== e.id) })
    } else {
      patch({ employees: [...draft.employees, e] })
      setQuery('')
    }
  }

  function removeEmployee(id: string) {
    patch({ employees: draft.employees.filter(e => e.id !== id) })
  }

  // 공통 날짜 범위 UI (색상 커스텀)
  function renderDateRange(color: 'teal'|'pink'|'red'|'gray' = 'gray') {
    const borderCls = `border-${color}-200`
    const ringCls   = `focus:ring-${color}-400`
    const textCls   = `text-${color}-600`
    return (
      <div className={`bg-${color}-50 rounded-xl px-4 py-3`}>
        <p className={`text-xs font-semibold ${textCls} mb-2`}>
          적용 기간 <span className={`font-normal opacity-60`}>(선택, 비워두면 항상 적용)</span>
        </p>
        <div className="flex items-center gap-2">
          <input type="date" value={draft.validFrom}
            onChange={e => patch({ validFrom: e.target.value })}
            className={`flex-1 px-2 py-1.5 text-xs border ${borderCls} rounded-lg focus:outline-none focus:ring-2 ${ringCls} bg-white`} />
          <span className={`${textCls} text-xs shrink-0`}>~</span>
          <input type="date" value={draft.validTo} min={draft.validFrom}
            onChange={e => patch({ validTo: e.target.value })}
            className={`flex-1 px-2 py-1.5 text-xs border ${borderCls} rounded-lg focus:outline-none focus:ring-2 ${ringCls} bg-white`} />
        </div>
        {draft.validFrom && draft.validTo && draft.validFrom > draft.validTo && (
          <p className="text-[10px] text-red-500 mt-1">종료일이 시작일보다 빠릅니다</p>
        )}
      </div>
    )
  }

  const canSubmit =
    draft.employees.length > 0 &&
    (draft.ruleType !== 'shortened_hours' ||
      (draft.validFrom !== '' && draft.validTo !== '' && draft.validFrom <= draft.validTo))

  function handleAdd() {
    for (const e of draft.employees) {
      onAdd({
        employeeId:     e.id,
        employeeName:   e.name,
        jobTitle:       e.jobTitle,
        division:       e.division,
        team:           e.team,
        ruleType:       draft.ruleType,
        excludeFromOt:  draft.excludeFromOt,
        shortenedHours: draft.shortenedHours,
        validFrom:      draft.validFrom,
        validTo:        draft.validTo,
      })
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-[480px] flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="text-sm font-bold text-gray-800">직원 예외 규칙 추가</h3>
            {draft.employees.length > 0 && (
              <p className="text-[10px] text-blue-600 mt-0.5 font-medium">{draft.employees.length}명 선택됨</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400
              hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 space-y-5">

          {/* ── 1. Employee multi-select ── */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              직원 선택
              <span className="text-[10px] font-normal text-gray-400 ml-1">(복수 선택 가능)</span>
            </label>

            <input
              type="text"
              placeholder="이름, 부서, 팀으로 검색..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            {/* Candidate dropdown */}
            {candidates.length > 0 && (
              <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden
                max-h-48 overflow-y-auto shadow-sm">
                {candidates.map(e => {
                  const isSelected = selectedIds.has(e.id)
                  return (
                    <button
                      key={e.id}
                      onClick={() => toggleEmployee(e)}
                      className={`w-full px-3 py-2.5 flex items-center gap-3 text-left transition-colors
                        border-b border-gray-50 last:border-0
                        ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      {/* Checkbox */}
                      <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border transition-colors
                        ${isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'}`}
                      >
                        {isSelected && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${avatarCls(e.name)}`}>
                        {e.name[0]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 leading-tight">{e.name}</p>
                        <p className="text-[10px] text-gray-400 truncate">{e.division} · {e.team}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[10px] text-gray-400">{e.jobTitle}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Selected employees chips */}
            {draft.employees.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.employees.map(e => (
                  <span
                    key={e.id}
                    className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 bg-blue-100
                      text-blue-800 text-xs font-medium rounded-full"
                  >
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${avatarCls(e.name)}`}>
                      {e.name[0]}
                    </div>
                    <span>{e.name}</span>
                    <button
                      onClick={() => removeEmployee(e.id)}
                      className="text-blue-400 hover:text-blue-700 transition-colors rounded-full"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── 2. Rule type ── */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-2">규칙 유형</label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.entries(RULE_BADGE) as [RuleType, typeof RULE_BADGE[RuleType]][]).map(([type, cfg]) => {
                const sel = draft.ruleType === type
                return (
                  <label
                    key={type}
                    className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-all ${
                      sel ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}
                  >
                    <input
                      type="radio"
                      name="ruleType"
                      checked={sel}
                      onChange={() => patch({ ruleType: type })}
                      className="mt-0.5 accent-blue-600"
                    />
                    <div>
                      <p className={`text-xs font-semibold ${sel ? 'text-blue-700' : 'text-gray-700'}`}>
                        {cfg.label}
                      </p>
                      <p className="text-[10px] text-gray-400 leading-tight">{cfg.desc}</p>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* ── 3. Rule-specific fields ── */}
          {draft.ruleType === 'manager_exemption' && (
            <div className="space-y-2.5">
              <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-gray-700">OT 미산입</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">연장근로 집계에서 제외</p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle on={draft.excludeFromOt} onChange={v => patch({ excludeFromOt: v })} />
                  <span className={`text-[10px] font-bold w-6 ${draft.excludeFromOt ? 'text-blue-600' : 'text-gray-400'}`}>
                    {draft.excludeFromOt ? 'ON' : 'OFF'}
                  </span>
                </div>
              </div>
              {renderDateRange('gray')}
            </div>
          )}

          {draft.ruleType === 'ten_am_starter' && (
            <div className="bg-sky-50 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-sky-700">10시 출근 적용 내용</p>
              <ul className="text-[10px] text-sky-600 mt-1.5 space-y-0.5 list-disc list-inside">
                <li>출근 기준: 10:00 이전 출근도 10:00으로 스냅</li>
                <li>지각 기준: 10:00 이후 출근 시 지각 처리</li>
                <li>OT 기준: 10:00 + 8h + 점심 + 1h 식대 = 20:00 이후 연장근로</li>
              </ul>
            </div>
          )}

          {draft.ruleType === 'dispatched_worker' && (
            <div className="space-y-2.5">
              <div className="bg-teal-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-teal-700">파견자 적용 내용</p>
                <ul className="text-[10px] text-teal-600 mt-1.5 space-y-0.5 list-disc list-inside">
                  <li>출퇴근 미기록(미태깅) 이상치 감지 면제</li>
                  <li>CAPS 태깅이 없어도 출퇴근누락 플래그 미발생</li>
                </ul>
              </div>
              {renderDateRange('teal')}
            </div>
          )}

          {draft.ruleType === 'parental_leave' && (
            <div className="space-y-2.5">
              <div className="bg-pink-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-pink-700">육아휴직자 적용 내용</p>
                <ul className="text-[10px] text-pink-600 mt-1.5 space-y-0.5 list-disc list-inside">
                  <li>모든 근태 이상치 감지 면제 (지각·근무시간미달·미태깅·미신청OT)</li>
                  <li>해당 기간 데이터는 정상 또는 휴가로 표시</li>
                </ul>
              </div>
              {renderDateRange('pink')}
            </div>
          )}
          {draft.ruleType === 'fixed_schedule_a' && (
            <div className="bg-orange-50 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-orange-700">특수근무제 A 적용 내용</p>
              <ul className="text-[10px] text-orange-600 mt-1.5 space-y-0.5 list-disc list-inside">
                <li>출근 스냅: 08:00 (이전 출근도 08:00으로 인정)</li>
                <li>지각 기준: 08:00 초과</li>
                <li>정상 퇴근: 16:00 이상</li>
                <li>조기퇴근: 15:31 ~ 15:59 / 근태이상: 15:30 이하</li>
                <li>휴게 시간: 30분 차감</li>
              </ul>
            </div>
          )}
          {draft.ruleType === 'fixed_schedule_b' && (
            <div className="bg-rose-50 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-rose-700">특수근무제 B 적용 내용</p>
              <ul className="text-[10px] text-rose-600 mt-1.5 space-y-0.5 list-disc list-inside">
                <li>출근 스냅: 08:30 (이전 출근도 08:30으로 인정)</li>
                <li>지각 기준: 08:30 초과</li>
                <li>정상 퇴근: 12:30 이상</li>
                <li>조기퇴근: 12:01 ~ 12:29 / 근태이상: 12:00 이하</li>
                <li>휴게 시간: 없음 (0분)</li>
              </ul>
            </div>
          )}
          {draft.ruleType === 'pregnant_reduced' && (
            <div className="space-y-2.5">
              <div className="bg-fuchsia-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-fuchsia-700">임산부 단축근로 적용 내용</p>
                <ul className="text-[10px] text-fuchsia-600 mt-1.5 space-y-0.5 list-disc list-inside">
                  <li>실근무 + 휴가환산 합산 ≥ 360분 기준 검사</li>
                  <li>반차 사용 시 4시간(240분) 휴가로 환산 합산</li>
                  <li>기준 미달 시 근태이상 처리</li>
                </ul>
              </div>
              <div className="bg-fuchsia-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-fuchsia-700 mb-2">적용 기간 <span className="text-fuchsia-400 font-normal">(선택, 비워두면 항상 적용)</span></p>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={draft.validFrom}
                    onChange={e => patch({ validFrom: e.target.value })}
                    className="flex-1 px-2 py-1.5 text-xs border border-fuchsia-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-fuchsia-400 bg-white"
                  />
                  <span className="text-fuchsia-400 text-xs shrink-0">~</span>
                  <input
                    type="date"
                    value={draft.validTo}
                    min={draft.validFrom}
                    onChange={e => patch({ validTo: e.target.value })}
                    className="flex-1 px-2 py-1.5 text-xs border border-fuchsia-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-fuchsia-400 bg-white"
                  />
                </div>
                {draft.validFrom && draft.validTo && draft.validFrom > draft.validTo && (
                  <p className="text-[10px] text-red-500 mt-1">종료일이 시작일보다 빠릅니다</p>
                )}
              </div>
            </div>
          )}
          {draft.ruleType === 'resigned' && (
            <div className="space-y-2.5">
              <div className="bg-red-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-red-700">퇴사자 적용 내용</p>
                <ul className="text-[10px] text-red-600 mt-1.5 space-y-0.5 list-disc list-inside">
                  <li>퇴사일 이후 모든 근태 이상치 감지 제외</li>
                  <li>집계 및 이상치 목록에서 제외</li>
                </ul>
              </div>
              <div className="bg-red-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-red-700 mb-2">
                  퇴사일 <span className="font-normal opacity-60">(이 날부터 적용)</span>
                </p>
                <input type="date" value={draft.validFrom}
                  onChange={e => patch({ validFrom: e.target.value })}
                  className="w-full px-2 py-1.5 text-xs border border-red-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400 bg-white" />
              </div>
            </div>
          )}
          {draft.ruleType === 'global_exclusion' && (
            <div className="bg-gray-100 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-gray-700">전체 제외 적용 내용</p>
              <ul className="text-[10px] text-gray-600 mt-1.5 space-y-0.5 list-disc list-inside">
                <li>해당 직원의 모든 근태 데이터를 집계에서 제외</li>
                <li>대시보드 및 이상치 목록에 미노출</li>
                <li>임원, 장애인고용, 임시출입 등에 적용</li>
              </ul>
            </div>
          )}

          {draft.ruleType === 'shortened_hours' && (
            <div className="space-y-2.5">
              <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-xs font-semibold text-gray-700">일 근무시간 단축</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">기본값 8h에서 변경</p>
                </div>
                <input
                  type="number"
                  min={1} max={7} step={0.5}
                  value={draft.shortenedHours}
                  onChange={e => patch({ shortenedHours: Number(e.target.value) })}
                  className="w-16 px-2 py-1 text-sm border border-gray-200 rounded-lg
                    focus:outline-none focus:ring-2 focus:ring-blue-500 text-right"
                />
                <span className="text-xs text-gray-500 shrink-0">h / 일</span>
              </div>

              <div className="bg-gray-50 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-gray-700 mb-2">유효 기간</p>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={draft.validFrom}
                    onChange={e => patch({ validFrom: e.target.value })}
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-gray-400 text-xs shrink-0">~</span>
                  <input
                    type="date"
                    value={draft.validTo}
                    min={draft.validFrom}
                    onChange={e => patch({ validTo: e.target.value })}
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                {draft.validFrom && draft.validTo && draft.validFrom > draft.validTo && (
                  <p className="text-[10px] text-red-500 mt-1">종료일이 시작일보다 빠릅니다</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg
              hover:bg-gray-50 transition-colors"
          >
            취소
          </button>
          <button
            disabled={!canSubmit}
            onClick={handleAdd}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg
              hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {draft.employees.length > 1 ? `추가 (${draft.employees.length}명)` : '추가'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export function ExceptionRulesTab() {
  const { exceptionRules: rules, addRule, patchRule, deleteRule, deleteRules } = useEmployeeExceptions()
  const { employees, isLiveData } = useAttendanceSource()
  const [showModal, setShowModal] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)

  const existingIds = useMemo(() => new Set(rules.map(r => r.employeeId)), [rules])

  const pageCount = Math.max(1, Math.ceil(rules.length / RULES_PAGE_SIZE))
  const safePage  = Math.min(page, pageCount - 1)
  const pageRules = useMemo(
    () => rules.slice(safePage * RULES_PAGE_SIZE, safePage * RULES_PAGE_SIZE + RULES_PAGE_SIZE),
    [rules, safePage],
  )

  const liveEmployeeIds = useMemo(() => new Set(employees.map(e => e.id)), [employees])
  // 실제 계산 경로(useProcessedAttendance.ts)와 동일한 판정 기준: ID가 직접 안 맞아도
  // 이름으로 재매칭되면 정상 적용되므로 orphan이 아님 — 여기도 같은 이름 폴백을 거쳐야
  // "미연결" 배너가 실제로 적용 안 되는 규칙만 정확히 잡아낸다.
  const nameToLiveId = useMemo(() => {
    const normName = (s: string) => s.trim().replace(/\s+/g, '')
    return new Map(employees.map(e => [normName(e.name), e.id]))
  }, [employees])
  const orphanedRules = useMemo(
    () => rules.filter(r => {
      if (liveEmployeeIds.has(r.employeeId)) return false
      const normName = (s: string) => s.trim().replace(/\s+/g, '')
      return !nameToLiveId.has(normName(r.employeeName))
    }),
    [rules, liveEmployeeIds, nameToLiveId],
  )

  const managerCount = rules.filter(r => r.ruleType === 'manager_exemption').length
  const shortenCount = rules.filter(r => r.ruleType === 'shortened_hours').length

  const allChecked  = pageRules.length > 0 && pageRules.every(r => selectedIds.has(r.id))
  const someChecked = pageRules.some(r => selectedIds.has(r.id)) && !allChecked

  const toggleAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allChecked) pageRules.forEach(r => next.delete(r.id))
      else            pageRules.forEach(r => next.add(r.id))
      return next
    })
  }, [allChecked, pageRules])

  const toggleRow = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  function handleBulkDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`선택한 ${selectedIds.size}명의 예외 규칙을 삭제하시겠습니까?`)) return
    deleteRules([...selectedIds])
    setSelectedIds(new Set())
  }

  return (
    <>
      {/* ── Orphaned-rule warning ── */}
      {orphanedRules.length > 0 && (
        <div className="mb-4 flex items-start gap-2.5 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50">
          <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div>
            <p className="text-xs font-semibold text-amber-800">
              {orphanedRules.length}개 규칙이 현재 직원 데이터와 연결되지 않았습니다
            </p>
            <p className="text-[10px] text-amber-600 mt-0.5">
              {isLiveData
                ? `근태 데이터를 재업로드하기 전에 추가된 규칙입니다. 해당 규칙은 이름 기반으로 자동 매핑됩니다 — 이름이 정확히 일치하지 않으면 적용되지 않을 수 있습니다.`
                : `근태 데이터를 먼저 업로드해야 규칙이 올바르게 적용됩니다.`}
            </p>
            <p className="text-[10px] text-amber-500 mt-1 font-medium">
              미연결 직원: {orphanedRules.map(r => r.employeeName).join(', ')}
            </p>
          </div>
        </div>
      )}

      {/* ── Header row ── */}
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-800">예외 규칙</h2>
          <p className="text-xs text-gray-400 mt-1">
            그룹 템플릿보다 우선 적용되는 개인별 근무 예외 규칙을 관리합니다.
          </p>
          {rules.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 font-semibold">
                직책자 {managerCount}명
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">
                단축근로 {shortenCount}명
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white
                bg-red-500 rounded-lg hover:bg-red-600 transition-colors shadow-sm"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              선택 삭제 ({selectedIds.size})
            </button>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white
              bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            직원 추가
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 bg-gray-50 rounded-xl
          border border-dashed border-gray-200 gap-2">
          <span className="text-3xl">⚡</span>
          <p className="text-sm font-semibold text-gray-500">등록된 예외 규칙이 없습니다</p>
          <p className="text-xs text-gray-400">위 버튼을 눌러 직원을 추가하세요</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {/* Select-all checkbox */}
                <th className="w-10 px-3 py-3 text-center">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked }}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
                  />
                </th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500 whitespace-nowrap">직원</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500 whitespace-nowrap">부서 · 팀</th>
                <th className="text-center px-4 py-3 text-[11px] font-semibold text-gray-500 whitespace-nowrap">규칙 유형</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500">설정</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {pageRules.map((r, i) => {
                const badge = RULE_BADGE[r.ruleType] ?? { label: r.ruleType || '예외', cls: 'bg-gray-100 text-gray-700', desc: '' }
                const isChecked = selectedIds.has(r.id)
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-gray-100 last:border-0 transition-colors ${
                      isChecked ? 'bg-blue-50/60' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'
                    }`}
                  >
                    {/* Row checkbox */}
                    <td className="px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRow(r.id)}
                        className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
                      />
                    </td>

                    {/* Employee */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${avatarCls(r.employeeName)}`}>
                          {(r.employeeName || '?')[0]}
                        </div>
                        <div>
                          <p className="font-semibold text-gray-800 text-[12px]">{r.employeeName}</p>
                          <p className="text-[10px] text-gray-400">{r.jobTitle}</p>
                        </div>
                      </div>
                    </td>

                    {/* Department */}
                    <td className="px-4 py-3">
                      <p className="text-gray-700">{r.division}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">{r.team}</p>
                    </td>

                    {/* Rule type badge */}
                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </td>

                    {/* Controls — vary by rule type */}
                    <td className="px-4 py-3">
                      {(r.ruleType === 'ten_am_starter' || r.ruleType === 'dispatched_worker' || r.ruleType === 'parental_leave' || r.ruleType === 'fixed_schedule_a' || r.ruleType === 'fixed_schedule_b' || r.ruleType === 'pregnant_reduced' || r.ruleType === 'global_exclusion') && (
                        <span className="text-[10px] text-gray-400 italic">
                          {r.ruleType === 'ten_am_starter'    && '10:00 스냅 · OT 20:00+'}
                          {r.ruleType === 'dispatched_worker' && '미태깅 면제'}
                          {r.ruleType === 'parental_leave'    && '전체 이상치 면제'}
                          {r.ruleType === 'fixed_schedule_a'  && '08:00 스냅 · 정상 퇴근 16:00+'}
                          {r.ruleType === 'fixed_schedule_b'  && '08:30 스냅 · 정상 퇴근 12:30+'}
                          {r.ruleType === 'pregnant_reduced'  && '실근무+휴가 ≥ 360분'}
                          {r.ruleType === 'global_exclusion'  && '집계 전체 제외'}
                        </span>
                      )}
                      {r.ruleType === 'manager_exemption' && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <div className="flex items-center gap-2">
                            <Toggle
                              on={r.excludeFromOt}
                              onChange={v => patchRule(r.id, { excludeFromOt: v })}
                            />
                            <span className={`text-[11px] font-semibold ${r.excludeFromOt ? 'text-blue-600' : 'text-gray-400'}`}>
                              OT 미산입 {r.excludeFromOt ? 'ON' : 'OFF'}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-gray-400 whitespace-nowrap">발령:</span>
                            <input
                              type="date"
                              value={r.validFrom}
                              onChange={e => patchRule(r.id, { validFrom: e.target.value })}
                              className="px-1.5 py-1 text-[10px] border border-gray-200 rounded-lg
                                focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                            />
                            <span className="text-[10px] text-gray-400">~</span>
                            <input
                              type="date"
                              value={r.validTo}
                              min={r.validFrom}
                              onChange={e => patchRule(r.id, { validTo: e.target.value })}
                              className="px-1.5 py-1 text-[10px] border border-gray-200 rounded-lg
                                focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                            />
                          </div>
                        </div>
                      )}

                      {r.ruleType === 'shortened_hours' && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={1} max={7} step={0.5}
                              value={r.shortenedHours}
                              onChange={e => patchRule(r.id, { shortenedHours: Number(e.target.value) })}
                              className="w-12 px-1.5 py-1 text-xs border border-gray-200 rounded-lg
                                focus:outline-none focus:ring-2 focus:ring-blue-500 text-right"
                            />
                            <span className="text-[10px] text-gray-500 font-medium">h / 일</span>
                          </div>

                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-gray-400 whitespace-nowrap">유효:</span>
                            <input
                              type="date"
                              value={r.validFrom}
                              onChange={e => patchRule(r.id, { validFrom: e.target.value })}
                              className="px-1.5 py-1 text-[10px] border border-gray-200 rounded-lg
                                focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                            />
                            <span className="text-[10px] text-gray-400">~</span>
                            <input
                              type="date"
                              value={r.validTo}
                              min={r.validFrom}
                              onChange={e => patchRule(r.id, { validTo: e.target.value })}
                              className="px-1.5 py-1 text-[10px] border border-gray-200 rounded-lg
                                focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                            />
                          </div>
                        </div>
                      )}

                      {r.ruleType === 'resigned' && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-gray-400 whitespace-nowrap">퇴사일:</span>
                          <input
                            type="date"
                            value={r.validFrom}
                            onChange={e => patchRule(r.id, { validFrom: e.target.value })}
                            className={`px-1.5 py-1 text-[10px] rounded-lg tabular-nums border
                              focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              r.validFrom === '' ? 'border-red-300 bg-red-50' : 'border-gray-200'
                            }`}
                          />
                          {r.validFrom === '' && (
                            <span className="text-[10px] text-red-500 whitespace-nowrap">미입력 — 전체 기간 제외됨</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Per-row delete */}
                    <td className="px-3 py-3">
                      <button
                        onClick={() => deleteRule(r.id)}
                        title="규칙 삭제"
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-300
                          hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <PaginationBar
            page={safePage}
            pageCount={pageCount}
            onPageChange={setPage}
            startItem={safePage * RULES_PAGE_SIZE + 1}
            endItem={Math.min((safePage + 1) * RULES_PAGE_SIZE, rules.length)}
            totalCount={rules.length}
            unit="명"
          />
        </div>
      )}

      {/* ── Add modal ── */}
      {showModal && (
        <AddModal
          allEmployees={employees}
          existingIds={existingIds}
          onAdd={addRule}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  )
}
