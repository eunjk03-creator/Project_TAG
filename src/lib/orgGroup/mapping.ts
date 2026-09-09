export type JobTitleValue =
  | 'CEO' | 'CSO' | 'CFO' | 'DIVISION_PRESIDENT' | 'DIVISION_HEAD'
  | 'TEAM_LEAD' | 'PART_LEAD' | 'MEMBER' | 'INTERN' | 'CONTRACT'
  | 'PART_TIMER' | 'OTHER'

const LEADER_TITLES: ReadonlySet<JobTitleValue> = new Set([
  'CEO', 'CSO', 'CFO', 'DIVISION_PRESIDENT', 'DIVISION_HEAD', 'TEAM_LEAD', 'PART_LEAD',
])

const RAW_JOB_TITLE_MAP: Record<string, JobTitleValue> = {
  '팀장': 'TEAM_LEAD',
  '팀원': 'MEMBER',
  '파트장': 'PART_LEAD',
  '인턴': 'INTERN',
  '본부장': 'DIVISION_HEAD',
  '부문대표': 'DIVISION_PRESIDENT',
  '': 'MEMBER',
  'CFO': 'CFO',
  'CEO': 'CEO',
  'CSO': 'CSO',
  '계약직': 'CONTRACT',
  '파트타이머': 'PART_TIMER',
}

/** EmployeeMaster.jobTitle(자유 텍스트) → JobTitle enum 값. 인식 못하면 OTHER. */
export function mapEmployeeMasterJobTitle(raw: string): JobTitleValue {
  return RAW_JOB_TITLE_MAP[raw.trim()] ?? 'OTHER'
}

/** ExceptionRule.employeeId("rawId_이름" 합성키)를 분리. 언더스코어 없으면 null. */
export function parseExceptionRuleEmployeeId(employeeId: string): { rawId: string; name: string } | null {
  const idx = employeeId.indexOf('_')
  if (idx < 0) return null
  return { rawId: employeeId.slice(0, idx), name: employeeId.slice(idx + 1) }
}

/**
 * 초기 이관 시 직책 결정 — EmployeeMaster.jobTitle이 이미 리더급이면 그걸 신뢰하고,
 * 아니면서 리더 예외규칙(manager_exemption)이 있으면 TEAM_LEAD로 이관(본부장/파트장 구분은
 * 예외규칙에 없으므로 관리자 수동 검수 필요 — 스펙 §초기적재 (c) 참고).
 */
export function resolveInitialJobTitle(
  employeeMasterJobTitle: string,
  hasLeaderExceptionRule: boolean,
): JobTitleValue {
  const mapped = mapEmployeeMasterJobTitle(employeeMasterJobTitle)
  if (LEADER_TITLES.has(mapped)) return mapped
  if (hasLeaderExceptionRule) return 'TEAM_LEAD'
  return mapped
}

/** ExceptionRule.validFrom(빈 문자열 가능) → Date. 빈 값이면 fallbackIso 사용. */
export function parseValidFrom(raw: string | null | undefined, fallbackIso: string): Date {
  const trimmed = (raw ?? '').trim()
  return new Date(trimmed.length > 0 ? trimmed : fallbackIso)
}
