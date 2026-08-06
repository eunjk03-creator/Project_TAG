'use client'
import { useState, useEffect, useMemo } from 'react'

interface Department {
  id: string
  name: string
  level: number
  parentId: string | null
  order: number
}

interface EmployeeMasterRow {
  rawId: string
  name: string
  departmentId: string | null
  jobTitle: string
  contractType: string
  status: 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED'
}

const CONTRACT_LABEL: Record<string, string> = {
  FULL_TIME: '정규직', CONTRACT: '계약직', DISPATCHED: '파견', INTERN: '인턴', EXECUTIVE: '임원', OTHER: '기타',
}

function PersonRow({ p }: { p: EmployeeMasterRow }) {
  return (
    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-gray-50 text-xs">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-gray-400 font-medium shrink-0 w-12 truncate">{p.jobTitle || '-'}</span>
        <span className="font-medium text-gray-800 truncate">{p.name}</span>
      </span>
      {p.contractType !== 'FULL_TIME' && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0">
          {CONTRACT_LABEL[p.contractType] ?? p.contractType}
        </span>
      )}
    </div>
  )
}

export default function OrgChartPage() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [employees, setEmployees] = useState<EmployeeMasterRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/departments').then(r => r.json()),
      fetch('/api/employee-master').then(r => r.json()),
    ])
      .then(([depts, emps]) => {
        if (depts?.error) throw new Error(depts.error)
        if (emps?.error) throw new Error(emps.error)
        setDepartments(depts)
        setEmployees(emps.filter((e: EmployeeMasterRow) => e.status === 'ACTIVE'))
      })
      .catch(err => setError(String(err)))
      .finally(() => setIsLoading(false))
  }, [])

  const tree = useMemo(() => {
    const empsByDept = new Map<string, EmployeeMasterRow[]>()
    for (const e of employees) {
      if (!e.departmentId) continue
      const list = empsByDept.get(e.departmentId) ?? []
      list.push(e)
      empsByDept.set(e.departmentId, list)
    }
    // 직책 우선순위 — 시트에서 쓰인 표기 그대로(팀장/파트장이 위, 팀원/인턴이 아래)
    const titleRank: Record<string, number> = {
      'CEO': 0, 'CSO': 0, 'CFO': 0, '본부장': 1, '부문대표': 1, '팀장': 2, '파트장': 3, '팀원': 4, '인턴': 5,
    }
    for (const list of empsByDept.values()) {
      list.sort((a, b) => (titleRank[a.jobTitle] ?? 9) - (titleRank[b.jobTitle] ?? 9) || a.name.localeCompare(b.name, 'ko'))
    }

    const divisions = departments.filter(d => d.level === 0).sort((a, b) => a.order - b.order)
    return divisions.map(division => {
      const teams = departments
        .filter(d => d.level === 1 && d.parentId === division.id)
        .sort((a, b) => a.order - b.order)
      const directEmps = empsByDept.get(division.id) ?? []
      const teamGroups = teams.map(team => ({ team, employees: empsByDept.get(team.id) ?? [] }))
      const headcount = directEmps.length + teamGroups.reduce((s, g) => s + g.employees.length, 0)
      return { division, directEmps, teamGroups, headcount }
    })
  }, [departments, employees])

  const totalHeadcount = employees.length

  if (isLoading) return <div className="p-8 text-sm text-gray-400">불러오는 중…</div>
  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>
  if (departments.length === 0) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-400 text-center py-10">
          아직 조직도 데이터가 없습니다. 설정 &gt; 조직도 동기화에서 엑셀 파일을 먼저 반영해주세요.
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">조직도</h1>
          <p className="text-xs text-gray-400 mt-0.5">인력 마스터 기준 · 총 {totalHeadcount}명 (재직중)</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {tree.map(({ division, directEmps, teamGroups, headcount }) => (
          <section key={division.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">{division.name}</h2>
              <span className="text-xs font-medium text-gray-400 tabular-nums">{headcount}명</span>
            </div>
            <div className="p-3 space-y-3 max-h-[420px] overflow-y-auto">
              {directEmps.length > 0 && (
                <div>
                  {directEmps.map(p => <PersonRow key={p.rawId} p={p} />)}
                </div>
              )}
              {teamGroups.map(({ team, employees: teamEmps }) => (
                <div key={team.id}>
                  <p className="text-[11px] font-semibold text-gray-400 px-2.5 pb-1 flex items-center justify-between">
                    <span>{team.name}</span>
                    <span className="tabular-nums">{teamEmps.length}명</span>
                  </p>
                  {teamEmps.map(p => <PersonRow key={p.rawId} p={p} />)}
                </div>
              ))}
              {directEmps.length === 0 && teamGroups.every(g => g.employees.length === 0) && (
                <p className="text-xs text-gray-300 text-center py-4">소속 인원 없음</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
