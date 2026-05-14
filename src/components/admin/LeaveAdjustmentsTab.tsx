'use client'
import { useState, useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────

interface LeaveSettings {
  halfDayHours:     number   // 반차 인정 시간 (h)
  quarterDayHours:  number   // 반반차 인정 시간 (h)
  ruleAThreshHours: number   // 규칙 A — 체류 시간 임계값 (h)
  ruleADeductMins:  number   // 규칙 A — 공제 분
  ruleBThreshHours: number   // 규칙 B — 체류 시간 임계값 (h)
  ruleBDeductMins:  number   // 규칙 B — 공제 분
}

const DEFAULTS: LeaveSettings = {
  halfDayHours:     4,
  quarterDayHours:  2,
  ruleAThreshHours: 4,
  ruleADeductMins:  30,
  ruleBThreshHours: 8,
  ruleBDeductMins:  60,
}

// ── Labels for diff preview ───────────────────────────────────────────────

const FIELD_LABELS: Record<keyof LeaveSettings, string> = {
  halfDayHours:     '반차 인정 시간',
  quarterDayHours:  '반반차 인정 시간',
  ruleAThreshHours: '규칙 A 임계 시간',
  ruleADeductMins:  '규칙 A 공제 시간',
  ruleBThreshHours: '규칙 B 임계 시간',
  ruleBDeductMins:  '규칙 B 공제 시간',
}

const FIELD_UNITS: Record<keyof LeaveSettings, string> = {
  halfDayHours:     'h',
  quarterDayHours:  'h',
  ruleAThreshHours: 'h',
  ruleADeductMins:  '분',
  ruleBThreshHours: 'h',
  ruleBDeductMins:  '분',
}

// ── Numeric input sub-component ───────────────────────────────────────────

function Num({
  value, onChange, min, max, step = 1, unit, width = 'w-16',
}: {
  value:    number
  onChange: (v: number) => void
  min?:     number
  max?:     number
  step?:    number
  unit:     string
  width?:   string
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => onChange(Number(e.target.value))}
        className={`${width} px-2 py-1.5 text-sm border border-gray-200 rounded-lg
          focus:outline-none focus:ring-2 focus:ring-blue-500 text-right tabular-nums`}
      />
      <span className="text-xs text-gray-400 whitespace-nowrap">{unit}</span>
    </div>
  )
}

// ── Computed break-deduction preview ─────────────────────────────────────

function buildPreviewRows(draft: LeaveSettings) {
  const rules = [
    { thresh: draft.ruleAThreshHours, deduct: draft.ruleADeductMins, label: '규칙 A' },
    { thresh: draft.ruleBThreshHours, deduct: draft.ruleBDeductMins, label: '규칙 B' },
  ].sort((a, b) => a.thresh - b.thresh)

  if (rules[0].thresh === rules[1].thresh) return null  // invalid — warn elsewhere

  return [
    { range: `0h ~ ${rules[0].thresh}h`,              deduct: null,               label: '—' },
    { range: `${rules[0].thresh}h ~ ${rules[1].thresh}h`, deduct: rules[0].deduct, label: rules[0].label },
    { range: `${rules[1].thresh}h 초과`,               deduct: rules[1].deduct,   label: rules[1].label },
  ]
}

// ── Main Component ────────────────────────────────────────────────────────

