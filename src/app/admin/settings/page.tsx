'use client'
import { useState } from 'react'
import { DEFAULT_POLICY, type PolicySettings } from '@/types/tag'
import { usePolicy } from '@/context/PolicyContext'
import { ExceptionRulesTab } from '@/components/admin/ExceptionRulesTab'
import { WorkSchedulesTab } from '@/components/admin/WorkSchedulesTab'
import { LeaveAdjustmentsTab } from '@/components/admin/LeaveAdjustmentsTab'
import { SlackIntegrationTab } from '@/components/admin/SlackIntegrationTab'
import { OrgSyncTab } from '@/components/admin/OrgSyncTab'
import { OrgGroupManageTab } from '@/components/admin/OrgGroupManageTab'

// ── Types ─────────────────────────────────────────────────────────────────

type FieldDef = {
  key:    keyof PolicySettings
  label:  string
  desc:   string
  type:   'time' | 'number'
  unit?:  string
  locked?: boolean
  step?:  number
}

interface PolicyCat {
  id:     string
  label:  string
  fields: FieldDef[]
}

// ── Policy categories ─────────────────────────────────────────────────────

const POLICY_CATS: PolicyCat[] = [
  {
    id: 'commute', label: '출퇴근 규칙',
    fields: [
      { key: 'flexStart',     label: '유연근무 시작',  desc: '이 시각 이전 출근 태깅은 이 시각으로 자동 보정 (Snap-to-start)', type: 'time' },
      { key: 'flexEnd',       label: '지각 기준',      desc: '이 시각을 초과한 출근 태깅은 LATE 이상치로 처리', type: 'time' },
      { key: 'standardHours', label: '소정 근무시간',  desc: '점심 제외 일 기준 실근무시간 (한국 근로기준법 8시간)', type: 'number', unit: 'h' },
      { key: 'lunchStart',    label: '중식 휴게 시작', desc: '이 구간은 근무시간 자동 차감 (고정)', type: 'time' },
      { key: 'lunchEnd',      label: '중식 휴게 종료', desc: '이 구간은 근무시간 자동 차감 (고정)', type: 'time' },
    ],
  },
  {
    id: 'ot', label: 'OT · 야간 근무',
    fields: [
      { key: 'dinnerGraceMinutes', label: '석식 유예 시간',   desc: '정규 퇴근 후 이 시간은 OT 미산입 — 저녁 식사 시간으로 간주', type: 'number', unit: '분' },
      { key: 'otUnitMinutes',      label: 'OT 인정 단위',     desc: '이 단위 미만은 절삭 처리 (30분 권장)', type: 'number', unit: '분' },
      { key: 'otRate',             label: 'OT 가산율',        desc: '통상임금 기준 배율 (법정 최소 1.5×)', type: 'number', unit: '×', step: 0.1 },
      { key: 'nightStart',         label: '야간 근무 시작',   desc: '이 시각부터 야간 가산 적용', type: 'time' },
      { key: 'nightEnd',           label: '야간 근무 종료',   desc: '야간 가산 종료 시각 (익일 기준)', type: 'time' },
      { key: 'nightRate',          label: '야간 추가 가산율', desc: 'OT 위에 추가 적용되는 야간 배율', type: 'number', unit: '×', step: 0.1 },
      { key: 'avgHourlyWage',      label: '평균 시급',        desc: '경영진 현황의 초과근무 비용 환산에 사용 (0이면 미설정으로 취급, 금액 표시 안 함)', type: 'number', unit: '원' },
    ],
  },
  {
    id: 'holiday', label: '휴일 · 휴가',
    fields: [
      { key: 'holidayRate',       label: '휴일 기본 배율', desc: '8시간 이하 휴일 근무 가산율', type: 'number', unit: '×', step: 0.1, locked: true },
      { key: 'holidayExcessRate', label: '휴일 초과 배율', desc: '8시간 초과 휴일 근무 가산율 (법적 고정)', type: 'number', unit: '×', step: 0.1, locked: true },
    ],
  },
  {
    id: 'overview-kpi', label: '종합현황 KPI 기준',
    fields: [
      { key: 'attendanceTargetPct',          label: '출근율 목표',           desc: '일간 출근율 KPI의 "기준 대비" 계산 기준값', type: 'number', unit: '%' },
      { key: 'attendanceWarnDeltaPp',        label: '출근율 주의 임계',       desc: '목표 대비 이 값(%p)까지는 주의, 그 아래는 조치 필요 (음수로 입력)', type: 'number', unit: '%p' },
      { key: 'weeklyOtWarningH',             label: '주간 연장 주의 기준',     desc: '부서 주당 평균 연장근로가 이 시간 이상이면 주의', type: 'number', unit: 'h', step: 0.5 },
      { key: 'weeklyOtActionH',              label: '주간 연장 조치 기준',     desc: '부서 주당 평균 연장근로가 이 시간 이상이면 조치 필요', type: 'number', unit: 'h', step: 0.5 },
      { key: 'holidayWarningCount',          label: '휴일근로 주의 건수',      desc: '부서 휴일근로가 이 건수 이상이면 주의', type: 'number', unit: '건' },
      { key: 'holidayActionCount',           label: '휴일근로 조치 건수',      desc: '부서 휴일근로가 이 건수 이상이면 조치 필요', type: 'number', unit: '건' },
      { key: 'leaveTargetWarnDeltaPp',       label: '연차 누적 주의 임계',     desc: '누적 사용률 목표 대비 이 값(%p)까지는 주의, 그 아래는 조치 필요 (음수로 입력)', type: 'number', unit: '%p' },
      { key: 'monthlyAllocationWarnDeltaPp', label: '연차 단월 주의 임계',     desc: '단월 배분(8.3%) 대비 이 값(%p)까지는 주의, 그 아래는 조치 필요 (음수로 입력)', type: 'number', unit: '%p', step: 0.1 },
    ],
  },
  { id: 'system', label: '시스템 관리', fields: [] },
]

