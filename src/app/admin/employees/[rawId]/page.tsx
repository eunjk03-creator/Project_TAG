'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useScopedProcessedRecords } from '@/hooks/useProcessedAttendance'
import { computeRealHoursOtForRecord, isLeaderOnDate, flagToAnomalyCategories, parseTimeToMins } from '@/utils/attendanceCalc'
import { checkEmployeeCompleteness, type EmployeeMasterLike } from '@/lib/employeeCompleteness'
import { classifyOrgGroupHistory, type OrgGroupHistoryRow } from '@/lib/orgGroup/history'
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

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']
function dowKr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return DOW_KR[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}
function fmtH(mins: number): string {
  const abs = Math.abs(Math.round(mins))
  return `${mins < 0 ? '-' : ''}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`
}
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type TabKey = 'sum' | 'history' | 'detail' | 'anomalies' | 'requests' | 'pay' | 'docs' | 'rules' | 'schedule'
const NAV: { key: TabKey; label: string; group?: string }[] = [
  { key: 'sum',       label: '근태 요약' },
  { key: 'history',   label: '인사 이력' },
  { key: 'detail',    label: '근태 상세' },
  { key: 'anomalies', label: '이상치' },
  { key: 'requests',  label: '신청 이력' },
  { key: 'pay',       label: '급여용 값', group: '연동' },
  { key: 'docs',      label: '서류 · 증명' },
  { key: 'rules',     label: '개인 예외 규칙', group: '설정' },
  { key: 'schedule',  label: '근무제 배정' },
]
// 실제 데이터로 채운 탭 — 나머지는 목업(README "미확정 사항")과 동일하게 안내 카드만 노출.
const REAL_TABS = new Set<TabKey>(['sum', 'history', 'detail', 'rules'])
const PILL_TABS: { key: TabKey; label: string }[] = [
  { key: 'history', label: '인사 이력' },
  { key: 'detail',  label: '근태 상세' },
  { key: 'sum',     label: '근태 요약 결과표' },
]

