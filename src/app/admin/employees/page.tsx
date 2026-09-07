'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { checkEmployeeCompleteness, deriveHireDateFromRawId, type EmployeeMasterLike } from '@/lib/employeeCompleteness'

interface DepartmentRow { id: string; division: string; team: string | null }
interface EmployeeMasterRow {
  rawId: string
  name: string
  jobTitle: string
  status: 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED'
  hireDate: string | null
  resignedDate: string | null
  department: DepartmentRow | null
}
interface WorkScheduleRow { id: string; name: string }

type FilterKey = 'all' | 'active' | 'onLeave' | 'issues'

export default function EmployeesPage() {
  const { exceptionRules, rulesLoading, openDrawer } = useEmployeeExceptions()
  const [employees, setEmployees] = useState<EmployeeMasterRow[]>([])
  const [schedules, setSchedules] = useState<WorkScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [search, setSearch] = useState('')
  const [editingRawId, setEditingRawId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ hireDate: string; resignedDate: string; status: EmployeeMasterRow['status'] }>({
    hireDate: '', resignedDate: '', status: 'ACTIVE',
  })
  const [saving, setSaving] = useState(false)

  function startEdit(emp: EmployeeMasterRow) {
    setEditingRawId(emp.rawId)
    setDraft({
      hireDate: emp.hireDate ?? deriveHireDateFromRawId(emp.rawId) ?? '',
      resignedDate: emp.resignedDate ?? '',
      status: emp.status,
    })
  }

  async function saveEdit(rawId: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/employee-master/${encodeURIComponent(rawId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hireDate: draft.hireDate || null,
          resignedDate: draft.resignedDate || null,
          status: draft.status,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      setEmployees(prev => prev.map(e => e.rawId === rawId
        ? { ...e, hireDate: updated.hireDate, resignedDate: updated.resignedDate, status: updated.status }
        : e))
      setEditingRawId(null)
    } catch (err) {
      alert(`저장 실패: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/employee-master').then(r => r.json()),
      fetch('/api/work-schedules').then(r => r.json()),
    ]).then(([emp, ws]) => {
      if (cancelled) return
      setEmployees(Array.isArray(emp) ? emp : [])
      setSchedules(Array.isArray(ws) ? ws : [])
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const scheduleNameById = useMemo(() => new Map(schedules.map(s => [s.id, s.name])), [schedules])

  const rows = useMemo(() => {
    return employees.map(emp => {
      const compositeId = `${emp.rawId}_${emp.name}`
      const rules = exceptionRules.filter(r => r.employeeId === compositeId)
      const completeness = checkEmployeeCompleteness(emp as EmployeeMasterLike, rules)
      const scheduleRule = rules.find(r => r.workScheduleId)
      const scheduleName = scheduleRule?.workScheduleId ? scheduleNameById.get(scheduleRule.workScheduleId) ?? '표준' : '표준'
      const leaveRule = completeness.fields.find(f => f.label === '휴직구간')
      return {
        emp, compositeId, completeness, scheduleName,
        leaveDetail: leaveRule?.status === '입력됨' ? leaveRule.detail : null,
        hasRules: rules.length > 0,
      }
    })
  }, [employees, exceptionRules, scheduleNameById])

  const kpi = useMemo(() => {
    const active = rows.filter(r => r.emp.status === 'ACTIVE').length
    const onLeave = rows.filter(r => r.emp.status === 'ON_LEAVE').length
    const withIssues = rows.filter(r => r.completeness.issueCount > 0).length
    const withRules = rows.filter(r => r.hasRules).length
    const thisMonth = new Date().toISOString().slice(0, 7)
    const titleChangedThisMonth = rows.filter(r => r.completeness.lastTitleChangeDate?.startsWith(thisMonth)).length
    return { active, onLeave, withIssues, withRules, titleChangedThisMonth }
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (filter === 'active')   r = r.filter(x => x.emp.status === 'ACTIVE')
    if (filter === 'onLeave')  r = r.filter(x => x.emp.status === 'ON_LEAVE')
    if (filter === 'issues')   r = r.filter(x => x.completeness.issueCount > 0)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      r = r.filter(x => x.emp.name.toLowerCase().includes(q) || x.emp.rawId.toLowerCase().includes(q))
    }
    return r
  }, [rows, filter, search])

  if (loading || rulesLoading) {
    return <div className="wrap"><div className="col wide" style={{ maxWidth: 'none' }}>
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--ink-4)' }}>불러오는 중...</div>
    </div></div>
  }

  return (
    <div className="wrap">
      <div className="col wide" style={{ maxWidth: 'none' }}>

        <div className="ptitle">
          <h2>직원 정보</h2>
        </div>

        <div className="card kpi">
          <div className="kc"><div className="n"><b>{kpi.active}</b><span>명</span></div><div className="l">재직</div></div>
          <div className={`kc ${kpi.withIssues > 0 ? 'bad' : 'good'}`}><div className="n"><b>{kpi.withIssues}</b><span>명</span></div><div className="l">확인 필요 항목 있음</div></div>
          <div className="kc"><div className="n"><b>{kpi.onLeave}</b><span>명</span></div><div className="l">휴직 중</div></div>
          <div className="kc"><div className="n"><b>{kpi.withRules}</b><span>명</span></div><div className="l">개인 예외 규칙</div></div>
          <div className="kc"><div className="n"><b>{kpi.titleChangedThisMonth}</b><span>명</span></div><div className="l">이번 달 직책 변경</div></div>
        </div>

        <div className="card">
          <div className="tbar">
            <div className="chips">
              {([
                ['all', '전체'], ['active', '재직'], ['onLeave', '휴직'], ['issues', '확인 필요'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  className="chip"
                  style={filter === key ? { background: 'var(--pos-bg)', color: 'var(--pos)', borderColor: 'transparent' } : undefined}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="ct">{filtered.length}명</span>
            <input
              className="search"
              placeholder="이름 · 사번으로 검색"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="tscroll">
            <table>
              <thead>
                <tr>
                  <th>사번</th><th className="l">이름</th><th className="l">소속·직책</th><th>근무제</th>
                  <th>입사일</th><th>퇴사일</th><th>휴직구간</th><th>최근 직책변경</th>
                  <th>확인 필요</th><th>내용</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ emp, compositeId, completeness, scheduleName, leaveDetail }) => {
                  const hire = completeness.fields.find(f => f.label === '입사일')!
                  const resign = completeness.fields.find(f => f.label === '퇴사일')!
                  const title = completeness.fields.find(f => f.label === '직책변경')!
                  const cellCls = (s: string) => s === '미확인' ? 'miss' : s === '해당없음' ? 'mute' : ''
                  const isEditing = editingRawId === emp.rawId
                  return (
                    <tr key={emp.rawId}>
                      <td className="mute">{emp.rawId}</td>
                      <td className="l">
                        <Link className="lnk" href={`/admin/employees/${encodeURIComponent(emp.rawId)}`}>{emp.name}</Link>
                      </td>
                      <td className="l">
                        {emp.department ? `${emp.department.division}${emp.department.team ? ' · ' + emp.department.team : ''}` : '—'}
                        {emp.jobTitle ? ` · ${emp.jobTitle}` : ''}
                      </td>
                      <td>{scheduleName}</td>
                      {isEditing ? (
                        <>
                          <td>
                            <input
                              type="date" className="tf" style={{ width: 132 }}
                              value={draft.hireDate}
                              onChange={e => setDraft(d => ({ ...d, hireDate: e.target.value }))}
                            />
                          </td>
                          <td>
                            <input
                              type="date" className="tf" style={{ width: 132 }}
                              value={draft.resignedDate}
                              onChange={e => setDraft(d => ({ ...d, resignedDate: e.target.value }))}
                            />
                          </td>
                          <td className="mute">{leaveDetail ?? '—'}</td>
                          <td className="mute">{title.detail ?? '—'}</td>
                          <td>
                            {completeness.issueCount > 0
                              ? <span style={{ color: 'var(--cau)', fontWeight: 700 }}>● {completeness.issueCount}건</span>
                              : <span style={{ color: 'var(--pos)', fontWeight: 700 }}>● 0건</span>}
                          </td>
                          <td>
                            <select
                              className="selct" style={{ height: 34 }}
                              value={draft.status}
                              onChange={e => setDraft(d => ({ ...d, status: e.target.value as EmployeeMasterRow['status'] }))}
                            >
                              <option value="ACTIVE">재직</option>
                              <option value="ON_LEAVE">휴직</option>
                              <option value="RESIGNED">퇴사</option>
                            </select>
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="solid" disabled={saving} onClick={() => saveEdit(emp.rawId)} style={{ marginRight: 6 }}>✓</button>
                            <button className="ghost" disabled={saving} onClick={() => setEditingRawId(null)}>✕</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className={cellCls(hire.status)} title={hire.detail}>{hire.detail ?? (hire.status === '미확인' ? '미입력' : '—')}</td>
                          <td className={cellCls(resign.status)}>{resign.detail ?? (resign.status === '해당없음' ? '—' : '미입력')}</td>
                          <td className="mute">{leaveDetail ?? '—'}</td>
                          <td className="mute">{title.detail ?? '—'}</td>
                          <td>
                            {completeness.issueCount > 0
                              ? <span style={{ color: 'var(--cau)', fontWeight: 700 }}>● {completeness.issueCount}건</span>
                              : <span style={{ color: 'var(--pos)', fontWeight: 700 }}>● 0건</span>}
                          </td>
                          <td>
                            {emp.status === 'ON_LEAVE' && <span className="bg bg-info">휴직</span>}
                            {emp.status === 'RESIGNED' && <span className="bg bg-gray">퇴사</span>}
                            {emp.status === 'ACTIVE' && completeness.issueCount === 0 && <span className="bg bg-pos">정상</span>}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="ghost" onClick={() => startEdit(emp)} style={{ marginRight: 6 }} title="입사일·퇴사일·상태 수정">✎</button>
                            <button className="ghost" onClick={() => openDrawer(compositeId)}>보완</button>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
