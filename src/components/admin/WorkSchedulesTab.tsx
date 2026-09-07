'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import type { Employee } from '@/types/tag'
import { useEmployeeExceptions, type RuleType } from '@/context/EmployeeExceptionsContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { RULE_BADGE } from './ExceptionRulesTab'

// ── WorkSchedule 데이터 모델 (서버 응답 shape) ──────────────────────────────
interface WorkSchedule {
  id:             string
  name:           string
  description:    string
  ruleType:       RuleType
  shortenedHours: number | null
  excludeFromOt:  boolean
  _count?:        { members: number }
}

interface WorkScheduleMember {
  id:           string
  employeeId:   string
  employeeName: string
  jobTitle:     string
  division:     string
  team:         string
}

interface WorkScheduleDetail extends WorkSchedule {
  members: WorkScheduleMember[]
}

// ── 직원 검색 · 다중선택 (ExceptionRulesTab.tsx의 AddModal 패턴 재사용) ─────
function EmployeePicker({
  allEmployees,
  existingIds,
  onAdd,
  onClose,
}: {
  allEmployees: Employee[]
  existingIds:  Set<string>
  onAdd:        (employees: Employee[]) => void
  onClose:      () => void
}) {
  const [query, setQuery]     = useState('')
  const [picked, setPicked]   = useState<Employee[]>([])
  const pickedIds = useMemo(() => new Set(picked.map(e => e.id)), [picked])

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '' && picked.length > 0) return []
    return allEmployees
      .filter(e => !existingIds.has(e.id))
      .filter(e => q === '' || e.name.includes(q) || e.id.includes(q) ||
        e.division.toLowerCase().includes(q) || e.team.toLowerCase().includes(q))
      .slice(0, 8)
  }, [query, existingIds, allEmployees, picked.length])

  function toggle(e: Employee) {
    if (pickedIds.has(e.id)) setPicked(picked.filter(p => p.id !== e.id))
    else { setPicked([...picked, e]); setQuery('') }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 bg-[var(--card,#fff)] rounded-2xl shadow-2xl w-full max-w-[420px] flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--line)]">
          <h3 className="text-sm font-bold text-[var(--ink)]">직원 추가</h3>
          <button onClick={onClose} className="text-[var(--ink-3)] text-sm">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-3">
          <input
            type="text" placeholder="이름 · 사번으로 검색" value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-[var(--line)] rounded-lg focus:outline-none focus:border-[var(--pri)]"
          />
          {candidates.length > 0 && (
            <div className="border border-[var(--line)] rounded-xl overflow-hidden max-h-48 overflow-y-auto">
              {candidates.map(e => (
                <button key={e.id} onClick={() => toggle(e)}
                  className={`w-full px-3 py-2 flex items-center justify-between text-left border-b border-[var(--line-2)] last:border-0 ${pickedIds.has(e.id) ? 'bg-[#f7faff]' : 'hover:bg-[#fafbfc]'}`}>
                  <span className="text-sm text-[var(--ink)]">{e.name}</span>
                  <span className="text-[10px] text-[var(--ink-3)]">{e.division} · {e.team}</span>
                </button>
              ))}
            </div>
          )}
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map(e => (
                <span key={e.id} className="inline-flex items-center gap-1 bg-[var(--info-bg)] text-[var(--info)] text-xs font-medium rounded-full pl-2 pr-1 py-1">
                  {e.name}
                  <button onClick={() => setPicked(picked.filter(p => p.id !== e.id))}>✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-[var(--line)] flex justify-end gap-2">
          <button onClick={onClose} className="ghost">취소</button>
          <button
            disabled={picked.length === 0}
            onClick={() => { onAdd(picked); onClose() }}
            className="solid blue disabled:opacity-40"
          >
            추가{picked.length > 0 ? ` (${picked.length}명)` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorkSchedulesTab() {
  const { employees } = useAttendanceSource()
  const { addRule, patchRule } = useEmployeeExceptions()

  const [schedules, setSchedules] = useState<WorkSchedule[]>([])
  const [loading, setLoading]     = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail]       = useState<WorkScheduleDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName]     = useState('')
  const [newRuleType, setNewRuleType] = useState<RuleType>('manager_exemption')
  const [feedback, setFeedback]   = useState<string | null>(null)

  const loadList = useCallback(() => {
    setLoading(true)
    fetch('/api/work-schedules')
      .then(r => r.json())
      .then((data: WorkSchedule[]) => { if (Array.isArray(data)) setSchedules(data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadList() }, [loadList])

  const loadDetail = useCallback((id: string) => {
    setDetailLoading(true)
    fetch(`/api/work-schedules/${id}`)
      .then(r => r.json())
      .then((data: WorkScheduleDetail) => setDetail(data))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }, [])

  useEffect(() => {
    if (selectedId) loadDetail(selectedId)
    else setDetail(null)
  }, [selectedId, loadDetail])

  async function createSchedule() {
    if (!newName.trim()) return
    const res = await fetch('/api/work-schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), ruleType: newRuleType }),
    })
    if (res.ok) {
      const row = await res.json()
      setShowCreate(false); setNewName('')
      loadList()
      setSelectedId(row.id)
    } else {
      const err = await res.json()
      setFeedback(err.error ?? '생성 실패')
    }
  }

  async function saveDetail(patch: Partial<WorkSchedule>) {
    if (!detail) return
    const res = await fetch(`/api/work-schedules/${detail.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      const row = await res.json()
      setDetail(row)
      loadList()
      setFeedback(`${row.members?.length ?? 0}명 재계산 완료`)
      setTimeout(() => setFeedback(null), 4000)
    }
  }

  async function deleteSchedule(id: string) {
    if (!confirm('이 근무제를 삭제할까요? 배정된 인원이 있으면 삭제되지 않습니다.')) return
    const res = await fetch(`/api/work-schedules/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setSelectedId(null)
      loadList()
    } else {
      const err = await res.json()
      setFeedback(err.error ?? '삭제 실패')
    }
  }

  async function addMembers(picked: Employee[]) {
    if (!detail) return
    for (const e of picked) {
      await addRule({
        employeeId: e.id, employeeName: e.name, jobTitle: e.jobTitle,
        division: e.division, team: e.team,
        ruleType: detail.ruleType,
        excludeFromOt: detail.excludeFromOt,
        shortenedHours: detail.shortenedHours ?? 0,
        validFrom: '', validTo: '',
        workScheduleId: detail.id,
      })
    }
    loadDetail(detail.id)
    loadList()
  }

  // 그룹에서만 제외 — 배정 해제(workScheduleId=null)만 하고, 그 직원의 예외규칙 자체는
  // 지우지 않는다(개별 규칙은 예외규칙 탭에서 별도 관리 — 근무제 소속 정보만 떼어냄).
  async function removeMember(memberId: string) {
    await patchRule(memberId, { workScheduleId: null })
    if (detail) loadDetail(detail.id)
    loadList()
  }

  const existingMemberIds = useMemo(
    () => new Set((detail?.members ?? []).map(m => m.employeeId)),
    [detail],
  )

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-base font-semibold text-[var(--ink)]">근무제 관리</h2>
        <p className="text-xs text-[var(--ink-3)] mt-1">
          이름 붙인 근무제를 만들어 여러 직원을 한번에 배정합니다. 근무제 배정은 결국
          예외 규칙(같은 규칙 유형)을 만드는 것과 같아서, 계산 엔진은 별도로 안 바뀝니다.
        </p>
      </div>

      <div className="flex gap-4 items-start">
        {/* ── 좌측 목록 ── */}
        <div className="card" style={{ width: 300, flexShrink: 0 }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--line)]">
            <span className="text-sm font-semibold text-[var(--ink)]">근무제 목록</span>
            <button onClick={() => setShowCreate(true)} className="ghost" style={{ height: 28, padding: '0 10px', fontSize: 12 }}>
              + 추가
            </button>
          </div>
          {loading ? (
            <p className="px-4 py-6 text-xs text-[var(--ink-3)] text-center">불러오는 중…</p>
          ) : schedules.length === 0 ? (
            <p className="px-4 py-6 text-xs text-[var(--ink-3)] text-center">등록된 근무제가 없습니다</p>
          ) : (
            schedules.map(s => {
              const badge = RULE_BADGE[s.ruleType] ?? { label: s.ruleType, cls: 'bg-gray-100 text-gray-700' }
              const on = selectedId === s.id
              return (
                <button key={s.id} onClick={() => setSelectedId(s.id)}
                  className="w-full text-left px-4 py-3 flex items-center justify-between border-b border-[var(--line-2)] last:border-0"
                  style={on ? { background: '#f7faff', boxShadow: 'inset 3px 0 0 var(--pri)' } : undefined}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--ink)] truncate">{s.name}</p>
                    <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                  </div>
                  <span className="text-xs text-[var(--ink-3)] tabular-nums shrink-0 ml-2">{s._count?.members ?? 0}명</span>
                </button>
              )
            })
          )}
        </div>

        {/* ── 우측 상세 ── */}
        <div className="card flex-1 min-w-0">
          {!selectedId || !detail ? (
            <p className="px-6 py-10 text-sm text-[var(--ink-3)] text-center">
              {detailLoading ? '불러오는 중…' : '왼쪽에서 근무제를 선택하세요'}
            </p>
          ) : (
            <div>
              <div className="fr" style={{ minHeight: 'auto', padding: '16px 20px' }}>
                <div className="lead">
                  <input
                    value={detail.name}
                    onChange={e => setDetail({ ...detail, name: e.target.value })}
                    className="text-sm font-bold text-[var(--ink)] w-full border-0 focus:outline-none bg-transparent"
                  />
                  <input
                    value={detail.description}
                    placeholder="설명 (선택)"
                    onChange={e => setDetail({ ...detail, description: e.target.value })}
                    className="text-xs text-[var(--ink-3)] w-full border-0 focus:outline-none bg-transparent mt-1"
                  />
                </div>
                <button
                  className="solid blue"
                  onClick={() => saveDetail({ name: detail.name, description: detail.description })}
                >
                  저장
                </button>
                <button className="ghost" onClick={() => deleteSchedule(detail.id)}>삭제</button>
              </div>

              {detail.ruleType === 'shortened_hours' && (
                <div className="fr">
                  <div className="lead">
                    <p className="nm">일 근무시간</p>
                    <p className="ds">기본값 8h에서 변경</p>
                  </div>
                  <input
                    type="number" min={1} max={7} step={0.5}
                    value={detail.shortenedHours ?? 6}
                    onChange={e => setDetail({ ...detail, shortenedHours: Number(e.target.value) })}
                    onBlur={() => saveDetail({ shortenedHours: detail.shortenedHours })}
                    className="tf"
                  />
                </div>
              )}

              <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--line)]">
                <span className="text-sm font-semibold text-[var(--ink)]">배정 인원 ({detail.members.length}명)</span>
                <button onClick={() => setShowPicker(true)} className="ghost" style={{ height: 30, fontSize: 12 }}>직원 추가</button>
              </div>
              {detail.members.length === 0 ? (
                <p className="px-5 py-6 text-xs text-[var(--ink-3)] text-center">배정된 직원이 없습니다</p>
              ) : (
                detail.members.map(m => (
                  <div key={m.id} className="rowitem">
                    <div className="tx">
                      <b>{m.employeeName}</b>
                      <span>{m.division} · {m.team}</span>
                    </div>
                    <button
                      onClick={() => removeMember(m.id)}
                      className="text-[var(--ink-3)] hover:text-[var(--neg)] text-xs ml-auto"
                      title="근무제에서만 제외 — 예외규칙 자체는 남습니다"
                    >
                      제외
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {feedback && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-9 bg-[var(--dark)] text-white text-sm font-semibold rounded-[10px] px-5 h-[46px] flex items-center z-40">
          {feedback}
        </div>
      )}

      {showPicker && detail && (
        <EmployeePicker
          allEmployees={employees}
          existingIds={existingMemberIds}
          onAdd={addMembers}
          onClose={() => setShowPicker(false)}
        />
      )}

      {showCreate && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowCreate(false)} />
          <div className="relative z-10 dlg" style={{ width: 400 }}>
            <h3>새 근무제</h3>
            <input
              value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="근무제 이름 (예: 교대 A · 주간)"
              className="tf" style={{ width: '100%', textAlign: 'left' }}
            />
            <select
              value={newRuleType}
              onChange={e => setNewRuleType(e.target.value as RuleType)}
              className="selct"
            >
              {(Object.entries(RULE_BADGE) as [RuleType, typeof RULE_BADGE[RuleType]][]).map(([type, cfg]) => (
                <option key={type} value={type}>{cfg.label}</option>
              ))}
            </select>
            <div className="dfoot">
              <button className="c" onClick={() => setShowCreate(false)}>취소</button>
              <button className="k" onClick={createSchedule}>만들기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
