'use client'
import { useState } from 'react'
import type { ErpUnmatchedGroup } from '@/utils/erpUnmatchedGrouping'

/**
 * 업로드 직후 결과 배지 옆에 붙는 축약 버전 — ErpUnmatchedCard(직원정보 페이지, 전체
 * 이력 기준 자체 fetch)와 달리 이번 업로드 응답에 실린 groups를 그대로 받아 보여준다.
 * 처리(신규등록/매핑)하면 이 스냅샷에서만 제거 — 그리드/테이블 등 나머지 화면은
 * /admin/employees의 ErpUnmatchedCard가 다음에 열릴 때 최신 상태로 다시 보여준다.
 */
export function ErpUnmatchedInlineList({ initialGroups }: { initialGroups: ErpUnmatchedGroup[] }) {
  const [groups, setGroups] = useState(initialGroups)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)

  function removeGroup(key: string) {
    setGroups(prev => prev.filter(g => gk(g) !== key))
    setOpenKey(null)
  }

  async function registerNew(g: ErpUnmatchedGroup) {
    const key = gk(g)
    setBusyKey(key)
    await fetch('/api/erp-unmatched/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawId: g.rawId, name: g.erpName, dept: g.dept ?? '', dates: g.dates }),
    })
    removeGroup(key)
    setBusyKey(null)
  }

  async function mapToCandidate(g: ErpUnmatchedGroup, targetEmployeeId: string) {
    const key = gk(g)
    setBusyKey(key)
    await fetch('/api/erp-employee-alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawId: g.rawId, erpName: g.erpName, targetEmployeeId }),
    })
    removeGroup(key)
    setBusyKey(null)
  }

  if (groups.length === 0) return null

  return (
    <div className="w-full mt-1.5 space-y-1">
      {groups.map(g => {
        const key = gk(g)
        const isOpen = openKey === key
        const isBusy = busyKey === key
        return (
          <div key={key} className="bg-amber-50/60 border border-amber-200 rounded-lg px-2.5 py-1.5 text-[11px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[var(--ink)]">{g.erpName}</span>
              <span className="text-[var(--ink-4)] font-mono">{g.rawId}</span>
              {g.otHours > 0 && <span className="text-blue-600 font-medium">연장 {g.otHours}h</span>}
              {g.leaveDays > 0 && <span className="text-purple-600 font-medium">휴가 {g.leaveDays}일</span>}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600">
                {g.reason === 'no_caps' ? 'CAPS 미등록' : '매칭 후보 모호'}
              </span>
              <span className="flex-1" />
              <button
                onClick={() => setOpenKey(isOpen ? null : key)}
                disabled={isBusy}
                className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[var(--dark)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {g.reason === 'no_caps' ? '신규 등록' : '매핑'}
              </button>
            </div>
            {isOpen && g.reason === 'no_caps' && (
              <div className="mt-1.5 pt-1.5 border-t border-amber-200 flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-[var(--ink-3)]">{g.dates.join(', ')} — 미태깅으로 등록 후 인라인 처리로 시각 입력</span>
                <button
                  onClick={() => registerNew(g)}
                  disabled={isBusy}
                  className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
                >
                  {isBusy ? '처리 중…' : '확인, 등록'}
                </button>
              </div>
            )}
            {isOpen && g.reason === 'ambiguous' && (
              <div className="mt-1.5 pt-1.5 border-t border-amber-200 flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-[var(--ink-3)]">같은 사번 CAPS 후보:</span>
                {(g.candidates ?? []).map(c => (
                  <button
                    key={c.id}
                    onClick={() => mapToCandidate(g, c.id)}
                    disabled={isBusy}
                    className="text-[11px] font-medium px-2 py-0.5 rounded-md border border-[var(--line)] hover:border-blue-400 hover:text-blue-600 transition-colors disabled:opacity-40"
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
  )
}

function gk(g: ErpUnmatchedGroup): string {
  return `${g.rawId}_${g.erpName}`
}
