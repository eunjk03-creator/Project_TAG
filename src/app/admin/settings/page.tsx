'use client'
import { useState } from 'react'
import { DEFAULT_POLICY, type PolicySettings } from '@/types/tag'
import { usePolicy } from '@/context/PolicyContext'
import { ExceptionRulesTab } from '@/components/admin/ExceptionRulesTab'
import { LeaveAdjustmentsTab } from '@/components/admin/LeaveAdjustmentsTab'
import { SlackIntegrationTab } from '@/components/admin/SlackIntegrationTab'

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

interface GroupTemplate {
  id:             string
  name:           string    // English
  nameKo:         string    // Korean badge
  desc:           string
  badgeCls:       string    // chip colour classes
  ringCls:        string    // card border accent
  coreStart:      string    // HH:MM — earliest / snap-to
  coreEnd:        string    // HH:MM — late threshold
  baseHours:      number
  capsException:  boolean | null   // null = feature N/A for this group
  members:        string           // comma-separated dept names
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
    ],
  },
  {
    id: 'holiday', label: '휴일 · 휴가',
    fields: [
      { key: 'holidayRate',       label: '휴일 기본 배율', desc: '8시간 이하 휴일 근무 가산율', type: 'number', unit: '×', step: 0.1, locked: true },
      { key: 'holidayExcessRate', label: '휴일 초과 배율', desc: '8시간 초과 휴일 근무 가산율 (법적 고정)', type: 'number', unit: '×', step: 0.1, locked: true },
    ],
  },
  { id: 'system', label: '시스템 관리', fields: [] },
]

// ── Group template defaults ───────────────────────────────────────────────

const DEFAULT_GROUPS: GroupTemplate[] = [
  {
    id: 'standard', name: 'Standard', nameKo: '표준 그룹',
    desc: '일반 본부·팀 기본 적용 그룹 (전사 기본값)',
    badgeCls: 'bg-blue-100 text-blue-700',
    ringCls:  'border-blue-200',
    coreStart: '08:00', coreEnd: '09:00', baseHours: 8,
    capsException: null,
    members: '개발본부, 경영지원본부, 마케팅본부',
  },
  {
    id: 'special', name: 'Special Dept', nameKo: '특수 부서 그룹',
    desc: '용인 QC팀 등 탄력 출근 시각이 적용되는 부서',
    badgeCls: 'bg-violet-100 text-violet-700',
    ringCls:  'border-violet-200',
    coreStart: '10:00', coreEnd: '10:00', baseHours: 8,
    capsException: null,
    members: '용인 QC팀',
  },
  {
    id: 'remote', name: 'Remote Work', nameKo: '재택·외근 그룹',
    desc: 'CAPS 태깅이 면제되는 원격 근무·외근 전담 직원',
    badgeCls: 'bg-emerald-100 text-emerald-700',
    ringCls:  'border-emerald-200',
    coreStart: '09:00', coreEnd: '10:00', baseHours: 8,
    capsException: true,
    members: '글로벌사업팀, 필드 영업팀',
  },
]

// ── Toggle switch ─────────────────────────────────────────────────────────

function Toggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
        ${disabled ? 'cursor-default' : 'cursor-pointer'}
        ${on ? 'bg-blue-600' : 'bg-gray-200'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform
        ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`}
      />
    </button>
  )
}

// ── Group Template Card ───────────────────────────────────────────────────

function GroupCard({
  group,
  editing,
  draft,
  onEdit,
  onCancel,
  onSave,
  onPatch,
  onToggleCaps,
}: {
  group:         GroupTemplate
  editing:       boolean
  draft:         GroupTemplate | null
  onEdit:        () => void
  onCancel:      () => void
  onSave:        () => void
  onPatch:       (p: Partial<GroupTemplate>) => void
  onToggleCaps:  (v: boolean) => void   // live toggle, no edit mode required
}) {
  const g = editing && draft ? draft : group
  const rangeLabel = g.coreStart === g.coreEnd ? g.coreStart : `${g.coreStart} ~ ${g.coreEnd}`

  return (
    <div className={`bg-white rounded-xl border ${group.ringCls} p-5 transition-shadow hover:shadow-sm`}>

      {/* ── Card header ── */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`shrink-0 px-2 py-0.5 text-[11px] font-bold rounded-md ${group.badgeCls}`}>
            {group.nameKo}
          </span>
          <span className="text-xs text-gray-400 font-medium truncate">{group.name}</span>
        </div>
        {editing ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onCancel}
              className="px-2.5 py-1 text-xs rounded-lg border border-gray-200 text-gray-500
                hover:bg-gray-50 transition-colors"
            >
              취소
            </button>
            <button
              onClick={onSave}
              className="px-2.5 py-1 text-xs rounded-lg bg-blue-600 text-white font-medium
                hover:bg-blue-700 transition-colors"
            >
              저장
            </button>
          </div>
        ) : (
          <button
            onClick={onEdit}
            className="shrink-0 px-2.5 py-1 text-xs rounded-lg border border-gray-200 text-gray-600
              hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50/60 transition-all"
          >
            편집
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500 mb-4 leading-relaxed">{group.desc}</p>

      {/* ── Properties ── */}
      <div className="space-y-3">

        {/* Core commute window */}
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium text-gray-600 shrink-0">핵심 출근 시간</span>
          {editing && draft ? (
            <div className="flex items-center gap-1.5">
              <input
                type="time"
                value={draft.coreStart}
                onChange={e => onPatch({ coreStart: e.target.value })}
                className="w-28 px-2 py-1 text-xs border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-gray-400 text-xs">~</span>
              <input
                type="time"
                value={draft.coreEnd}
                onChange={e => onPatch({ coreEnd: e.target.value })}
                className="w-28 px-2 py-1 text-xs border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ) : (
            <span className="text-xs font-semibold text-gray-800 tabular-nums">{rangeLabel}</span>
          )}
        </div>

        {/* Base hours */}
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium text-gray-600 shrink-0">소정 근무시간</span>
          {editing && draft ? (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1} max={12}
                value={draft.baseHours}
                onChange={e => onPatch({ baseHours: Number(e.target.value) })}
                className="w-16 px-2 py-1 text-xs border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-blue-500 text-right"
              />
              <span className="text-xs text-gray-400">h</span>
            </div>
          ) : (
            <span className="text-xs font-semibold text-gray-800">{g.baseHours} 시간</span>
          )}
        </div>

        {/* CAPS tagging exception — rendered only for groups where it's applicable */}
        {group.capsException !== null && (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <span className="text-xs font-medium text-gray-600">CAPS 태깅 예외</span>
              <span className="ml-1.5 text-[10px] text-gray-400">출퇴근 태깅 면제</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Toggle
                on={g.capsException ?? false}
                onChange={editing && draft
                  ? v => onPatch({ capsException: v })
                  : onToggleCaps
                }
              />
              <span className={`text-[10px] font-bold w-5 ${g.capsException ? 'text-blue-600' : 'text-gray-400'}`}>
                {g.capsException ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
        )}

        {/* Applied departments */}
        <div className="flex items-start justify-between gap-4">
          <span className="text-xs font-medium text-gray-600 shrink-0 pt-0.5">적용 부서</span>
          {editing && draft ? (
            <input
              type="text"
              value={draft.members}
              onChange={e => onPatch({ members: e.target.value })}
              className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-500 text-right min-w-0"
            />
          ) : (
            <span className="text-xs text-gray-500 text-right leading-relaxed">{g.members}</span>
          )}
        </div>

      </div>
    </div>
  )
}

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
  const [groups,      setGroups]      = useState<GroupTemplate[]>(DEFAULT_GROUPS)
  const [editingId,   setEditingId]   = useState<string | null>(null)
  const [groupDraft,  setGroupDraft]  = useState<GroupTemplate | null>(null)

  const isDirty      = JSON.stringify(policyDraft) !== JSON.stringify(policy)
  const activePolicy = POLICY_CATS.find(c => c.id === activeId)

  // ── Policy handlers ──
  function updatePolicyDraft(key: keyof PolicySettings, value: string | number) {
    setPolicyDraft(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }
  function handleSavePolicy()  { setPolicy(policyDraft); setSaved(true) }
  function handleResetPolicy() { setPolicyDraft({ ...DEFAULT_POLICY }); setSaved(false) }

  // ── Group handlers ──
  function startEdit(g: GroupTemplate) { setEditingId(g.id); setGroupDraft({ ...g }) }
  function cancelEdit()                { setEditingId(null); setGroupDraft(null) }
  function saveEdit() {
    if (!groupDraft) return
    setGroups(gs => gs.map(g => g.id === groupDraft.id ? groupDraft : g))
    setEditingId(null); setGroupDraft(null)
  }
  function patchDraft(patch: Partial<GroupTemplate>) {
    setGroupDraft(prev => prev ? { ...prev, ...patch } : prev)
  }
  function toggleCaps(id: string, v: boolean) {
    setGroups(gs => gs.map(g => g.id === id ? { ...g, capsException: v } : g))
  }

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
            { id: 'groups',     label: '그룹 템플릿' },
            { id: 'exceptions', label: '예외 규칙'   },
            { id: 'leave',      label: '연차 조정'   },
            { id: 'slack',      label: '슬랙 연동'   },
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

          {/* ─── Tab: Group Templates ─── */}
          {activeId === 'groups' && (
            <div>
              <div className="mb-5">
                <h2 className="text-base font-semibold text-gray-800">그룹 템플릿</h2>
                <p className="text-xs text-gray-400 mt-1">
                  부서·팀별 근무 규칙을 그룹으로 관리합니다.
                  카드의 <strong className="text-gray-600 font-semibold">편집</strong> 버튼을 눌러 시간 및 조건을 수정하세요.
                </p>
              </div>
              <div className="space-y-4 max-w-2xl">
                {groups.map(g => (
                  <GroupCard
                    key={g.id}
                    group={g}
                    editing={editingId === g.id}
                    draft={editingId === g.id ? groupDraft : null}
                    onEdit={()  => startEdit(g)}
                    onCancel={cancelEdit}
                    onSave={saveEdit}
                    onPatch={patchDraft}
                    onToggleCaps={v => toggleCaps(g.id, v)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ─── Tab: Exception Rules ─── */}
          {activeId === 'exceptions' && <ExceptionRulesTab />}

          {/* ─── Tab: Leave Adjustments ─── */}
          {activeId === 'leave' && <LeaveAdjustmentsTab />}

          {/* ─── Tab: Slack Integration ─── */}
          {activeId === 'slack' && <SlackIntegrationTab />}

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
