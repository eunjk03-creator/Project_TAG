'use client'
import { useEffect, useState, useCallback } from 'react'

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

const LEADER_TITLES = new Set(['DIVISION_HEAD', 'TEAM_LEAD', 'PART_LEAD'])
const JOB_TITLE_LABEL: Record<string, string> = {
  CEO: 'CEO', CSO: 'CSO', CFO: 'CFO',
  DIVISION_PRESIDENT: '부문대표', DIVISION_HEAD: '본부장',
  TEAM_LEAD: '팀장', PART_LEAD: '파트장', MEMBER: '팀원',
  INTERN: '인턴', CONTRACT: '계약직', PART_TIMER: '파트타이머', OTHER: '기타',
}

function buildTree(groups: Group[]): Map<string | null, Group[]> {
  const byParent = new Map<string | null, Group[]>()
  for (const g of groups) {
    const list = byParent.get(g.parentId) ?? []
    list.push(g)
    byParent.set(g.parentId, list)
  }
  return byParent
}

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

export function OrgGroupManageTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addingUnder, setAddingUnder] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/org-groups')
      .then(r => r.json())
      .then(rows => { setGroups(rows); setLoading(false) })
      .catch(err => { setError(String(err)); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

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

  async function deleteGroup(id: string) {
    if (!window.confirm('이 그룹을 삭제할까요?')) return
    setError('')
    const res = await fetch(`/api/org-groups/${id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? '삭제 실패'); return }
    if (selectedId === id) setSelectedId(null)
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

  if (loading) return <div className="text-sm text-gray-400 py-10 text-center">불러오는 중...</div>

  const byParent = buildTree(groups)
  const selected = groups.find(g => g.id === selectedId) ?? null

  function renderNode(g: Group, depth: number) {
    const children = byParent.get(g.id) ?? []
    return (
      <div key={g.id}>
        <div
          className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm ${
            selectedId === g.id ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-gray-50 text-gray-700'
          }`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => setSelectedId(g.id)}
        >
          <span>{g.name} <span className="text-xs text-gray-400">({g.members.length}명)</span></span>
          <span className="flex items-center gap-1 shrink-0">
            <button
              className="text-xs text-gray-400 hover:text-blue-600 px-1"
              onClick={e => { e.stopPropagation(); setAddingUnder(g.id); setNewName('') }}
            >+ 하위그룹</button>
            <button
              className="text-xs text-gray-400 hover:text-blue-600 px-1"
              onClick={e => { e.stopPropagation(); setRenamingId(g.id); setRenameValue(g.name) }}
            >이름수정</button>
            <button
              className="text-xs text-gray-400 hover:text-red-600 px-1"
              onClick={e => { e.stopPropagation(); deleteGroup(g.id) }}
            >삭제</button>
          </span>
        </div>
        {renamingId === g.id && (
          <div className="flex gap-2 items-center py-1" style={{ paddingLeft: 8 + depth * 16 }}>
            <input
              autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && renameGroup(g.id)}
              className="text-sm border border-gray-200 rounded px-2 py-1 w-40"
            />
            <button className="text-xs text-blue-600" onClick={() => renameGroup(g.id)}>저장</button>
            <button className="text-xs text-gray-400" onClick={() => setRenamingId(null)}>취소</button>
          </div>
        )}
        {addingUnder === g.id && (
          <div className="flex gap-2 items-center py-1" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
            <input
              autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="새 그룹명"
              onKeyDown={e => e.key === 'Enter' && addGroup(g.id)}
              className="text-sm border border-gray-200 rounded px-2 py-1 w-40"
            />
            <button className="text-xs text-blue-600" onClick={() => addGroup(g.id)}>추가</button>
            <button className="text-xs text-gray-400" onClick={() => setAddingUnder(null)}>취소</button>
          </div>
        )}
        {children.sort((a, b) => a.order - b.order).map(c => renderNode(c, depth + 1))}
      </div>
    )
  }

  const topLevel = (byParent.get(null) ?? []).sort((a, b) => a.order - b.order)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">조직도 관리</h2>
          <p className="text-xs text-gray-400 mt-1">그룹 {groups.length}개 · 배정 인원 {groups.reduce((s, g) => s + g.members.length, 0)}명</p>
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

      <div className="flex gap-6">
        <div className="w-96 bg-white border border-gray-200 rounded-xl p-3 max-h-[600px] overflow-auto">
          {topLevel.map(g => renderNode(g, 0))}
        </div>

        <div className="flex-1 bg-white border border-gray-200 rounded-xl p-4">
          {!selected ? (
            <p className="text-sm text-gray-400">왼쪽에서 그룹을 선택하면 구성원이 여기 표시됩니다.</p>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-gray-800 mb-1">{groupLabel(groups, selected.id)}</h3>
              <p className="text-xs text-gray-400 mb-3">구성원 {selected.members.length}명</p>
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
    </div>
  )
}
