'use client'
import { useMemo, useState } from 'react'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useProcessedAttendance } from '@/hooks/useProcessedAttendance'
import { useMasterActiveRoster } from '@/hooks/useMasterActiveRoster'
import { useEmployeeRoster, type RosterRow } from '@/hooks/useEmployeeRoster'
import { PaginationBar } from '@/components/admin/PaginationBar'
import { EmployeeDetailModal } from '@/components/admin/EmployeeDetailModal'
import { buildMasterDiscrepancyRollup, buildResignationCandidates } from '@/utils/overviewAggregations'

function todayStrFrom(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 이 페이지는 관리용이라 기간 탐색 UI가 없음 — 고정된 최근 90일 창으로만 데이터를 가져온다.
// (부수 효과: Overview에서 "일" 단위로 볼 때 recentActiveRawIds의 7일 lookback이 그날
// 하루치 레코드 안에서만 검색돼 무력화되던 문제가, 항상 90일치를 갖고 있는 이 페이지에서는
// 구조적으로 발생하지 않는다.)
const WINDOW_DAYS = 90

const CONTRACT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: '정규직', CONTRACT: '계약직', DISPATCHED: '파견', INTERN: '인턴/수습', EXECUTIVE: '임원', OTHER: '기타',
}
const MASTER_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ACTIVE:   { label: '재직', cls: 'bg-emerald-50 text-emerald-700' },
  ON_LEAVE: { label: '휴직', cls: 'bg-amber-50 text-amber-700' },
  RESIGNED: { label: '퇴사', cls: 'bg-gray-100 text-gray-500' },
}
const ROSTER_PAGE_SIZE = 20

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-400 text-center py-6">{text}</p>
}

type Tab = 'active' | 'resign' | 'parttime'

