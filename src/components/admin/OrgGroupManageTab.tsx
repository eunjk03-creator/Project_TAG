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

/** 그룹 트리 전체 인원 합(자기 + 모든 하위그룹) — "펼치기 전" 카운트 표시용. */
function totalHeadcount(byParent: Map<string | null, Group[]>, group: Group): number {
  let sum = group.members.length
  for (const child of byParent.get(group.id) ?? []) sum += totalHeadcount(byParent, child)
  return sum
}

export function OrgGroupManageTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [unassigned, setUnassigned] = useState<UnassignedEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [addingUnder, setAddingUnder] = useState<string | 'root' | null>(null)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [addMemberFor, setAddMemberFor] = useState<string | null>(null)
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

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function expandAll() { setExpanded(new Set(groups.map(g => g.id))) }
  function collapseAll() { setExpanded(new Set()) }

  async function addGroup(parentId: string | null) {
    if (!newName.trim()) return
    setError('')
    const res = await fetch('/api/org-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), parentId }),
    })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '추가 실패'); return }
    if (parentId) setExpanded(prev => new Set(prev).add(parentId))
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

  async function deleteGroup(id: string) {
    if (!window.confirm('이 그룹을 삭제할까요?')) return
    setError('')
    const res = await fetch(`/api/org-groups/${id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '삭제 실패'); return }
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
    setAddMemberFor(null); setAddMemberRawId(''); setAddMemberSearch(''); setAddMemberJobTitle('MEMBER')
    load()
  }

  if (loading) return <div className="text-sm text-gray-400 py-10 text-center">불러오는 중...</div>

  const filteredUnassigned = unassigned.filter(u =>
    !addMemberSearch.trim() || u.name.includes(addMemberSearch.trim()) || u.rawId.includes(addMemberSearch.trim()),
  )

  function renderNode(g: Group, depth: number) {
    const children = byParent.get(g.id) ?? []
    const isOpen = expanded.has(g.id)
    const total = totalHeadcount(byParent, g)

    return (
      <div key={g.id}>
        <div
          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 text-sm"
          style={{ paddingLeft: 8 + depth * 20 }}
        >
          <span className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0" onClick={() => toggleExpand(g.id)}>
            <span className="text-gray-300 w-3 shrink-0">{isOpen ? '▾' : '▸'}</span>
            <span className="text-gray-700 truncate">{g.name}</span>
            <span className="text-xs text-gray-400 shrink-0">({total})</span>
          </span>
          <span className="flex items-center gap-2 text-xs shrink-0">
            <button className="text-gray-400 hover:text-blue-600" onClick={() => { setAddMemberFor(g.id); setExpanded(prev => new Set(prev).add(g.id)) }}>+ 구성원</button>
            <button className="text-gray-400 hover:text-blue-600" onClick={() => { setAddingUnder(g.id); setNewName(''); setExpanded(prev => new Set(prev).add(g.id)) }}>+ 하위그룹</button>
            <button className="text-gray-400 hover:text-blue-600" onClick={() => { setRenamingId(g.id); setRenameValue(g.name) }}>이름수정</button>
            <button className="text-gray-400 hover:text-red-600" onClick={() => deleteGroup(g.id)}>삭제</button>
          </span>
        </div>

        {renamingId === g.id && (
          <div className="flex gap-2 items-center py-1" style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
            <input
              autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && renameGroup(g.id)}
              className="text-xs border border-gray-200 rounded px-2 py-1 w-40"
            />
            <button className="text-xs text-blue-600" onClick={() => renameGroup(g.id)}>저장</button>
            <button className="text-xs text-gray-400" onClick={() => setRenamingId(null)}>취소</button>
          </div>
        )}
        {addingUnder === g.id && (
          <div className="flex gap-2 items-center py-1" style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
            <input
              autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="새 하위그룹명"
              onKeyDown={e => e.key === 'Enter' && addGroup(g.id)}
              className="text-xs border border-gray-200 rounded px-2 py-1 w-40"
            />
            <button className="text-xs text-blue-600" onClick={() => addGroup(g.id)}>추가</button>
            <button className="text-xs text-gray-400" onClick={() => setAddingUnder(null)}>취소</button>
          </div>
        )}

        {isOpen && (
          <div>
            {addMemberFor === g.id && (
              <div className="my-2 p-3 bg-gray-50 border border-gray-200 rounded-lg" style={{ marginLeft: 8 + (depth + 1) * 20 }}>
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
                    onClick={() => addMember(g.id)}
                  >이 그룹에 배치</button>
                  <button className="text-xs text-gray-400" onClick={() => setAddMemberFor(null)}>취소</button>
                </div>
              </div>
            )}

            {g.members.map(m => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-2 py-1.5 border-b border-gray-50 text-sm"
                style={{ paddingLeft: 8 + (depth + 1) * 20 + 16 }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-800 font-medium">{m.name}</span>
                  <span className="text-xs text-gray-400">{m.employeeRawId}</span>
                  <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                    {JOB_TITLE_LABEL[m.jobTitle] ?? m.jobTitle}
                  </span>
                  {LEADER_TITLES.has(m.jobTitle) && (
                    <span title={m.hasApprovalAuthority ? '승인 권한 있는 리더' : '승인 권한 없는 리더'}>
                      {m.hasApprovalAuthority ? '⭐' : '★'}
                    </span>
                  )}
                </span>
                <select
                  className="text-xs border border-gray-200 rounded px-2 py-1 shrink-0"
                  value={g.id}
                  onChange={e => moveMember(m.employeeRawId, e.target.value)}
                >
                  {groups.map(gg => (
                    <option key={gg.id} value={gg.id}>{groupLabel(groups, gg.id)}</option>
                  ))}
                </select>
              </div>
            ))}

            {children.map(c => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const topLevel = (byParent.get(null) ?? []).sort((a, b) => a.order - b.order)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">조직도 관리</h2>
          <p className="text-xs text-gray-400 mt-1">
            그룹 {groups.length}개 · 배정 인원 {groups.reduce((s, g) => s + g.members.length, 0)}명 · 미배정 {unassigned.length}명
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
            onClick={expandAll}
          >+ 전체 펼치기</button>
          <button
            className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
            onClick={collapseAll}
          >- 전체 접기</button>
          <button
            className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
            onClick={() => { setAddingUnder('root'); setNewName('') }}
          >+ 최상위 그룹 추가</button>
        </div>
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

      <div className="bg-white border border-gray-200 rounded-xl p-3 max-h-[700px] overflow-y-auto">
        {topLevel.map(g => renderNode(g, 0))}
      </div>
    </div>
  )
}
