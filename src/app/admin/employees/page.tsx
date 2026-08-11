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
const WINDOW_DAYS = 90
const PAGE_SIZE = 20

const CONTRACT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: '정규직', CONTRACT: '계약직', DISPATCHED: '파견', INTERN: '인턴/수습', EXECUTIVE: '임원', OTHER: '기타',
}

type UnifiedStatus = 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED' | 'REVIEW_RESIGN' | 'REVIEW_PARTTIME'

const STATUS_LABEL: Record<UnifiedStatus, { label: string; cls: string }> = {
  ACTIVE:           { label: '재직',   cls: 'bg-emerald-50 text-emerald-700' },
  ON_LEAVE:         { label: '휴직',   cls: 'bg-amber-50 text-amber-700' },
  RESIGNED:         { label: '퇴사',   cls: 'bg-gray-100 text-gray-500' },
  REVIEW_RESIGN:    { label: '확인필요', cls: 'bg-red-50 text-red-700' },
  REVIEW_PARTTIME:  { label: '확인필요', cls: 'bg-orange-50 text-orange-700' },
}

interface UnifiedRow {
  rawId:        string
  name:         string
  division:     string
  team:         string
  jobTitle:     string
  contractType: string
  hireDate:     string | null
  resignedDate: string | null
  status:       UnifiedStatus
  note?:        string  // REVIEW_* 행에서 왜 확인이 필요한지
  hasCapsMatch: boolean
}

function formatTenure(hireDate: string | null, endDate: string | null, today: string): string {
  if (!hireDate) return '—'
  const start = new Date(hireDate + 'T00:00')
  const end   = new Date((endDate ?? today) + 'T00:00')
  const days  = Math.round((end.getTime() - start.getTime()) / 86400000)
  if (days < 0) return '—'
  if (days < 31) return `${days}일`
  const months = Math.floor(days / 30.4)
  if (months < 12) return `${months}개월`
  return `${Math.floor(months / 12)}년 ${months % 12}개월`
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-gray-400 text-center py-6">{text}</p>
}

type StatusFilter = 'ALL' | 'ACTIVE' | 'RESIGNED' | 'REVIEW'

