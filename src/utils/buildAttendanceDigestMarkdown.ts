/**
 * 경영진 현황 상단 KPI/카드가 이미 계산해둔 값들을 그대로 받아 Slack mrkdwn 텍스트로
 * 포맷팅만 한다 — 새 집계 로직 없음(중복 계산 금지, page.tsx의 kpiTiles/카드 로직과
 * 반드시 같은 숫자를 보여줘야 하므로 여기서 다시 계산하면 어긋날 위험이 있다).
 *
 * scopeDivision이 null이면 전사 요약(부문 간 비교 위주, 개인 목록은 캡을 둬서 짧게),
 * 특정 부문 문자열이면 그 부문 대표에게 공유할 상세(개인별 breakdown을 캡 없이 전부) —
 * 두 모드 다 같은 입력 타입을 쓰고 있으면 해당 필드만 채운다.
 */

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

function dowLabel(dateStr: string): string {
  return DOW_KR[new Date(dateStr + 'T12:00').getDay()]
}

function pctStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%p`
}

export interface AnomalyPersonDetail {
  label:    string
  late:     number
  shortage: number
  notag:    number
  total:    number
}

/** "이름(지각1·미달1) · 이름(미태깅2)" — 부문 대표 공유용 개인별 상세, 0건 항목은 생략. */
function formatAnomalyPeople(rows: AnomalyPersonDetail[]): string {
  return rows.map(r => {
    const parts: string[] = []
    if (r.late)     parts.push(`지각${r.late}`)
    if (r.shortage) parts.push(`미달${r.shortage}`)
    if (r.notag)    parts.push(`미태깅${r.notag}`)
    return `${r.label}(${parts.join('·')})`
  }).join(' · ')
}

// ── 일간 ──────────────────────────────────────────────────────────────────

export interface DailyDigestInput {
  scopeDivision: string | null
  date: string          // YYYY-MM-DD
  attendancePct: number
  vsTargetPct: number
  vsPrevPct: number | null
  normalCount: number
  anomalyTotal: number
  anomalyLate: number
  anomalyShortage: number
  anomalyNotag: number
  leaveCount: number
  offsiteCount: number
  /** scopeDivision === null일 때만 사용 — 부문 비교 TOP3 */
  topDivisions: { label: string; value: number; unit: string }[]
  /** scopeDivision이 있을 때만 사용 — 그 부문의 이상치 있는 개인 전원(캡 없음) */
  anomalyPeople: AnomalyPersonDetail[]
  repeatOffenders: { name: string; division: string; count: number }[]
}

export function buildDailyDigestMarkdown(d: DailyDigestInput): string {
  const title = d.scopeDivision
    ? `*📊 일일 근태 요약 — ${d.scopeDivision} (${d.date} ${dowLabel(d.date)})*`
    : `*📊 일일 근태 요약 (${d.date} ${dowLabel(d.date)})*`

  const lines = [title, '']
  const vsPrev = d.vsPrevPct !== null ? `, 전일 대비 ${pctStr(d.vsPrevPct)}` : ''
  lines.push(`• 출근율 ${d.attendancePct.toFixed(1)}% (기준 대비 ${pctStr(d.vsTargetPct)}${vsPrev}) · 정상출근 ${d.normalCount}명`)
  lines.push(`• 당일 이상치 ${d.anomalyTotal}건 — 지각 ${d.anomalyLate} · 근무미달 ${d.anomalyShortage} · 미태깅 ${d.anomalyNotag}`)
  lines.push(`• 당일 휴가·외근 현황 ${d.leaveCount + d.offsiteCount}명 (휴가 ${d.leaveCount} · 외근 ${d.offsiteCount})`)

  if (d.scopeDivision === null) {
    if (d.topDivisions.length > 0) {
      lines.push(`• 확인 필요 TOP${d.topDivisions.length}: ${d.topDivisions.map(t => `${t.label} ${t.value}${t.unit}`).join(' · ')}`)
    }
  } else if (d.anomalyPeople.length > 0) {
    lines.push(`• 이상치 상세 (${d.anomalyPeople.length}명): ${formatAnomalyPeople(d.anomalyPeople)}`)
  }

  if (d.repeatOffenders.length > 0) {
    const names = d.repeatOffenders.map(r => d.scopeDivision ? `${r.name}(${r.count}회)` : `${r.name}(${r.division},${r.count}회)`).join(' · ')
    lines.push(`• 이번 주 반복(2회+): ${names} 등 ${d.repeatOffenders.length}명`)
  }

  return lines.join('\n')
}

// ── 주간 ──────────────────────────────────────────────────────────────────

export interface WeeklyDigestInput {
  scopeDivision: string | null
  periodLabel: string   // "2026-08-31 ~ 09-06"
  dangerCount: number
  cautionCount: number
  warningCount: number
  vsPrevDanger: number | null
  avgOtPerPerson: string   // 이미 포맷된 "1h 8m"
  totalOt: string
  otEligible: number
  estimatedOtCost: string | null   // null이면 "준비중"(시급 미설정)
  holidayCount: number
  holidayHours: string
  /** scopeDivision === null일 때만 — 휴일근로 발생 부문별 인원수 */
  holidayByDivision: { label: string; count: number }[]
  /** scopeDivision === null일 때만 — 위험군 TOP3 부문 */
  topDivisions: { label: string; value: number; unit: string }[]
  /** scopeDivision이 있을 때만 — 45h 이상(주의 이상) 명단, 시간 내림차순(캡 없음) */
  riskPeople: { name: string; hours: number; bucket: 'caution' | 'warning' | 'danger' }[]
  /** scopeDivision이 있을 때만 — 연장근로 발생 인원 명단, 시간 내림차순(캡 없음) */
  otPeople: { name: string; hours: number }[]
  /** scopeDivision이 있을 때만 — 휴일근로 인원 명단(캡 없음) */
  holidayPeople: { name: string; hours: number }[]
  /** scopeDivision이 있을 때만 — 그 부문의 이상치 있는 개인 전원(캡 없음) */
  anomalyPeople: AnomalyPersonDetail[]
  /** scopeDivision === null일 때만 — 이번 주(월 아님) 2건 이상 반복자. scopeDivision이
   *  있을 때는 anomalyPeople이 이미 이번 주 전원을 보여주므로 중복이라 안 쓴다. */
  weeklyRepeatOffenders: { name: string; division: string; count: number }[]
}

const BUCKET_LABEL: Record<'caution' | 'warning' | 'danger', string> = { caution: '주의', warning: '경고', danger: '위험' }

export function buildWeeklyDigestMarkdown(d: WeeklyDigestInput): string {
  const title = d.scopeDivision
    ? `*📊 주간 근태 요약 — ${d.scopeDivision} (${d.periodLabel})*`
    : `*📊 주간 근태 요약 (${d.periodLabel})*`

  const lines = [title, '']
  const vsPrev = d.vsPrevDanger !== null ? ` (전주 대비 ${d.vsPrevDanger >= 0 ? '+' : ''}${d.vsPrevDanger}명)` : ''
  lines.push(`• 주 52시간 초과 위험군 ${d.dangerCount}명${vsPrev} — 경고 50–52h ${d.warningCount}명 · 주의 45–50h ${d.cautionCount}명`)
  if (d.scopeDivision !== null && d.riskPeople.length > 0) {
    lines.push(`  └ ${d.riskPeople.map(r => `${r.name} ${r.hours.toFixed(1)}h(${BUCKET_LABEL[r.bucket]})`).join(' · ')}`)
  }
  lines.push(`• 주당 평균 연장근로 ${d.avgOtPerPerson} · 총 연장 ${d.totalOt} · 대상 ${d.otEligible}명 · 예상 수당 ${d.estimatedOtCost ?? '준비중(시급 미설정)'}`)
  if (d.scopeDivision !== null && d.otPeople.length > 0) {
    lines.push(`  └ ${d.otPeople.map(p => `${p.name} ${p.hours.toFixed(1)}h`).join(' · ')}`)
  }

  if (d.scopeDivision === null) {
    lines.push(`• 휴일근로 ${d.holidayCount}건 (총 ${d.holidayHours}${d.holidayByDivision.length > 0 ? `, ${d.holidayByDivision.slice(0, 3).map(h => `${h.label} ${h.count}명`).join(' · ')}` : ''})`)
    if (d.topDivisions.length > 0) {
      lines.push(`• 확인 필요 TOP${d.topDivisions.length}: ${d.topDivisions.map(t => `${t.label} ${t.value}${t.unit}`).join(' · ')}`)
    }
  } else {
    lines.push(`• 휴일근로 ${d.holidayCount}건 (총 ${d.holidayHours})`)
    if (d.holidayPeople.length > 0) {
      lines.push(`  └ ${d.holidayPeople.map(p => `${p.name} ${p.hours.toFixed(1)}h`).join(' · ')}`)
    }
    if (d.anomalyPeople.length > 0) {
      lines.push(`• 이번 주 이상치 상세 (${d.anomalyPeople.length}명): ${formatAnomalyPeople(d.anomalyPeople)}`)
    }
  }

  if (d.scopeDivision === null && d.weeklyRepeatOffenders.length > 0) {
    const names = d.weeklyRepeatOffenders.map(r => `${r.name}(${r.division},${r.count}건)`).join(' · ')
    lines.push(`• 이번 주 이상치 2건 이상: ${names} 등 ${d.weeklyRepeatOffenders.length}명`)
  }

  return lines.join('\n')
}

// ── 월간 ──────────────────────────────────────────────────────────────────

export interface MonthlyDigestInput {
  scopeDivision: string | null
  monthLabel: string   // "2026년 8월"
  cumulativePct: number
  vsBenchmarkPct: number
  /** scopeDivision === null일 때만 — 목표 미달 부문 목록 */
  belowTargetDivisions: { label: string; pct: number }[]
  belowTargetCount: number
  totalDivisionsCount: number
  over209Count: number
  /** 전사 모드에선 TOP3만, 부문 모드에선 캡 없이 그 부문 전원 */
  over209People: { name: string; division: string }[]
  /** scopeDivision === null일 때만 — 이상치 최다 부문 */
  topAnomalyDivisions: { label: string; total: number }[]
  /** scopeDivision이 있을 때만 — 그 부문의 이상치 있는 개인 전원(캡 없음) */
  anomalyPeople: AnomalyPersonDetail[]
  anomalyTotal: number
}

export function buildMonthlyDigestMarkdown(d: MonthlyDigestInput): string {
  const title = d.scopeDivision
    ? `*📊 월간 근태 요약 — ${d.scopeDivision} (${d.monthLabel})*`
    : `*📊 월간 근태 요약 (${d.monthLabel})*`

  const lines = [title, '']
  const rateLabel = d.scopeDivision ? '연차 사용률(누적)' : '전사 연차 사용률(누적)'
  lines.push(`• ${rateLabel} ${d.cumulativePct.toFixed(1)}% — 목표 대비 ${pctStr(d.vsBenchmarkPct)}`)

  if (d.scopeDivision === null) {
    lines.push(`• 목표 미달 부문 ${d.belowTargetCount}/${d.totalDivisionsCount}개${d.belowTargetDivisions.length > 0 ? ` — ${d.belowTargetDivisions.slice(0, 3).map(b => `${b.label} ${b.pct.toFixed(1)}%`).join(' · ')}` : ''}`)
  }

  lines.push(`• 연말 예상 연차수당: 준비중(급여 시급 데이터 연동 필요)`)

  const over209Rows = d.scopeDivision ? d.over209People : d.over209People.slice(0, 3)
  const over209Label = over209Rows.map(p => d.scopeDivision ? p.name : `${p.division} ${p.name}`).join(' · ')
  const over209Suffix = !d.scopeDivision && d.over209People.length > 3 ? ' 등' : ''
  lines.push(`• 월간 209시간 초과 인원 ${d.over209Count}명${over209Label ? ` (${over209Label}${over209Suffix})` : ''}`)

  if (d.scopeDivision === null && d.topAnomalyDivisions.length > 0) {
    lines.push(`• 이번 달 이상치 최다 부문: ${d.topAnomalyDivisions.slice(0, 3).map(a => `${a.label} ${a.total}건`).join(' · ')}`)
  } else if (d.scopeDivision) {
    const detail = d.anomalyPeople.length > 0 ? ` — ${formatAnomalyPeople(d.anomalyPeople)}` : ''
    lines.push(`• 이번 달 이상치 ${d.anomalyTotal}건${detail}`)
  }

  return lines.join('\n')
}
