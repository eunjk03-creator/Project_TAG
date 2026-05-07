'use client'
import { useState } from 'react'
import { DEFAULT_POLICY, type PolicySettings } from '@/types/tag'
import { usePolicy } from '@/context/PolicyContext'

type FieldDef = {
  key: keyof PolicySettings
  label: string
  desc: string
  type: 'time' | 'number'
  unit?: string
  locked?: boolean
  step?: number
}

type Category = {
  id: string
  label: string
  fields: FieldDef[]
}

const CATEGORIES: Category[] = [
  {
    id: 'commute',
    label: '출퇴근 규칙',
    fields: [
      { key: 'flexStart', label: '유연근무 시작', desc: '이 시각 이전 출근 태깅은 이 시각으로 자동 보정 (Snap-to-start)', type: 'time' },
      { key: 'flexEnd', label: '지각 기준', desc: '이 시각을 초과한 출근 태깅은 LATE 이상치로 처리', type: 'time' },
      { key: 'standardHours', label: '소정 근무시간', desc: '점심 제외 일 기준 실근무시간 (한국 근로기준법 8시간)', type: 'number', unit: 'h' },
      { key: 'lunchStart', label: '중식 휴게 시작', desc: '이 구간은 근무시간 자동 차감 (고정)', type: 'time' },
      { key: 'lunchEnd', label: '중식 휴게 종료', desc: '이 구간은 근무시간 자동 차감 (고정)', type: 'time' },
    ],
  },
  {
    id: 'ot',
    label: 'OT · 야간 근무',
    fields: [
      { key: 'dinnerGraceMinutes', label: '석식 유예 시간', desc: '정규 퇴근 후 이 시간은 OT 미산입 — 저녁 식사 시간으로 간주', type: 'number', unit: '분' },
      { key: 'otUnitMinutes', label: 'OT 인정 단위', desc: '이 단위 미만은 절삭 처리 (30분 권장)', type: 'number', unit: '분' },
      { key: 'otRate', label: 'OT 가산율', desc: '통상임금 기준 배율 (법정 최소 1.5×)', type: 'number', unit: '×', step: 0.1 },
      { key: 'nightStart', label: '야간 근무 시작', desc: '이 시각부터 야간 가산 적용', type: 'time' },
      { key: 'nightEnd', label: '야간 근무 종료', desc: '야간 가산 종료 시각 (익일 기준)', type: 'time' },
      { key: 'nightRate', label: '야간 추가 가산율', desc: 'OT 위에 추가 적용되는 야간 배율', type: 'number', unit: '×', step: 0.1 },
    ],
  },
  {
    id: 'holiday',
    label: '휴일 · 휴가',
    fields: [
      { key: 'holidayRate', label: '휴일 기본 배율', desc: '8시간 이하 휴일 근무 가산율', type: 'number', unit: '×', step: 0.1, locked: true },
      { key: 'holidayExcessRate', label: '휴일 초과 배율', desc: '8시간 초과 휴일 근무 가산율 (법적 고정)', type: 'number', unit: '×', step: 0.1, locked: true },
    ],
  },
  {
    id: 'system',
    label: '시스템 관리',
    fields: [],
  },
]

export default function SettingsPage() {
  const { policy, setPolicy } = usePolicy()
  const [draft, setDraft] = useState<PolicySettings>({ ...policy })
  const [activeCategory, setActiveCategory] = useState('commute')
  const [saved, setSaved] = useState(false)

  const isDirty = JSON.stringify(draft) !== JSON.stringify(policy)
  const category = CATEGORIES.find(c => c.id === activeCategory)!

  function updateDraft(key: keyof PolicySettings, value: string | number) {
    setDraft(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  function handleSave() {
    setPolicy(draft)
    setSaved(true)
  }

  function handleReset() {
    setDraft({ ...DEFAULT_POLICY })
    setSaved(false)
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-gray-900">근태 기준 설정</h1>
          <p className="text-xs text-gray-400 mt-0.5">저장 후 대시보드 계산에 즉시 반영</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-green-600 font-medium">✓ 저장됨</span>}
          {isDirty && !saved && <span className="text-xs text-amber-600">미저장 변경사항</span>}
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            초기화
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            저장하기
          </button>
        </div>
      </div>

      {/* Body: Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Settings sidebar */}
        <aside className="w-52 bg-white border-r border-gray-200 p-3 space-y-0.5 shrink-0">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                activeCategory === cat.id
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </aside>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">{category.label}</h2>

          {category.fields.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-sm text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
              추후 배치 스케줄, Slack API 키 등 시스템 설정이 여기에 추가됩니다.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
              {category.fields.map(f => (
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
                        value={draft[f.key] as string}
                        disabled={f.locked}
                        onChange={e => updateDraft(f.key, e.target.value)}
                        className="w-32 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
                      />
                    ) : (
                      <input
                        type="number"
                        step={f.step ?? 1}
                        value={draft[f.key] as number}
                        disabled={f.locked}
                        onChange={e => updateDraft(f.key, Number(e.target.value))}
                        className="w-24 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed text-right"
                      />
                    )}
                    {f.unit && <span className="text-xs text-gray-400 w-5">{f.unit}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Changed values preview */}
          {isDirty && (
            <div className="mt-5 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <p className="text-xs font-semibold text-amber-700 mb-2">변경 예정 항목</p>
              <div className="space-y-1">
                {(Object.keys(draft) as (keyof PolicySettings)[])
                  .filter(k => draft[k] !== policy[k])
                  .map(k => {
                    const field = CATEGORIES.flatMap(c => c.fields).find(f => f.key === k)
                    return (
                      <div key={k as string} className="flex items-center gap-2 text-xs text-amber-800">
                        <span className="font-medium">{field?.label ?? k as string}</span>
                        <span className="text-amber-500">{String(policy[k])}</span>
                        <span>→</span>
                        <span className="font-semibold">{String(draft[k])}</span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
