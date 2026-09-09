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

function totalHeadcount(byParent: Map<string | null, Group[]>, group: Group): number {
  let sum = group.members.length
  for (const child of byParent.get(group.id) ?? []) sum += totalHeadcount(byParent, child)
  return sum
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-300 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

export function OrgGroupManageTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [unassigned, setUnassigned] = useState<UnassignedEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
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

  const topLevel = (byParent.get(null) ?? []).sort((a, b) => a.order - b.order)

  function toggleCollapsed(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function expandAll() { setCollapsed(new Set()) }
  function collapseAll() { setCollapsed(new Set(topLevel.map(g => g.id))) }

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

  function actionBar(g: Group) {
    return (
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] mb-1">
        <button className="text-gray-400 hover:text-blue-600 whitespace-nowrap" onClick={() => { setAddMemberFor(g.id); setAddMemberSearch(''); setAddMemberRawId('') }}>+ 구성원</button>
        <button className="text-gray-400 hover:text-blue-600 whitespace-nowrap" onClick={() => { setAddingUnder(g.id); setNewName('') }}>+ 하위그룹</button>
        <button className="text-gray-400 hover:text-blue-600 whitespace-nowrap" onClick={() => { setRenamingId(g.id); setRenameValue(g.name) }}>이름수정</button>
        <button className="text-gray-400 hover:text-red-600 whitespace-nowrap" onClick={() => deleteGroup(g.id)}>삭제</button>
      </div>
    )
  }

  function addMemberPanel(groupId: string) {
    if (addMemberFor !== groupId) return null
    return (
      <div className="my-2 p-2.5 bg-gray-50 border border-gray-200 rounded-lg">
        <div className="flex gap-1.5 mb-1.5">
          <input
            value={addMemberSearch} onChange={e => setAddMemberSearch(e.target.value)}
            placeholder="이름/사번 검색"
            className="text-xs border border-gray-200 rounded px-2 py-1 flex-1 min-w-0"
          />
          <select
            value={addMemberJobTitle} onChange={e => setAddMemberJobTitle(e.target.value)}
            className="text-xs border border-gray-200 rounded px-1 py-1"
          >
            {JOB_TITLE_OPTIONS.map(t => <option key={t} value={t}>{JOB_TITLE_LABEL[t]}</option>)}
          </select>
        </div>
        <div className="max-h-28 overflow-y-auto border border-gray-100 rounded bg-white">
          {filteredUnassigned.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-gray-300">검색 결과 없음</div>
          ) : filteredUnassigned.slice(0, 30).map(u => (
            <div
              key={u.rawId}
              className={`px-2 py-1 text-xs cursor-pointer hover:bg-blue-50 ${addMemberRawId === u.rawId ? 'bg-blue-50 text-blue-700' : ''}`}
              onClick={() => setAddMemberRawId(u.rawId)}
            >
              {u.name} <span className="text-[10px] text-gray-400">{u.rawId}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-1.5">
          <button
            disabled={!addMemberRawId}
            className="text-[11px] px-2 py-1 bg-blue-600 text-white rounded disabled:bg-gray-300"
            onClick={() => addMember(groupId)}
          >배치</button>
          <button className="text-[11px] text-gray-400" onClick={() => setAddMemberFor(null)}>취소</button>
        </div>
      </div>
    )
  }

  function renderMemberRow(m: Member, groupId: string) {
    return (
      <tr key={m.id}>
        <td className="py-1 pr-2 text-xs whitespace-nowrap">
          {JOB_TITLE_LABEL[m.jobTitle] ?? m.jobTitle}
          {LEADER_TITLES.has(m.jobTitle) && (
            <span className="ml-0.5" title={m.hasApprovalAuthority ? '승인권한 O' : '승인권한 X'}>
              {m.hasApprovalAuthority ? '⭐' : '★'}
            </span>
          )}
        </td>
        <td className="py-1 pr-2 text-xs font-medium whitespace-nowrap">{m.name} <span className="text-[10px] text-gray-400 font-normal">{m.employeeRawId}</span></td>
        <td className="py-1">
          <select
            className="text-[11px] border border-gray-200 rounded px-1 py-0.5 max-w-[140px]"
            value={groupId}
            onChange={e => moveMember(m.employeeRawId, e.target.value)}
          >
            {groups.map(gg => (
              <option key={gg.id} value={gg.id}>{groupLabel(groups, gg.id)}</option>
            ))}
          </select>
        </td>
      </tr>
    )
  }

  /** division 카드 내부 — 자기 자신(팀 없이 바로 속한 사람)부터 하위그룹(팀/파트)까지 재귀 렌더 */
  function renderGroupSection(g: Group, depth: number) {
    const children = byParent.get(g.id) ?? []
    return (
      <div key={g.id} style={{ marginLeft: depth * 10 }}>
        {depth > 0 && (
          <div className="flex items-center justify-between pt-2 pb-0.5">
            <span className="text-[11px] font-semibold text-gray-500 bg-gray-50 rounded px-2 py-0.5">
              {g.name} <span className="text-gray-400 font-normal">({totalHeadcount(byParent, g)}명)</span>
            </span>
          </div>
        )}
        {depth > 0 && actionBar(g)}
        {renamingId === g.id && (
          <div className="flex gap-1.5 items-center mb-1.5">
            <input
              autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && renameGroup(g.id)}
              className="text-xs border border-gray-200 rounded px-2 py-1 w-28"
            />
            <button className="text-[11px] text-blue-600" onClick={() => renameGroup(g.id)}>저장</button>
            <button className="text-[11px] text-gray-400" onClick={() => setRenamingId(null)}>취소</button>
          </div>
        )}
        {addingUnder === g.id && (
          <div className="flex gap-1.5 items-center mb-1.5">
            <input
              autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="새 하위그룹명"
              onKeyDown={e => e.key === 'Enter' && addGroup(g.id)}
              className="text-xs border border-gray-200 rounded px-2 py-1 w-28"
            />
            <button className="text-[11px] text-blue-600" onClick={() => addGroup(g.id)}>추가</button>
            <button className="text-[11px] text-gray-400" onClick={() => setAddingUnder(null)}>취소</button>
          </div>
        )}
        {addMemberPanel(g.id)}
        {g.members.length > 0 && (
          <table className="w-full mb-1">
            <tbody>{g.members.map(m => renderMemberRow(m, g.id))}</tbody>
          </table>
        )}
        {children.map(c => renderGroupSection(c, depth + 1))}
      </div>
    )
  }

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
          <button onClick={expandAll} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">전체 펼치기</button>
          <button onClick={collapseAll} className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">전체 접기</button>
          <button
            className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {topLevel.map(g => {
          const isOpen = !collapsed.has(g.id)
          return (
            <section key={g.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <button
                onClick={() => toggleCollapsed(g.id)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 text-white hover:bg-gray-700 transition-colors"
              >
                <span className="text-sm font-semibold truncate">{g.name}</span>
                <span className="text-xs font-medium text-gray-300 tabular-nums shrink-0">{totalHeadcount(byParent, g)}명</span>
              </button>
              <button onClick={() => toggleCollapsed(g.id)} className="w-full flex items-center justify-center py-1 text-gray-300 hover:bg-gray-50">
                <ChevronIcon open={isOpen} />
              </button>
              {isOpen && (
                <div className="p-3 max-h-[480px] overflow-y-auto">
                  {actionBar(g)}
                  {renamingId === g.id && (
                    <div className="flex gap-1.5 items-center mb-1.5">
                      <input
                        autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && renameGroup(g.id)}
                        className="text-xs border border-gray-200 rounded px-2 py-1 w-28"
                      />
                      <button className="text-[11px] text-blue-600" onClick={() => renameGroup(g.id)}>저장</button>
                      <button className="text-[11px] text-gray-400" onClick={() => setRenamingId(null)}>취소</button>
                    </div>
                  )}
                  {addingUnder === g.id && (
                    <div className="flex gap-1.5 items-center mb-1.5">
                      <input
                        autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                        placeholder="새 하위그룹명"
                        onKeyDown={e => e.key === 'Enter' && addGroup(g.id)}
                        className="text-xs border border-gray-200 rounded px-2 py-1 w-28"
                      />
                      <button className="text-[11px] text-blue-600" onClick={() => addGroup(g.id)}>추가</button>
                      <button className="text-[11px] text-gray-400" onClick={() => setAddingUnder(null)}>취소</button>
                    </div>
                  )}
                  {addMemberPanel(g.id)}
                  {g.members.length > 0 && (
                    <table className="w-full mb-1">
                      <tbody>{g.members.map(m => renderMemberRow(m, g.id))}</tbody>
                    </table>
                  )}
                  {(byParent.get(g.id) ?? []).map(c => renderGroupSection(c, 1))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