export function LeaveAdjustmentsTab() {
  const [committed, setCommitted] = useState<LeaveSettings>({ ...DEFAULTS })
  const [draft,     setDraft]     = useState<LeaveSettings>({ ...DEFAULTS })
  const [saved,     setSaved]     = useState(false)

  const isDirty = JSON.stringify(draft) !== JSON.stringify(committed)

  function patch(p: Partial<LeaveSettings>) {
    setDraft(prev => ({ ...prev, ...p }))
    setSaved(false)
  }
  function handleSave()  { setCommitted({ ...draft }); setSaved(true) }
  function handleReset() { setDraft({ ...DEFAULTS });  setSaved(false) }

  const ruleOrderWarning = draft.ruleAThreshHours >= draft.ruleBThreshHours
  const previewRows      = useMemo(() => buildPreviewRows(draft), [draft])
  const changedKeys      = (Object.keys(draft) as (keyof LeaveSettings)[]).filter(k => draft[k] !== committed[k])

  return (
    <div className="space-y-6 max-w-2xl">

      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-800">연차 조정</h2>
          <p className="text-xs text-gray-400 mt-1">
            반차·반반차 인정 시간 및 휴일 근무 시 자동 공제 규칙을 설정합니다.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saved && !isDirty && (
            <span className="text-xs text-green-600 font-medium">✓ 저장됨</span>
          )}
          {isDirty && (
            <span className="text-xs text-amber-600">미저장 변경사항</span>
          )}
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg
              hover:bg-gray-50 transition-colors"
          >
            초기화
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg
              hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            저장하기
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
           Section 1 — Leave Credit Settings
         ══════════════════════════════════════════════════════════════ */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-700">휴가 인정 시간 설정</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium border border-blue-100">
            Leave Credit
          </span>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          반차·반반차 사용 시 소정 근무시간으로 인정하는 시간을 설정합니다.
        </p>

        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">

          {/* 반차 */}
          <div className="px-5 py-4 flex items-center justify-between gap-6">
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0 w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                <span className="text-sm">🌙</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800">반차</span>
                  <span className="text-[10px] text-gray-400 font-medium">Half-Day</span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                  오전 또는 오후 반일 휴가 사용 시 소정 근무시간으로 인정하는 시간
                </p>
              </div>
            </div>
            <Num
              value={draft.halfDayHours}
              onChange={v => patch({ halfDayHours: v })}
              min={1} max={8} unit="h" width="w-16"
            />
          </div>

          {/* 반반차 */}
          <div className="px-5 py-4 flex items-center justify-between gap-6">
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0 w-8 h-8 rounded-lg bg-cyan-50 flex items-center justify-center">
                <span className="text-sm">🌤️</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800">반반차</span>
                  <span className="text-[10px] text-gray-400 font-medium">Quarter-Day</span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                  2시간 단위 단기 휴가 사용 시 소정 근무시간으로 인정하는 시간
                </p>
              </div>
            </div>
            <Num
              value={draft.quarterDayHours}
              onChange={v => patch({ quarterDayHours: v })}
              min={1} max={draft.halfDayHours} unit="h" width="w-16"
            />
          </div>

        </div>

        {/* Half < Quarter warning */}
        {draft.quarterDayHours >= draft.halfDayHours && (
          <p className="mt-2 text-xs text-amber-600 flex items-center gap-1">
            <span>⚠️</span> 반반차 인정 시간은 반차보다 짧아야 합니다
          </p>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════
           Section 2 — Holiday Work Break Deduction Rules
         ══════════════════════════════════════════════════════════════ */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-700">휴일 근무 휴게 공제 규칙</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 font-medium border border-orange-100">
            Break Deduction
          </span>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          휴일 근무 중 체류 시간이 임계값을 초과하면 휴게 시간을 자동 공제합니다.
          규칙 B 조건 충족 시 규칙 A를 대체합니다.
        </p>

        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">

          {/* Rule A */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="shrink-0 px-2 py-0.5 text-[11px] font-bold rounded-md bg-indigo-100 text-indigo-700">
                규칙 A
              </span>
              <span className="text-xs text-gray-500">체류 시간이</span>
              <Num
                value={draft.ruleAThreshHours}
                onChange={v => patch({ ruleAThreshHours: v })}
                min={1} max={23} unit="h 초과 시" width="w-14"
              />
              <span className="text-gray-400 text-sm font-light shrink-0">→</span>
              <Num
                value={draft.ruleADeductMins}
                onChange={v => patch({ ruleADeductMins: v })}
                min={0} max={120} step={5} unit="분 공제" width="w-16"
              />
            </div>
          </div>

          {/* Rule B */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="shrink-0 px-2 py-0.5 text-[11px] font-bold rounded-md bg-violet-100 text-violet-700">
                규칙 B
              </span>
              <span className="text-xs text-gray-500">체류 시간이</span>
              <Num
                value={draft.ruleBThreshHours}
                onChange={v => patch({ ruleBThreshHours: v })}
                min={1} max={23} unit="h 초과 시" width="w-14"
              />
              <span className="text-gray-400 text-sm font-light shrink-0">→</span>
              <Num
                value={draft.ruleBDeductMins}
                onChange={v => patch({ ruleBDeductMins: v })}
                min={0} max={240} step={5} unit="분 공제" width="w-16"
              />
            </div>
          </div>

        </div>

        {/* Rule order warning */}
        {ruleOrderWarning && (
          <p className="mt-2 text-xs text-amber-600 flex items-center gap-1">
            <span>⚠️</span> 규칙 B 임계 시간은 규칙 A보다 커야 합니다
          </p>
        )}

        {/* ── Live preview table ── */}
        {previewRows && !ruleOrderWarning && (
          <div className="mt-4 bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-200">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                적용 미리보기 — 체류 시간별 공제 요약
              </p>
            </div>
            <div className="divide-y divide-gray-100">
              {previewRows.map((row, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      i === 0 ? 'bg-gray-300' : i === 1 ? 'bg-indigo-400' : 'bg-violet-400'
                    }`} />
                    <span className="text-xs text-gray-600 tabular-nums font-medium">{row.range}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {row.deduct !== null ? (
                      <>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          i === 1 ? 'bg-indigo-100 text-indigo-700' : 'bg-violet-100 text-violet-700'
                        }`}>{row.label}</span>
                        <span className="text-xs font-bold text-gray-700 tabular-nums">
                          {row.deduct}분 공제
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-gray-400">공제 없음</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Changed values diff ── */}
      {isDirty && changedKeys.length > 0 && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-xs font-semibold text-amber-700 mb-2">변경 예정 항목</p>
          <div className="space-y-1">
            {changedKeys.map(k => (
              <div key={k} className="flex items-center gap-2 text-xs text-amber-800">
                <span className="font-medium">{FIELD_LABELS[k]}</span>
                <span className="text-amber-500">{committed[k]}{FIELD_UNITS[k]}</span>
                <span>→</span>
                <span className="font-semibold">{draft[k]}{FIELD_UNITS[k]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
