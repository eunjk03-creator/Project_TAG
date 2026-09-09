'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'

interface Member {
  id: string
  employeeRawId: string
  name: string
  jobTitle: string
  hasApprovalAuthority: boolean
}
interface Group {
  id: string
  name: string
  parentId: string | null
  order: number
  members: Member[]
}
interface UnassignedEmployee {
  rawId: string
  name: string
  status: string
}

const LEADER_TITLES = new Set(['DIVISION_HEAD', 'TEAM_LEAD', 'PART_LEAD'])
const JOB_TITLE_LABEL: Record<string, string> = {
  CEO: 'CEO', CSO: 'CSO', CFO: 'CFO',
  DIVISION_PRESIDENT: '부문대표', DIVISION_HEAD: '본부장',
  TEAM_LEAD: '팀장', PART_LEAD: '파트장', MEMBER: '팀원',
  INTERN: '인턴', CONTRACT: '계약직', PART_TIMER: '파트타이머', OTHER: '기타',
}
const JOB_TITLE_OPTIONS = Object.keys(JOB_TITLE_LABEL)

function groupLabel(groups: Group[], id: string): string {
  const byId = new Map(groups.map(g => [g.id, g]))
  const parts: string[] = []
  let cur: Group | undefined = byId.get(id)
  while (cur) {
    parts.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return parts.join(' / ')
}

const COLUMN_TITLES = ['최상위', '1depth', '2depth', '3depth', '4depth', '5depth', '6depth', '7depth']

export function OrgGroupManageTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [unassigned, setUnassigned] = useState<UnassignedEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedPath, setSelectedPath] = useState<string[]>([])
  const [addingUnder, setAddingUnder] = useState<string | 'root' | null>(null)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addMemberSearch, setAddMemberSearch] = useState('')
  const [addMemberRawId, setAddMemberRawId] = useState('')
  const [addMemberJobTitle, setAddMemberJobTitle] = useState('MEMBER')

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetch('/api/org-groups').then(r => r.json()),
      fetch('/api/org-groups/unassigned-employees').then(r => r.json()),
    ])
      .then(([g, u]) => { setGroups(g); setUnassigned(u); setLoading(false) })
      .catch(err => { setError(String(err)); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const byParent = useMemo(() => {
    const m = new Map<string | null, Group[]>()
    for (const g of groups) {
      const list = m.get(g.parentId) ?? []
      list.push(g)
      m.set(g.parentId, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.order - b.order)
    return m
  }, [groups])

  function selectAt(depth: number, groupId: string) {
    setSelectedPath(prev => [...prev.slice(0, depth), groupId])
    setAddMemberOpen(false)
  }

  async function addGroup(parentId: string | null) {
    if (!newName.trim()) return
    setError('')
    const res = await fetch('/api/org-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), parentId }),
    })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '추가 실패'); return }
    setNewName(''); setAddingUnder(null)
    load()
  }

  async function renameGroup(id: string) {
    if (!renameValue.trim()) return
    setError('')
    const res = await fetch(`/api/org-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renameValue.trim() }),
    })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '수정 실패'); return }
    setRenamingId(null)
    load()
  }

  async function deleteGroup(id: string, depth: number) {
    if (!window.confirm('이 그룹을 삭제할까요?')) return
    setError('')
    const res = await fetch(`/api/org-groups/${id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '삭제 실패'); return }
    setSelectedPath(prev => prev.slice(0, depth))
    load()
  }

  async function moveMember(employeeRawId: string, newGroupId: string) {
    setError('')
    const res = await fetch('/api/org-group-members/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeRawId, newGroupId }),
    })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '이동 실패'); return }
    load()
  }

  async function addMember(groupId: string) {
    if (!addMemberRawId) return
    setError('')
    const res = await fetch('/api/org-group-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeRawId: addMemberRawId, groupId, jobTitle: addMemberJobTitle }),
    })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '추가 실패'); return }
    setAddMemberOpen(false); setAddMemberRawId(''); setAddMemberSearch(''); setAddMemberJobTitle('MEMBER')
    load()
  }

  if (loading) return <div className="text-sm text-gray-400 py-10 text-center">불러오는 중...</div>

  const selected = selectedPath.length > 0 ? groups.find(g => g.id === selectedPath[selectedPath.length - 1]) : null

  // 컬럼 구성: 0열=최상위, i열=selectedPath[i-1]의 자식들. 마지막 선택 그룹에 자식이 있으면 빈 컬럼 하나 더.
  const columns: Group[][] = [byParent.get(null) ?? []]
  for (let i = 0; i < selectedPath.length; i++) {
    columns.push(byParent.get(selectedPath[i]) ?? [])
  }

  const filteredUnassigned = unassigned.filter(u =>
    !addMemberSearch.trim() || u.name.includes(addMemberSearch.trim()) || u.rawId.includes(addMemberSearch.trim()),
  )

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">조직도 관리</h2>
          <p className="text-xs text-gray-400 mt-1">
            그룹 {groups.length}개 · 배정 인원 {groups.reduce((s, g) => s + g.members.length, 0)}명 · 미배정 {unassigned.length}명
          </p>
        </div>
        <button
          className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
          onClick={() => { setAddingUnder('root'); setNewName('') }}
        >+ 최상위 그룹 추가</button>
      </div>

      {error && <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      {addingUnder === 'root' && (
        <div className="flex gap-2 items-center mb-3">
          <input
            autoFocus value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="새 최상위 그룹명"
            onKeyDown={e => e.key === 'Enter' && addGroup(null)}
            className="text-sm border border-gray-200 rounded px-2 py-1 w-48"
          />
          <button className="text-xs text-blue-600" onClick={() => addGroup(null)}>추가</button>
          <button className="text-xs text-gray-400" onClick={() => setAddingUnder(null)}>취소</button>
        </div>
      )}

      {/* ── 가로 depth 컬럼 뷰 ── */}
      <div className="flex gap-3 overflow-x-auto pb-2 mb-6" style={{ maxWidth: '100%' }}>
        {columns.map((colGroups, depth) => (
          <div key={depth} className="w-64 shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100 text-xs font-semibold text-gray-400">
              {COLUMN_TITLES[depth] ?? `${depth}depth`}
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              {colGroups.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-300">하위 그룹 없음</div>
              ) : colGroups.map(g => {
                const isSelected = selectedPath[depth] === g.id
                const hasChildren = (byParent.get(g.id) ?? []).length > 0
                return (
                  <div key={g.id} className={`border-b border-gray-50 ${isSelected ? 'bg-blue-50' : ''}`}>
                    <div
                      className={`flex items-center justify-between gap-1 px-3 py-2 cursor-pointer text-sm ${
                        isSelected ? 'text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
                      }`}
                      onClick={() => selectAt(depth, g.id)}
                    >
                      <span className="truncate">{g.name} <span className="text-xs text-gray-400">({g.members.length})</span></span>
                      {hasChildren && <span className="text-gray-300 shrink-0">›</span>}
                    </div>
                    {isSelected && (
                      <div className="flex gap-2 px-3 pb-2 text-xs">
                        <button className="text-gray-400 hover:text-blue-600" onClick={e => { e.stopPropagation(); setAddingUnder(g.id); setNewName('') }}>+ 하위그룹</button>
                        <button className="text-gray-400 hover:text-blue-600" onClick={e => { e.stopPropagation(); setRenamingId(g.id); setRenameValue(g.name) }}>이름수정</button>
                        <button className="text-gray-400 hover:text-red-600" onClick={e => { e.stopPropagation(); deleteGroup(g.id, depth) }}>삭제</button>
                      </div>
                    )}
                    {isSelected && renamingId === g.id && (
                      <div className="flex gap-2 items-center px-3 pb-2">
                        <input
                          autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && renameGroup(g.id)}
                          className="text-xs border border-gray-200 rounded px-2 py-1 w-32"
                        />
                        <button className="text-xs text-blue-600" onClick={() => renameGroup(g.id)}>저장</button>
                        <button className="text-xs text-gray-400" onClick={() => setRenamingId(null)}>취소</button>
                      </div>
                    )}
                    {isSelected && addingUnder === g.id && (
                      <div className="flex gap-2 items-center px-3 pb-2">
                        <input
                          autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                          placeholder="새 하위그룹명"
                          onKeyDown={e => e.key === 'Enter' && addGroup(g.id)}
                          className="text-xs border border-gray-200 rounded px-2 py-1 w-32"
                        />
                        <button className="text-xs text-blue-600" onClick={() => addGroup(g.id)}>추가</button>
                        <button className="text-xs text-gray-400" onClick={() => setAddingUnder(null)}>취소</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── 선택된 그룹의 구성원 패널 ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        {!selected ? (
          <p className="text-sm text-gray-400">위에서 그룹을 선택하면 구성원이 여기 표시됩니다.</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-gray-800">{groupLabel(groups, selected.id)}</h3>
              <button
                className="text-xs px-2.5 py-1 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
                onClick={() => setAddMemberOpen(v => !v)}
              >+ 구성원 추가</button>
            </div>
            <p className="text-xs text-gray-400 mb-3">구성원 {selected.members.length}명</p>

            {addMemberOpen && (
              <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-xs font-semibold text-gray-500 mb-2">미배정 인원 {unassigned.length}명 중에서 선택 (신규입사자 포함)</p>
                <div className="flex gap-2 mb-2">
                  <input
                    value={addMemberSearch} onChange={e => setAddMemberSearch(e.target.value)}
                    placeholder="이름/사번 검색"
                    className="text-sm border border-gray-200 rounded px-2 py-1 flex-1"
                  />
                  <select
                    value={addMemberJobTitle} onChange={e => setAddMemberJobTitle(e.target.value)}
                    className="text-sm border border-gray-200 rounded px-2 py-1"
                  >
                    {JOB_TITLE_OPTIONS.map(t => <option key={t} value={t}>{JOB_TITLE_LABEL[t]}</option>)}
                  </select>
                </div>
                <div className="max-h-40 overflow-y-auto border border-gray-100 rounded bg-white">
                  {filteredUnassigned.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-gray-300">검색 결과 없음</div>
                  ) : filteredUnassigned.slice(0, 50).map(u => (
                    <div
                      key={u.rawId}
                      className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 ${addMemberRawId === u.rawId ? 'bg-blue-50 text-blue-700' : ''}`}
                      onClick={() => setAddMemberRawId(u.rawId)}
                    >
                      {u.name} <span className="text-xs text-gray-400">{u.rawId} · {u.status === 'ACTIVE' ? '재직' : '휴직'}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    disabled={!addMemberRawId}
                    className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded disabled:bg-gray-300"
                    onClick={() => addMember(selected.id)}
                  >이 그룹에 배치</button>
                  <button className="text-xs text-gray-400" onClick={() => setAddMemberOpen(false)}>취소</button>
                </div>
              </div>
            )}

            {selected.members.length === 0 ? (
              <p className="text-sm text-gray-300">소속 인원이 없습니다.</p>
            ) : (
              <ul className="space-y-2">
                {selected.members.map(m => (
                  <li key={m.id} className="flex items-center justify-between border border-gray-100 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800">{m.name}</span>
                      <span className="text-xs text-gray-400">{m.employeeRawId}</span>
                      <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                        {JOB_TITLE_LABEL[m.jobTitle] ?? m.jobTitle}
                      </span>
                      {LEADER_TITLES.has(m.jobTitle) && (
                        <span title={m.hasApprovalAuthority ? '승인 권한 있는 리더' : '승인 권한 없는 리더'}>
                          {m.hasApprovalAuthority ? '⭐' : '★'}
                        </span>
                      )}
                    </div>
                    <select
                      className="text-xs border border-gray-200 rounded px-2 py-1"
                      value={selected.id}
                      onChange={e => moveMember(m.employeeRawId, e.target.value)}
                    >
                      {groups.map(g => (
                        <option key={g.id} value={g.id}>{groupLabel(groups, g.id)}</option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
