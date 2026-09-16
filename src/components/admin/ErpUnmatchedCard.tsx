'use client'
import { useEffect, useState } from 'react'
import type { ErpUnmatchedGroup } from '@/utils/erpUnmatchedGrouping'

/**
 * "ERP 매칭 실패" 알림 — CAPS 등록 자체가 없거나(reason: no_caps) 이름 철자가 달라
 * rawId로도 후보가 2명 이상 잡히는(reason: ambiguous) ERP 연장근로/휴가 신청을 보여준다.
 * rawId 하나로 후보가 정확히 1명인 이름-철자 불일치는 dataParser.ts가 자동으로 붙여서
 * 여기 뜨지 않는다 — 정말 관리자 확인이 필요한 것만 남는다.
 */
export function ErpUnmatchedCard() {
  const [groups, setGroups] = useState<ErpUnmatchedGroup[] | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)

  async function load() {
    const res = await fetch('/api/erp-unmatched')
    if (res.ok) setGroups(await res.json())
  }
  useEffect(() => { load() }, [])

  async function registerNew(g: ErpUnmatchedGroup) {
    setBusyKey(gk(g))
    await fetch('/api/erp-unmatched/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawId: g.rawId, name: g.erpName, dept: g.dept ?? '', dates: g.dates }),
    })
    setOpenKey(null)
    await load()
    setBusyKey(null)
  }

  async function mapToCandidate(g: ErpUnmatchedGroup, targetEmployeeId: string) {
    setBusyKey(gk(g))
    await fetch('/api/erp-employee-alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawId: g.rawId, erpName: g.erpName, targetEmployeeId }),
    })
    setOpenKey(null)
    await load()
    setBusyKey(null)
  }

  if (!groups || groups.length === 0) return null

  return (
    <div className="bg-white rounded-2xl border border-amber-200 bg-amber-50/40 shadow-sm px-5 py-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center text-xs shrink-0">⚠</span>
        <h3 className="text-sm font-semibold text-[var(--ink)]">ERP 매칭 실패 ({groups.length}건)</h3>
        <span className="text-[11px] text-[var(--ink-3)]">CAPS와 매칭 안 돼 연장근로·휴가가 불인정된 신청</span>
      </div>

      <div className="space-y-2">
        {groups.map(g => {
          const key = gk(g)
          const isOpen = openKey === key
          const isBusy = busyKey === key
          return (
            <div key={key} className="bg-white rounded-xl border border-[var(--line)] px-4 py-2.5">
              <div className="flex items-center gap-3 flex-wrap text-xs">
                <span className="font-semibold text-[var(--ink)]">{g.erpName}</span>
                <span className="text-[var(--ink-3)]">{g.dept ?? '부서 미상'}</span>
                <span className="text-[var(--ink-4)] font-mono">{g.rawId}</span>
                {g.otHours > 0 && <span className="text-blue-600 font-medium">연장 {g.otHours}h</span>}
                {g.leaveDays > 0 && <span className="text-purple-600 font-medium">휴가 {g.leaveDays}일</span>}
                <span className="text-[var(--ink-4)]">{g.dates.join(', ')}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${g.reason === 'no_caps' ? 'bg-red-50 text-red-600' : 'bg-amber-100 text-amber-700'}`}>
                  {g.reason === 'no_caps' ? 'CAPS 미등록' : '매칭 후보 모호'}
                </span>
                <span className="flex-1" />
                <button
                  onClick={() => setOpenKey(isOpen ? null : key)}
                  disabled={isBusy}
                  className="text-xs font-semibold px-3 py-1 rounded-lg bg-[var(--dark)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {g.reason === 'no_caps' ? '신규 등록' : '기존 직원과 매핑'}
                </button>
              </div>

              {isOpen && g.reason === 'no_caps' && (
                <div className="mt-2 pt-2 border-t border-[var(--line-2)] flex items-center gap-2 flex-wrap">
                  <p className="text-[11px] text-[var(--ink-3)]">
                    {g.dates.length}개 날짜에 출퇴근 빈 상태(미태깅)로 등록됩니다 — 이후 미태깅 처리 화면에서 실제 시각을 입력하세요.
                  </p>
                  <button
                    onClick={() => registerNew(g)}
                    disabled={isBusy}
                    className="text-xs font-semibold px-3 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
                  >
                    {isBusy ? '처리 중…' : '확인, 등록'}
                  </button>
                </div>
              )}

              {isOpen && g.reason === 'ambiguous' && (
                <div className="mt-2 pt-2 border-t border-[var(--line-2)] flex items-center gap-2 flex-wrap">
                  <p className="text-[11px] text-[var(--ink-3)]">같은 사번의 CAPS 등록 후보:</p>
                  {(g.candidates ?? []).map(c => (
                    <button
                      key={c.id}
                      onClick={() => mapToCandidate(g, c.id)}
                      disabled={isBusy}
                      className="text-xs font-medium px-3 py-1 rounded-lg border border-[var(--line)] hover:border-blue-400 hover:text-blue-600 transition-colors disabled:opacity-40"
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function gk(g: ErpUnmatchedGroup): string {
  return `${g.rawId}_${g.erpName}`
}
