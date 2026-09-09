export interface OrgGroupHistoryRow {
  groupId: string
  groupName: string
  jobTitle: string
  validFrom: string | Date
  validTo: string | Date | null
}

export interface OrgHistoryEntry {
  date: string
  title: string
  detail: string
}

const JOB_TITLE_LABEL: Record<string, string> = {
  CEO: 'CEO', CSO: 'CSO', CFO: 'CFO',
  DIVISION_PRESIDENT: '부문대표', DIVISION_HEAD: '본부장',
  TEAM_LEAD: '팀장', PART_LEAD: '파트장', MEMBER: '팀원',
  INTERN: '인턴', CONTRACT: '계약직', PART_TIMER: '파트타이머', OTHER: '기타',
}

function toDateStr(d: string | Date): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)
}
function titleLabel(t: string): string {
  return JOB_TITLE_LABEL[t] ?? t
}

/**
 * OrgGroupMember 이력(한 사람, validFrom 오름차순 정렬된 상태로 입력)을 "무슨 일이 있었는지"로
 * 분류한다. 별도 이력 테이블 없이 연속된 행을 비교해서 이동/직책변경/최초배치를 추론한다.
 */
export function classifyOrgGroupHistory(rows: OrgGroupHistoryRow[]): OrgHistoryEntry[] {
  const sorted = [...rows].sort((a, b) => toDateStr(a.validFrom).localeCompare(toDateStr(b.validFrom)))
  const entries: OrgHistoryEntry[] = []

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    const prev = i > 0 ? sorted[i - 1] : null
    const date = toDateStr(cur.validFrom)

    if (!prev) {
      entries.push({
        date, title: '조직 배치',
        detail: `최초 배치 — ${cur.groupName} · ${titleLabel(cur.jobTitle)}`,
      })
      continue
    }
    const groupChanged = prev.groupId !== cur.groupId
    const titleChanged = prev.jobTitle !== cur.jobTitle
    if (groupChanged && titleChanged) {
      entries.push({
        date, title: '조직 이동 + 직책 변경',
        detail: `${prev.groupName}(${titleLabel(prev.jobTitle)}) → ${cur.groupName}(${titleLabel(cur.jobTitle)})`,
      })
    } else if (groupChanged) {
      entries.push({
        date, title: '조직 이동',
        detail: `${prev.groupName} → ${cur.groupName}`,
      })
    } else if (titleChanged) {
      entries.push({
        date, title: '직책 변경',
        detail: `${titleLabel(prev.jobTitle)} → ${titleLabel(cur.jobTitle)}`,
      })
    }
  }
  return entries
}
