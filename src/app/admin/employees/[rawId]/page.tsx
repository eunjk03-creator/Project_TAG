'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useScopedProcessedRecords } from '@/hooks/useProcessedAttendance'
import { computeRealHoursOtForRecord, isLeaderOnDate } from '@/utils/attendanceCalc'
import { checkEmployeeCompleteness, type EmployeeMasterLike } from '@/lib/employeeCompleteness'
import { DateRangePicker } from '@/components/admin/DateRangePicker'
import type { DateRange } from '@/types/tag'

interface EmployeeMasterRow {
  rawId: string
  name: string
  jobTitle: string
  status: 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED'
  hireDate: string | null
  resignedDate: string | null
  department: { division: string; team: string | null } | null
}

// 근태규정.md §5 문구를 그대로 재사용 — 새로 설명을 지어내지 않음
const RULE_EFFECT: Record<string, string> = {
  manager_exemption:  '직책자 적용 — OT 30분 절삭 없음, 급여용 3종(소정외/법정연장/야간) 항상 0 고정, 리포팅 분리',
  parental_leave:     '육아휴직 적용 — 기간 내 모든 이상치 플래그 무시',
  shortened_hours:    '단축근무 적용 — 표준근무시간이 지정된 단축 시간으로 낮아짐',
  pregnant_reduced:   '임신부 단축근무 적용 — 표준근무 6시간, 실근무+휴가 360분 미만이면 이상치',
  dispatched_worker:  '파견자 적용 — 미태깅 페널티 면제',
  ten_am_starter:     '10시 출근자 적용 — 지각기준이 10:00으로 이동',
  fixed_schedule_a:   '고정스케줄 A 적용 — 08:00 출근, 30분 휴게 고정',
  fixed_schedule_b:   '고정스케줄 B 적용 — 08:30 출근, 휴게 없음 고정',
  easy_logis:         '이지로지스 적용 — 계산은 하되 이상치 플래그 전부 무시',
  global_exclusion:   '전체제외 적용 — 근태 계산 자체를 건너뜀',
  resigned:           '퇴사 처리 — 퇴사일 이후 근태 계산 제외',
}

type TabKey = 'history' | 'detail'