export default function EmployeesPage() {
  const { isLiveData } = useAttendanceSource()
  const today = todayStrFrom(new Date())
  const windowFrom = todayStrFrom(new Date(Date.now() - WINDOW_DAYS * 86400000))
  const { records, employees, finalAttrMap } = useProcessedAttendance(windowFrom, today)

  const masterActive = useMasterActiveRoster()
  const roster = useEmployeeRoster()
  const employeeIdToRawId = useMemo(
    () => new Map(employees.map(e => [e.id, e.rawId ?? e.id.split('_')[0]])),
    [employees],
  )
  const rawIdToEmployeeId = useMemo(
    () => new Map(employees.map(e => [e.rawId ?? e.id.split('_')[0], e.id])),
    [employees],
  )
  const recentActiveRawIds = useMemo(() => {
    const cutoff = new Date(today + 'T00:00')
    cutoff.setDate(cutoff.getDate() - 7)
    const cutoffStr = todayStrFrom(cutoff)
    const set = new Set<string>()
    for (const r of records) {
      if (r.date < cutoffStr) continue
      const rawId = employeeIdToRawId.get(r.employeeId)
      if (rawId) set.add(rawId)
    }
    return set
  }, [records, employeeIdToRawId])

  const masterDiscrepancies = useMemo(
    () => buildMasterDiscrepancyRollup(masterActive, recentActiveRawIds, employees),
    [masterActive, recentActiveRawIds, employees],
  )
  // CAPS_NOT_IN_MASTER는 최근 활동 여부를 안 따지므로(전체 CAPS 이력 기준), 최근 활동이
  // 없는 사람은 "퇴사 추정" 쪽으로 보내고 여기선 최근 활동 있는 사람만 남긴다(중복 방지).
  const partTimerCandidates = useMemo(
    () => masterDiscrepancies.filter(d => d.type === 'CAPS_NOT_IN_MASTER' && recentActiveRawIds.has(d.rawId)),
    [masterDiscrepancies, recentActiveRawIds],
  )

  const resignedFromByRawId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [employeeId, attr] of finalAttrMap) {
      if (attr.isResigned && attr.resignedFrom) {
        const rawId = employeeIdToRawId.get(employeeId)
        if (rawId) map.set(rawId, attr.resignedFrom)
      }
    }
    return map
  }, [finalAttrMap, employeeIdToRawId])
  const allMasterRawIds = useMemo(() => new Set(roster.map(r => r.rawId)), [roster])
  const resignedMasterRawIds = useMemo(
    () => new Set(roster.filter(r => r.status === 'RESIGNED').map(r => r.rawId)),
    [roster],
  )
  const [resolvedResignationRawIds, setResolvedResignationRawIds] = useState<Set<string>>(new Set())
  const [resignationDateDrafts, setResignationDateDrafts] = useState<Record<string, string>>({})
  const resignationCandidates = useMemo(
    () => buildResignationCandidates(employees, allMasterRawIds, recentActiveRawIds, resignedFromByRawId)
      .filter(c => !resolvedResignationRawIds.has(c.rawId) && !resignedMasterRawIds.has(c.rawId)),
    [employees, allMasterRawIds, recentActiveRawIds, resignedFromByRawId, resolvedResignationRawIds, resignedMasterRawIds],
  )
  async function confirmResignation(candidate: { rawId: string; name: string }, resignedDate: string) {
    if (!resignedDate) return
    await fetch(`/api/employee-master/${candidate.rawId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: candidate.name, status: 'RESIGNED', resignedDate }),
    })
    setResolvedResignationRawIds(prev => new Set(prev).add(candidate.rawId))
  }
  const [isBulkApplying, setIsBulkApplying] = useState(false)
  async function bulkApplyKnownResignations() {
    const known = resignationCandidates.filter(c => c.resignedFrom)
    if (known.length === 0) return
    setIsBulkApplying(true)
    try {
      await Promise.all(known.map(c => confirmResignation(c, c.resignedFrom!)))
    } finally {
      setIsBulkApplying(false)
    }
  }

  const [rosterQuery, setRosterQuery] = useState('')
  const [rosterPage, setRosterPage]   = useState(0)
  const [selectedRosterRow, setSelectedRosterRow] = useState<RosterRow | null>(null)
  const filteredRoster = useMemo(() => {
    const active = roster.filter(r => r.status === 'ACTIVE')
    const q = rosterQuery.trim().toLowerCase()
    if (!q) return active
    return active.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.division.toLowerCase().includes(q) ||
      r.team.toLowerCase().includes(q) ||
      r.rawId.toLowerCase().includes(q),
    )
  }, [roster, rosterQuery])
  const rosterPageCount = Math.max(1, Math.ceil(filteredRoster.length / ROSTER_PAGE_SIZE))
  const rosterSafePage  = Math.min(rosterPage, rosterPageCount - 1)
  const pageRoster = filteredRoster.slice(
    rosterSafePage * ROSTER_PAGE_SIZE, rosterSafePage * ROSTER_PAGE_SIZE + ROSTER_PAGE_SIZE,
  )
  const selectedRosterRecords = useMemo(() => {
    if (!selectedRosterRow) return []
    const employeeId = rawIdToEmployeeId.get(selectedRosterRow.rawId)
    return employeeId ? records.filter(r => r.employeeId === employeeId) : []
  }, [selectedRosterRow, rawIdToEmployeeId, records])

  const [tab, setTab] = useState<Tab>('active')

  if (!isLiveData) {
    return (
      <div className="p-8">
        <EmptyNote text="데이터를 먼저 업로드해주세요." />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-lg font-bold text-gray-900">사원 명단</h1>
        <p className="text-xs text-gray-400 mt-0.5">
          조직도 시트 기준 재직자 관리 · 퇴사 처리 · 파트타이머 확인 (최근 {WINDOW_DAYS}일 CAPS 활동 기준)
        </p>
      </div>

      {/* ── 탭: 개수가 곧 요약 ── */}
      <div className="flex bg-gray-100 rounded-lg p-0.5 w-fit">
        {([
          { key: 'active',   label: '재직 중',       count: roster.filter(r => r.status === 'ACTIVE').length },
          { key: 'resign',   label: '퇴사 처리 필요', count: resignationCandidates.length },
          { key: 'parttime', label: '파트타이머 확인', count: partTimerCandidates.length },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === t.key ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label} <span className="tabular-nums">{t.count}</span>
          </button>
        ))}
      </div>

      {/* ── 재직 중 ── */}
      {tab === 'active' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
          <input
            type="text"
            value={rosterQuery}
            onChange={e => { setRosterQuery(e.target.value); setRosterPage(0) }}
            placeholder="이름·부서·팀·사번으로 검색…"
            className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg
              focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {pageRoster.length === 0 ? (
            <EmptyNote text="검색 결과가 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="text-left py-2 font-medium">이름</th>
                    <th className="text-left py-2 font-medium">부서</th>
                    <th className="text-left py-2 font-medium">팀</th>
                    <th className="text-left py-2 font-medium">직급</th>
                    <th className="text-left py-2 font-medium">계약형태</th>
                    <th className="text-left py-2 font-medium">재직상태</th>
                    <th className="text-left py-2 font-medium">입사일</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pageRoster.map(row => {
                    const statusInfo = MASTER_STATUS_LABEL[row.status] ?? { label: row.status, cls: 'bg-gray-100 text-gray-500' }
                    const hasCapsMatch = rawIdToEmployeeId.has(row.rawId)
                    return (
                      <tr
                        key={row.rawId}
                        onClick={() => setSelectedRosterRow(row)}
                        className="hover:bg-gray-50/70 cursor-pointer"
                        title={hasCapsMatch ? '클릭하면 개인별 근태 상세정보' : 'CAPS 출퇴근 데이터 없음(조직정보만 표시됨)'}
                      >
                        <td className="py-1.5 font-medium text-gray-800">{row.name}</td>
                        <td className="py-1.5 text-gray-500">{row.division}</td>
                        <td className="py-1.5 text-gray-500">{row.team || '—'}</td>
                        <td className="py-1.5 text-gray-500">{row.jobTitle || '—'}</td>
                        <td className="py-1.5 text-gray-500">{CONTRACT_TYPE_LABEL[row.contractType] ?? row.contractType}</td>
                        <td className="py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusInfo.cls}`}>{statusInfo.label}</span>
                        </td>
                        <td className="py-1.5 text-gray-400 tabular-nums">{row.hireDate ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <PaginationBar
                page={rosterSafePage}
                pageCount={rosterPageCount}
                onPageChange={setRosterPage}
                startItem={rosterSafePage * ROSTER_PAGE_SIZE + 1}
                endItem={Math.min((rosterSafePage + 1) * ROSTER_PAGE_SIZE, filteredRoster.length)}
                totalCount={filteredRoster.length}
                unit="명"
              />
            </div>
          )}
        </div>
      )}

      {/* ── 퇴사 처리 필요 ── */}
      {tab === 'resign' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">
              조직도에도 없고 최근 {WINDOW_DAYS}일간 CAPS 활동도 없는 사람 — 예외규칙에 등록된 날짜가 있으면 미리 채워둠
            </p>
            {resignationCandidates.some(c => c.resignedFrom) && (
              <button
                onClick={bulkApplyKnownResignations}
                disabled={isBulkApplying}
                className="px-2.5 py-1 text-[11px] font-semibold text-red-600 bg-white border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-40 transition-colors shrink-0 ml-3"
              >
                {isBulkApplying ? '반영 중…' : `예외규칙 등록된 ${resignationCandidates.filter(c => c.resignedFrom).length}명 일괄 반영`}
              </button>
            )}
          </div>
          {resignationCandidates.length === 0 ? (
            <EmptyNote text="퇴사 확인이 필요한 인원이 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="text-left py-2 font-medium">이름</th>
                    <th className="text-left py-2 font-medium">부서</th>
                    <th className="text-left py-2 font-medium">사원번호</th>
                    <th className="text-left py-2 font-medium">상태</th>
                    <th className="text-left py-2 font-medium">퇴사일</th>
                    <th className="text-left py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {resignationCandidates.map(c => {
                    const draft = resignationDateDrafts[c.rawId] ?? c.resignedFrom ?? ''
                    return (
                      <tr key={c.rawId} className="hover:bg-gray-50/70">
                        <td className="py-1.5 font-medium text-gray-800">{c.name}</td>
                        <td className="py-1.5 text-gray-500">{c.division}</td>
                        <td className="py-1.5 text-gray-400 tabular-nums">{c.rawId}</td>
                        <td className="py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            c.inMaster ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {c.inMaster ? '조직도엔 있음' : '조직도에도 없음'}
                          </span>
                          {c.resignedFrom && (
                            <span className="ml-1.5 text-[10px] text-emerald-600">예외규칙 등록됨</span>
                          )}
                        </td>
                        <td className="py-1.5">
                          <input
                            type="date"
                            value={draft}
                            onChange={e => setResignationDateDrafts(prev => ({ ...prev, [c.rawId]: e.target.value }))}
                            className="text-xs border border-gray-200 rounded px-1.5 py-0.5"
                          />
                        </td>
                        <td className="py-1.5">
                          <button
                            disabled={!draft}
                            onClick={() => confirmResignation(c, draft)}
                            className="px-2 py-1 text-[11px] font-semibold text-red-600 bg-white border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {c.resignedFrom ? '반영' : '퇴사 확정'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── 파트타이머 확인 필요 ── */}
      {tab === 'parttime' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
          <p className="text-xs text-gray-400">최근 {WINDOW_DAYS}일간 CAPS 활동은 있는데 조직도 마스터엔 없는 사람</p>
          {partTimerCandidates.length === 0 ? (
            <EmptyNote text="확인이 필요한 인원이 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="text-left py-2 font-medium">이름</th>
                    <th className="text-left py-2 font-medium">부서</th>
                    <th className="text-left py-2 font-medium">사원번호</th>
                    <th className="text-left py-2 font-medium">내용</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {partTimerCandidates.map(d => (
                    <tr key={d.rawId} className="hover:bg-gray-50/70">
                      <td className="py-1.5 font-medium text-gray-800">{d.name}</td>
                      <td className="py-1.5 text-gray-500">{d.division}</td>
                      <td className="py-1.5 text-gray-400 tabular-nums">{d.rawId}</td>
                      <td className="py-1.5 text-gray-500">{d.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {selectedRosterRow && (
        <EmployeeDetailModal
          row={selectedRosterRow}
          records={selectedRosterRecords}
          periodLabel={`최근 ${WINDOW_DAYS}일`}
          onClose={() => setSelectedRosterRow(null)}
        />
      )}
    </div>
  )
}