export default function EmployeeCardPage() {
  const params = useParams<{ rawId: string }>()
  const rawId = decodeURIComponent(params.rawId)
  const { exceptionRules } = useEmployeeExceptions()
  const { dataVersion, employees } = useAttendanceSource()

  const [emp, setEmp] = useState<EmployeeMasterRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [orgHistory, setOrgHistory] = useState<OrgGroupHistoryRow[]>([])
  const [tab, setTab] = useState<TabKey>('sum')
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

  // 조직도 이력(OrgGroupMember) — 2026-09-09부터 조직도 관리 화면에서 만든 배치/이동/직책변경이
  // 여기 인사 이력에도 같이 보이도록 연동. 아직 OT 계산 소스는 아님(그건 Plan 2) — 표시 전용.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/org-group-members?employeeRawId=${encodeURIComponent(rawId)}`)
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        if (cancelled) return
        setOrgHistory(rows.map((r: { group: { name: string }; groupId: string; jobTitle: string; validFrom: string; validTo: string | null }) => ({
          groupId: r.groupId, groupName: r.group.name, jobTitle: r.jobTitle,
          validFrom: r.validFrom, validTo: r.validTo,
        })))
      })
      .catch(() => { if (!cancelled) setOrgHistory([]) })
    return () => { cancelled = true }
  }, [rawId])

  // ── compositeId — 캐노니컬 Employee.id 우선(2026-09-08 수정) ────────────────────────
  // 예전엔 `${emp.rawId}_${emp.name}`(EmployeeMaster.name 기준)를 직접 조합했는데, 앱의
  // 나머지 화면은 전부 AttendanceSourceContext.employees(CAPS 기반, 이미 이름표기 정규화된
  // 캐노니컬 Employee.id)를 쓴다. 두 이름 표기가 갈리면(조직도 시트 vs CAPS) 이 페이지만
  // 근태상세·인사이력·예외규칙이 조용히 비어보일 수 있어 캐노니컬 소스를 우선한다.
  const liveEmp = useMemo(() => employees.find(e => e.rawId === rawId), [employees, rawId])
  const compositeId = liveEmp?.id ?? (emp ? `${emp.rawId}_${emp.name}` : null)

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
    for (const h of classifyOrgGroupHistory(orgHistory)) {
      items.push({ date: h.date, title: `[조직도] ${h.title}`, effect: h.detail })
    }
    return items.sort((a, b) => b.date.localeCompare(a.date))
  }, [emp, rules, orgHistory])

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
        return { r, rh, leader, statusBadge }
      })
  }, [compositeId, scopedRecords, leaderRule])

  // ── 근태 요약 탭 전용 집계 — 전부 detailRows/rh에서 파생, 새 알고리즘·점수 없음 ──────────
  const anomalyTally = useMemo(() => {
    const t = { late: 0, shortage: 0, notag: 0, holidayWork: 0 }
    for (const { r } of detailRows) {
      for (const c of flagToAnomalyCategories(r.flag)) t[c]++
      if (r.dayType !== 'WEEKDAY' && r.finalStatus === '휴일근무') t.holidayWork++
    }
    const total = detailRows.filter(({ r }) => flagToAnomalyCategories(r.flag).length > 0).length
    return { ...t, total }
  }, [detailRows])

  const missingTagRows = useMemo(
    () => detailRows.filter(({ statusBadge }) => statusBadge === '미태깅 대체'),
    [detailRows],
  )

  const leaderDiff = useMemo(() => {
    if (!leaderRule) return null
    let realMins = 0
    for (const { rh, leader } of detailRows) if (leader) realMins += rh.otherMins + rh.otMins
    return realMins > 0 ? { realMins } : null
  }, [leaderRule, detailRows])

  const avgClockIn = useMemo(() => {
    const mins = detailRows
      .map(({ r }) => r.clockIn)
      .filter((t): t is string => !!t && /^\d{1,2}:\d{2}$/.test(t))
      .map(parseTimeToMins)
    if (mins.length === 0) return null
    const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)
    return `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`
  }, [detailRows])

  const otSummary = useMemo(() => {
    let approvedDays = 0, unapprovedMins = 0
    for (const { r, rh } of detailRows) {
      const otTotal = rh.otherMins + rh.otMins
      if (otTotal <= 0) continue
      if (r.erpOtApplied) approvedDays++
      else unapprovedMins += otTotal
    }
    return { approvedDays, unapprovedMins }
  }, [detailRows])

  const isCurrentLeader = leaderRule
    ? isLeaderOnDate({ isLeader: true, leaderFrom: leaderRule.validFrom || undefined, leaderTo: leaderRule.validTo || undefined }, undefined, todayStr())
    : false

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-4)' }}>불러오는 중...</div>
  }
  if (!emp) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--neg)' }}>직원을 찾을 수 없습니다.</div>
  }

  const scheduleLabel = leaderRule ? '직책자 근무제'
    : rules.find(r => r.ruleType === 'fixed_schedule_a') ? '고정스케줄 A'
    : rules.find(r => r.ruleType === 'fixed_schedule_b') ? '고정스케줄 B'
    : '표준 근무제'
  const statusLabel = emp.status === 'ACTIVE' ? '재직 중' : emp.status === 'ON_LEAVE' ? '휴직 중' : '퇴사'

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {/* ── 좌측 레일 ── */}
      <aside className="ecrail">
        <div className="eccrumb"><Link href="/admin/employees">직원 목록</Link> <span>»</span></div>
        <div className="ecidblk">
          <div className="no">{emp.rawId}</div>
          <div className="hr" />
          <div className="ecava">
            {emp.name.slice(0, 2)}
            {isCurrentLeader && <span className="flag" title="직책자" />}
          </div>
          <div className="nm">{emp.name}</div>
          <div className="sub">{emp.department ? `${emp.department.division}${emp.department.team ? ' · ' + emp.department.team : ''}` : '—'}{emp.jobTitle ? ` · ${emp.jobTitle}` : ''}</div>
        </div>
        <nav className="ecnav">
          {NAV.map((n, i) => {
            const prevGroup = i > 0 ? NAV[i - 1].group : undefined
            const cv = n.key === 'history' ? timeline.length
              : n.key === 'detail' ? detailRows.length
              : n.key === 'rules' ? rules.length
              : null
            return (
              <div key={n.key}>
                {n.group && n.group !== prevGroup && <div className="gp">{n.group}</div>}
                <button className={tab === n.key ? 'on' : ''} onClick={() => setTab(n.key)}>
                  <span className="ic" />{n.label}
                  {cv !== null && <span className="cv">{cv}</span>}
                </button>
              </div>
            )
          })}
        </nav>
        <div className="ecfoot"><button className="chip" style={{ width: '100%', justifyContent: 'center' }} onClick={() => window.print()}>인사카드 인쇄</button></div>
      </aside>

      {/* ── 본문 ── */}
      <main className="ecmid" style={{ padding: '22px 30px 40px' }}>
        <div className="ecmhead">
          <h1>[{emp.department?.division ?? '—'}] {emp.name} · {range.to.slice(0, 7)} 근태 인사카드</h1>
          <span className="tag c">{scheduleLabel}</span>
          {otSummary.unapprovedMins > 0 && <span className="tag b">연장 승인 필요</span>}
          {anomalyTally.total > 0 && <span className="tag a">이상치 {anomalyTally.total}건</span>}
        </div>
        <div className="ecmhead"><div className="hr" /></div>

        <div className="ecpills">
          {PILL_TABS.map(p => (
            <button key={p.key} className={`ecpill${tab === p.key ? ' on' : ''}`} onClick={() => setTab(p.key)}>{p.label}</button>
          ))}
        </div>

        <div className="card ecidrow">
          <span className="av">{emp.name.slice(0, 2)}</span>
          <span className="who"><b>{emp.name}</b><span>{emp.rawId}{emp.hireDate ? ` · ${emp.hireDate} 입사` : ''}</span></span>
          <span className="ecfgrid">
            <span className="f"><span className="k">소속 / 직책</span><span className="v">{emp.department?.division ?? '—'}{emp.jobTitle ? ` · ${emp.jobTitle}` : ''}</span></span>
            <span className="f"><span className="k">근무제</span><span className="v">{scheduleLabel}</span></span>
            <span className="f"><span className="k">재직 상태</span><span className="v">{statusLabel}</span></span>
            <span className="f"><span className="k">조회 기간</span><span className="v">{range.from} ~ {range.to}</span></span>
          </span>
        </div>

        {tab === 'sum' && (
          <>
            <div className="card">
              <div className="sh"><span className="ic">◉</span><h2>근태 요약 결과표</h2></div>
            </div>

            <div className="slabel"><h3>종합 결과</h3><span className="x">점수·순위 없이 이 기간의 실측치만 보여줍니다.</span></div>
            <div className="card grade">
              <div className="gleft">
                <span className="t">이번 기간 이상치</span>
                <span className="g">{anomalyTally.total}건</span>
                <span className="s">지각 {anomalyTally.late} · 미달 {anomalyTally.shortage} · 미태깅 {anomalyTally.notag} · 휴일근로 {anomalyTally.holidayWork}</span>
                <span className="ecspark">
                  {detailRows.slice().reverse().map(({ r }) => (
                    <i key={r.date} className={flagToAnomalyCategories(r.flag).length > 0 ? 'hit' : ''} title={r.date} />
                  ))}
                </span>
                <span className="axis"><span>{range.from.slice(5)}</span><span>{range.to.slice(5)}</span></span>
              </div>
              <div className="gright">
                <span className="fact">
                  {anomalyTally.total === 0
                    ? '이 기간 이상치가 없습니다.'
                    : `지각 ${anomalyTally.late}건 · 근무시간미달 ${anomalyTally.shortage}건 · 미태깅 ${anomalyTally.notag}건 · 휴일근로 승인 ${anomalyTally.holidayWork}건`}
                </span>
                <ul>
                  {avgClockIn && <li>평균 출근 {avgClockIn} ({detailRows.length}일 기준)</li>}
                  {missingTagRows.length > 0 && (
                    <li>미태깅 {missingTagRows.length}건 — {missingTagRows.map(({ r }) => r.date.slice(5)).join(' · ')} 모두 한쪽 기록만 존재</li>
                  )}
                  <li>실근무 합계 {fmtH(detailRows.reduce((s, { rh }) => s + rh.realWorkMins, 0))} · 급여용 소정외 합계 {fmtH(detailRows.reduce((s, { rh }) => s + rh.payOtherH * 60, 0))} · 급여용 법정연장 합계 {fmtH(detailRows.reduce((s, { rh }) => s + rh.payOtH * 60, 0))}</li>
                  <li>ERP 연장 승인 {otSummary.approvedDays}일{otSummary.unapprovedMins > 0 ? ` · 미신청 ${fmtH(otSummary.unapprovedMins)}` : ''}</li>
                  {leaderRule && <li>직책 변경({leaderRule.validFrom || '미상'}) 이후 급여용 소정외·법정연장·야간이 0으로 고정됩니다.</li>}
                </ul>
              </div>
            </div>

            {(leaderDiff || missingTagRows.length > 0) && (
              <>
                <div className="slabel"><h3>급여 반영 전 확인</h3><span className="x">인사 정보가 근태 규칙을 바꾸는 항목입니다.</span></div>
                <div className="two">
                  {leaderDiff && (
                    <div className="card chkcard">
                      <div className="top"><span className="dot warn">!</span>직책자 규칙과 실계산 값의 차이</div>
                      <p>실근무 기준 소정외·법정연장 합계 <b>{fmtH(leaderDiff.realMins)}</b>이 계산됐지만 직책자 근무제가 급여용 3종을 0으로 고정합니다. 원본 값은 남아 있으니 수당 지급 대상이 아님을 급여팀과 맞춰야 합니다.</p>
                      <div className="alertbox">
                        <b>직책 변경 시점 {leaderRule?.validFrom || '미상'}</b>
                        <span>이 날부터 직책자 근무제로 전환됐습니다. 발령 전 구간은 표준 근무제 기준으로 계산돼 있습니다.</span>
                      </div>
                    </div>
                  )}
                  {missingTagRows.length > 0 && (
                    <div className="card chkcard">
                      <div className="top"><span className="dot warn">!</span>미태깅 {missingTagRows.length}건의 처리 근거</div>
                      <p>{missingTagRows.map(({ r }) => r.date.slice(5)).join(' · ')} 모두 출·퇴근 한쪽만 기록됐습니다. 실근무를 산정할 수 없어 소정근로로 대체 인정 처리됐습니다.</p>
                      <div className="chips" style={{ marginTop: 14 }}>
                        <Link className="chip" href="/admin/anomalies">이상치 처리하기</Link>
                        <Link className="chip" href="/admin/settings">계산 근거 규칙 보기</Link>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="slabel"><h3>유형별 이상치</h3><span className="x">건별 처리는 이상치 검토 화면에서 이어서 할 수 있습니다.</span></div>
            <div className="card">
              <div className="rowitem"><span className="ic ic-c">!</span><span className="tx"><b>미태깅</b><span>{missingTagRows.map(({ r }) => r.date.slice(5)).join(' · ') || '없음'}</span></span><span className="bg bg-cau">{anomalyTally.notag > 0 ? '대체 처리' : '해당 없음'}</span><span className="n">{anomalyTally.notag}건</span></div>
              <div className="rowitem"><span className="ic ic-b">↗</span><span className="tx"><b>연장 미신청</b><span>실계산 {fmtH(otSummary.unapprovedMins)} · ERP 승인 없음</span></span><span className="bg bg-info">{otSummary.unapprovedMins > 0 ? '확인 필요' : '해당 없음'}</span><span className="n">{detailRows.filter(({ r, rh }) => !r.erpOtApplied && rh.otherMins + rh.otMins > 0).length}건</span></div>
              <div className="rowitem"><span className="ic ic-a">✓</span><span className="tx"><b>지각 · 근무시간미달</b><span>지각 {anomalyTally.late}건 · 미달 {anomalyTally.shortage}건</span></span><span className="bg bg-pos">{anomalyTally.late + anomalyTally.shortage > 0 ? '확인 필요' : '해당 없음'}</span><span className="n">{anomalyTally.late + anomalyTally.shortage}건</span></div>
              <div className="rowitem"><span className="ic ic-d">≡</span><span className="tx"><b>휴일근로</b><span>승인된 휴일 근무</span></span><span className="bg bg-vio">{anomalyTally.holidayWork > 0 ? '승인 완료' : '해당 없음'}</span><span className="n">{anomalyTally.holidayWork}건</span></div>
            </div>
          </>
        )}

        {tab === 'history' && (
          <>
            <div className="card">
              <div className="sh"><span className="ic">◉</span><h2>인사 이력</h2></div>
            </div>
            <div className="slabel"><h3>근태 규칙에 영향을 주는 이력</h3><span className="x">입·퇴사, 직책 변경, 휴직은 적용 근무제와 급여용 계산을 바꿉니다.</span></div>
            <div className="card tl">
              {timeline.length === 0 ? (
                <p style={{ padding: '20px 0', color: 'var(--ink-4)', fontSize: 13 }}>기록된 이력이 없습니다.</p>
              ) : timeline.map((t, i) => (
                <div key={i} className={`tlrow${i === 0 ? ' hot' : ''}`}>
                  <span className="d">{t.date}</span>
                  <span className="stem" />
                  <span className="bd">
                    <span className="r1"><b>{t.title}</b>{i === 0 && <span className="bg bg-info">최신</span>}</span>
                    {t.effect && <p>{t.effect}</p>}
                  </span>
                </div>
              ))}
            </div>
            <div className="slabel"><h3>비어 있는 항목</h3><span className="x">아래 값이 없으면 근태 규칙을 정확히 적용할 수 없습니다.</span></div>
            <div className="card">
              {completeness?.fields.map(f => (
                <div key={f.label} className="rowitem">
                  <span className={`ic ${f.status === '입력됨' ? 'ic-a' : f.status === '미확인' ? 'ic-c' : 'ic-b'}`}>{f.status === '입력됨' ? '✓' : f.status === '미확인' ? '!' : '·'}</span>
                  <span className="tx"><b>{f.label}</b>{f.detail && <span>{f.detail}</span>}</span>
                  <span className={`bg ${f.status === '입력됨' ? 'bg-pos' : f.status === '미확인' ? 'bg-cau' : 'bg-gray'}`}>{f.status}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'detail' && (
          <>
            <div className="card">
              <div className="sh"><span className="ic">◉</span><h2>근태 상세 · {range.from} ~ {range.to}</h2></div>
            </div>
            <div className="slabel"><h3>일자별 계산 결과</h3><span className="x">원본은 정책만 적용한 값, 급여용은 ERP 승인·직책자 규칙 통과 후 값입니다.</span></div>
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="tbar"><DateRangePicker value={range} onChange={setRange} /><span className="ct">{detailRows.length}일</span></div>
              <div className="tscroll">
                <table>
                  <thead>
                    <tr>
                      <th>날짜</th><th>요일</th><th>출근</th><th>퇴근</th><th>순체류</th><th>실근무</th>
                      <th>소정외(원본)</th><th>소정외(급여용)</th><th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailRows.map(({ r, rh, statusBadge }) => (
                      <tr key={r.date}>
                        <td className="mute">{r.date}</td>
                        <td className="mute">{dowKr(r.date)}</td>
                        <td>{r.clockIn ?? '—'}</td>
                        <td>{r.clockOut ?? '—'}</td>
                        <td>{r.clockIn && r.clockOut ? fmtH(rh.stayMins) : '—'}</td>
                        <td className="strong">{fmtH(rh.realWorkMins)}</td>
                        <td>{fmtH(rh.otherMins + rh.otMins)}</td>
                        <td className="strong">{fmtH((rh.payOtherH + rh.payOtH) * 60)}</td>
                        <td><span className="bg bg-gray">{statusBadge}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {tab === 'rules' && (
          <>
            <div className="card">
              <div className="sh"><span className="ic">◉</span><h2>개인 예외 규칙</h2></div>
            </div>
            <div className="slabel"><h3>이 직원에게 적용 중인 규칙</h3><span className="x">근무제 관리·설정 화면에서 등록한 예외 규칙입니다.</span></div>
            <div className="card">
              {rules.length === 0 ? (
                <p style={{ padding: '20px', color: 'var(--ink-4)', fontSize: 13 }}>등록된 개인 예외 규칙이 없습니다(표준 근무제 적용).</p>
              ) : rules.map(r => (
                <div key={r.id} className="rowitem">
                  <span className="ic ic-d">◆</span>
                  <span className="tx"><b>{RULE_EFFECT[r.ruleType]?.split(' — ')[0] ?? r.ruleType}</b><span>{r.validFrom || '시작일 미상'} ~ {r.validTo || '무기한'}</span></span>
                  <span className="bg bg-vio">{r.workScheduleId ? '근무제 배정' : '개별 규칙'}</span>
                </div>
              ))}
            </div>
            {rules.length > 0 && (
              <div className="card" style={{ padding: 18 }}>
                {rules.map(r => (
                  <p key={r.id} style={{ fontSize: 13, lineHeight: '20px', color: 'var(--ink-2)', marginBottom: 6 }}>
                    <b>{r.ruleType}</b> — {RULE_EFFECT[r.ruleType] ?? '설명 없음'}
                  </p>
                ))}
              </div>
            )}
          </>
        )}

        {!REAL_TABS.has(tab) && (
          <div className="card" style={{ padding: 56, textAlign: 'center', color: 'var(--ink-3)', fontSize: 14, lineHeight: '22px' }}>
            이 탭은 다음 라운드에 채웁니다.<br />지금은 근태 요약 · 인사 이력 · 근태 상세 · 개인 예외 규칙만 실제 데이터로 구성했습니다.
          </div>
        )}
      </main>
    </div>
  )
}