export default function EmployeesPage() {
  const { isLiveData } = useAttendanceSource()
  const today = todayStrFrom(new Date())
  const windowFrom = todayStrFrom(new Date(Date.now() - WINDOW_DAYS * 86400000))
  const { records, employees, finalAttrMap } = useProcessedAttendance(windowFrom, today)

  const [masterActive, refetchMasterActive] = useMasterActiveRoster()
  const [roster, refetchRoster] = useEmployeeRoster()
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
  const [resolvedPartTimeRawIds, setResolvedPartTimeRawIds] = useState<Set<string>>(new Set())
  const partTimerCandidates = useMemo(
    () => masterDiscrepancies.filter(
      d => d.type === 'CAPS_NOT_IN_MASTER' && recentActiveRawIds.has(d.rawId) && !resolvedPartTimeRawIds.has(d.rawId),
    ),
    [masterDiscrepancies, recentActiveRawIds, resolvedPartTimeRawIds],
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
  const [contractTypeDrafts, setContractTypeDrafts] = useState<Record<string, string>>({})
  const resignationCandidates = useMemo(
    () => buildResignationCandidates(employees, allMasterRawIds, recentActiveRawIds, resignedFromByRawId)
      .filter(c => !resolvedResignationRawIds.has(c.rawId) && !resignedMasterRawIds.has(c.rawId)),
    [employees, allMasterRawIds, recentActiveRawIds, resignedFromByRawId, resolvedResignationRawIds, resignedMasterRawIds],
  )
  async function confirmResignation(candidate: { rawId: string; name: string }, resignedDate: string) {
    if (!resignedDate) return
    const res = await fetch(`/api/employee-master/${candidate.rawId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: candidate.name, status: 'RESIGNED', resignedDate }),
    })
    if (!res.ok) {
      alert('퇴사 처리 반영에 실패했습니다. 다시 시도해주세요.')
      return
    }
    setResolvedResignationRawIds(prev => new Set(prev).add(candidate.rawId))
    // 마스터에 행이 없던 사람(신규 upsert)은 로컬 roster 캐시에 없어서 refetch 없이는
    // unifiedRows에서 아예 사라져 보인다 — 서버에서 최신 상태를 다시 받아와야 함.
    await refetchRoster()
  }
  async function registerAsActive(candidate: { rawId: string; name: string }, contractType: string) {
    const res = await fetch(`/api/employee-master/${candidate.rawId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: candidate.name, status: 'ACTIVE', contractType, resignedDate: null }),
    })
    if (!res.ok) {
      alert('재직 등록에 실패했습니다. 다시 시도해주세요.')
      return
    }
    setResolvedPartTimeRawIds(prev => new Set(prev).add(candidate.rawId))
    // masterActive(=EmployeeMaster status ACTIVE)에 반영돼야 CAPS_NOT_IN_MASTER 판정에서도
    // 빠지고, roster에도 반영돼야 정식 재직자 행으로 보인다 — 둘 다 다시 받아온다.
    await Promise.all([refetchRoster(), refetchMasterActive()])
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

  // ── 하나의 명단으로 합치기: 마스터(재직/휴직/퇴사) + 퇴사 확인 후보 + 파트타이머 확인 후보 ──
  // resignationCandidates 중 inMaster=true인 사람은 roster에도 ACTIVE로 이미 있는 같은
  // rawId라서, roster 쪽 행을 빼고 REVIEW_RESIGN 행 하나로 대체한다(중복 표시 방지).
  const rosterByRawId = useMemo(() => new Map(roster.map(r => [r.rawId, r])), [roster])
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const reviewRawIds = new Set([
      ...resignationCandidates.map(c => c.rawId),
      ...partTimerCandidates.map(d => d.rawId),
    ])
    const rows: UnifiedRow[] = roster
      .filter(r => !reviewRawIds.has(r.rawId))
      .map(r => ({
        rawId: r.rawId, name: r.name, division: r.division, team: r.team,
        jobTitle: r.jobTitle, contractType: r.contractType,
        hireDate: r.hireDate, resignedDate: r.resignedDate,
        status: r.status as UnifiedStatus,
        hasCapsMatch: rawIdToEmployeeId.has(r.rawId),
      }))
    for (const c of resignationCandidates) {
      const known = rosterByRawId.get(c.rawId)  // inMaster=true면 부서/직책 등 실제 값을 채울 수 있음
      rows.push({
        rawId: c.rawId, name: c.name, division: known?.division ?? c.division, team: known?.team ?? '',
        jobTitle: known?.jobTitle ?? '', contractType: known?.contractType ?? '',
        hireDate: known?.hireDate ?? null, resignedDate: c.resignedFrom ?? null,
        status: 'REVIEW_RESIGN',
        note: c.inMaster ? '조직도엔 있음 · 최근 활동 없음' : '조직도에도 없음 · 최근 활동 없음',
        hasCapsMatch: rawIdToEmployeeId.has(c.rawId),
      })
    }
    for (const d of partTimerCandidates) {
      rows.push({
        rawId: d.rawId, name: d.name, division: d.division, team: '',
        jobTitle: '', contractType: '', hireDate: null, resignedDate: null,
        status: 'REVIEW_PARTTIME', note: d.detail,
        hasCapsMatch: rawIdToEmployeeId.has(d.rawId),
      })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  }, [roster, resignationCandidates, partTimerCandidates, rawIdToEmployeeId, rosterByRawId])

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [page, setPage] = useState(0)
  const [selectedRow, setSelectedRow] = useState<UnifiedRow | null>(null)

  const filteredRows = useMemo(() => {
    let rows = unifiedRows
    if (statusFilter === 'ACTIVE')   rows = rows.filter(r => r.status === 'ACTIVE' || r.status === 'ON_LEAVE')
    if (statusFilter === 'RESIGNED') rows = rows.filter(r => r.status === 'RESIGNED')
    if (statusFilter === 'REVIEW')   rows = rows.filter(r => r.status === 'REVIEW_RESIGN' || r.status === 'REVIEW_PARTTIME')
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.division.toLowerCase().includes(q) ||
      r.rawId.toLowerCase().includes(q),
    )
  }, [unifiedRows, statusFilter, query])

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const safePage  = Math.min(page, pageCount - 1)
  const pageRows  = filteredRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const selectedRosterRow: RosterRow | null = selectedRow ? {
    rawId: selectedRow.rawId, name: selectedRow.name, division: selectedRow.division, team: selectedRow.team,
    jobTitle: selectedRow.jobTitle, contractType: selectedRow.contractType, status: selectedRow.status,
    hireDate: selectedRow.hireDate, resignedDate: selectedRow.resignedDate,
  } : null
  const selectedRecords = useMemo(() => {
    if (!selectedRow) return []
    const employeeId = rawIdToEmployeeId.get(selectedRow.rawId)
    return employeeId ? records.filter(r => r.employeeId === employeeId) : []
  }, [selectedRow, rawIdToEmployeeId, records])

  const knownResignCount = resignationCandidates.filter(c => c.resignedFrom).length

  if (!isLiveData) {
    return (
      <div className="p-8">
        <EmptyNote text="데이터를 먼저 업로드해주세요." />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">사원 명단</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            조직도 시트 + CAPS 대조 (최근 {WINDOW_DAYS}일 활동 기준) — 전체 {unifiedRows.length}명
          </p>
        </div>
        {knownResignCount > 0 && (
          <button
            onClick={bulkApplyKnownResignations}
            disabled={isBulkApplying}
            className="px-2.5 py-1.5 text-[11px] font-semibold text-red-600 bg-white border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-40 transition-colors"
          >
            {isBulkApplying ? '반영 중…' : `예외규칙 등록된 ${knownResignCount}명 일괄 반영`}
          </button>
        )}
      </div>

      {/* ── 검색 + 상태 필터 ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setPage(0) }}
          placeholder="이름·부서·사번으로 검색…"
          className="flex-1 min-w-[200px] px-3 py-2 text-xs border border-gray-200 rounded-lg
            focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value as StatusFilter); setPage(0) }}
          className="px-3 py-2 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="ALL">전체 상태</option>
          <option value="ACTIVE">재직/휴직만</option>
          <option value="RESIGNED">퇴사만</option>
          <option value="REVIEW">확인필요만</option>
        </select>
      </div>

      {/* ── 통합 명단 ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {pageRows.length === 0 ? (
          <EmptyNote text="검색 결과가 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-gray-400">
                  <th className="text-left px-4 py-2.5 font-medium">사번</th>
                  <th className="text-left px-4 py-2.5 font-medium">이름</th>
                  <th className="text-left px-4 py-2.5 font-medium">부서</th>
                  <th className="text-left px-4 py-2.5 font-medium">직책</th>
                  <th className="text-left px-4 py-2.5 font-medium">고용형태</th>
                  <th className="text-left px-4 py-2.5 font-medium">입사일</th>
                  <th className="text-left px-4 py-2.5 font-medium">퇴직일</th>
                  <th className="text-left px-4 py-2.5 font-medium">재직기간</th>
                  <th className="text-left px-4 py-2.5 font-medium">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pageRows.map(row => {
                  const statusInfo = STATUS_LABEL[row.status]
                  const isReviewResign = row.status === 'REVIEW_RESIGN'
                  const isReviewPartTime = row.status === 'REVIEW_PARTTIME'
                  const draft = resignationDateDrafts[row.rawId] ?? row.resignedDate ?? ''
                  const contractDraft = contractTypeDrafts[row.rawId] ?? 'CONTRACT'
                  return (
                    <tr key={row.rawId} className="hover:bg-gray-50/70">
                      <td className="px-4 py-2 text-gray-400 font-mono">{row.rawId}</td>
                      <td
                        className="px-4 py-2 font-medium text-gray-800 cursor-pointer"
                        onClick={() => setSelectedRow(row)}
                        title={row.hasCapsMatch ? '클릭하면 개인별 근태 상세정보' : 'CAPS 출퇴근 데이터 없음(조직정보만 표시됨)'}
                      >
                        {row.name}
                      </td>
                      <td className="px-4 py-2 text-gray-500">
                        {[row.division, row.team].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-4 py-2 text-gray-500">{row.jobTitle || '—'}</td>
                      <td className="px-4 py-2 text-gray-500">{CONTRACT_TYPE_LABEL[row.contractType] ?? row.contractType ?? '—'}</td>
                      <td className="px-4 py-2 text-gray-500 tabular-nums">{row.hireDate ?? '—'}</td>
                      <td className="px-4 py-2">
                        {isReviewResign ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="date"
                              value={draft}
                              onChange={e => setResignationDateDrafts(prev => ({ ...prev, [row.rawId]: e.target.value }))}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 w-[112px]"
                            />
                            <button
                              disabled={!draft}
                              onClick={() => confirmResignation(row, draft)}
                              className="px-1.5 py-0.5 text-[10px] font-semibold text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                            >
                              {row.resignedDate ? '반영' : '확정'}
                            </button>
                          </div>
                        ) : isReviewPartTime ? (
                          <div className="flex items-center gap-1">
                            <select
                              value={contractDraft}
                              onChange={e => setContractTypeDrafts(prev => ({ ...prev, [row.rawId]: e.target.value }))}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white"
                            >
                              {Object.entries(CONTRACT_TYPE_LABEL).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => registerAsActive(row, contractDraft)}
                              className="px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 bg-white border border-emerald-200 rounded hover:bg-emerald-50 transition-colors shrink-0"
                            >
                              재직 등록
                            </button>
                          </div>
                        ) : (
                          <span className="text-gray-500 tabular-nums">{row.resignedDate ?? '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-gray-500 tabular-nums">
                        {row.status === 'REVIEW_PARTTIME' ? '—' : formatTenure(row.hireDate, row.resignedDate, today)}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusInfo.cls}`}
                          title={row.note}
                        >
                          {statusInfo.label}
                        </span>
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
              startItem={safePage * PAGE_SIZE + 1}
              endItem={Math.min((safePage + 1) * PAGE_SIZE, filteredRows.length)}
              totalCount={filteredRows.length}
              unit="명"
            />
          </div>
        )}
      </div>

      {selectedRosterRow && (
        <EmployeeDetailModal
          row={selectedRosterRow}
          records={selectedRecords}
          periodLabel={`최근 ${WINDOW_DAYS}일`}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  )
}