// ── Placeholder view (tabs 2 & 3) ─────────────────────────────────────────

function ComingSoon({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-56 bg-gray-50 rounded-xl
      border border-dashed border-gray-200 gap-2">
      <span className="text-3xl">{icon}</span>
      <p className="text-sm font-semibold text-gray-600">{title}</p>
      <p className="text-xs text-gray-400 text-center max-w-xs">{sub}</p>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { policy, setPolicy } = usePolicy()
  const [policyDraft, setPolicyDraft] = useState<PolicySettings>({ ...policy })
  const [saved,       setSaved]       = useState(false)
  const [activeId,    setActiveId]    = useState('groups')

  // ── Company holidays ──
  const [holDate,  setHolDate]  = useState('')
  const [holLabel, setHolLabel] = useState('')

  function addCompanyHoliday() {
    if (!holDate) return
    const label = holLabel.trim() || '전사휴무'
    const existing = policy.companyHolidays ?? []
    if (existing.some(h => h.date === holDate)) return   // no duplicates
    const sorted = [...existing, { date: holDate, label }].sort((a, b) => a.date.localeCompare(b.date))
    setPolicy({ ...policy, companyHolidays: sorted })
    setHolDate(''); setHolLabel('')
  }

  function removeCompanyHoliday(date: string) {
    setPolicy({ ...policy, companyHolidays: (policy.companyHolidays ?? []).filter(h => h.date !== date) })
  }

  const isDirty      = JSON.stringify(policyDraft) !== JSON.stringify(policy)
  const activePolicy = POLICY_CATS.find(c => c.id === activeId)

  // ── Policy handlers ──
  function updatePolicyDraft(key: keyof PolicySettings, value: string | number) {
    setPolicyDraft(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }
  function handleSavePolicy()  { setPolicy(policyDraft); setSaved(true) }
  function handleResetPolicy() { setPolicyDraft({ ...DEFAULT_POLICY }); setSaved(false) }

  return (
    <div className="h-full flex flex-col">

      {/* ── Top bar ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-gray-900">설정</h1>
          <p className="text-xs text-gray-400 mt-0.5">근무 그룹 관리 및 정책 설정</p>
        </div>
        {activePolicy && (
          <div className="flex items-center gap-2">
            {saved    && <span className="text-xs text-green-600 font-medium">✓ 저장됨</span>}
            {isDirty && !saved && <span className="text-xs text-amber-600">미저장 변경사항</span>}
            <button
              onClick={handleResetPolicy}
              className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg
                hover:bg-gray-50 transition-colors"
            >
              초기화
            </button>
            <button
              onClick={handleSavePolicy}
              disabled={!isDirty}
              className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg
                hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              저장하기
            </button>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar */}
        <aside className="w-52 bg-white border-r border-gray-200 p-3 shrink-0 overflow-y-auto space-y-0.5">

          <p className="px-3 pt-1 pb-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
            근무 그룹 관리
          </p>
          {[
            { id: 'groups',     label: '근무제 관리' },
            { id: 'exceptions', label: '예외 규칙'   },
            { id: 'leave',      label: '연차 조정'   },
            { id: 'holidays',   label: '전사휴무'    },
            { id: 'slack',      label: '슬랙 연동'   },
            { id: 'org-sync',   label: '조직도 동기화' },
            { id: 'org-groups', label: '조직도 관리' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => setActiveId(item.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                activeId === item.id
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              {item.label}
            </button>
          ))}

          <div className="pt-3">
            <p className="px-3 pb-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              정책 설정
            </p>
            {POLICY_CATS.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveId(cat.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  activeId === cat.id
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">

          {/* ─── Tab: Work Schedules (근무제 관리) ─── */}
          {activeId === 'groups' && <WorkSchedulesTab />}

          {/* ─── Tab: Exception Rules ─── */}
          {activeId === 'exceptions' && <ExceptionRulesTab />}

          {/* ─── Tab: Leave Adjustments ─── */}
          {activeId === 'leave' && <LeaveAdjustmentsTab />}

          {/* ─── Tab: Slack Integration ─── */}
          {activeId === 'slack' && <SlackIntegrationTab />}

          {/* ─── Tab: Org Chart Sync ─── */}
          {activeId === 'org-sync' && <OrgSyncTab />}

          {/* ─── Tab: Org Group Management (조직도 관리) ─── */}
          {activeId === 'org-groups' && <OrgGroupManageTab />}

          {/* ─── Tab: Company Holidays (전사휴무) ─── */}
          {activeId === 'holidays' && (
            <div className="max-w-lg">
              <div className="mb-5">
                <h2 className="text-base font-semibold text-gray-800">전사휴무 관리</h2>
                <p className="text-xs text-gray-400 mt-1">
                  매월 전사휴무일을 등록하면 캘린더 그리드에 별도 색상(청록)으로 표시되고,
                  해당일 출근 시 자동으로 <strong className="text-gray-600">휴일근무</strong>로 처리됩니다.
                </p>
              </div>

              {/* Add form */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-5">
                <p className="text-xs font-semibold text-gray-500 mb-3">휴무일 추가</p>
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <label className="block text-[11px] text-gray-400 mb-1">날짜</label>
                    <input
                      type="date"
                      value={holDate}
                      onChange={e => setHolDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[11px] text-gray-400 mb-1">레이블 (선택)</label>
                    <input
                      type="text"
                      placeholder="예: 5월 전사휴무"
                      value={holLabel}
                      onChange={e => setHolLabel(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addCompanyHoliday()}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                  <button
                    onClick={addCompanyHoliday}
                    disabled={!holDate}
                    className="px-4 py-2 text-sm font-semibold bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    추가
                  </button>
                </div>
              </div>

              {/* Holiday list */}
              {(policy.companyHolidays ?? []).length === 0 ? (
                <div className="text-center py-10 text-sm text-gray-300">
                  등록된 전사휴무일이 없습니다.
                </div>
              ) : (
                <ul className="space-y-2">
                  {(policy.companyHolidays ?? []).map(h => {
                    const d = new Date(h.date + 'T12:00')
                    const DOW = ['일', '월', '화', '수', '목', '금', '토']
                    const dayStr = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`
                    return (
                      <li key={h.date}
                        className="flex items-center justify-between bg-white border border-teal-100 rounded-lg px-4 py-3 shadow-sm"
                      >
                        <div>
                          <span className="text-sm font-semibold text-teal-700">{h.label}</span>
                          <span className="ml-2 text-xs text-gray-400 tabular-nums">{dayStr}</span>
                        </div>
                        <button
                          onClick={() => removeCompanyHoliday(h.date)}
                          className="text-xs text-red-400 hover:text-red-600 transition-colors font-medium"
                        >
                          삭제
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          {/* ─── Policy category fields ─── */}
          {activePolicy && (
            <div>
              <h2 className="text-base font-semibold text-gray-800 mb-4">{activePolicy.label}</h2>

              {activePolicy.fields.length === 0 ? (
                <ComingSoon
                  icon="⚙️"
                  title="시스템 설정"
                  sub="추후 배치 스케줄, Slack API 키 등 시스템 설정이 여기에 추가됩니다"
                />
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
                  {activePolicy.fields.map(f => (
                    <div key={f.key as string} className="px-5 py-4 flex items-start justify-between gap-6">
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{f.label}</span>
                          {f.locked && (
                            <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded border border-gray-200">
                              법적 고정
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-1 leading-relaxed">{f.desc}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {f.type === 'time' ? (
                          <input
                            type="time"
                            value={policyDraft[f.key] as string}
                            disabled={f.locked}
                            onChange={e => updatePolicyDraft(f.key, e.target.value)}
                            className="w-32 px-3 py-1.5 text-sm border border-gray-200 rounded-lg
                              focus:outline-none focus:ring-2 focus:ring-blue-500
                              disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
                          />
                        ) : (
                          <input
                            type="number"
                            step={f.step ?? 1}
                            value={policyDraft[f.key] as number}
                            disabled={f.locked}
                            onChange={e => updatePolicyDraft(f.key, Number(e.target.value))}
                            className="w-24 px-3 py-1.5 text-sm border border-gray-200 rounded-lg
                              focus:outline-none focus:ring-2 focus:ring-blue-500
                              disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed text-right"
                          />
                        )}
                        {f.unit && <span className="text-xs text-gray-400 w-5">{f.unit}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {isDirty && (
                <div className="mt-5 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-xs font-semibold text-amber-700 mb-2">변경 예정 항목</p>
                  <div className="space-y-1">
                    {(Object.keys(policyDraft) as (keyof PolicySettings)[])
                      .filter(k => policyDraft[k] !== policy[k])
                      .map(k => {
                        const field = POLICY_CATS.flatMap(c => c.fields).find(f => f.key === k)
                        return (
                          <div key={k as string} className="flex items-center gap-2 text-xs text-amber-800">
                            <span className="font-medium">{field?.label ?? (k as string)}</span>
                            <span className="text-amber-500">{String(policy[k])}</span>
                            <span>→</span>
                            <span className="font-semibold">{String(policyDraft[k])}</span>
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
