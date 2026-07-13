// 직원 ↔ Slack 개인계정(user ID) 자동 매칭.
// 이름이 유니크하게 하나의 Slack 계정과만 일치하는 경우에만 자동 확정하고,
// (a) 같은 이름의 직원이 우리 쪽에 2명 이상이거나 (b) Slack 쪽에 같은 이름 계정이 2개 이상이면
// 잘못 배정될 위험이 있으므로 전부 "ambiguous"로 내려서 수동 확인을 받는다.

export interface SlackUserLite {
  id:          string
  name:        string
  realName:    string
  displayName: string
  email:       string
}

export interface MatchCandidate { slackUserId: string; slackName: string }

export interface MatchResult {
  matched:   { employeeId: string; employeeName: string; slackUserId: string; slackName: string }[]
  ambiguous: { employeeId: string; employeeName: string; candidates: MatchCandidate[] }[]
  unmatched: { employeeId: string; employeeName: string }[]
}

function normName(s: string): string {
  // NFC 정규화 필수 — Slack 프로필과 CAPS/ERP 원본이 다른 유니코드 정규화 형태(NFC/NFD)로
  // 저장돼 있으면 눈으로는 같은 글자인데 문자열 비교에서 실패해서 미매칭으로 빠짐.
  return s.normalize('NFC').trim().replace(/\s+/g, '')
}

export function matchEmployeesToSlackUsers(
  employees:  { id: string; name: string }[],
  slackUsers: SlackUserLite[],
): MatchResult {
  // 이름 → Slack 후보 목록
  const byName = new Map<string, SlackUserLite[]>()
  for (const u of slackUsers) {
    const names = new Set([u.realName, u.displayName, u.name].map(normName).filter(Boolean))
    for (const n of names) {
      const arr = byName.get(n) ?? []
      if (!arr.some(x => x.id === u.id)) arr.push(u)
      byName.set(n, arr)
    }
  }

  // 우리 쪽 동명이인 여부(같은 이름 직원이 2명 이상이면 자동매칭 금지)
  const empNameCount = new Map<string, number>()
  for (const emp of employees) {
    const n = normName(emp.name)
    empNameCount.set(n, (empNameCount.get(n) ?? 0) + 1)
  }

  const matched:   MatchResult['matched']   = []
  const ambiguous: MatchResult['ambiguous'] = []
  const unmatched: MatchResult['unmatched'] = []

  for (const emp of employees) {
    const n          = normName(emp.name)
    const candidates = byName.get(n) ?? []
    const ourNameIsDuplicate = (empNameCount.get(n) ?? 0) > 1

    if (candidates.length === 0) {
      unmatched.push({ employeeId: emp.id, employeeName: emp.name })
    } else if (candidates.length === 1 && !ourNameIsDuplicate) {
      const c = candidates[0]
      matched.push({
        employeeId: emp.id, employeeName: emp.name,
        slackUserId: c.id, slackName: c.realName || c.displayName || c.name,
      })
    } else {
      ambiguous.push({
        employeeId: emp.id, employeeName: emp.name,
        candidates: candidates.map(c => ({ slackUserId: c.id, slackName: c.realName || c.displayName || c.name })),
      })
    }
  }

  return { matched, ambiguous, unmatched }
}