export default function EmployeeCardPage() {
  const params = useParams<{ rawId: string }>()
  const rawId = decodeURIComponent(params.rawId)
  const { exceptionRules } = useEmployeeExceptions()
  const { dataVersion } = useAttendanceSource()

  const [emp, setEmp] = useState<EmployeeMasterRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabKey>('history')
  const [range, setRange] = useState<DateRange>(() => {
    const today = new Date()
    const from = new Date(today); from.setDate(from.getDate() - 30)
    const toDS = (d: Date) => d.toISOString().slice(0, 10)
    return { from: toDS(from), to: toDS(today) }
  })

  useEffect(() => {
    let cancelled = false
    fetch(`/api/employee-master/${encodeURIComponent(rawId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(row => { if (!cancelled) { setEmp(row); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [rawId])

  const compositeId = emp ? `${emp.rawId}_${emp.name}` : null
  const rules = useMemo(
    () => exceptionRules.filter(r => r.employeeId === compositeId),
    [exceptionRules, compositeId],
  )

  const completeness = useMemo(
    () => emp ? checkEmployeeCompleteness(emp as EmployeeMasterLike, rules) : null,
    [emp, rules],
  )

  // 인사 이력 타임라인 — hireDate/resignedDate + 규칙별 validFrom을 합쳐 날짜순 정렬
  const timeline = useMemo(() => {
    if (!emp) return []
    const items: { date: string; title: string; effect?: string }[] = []
    if (emp.hireDate) items.push({ date: emp.hireDate, title: '입사' })
    if (emp.resignedDate) items.push({ date: emp.resignedDate, title: '퇴사' })
    for (const r of rules) {
      if (!r.validFrom) continue
      const label: Record<string, string> = {
        manager_exemption: '직책 변경 — 직책자 적용',
        parental_leave: '육아휴직 시작',
        shortened_hours: '단축근무 적용',
        pregnant_reduced: '임신부 단축근무 적용',
        dispatched_worker: '파견 적용',
      }
      if (!label[r.ruleType]) continue
      items.push({ date: r.validFrom, title: label[r.ruleType], effect: RULE_EFFECT[r.ruleType] })
    }
    return items.sort((a, b) => b.date.localeCompare(a.date))
  }, [emp, rules])

  // 근태 상세 — 선택 기간 원본/급여용 소정외 비교
  const leaderRule = useMemo(() => rules.find(r => r.ruleType === 'manager_exemption'), [rules])
  const scopedRecords = useScopedProcessedRecords(range.from, range.to, dataVersion)
  const detailRows = useMemo(() => {
    if (!compositeId || !scopedRecords) return []
    return scopedRecords
      .filter(r => r.employeeId === compositeId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(r => {
        const leader = leaderRule
          ? isLeaderOnDate({ isLeader: true, leaderFrom: leaderRule.validFrom || undefined, leaderTo: leaderRule.validTo || undefined }, undefined, r.date)
          : false
        const rh = computeRealHoursOtForRecord(r, leader)
        const isSlackInj = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
        let statusBadge = '정상'
        if (r.dayType !== 'WEEKDAY' && r.finalStatus === '휴일근무') statusBadge = '휴일근로 승인'
        else if (isSlackInj) statusBadge = '미태깅 대체'
        else if (leader) statusBadge = '직책자 0 고정'
        else if (r.finalStatus !== '정상' && r.finalStatus !== '연장근로') statusBadge = r.finalStatus
        return { r, rh, statusBadge }
      })
  }, [compositeId, scopedRecords, rules])

  if (loading) {
    return <div className="wrap"><div className="col wide" style={{ maxWidth: 'none' }}>
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--ink-4)' }}>불러오는 중...</div>
    </div></div>
  }
  if (!emp) {
    return <div className="wrap"><div className="col wide" style={{ maxWidth: 'none' }}>
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--neg)' }}>직원을 찾을 수 없습니다.</div>
    </div></div>
  }

  return (
    <div className="wrap">
      <div style={{ display: 'flex', gap: 20, width: '100%', alignItems: 'flex-start' }}>
        {/* ── 좌측 레일 ── */}
        <aside className="card" style={{ width: 250, flexShrink: 0, padding: '24px 20px' }}>
          <Link href="/admin/employees" className="lnk" style={{ fontSize: 13, color: 'var(--ink-3)' }}>← 직원 목록</Link>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%', background: 'var(--dark)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700,
            }}>
              {emp.name.slice(0, 1)}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{emp.name}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              {emp.department ? `${emp.department.division}${emp.department.team ? ' · ' + emp.department.team : ''}` : '—'}
            </div>
          </div>
          <nav style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {([['history', '인사 이력'], ['detail', '근태 상세']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: 0,
                  fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  background: tab === key ? 'var(--dark)' : 'transparent',
                  color: tab === key ? '#fff' : 'var(--ink-2)',
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>

        {/* ── 본문 ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="ptitle"><h2>{emp.name} · 인사카드</h2></div>

          {tab === 'history' && (
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>인사 이력</h3>
              {timeline.length === 0 ? (
                <p style={{ color: 'var(--ink-4)', fontSize: 13 }}>기록된 이력이 없습니다.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {timeline.map((t, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12 }}>
                      <div style={{ width: 96, flexShrink: 0, fontSize: 13, fontWeight: 700, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' }}>
                        {t.date}
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{t.title}</div>
                        {t.effect && <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--ink-2)', marginTop: 2 }}>{t.effect}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <h3 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 12px' }}>비어 있는 항목</h3>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {completeness?.fields.map(f => (
                  <div key={f.label} className="fr" style={{ padding: '10px 0' }}>
                    <div className="lead">
                      <div className="nm">{f.label}</div>
                      {f.detail && <div className="ds">{f.detail}</div>}
                    </div>
                    <span
                      className="bg"
                      style={{
                        background: f.status === '입력됨' ? 'var(--pos-bg)' : f.status === '미확인' ? 'var(--cau-bg)' : 'var(--line-2)',
                        color: f.status === '입력됨' ? 'var(--pos)' : f.status === '미확인' ? 'var(--cau)' : 'var(--ink-4)',
                      }}
                    >
                      {f.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'detail' && (
            <div className="card">
              <div className="tbar">
                <DateRangePicker value={range} onChange={setRange} />
                <span className="ct">{detailRows.length}일</span>
              </div>
              <div className="tscroll">
                <table>
                  <thead>
                    <tr>
                      <th>날짜</th><th>출근</th><th>퇴근</th>
                      <th>소정외(원본)</th><th>소정외(급여용)</th>
                      <th>법정연장(원본)</th><th>법정연장(급여용)</th>
                      <th>근태상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailRows.map(({ r, rh, statusBadge }) => (
                      <tr key={r.date}>
                        <td className="mute">{r.date}</td>
                        <td>{r.clockIn ?? '—'}</td>
                        <td>{r.clockOut ?? '—'}</td>
                        <td>{(rh.otherMins / 60).toFixed(1)}h</td>
                        <td className="strong">{rh.payOtherH.toFixed(1)}h</td>
                        <td>{(rh.otMins / 60).toFixed(1)}h</td>
                        <td className="strong">{rh.payOtH.toFixed(1)}h</td>
                        <td><span className="bg bg-gray">{statusBadge}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
