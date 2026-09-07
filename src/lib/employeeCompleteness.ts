/**
 * 직원 인사정보 완결성 체크 — PRD §4.1.1. 순수 함수, React 의존 없음.
 *
 * 알려진 한계(plans/functional-roaming-boot.md 참고): ExceptionRule은 (직원,ruleType)당
 * 1행을 그대로 수정(PATCH in place)하는 구조라 과거 변경 이력이 실제로 안 남는다 —
 * "최근 직책 변경"은 현재 활성 manager_exemption 규칙의 validFrom을 근사치로 쓴다.
 */

export type CompletenessStatus = '입력됨' | '미확인' | '해당없음'

export interface CompletenessField {
  label: '입사일' | '퇴사일' | '휴직구간' | '직책변경' | '근무제배정'
  status: CompletenessStatus
  detail?: string
}

export interface CompletenessResult {
  fields: CompletenessField[]
  issueCount: number
  /** 최근 직책 변경일(근사치) — manager_exemption 규칙의 validFrom, 없으면 null */
  lastTitleChangeDate: string | null
}

export interface EmployeeMasterLike {
  rawId: string
  hireDate: string | null
  resignedDate: string | null
  status: 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED'
}

export interface RuleLike {
  ruleType: string
  validFrom: string
  validTo: string
  workScheduleId?: string | null
}

/**
 * 사원번호 E{YY}{MM}{DD}{SEQ} 포맷에서 입사일을 역산 — processRecord.ts의 "입사당일"
 * 특례 처리와 동일한 로직(그 쪽은 계산 엔진 내부용으로 독립 사용, 이 함수와 값은 항상
 * 일치해야 하므로 로직을 바꿀 때는 두 곳 다 확인). EmployeeMaster.hireDate가 비어있을 때
 * 화면에 보여줄 "추정값"으로만 쓰고, DB 반영은 별도 확인 후 저장.
 */
export function deriveHireDateFromRawId(rawId: string): string | null {
  if (!/^E\d{8}$/.test(rawId)) return null
  const yymmdd = rawId.slice(1, 7)
  return `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
}

export function checkEmployeeCompleteness(
  emp: EmployeeMasterLike,
  rules: RuleLike[],
): CompletenessResult {
  const fields: CompletenessField[] = []
  let issueCount = 0

  // 입사일 — 비어있어도 사원번호에서 역산 가능하면 "추정값 있음"으로 완화 표시
  // (그래도 실제 DB 확정 전까지는 확인 필요로 카운트 — 사원번호 오입력 가능성 감안).
  if (!emp.hireDate) {
    const derived = deriveHireDateFromRawId(emp.rawId)
    fields.push({
      label: '입사일', status: '미확인',
      detail: derived ? `사번 기준 추정: ${derived} (확인 후 저장 필요)` : undefined,
    })
    issueCount++
  } else {
    fields.push({ label: '입사일', status: '입력됨', detail: emp.hireDate })
  }

  // 퇴사일 — 퇴사자인데 없음, 또는 재직자인데 있음(불일치) 둘 다 확인 필요
  if (emp.status === 'RESIGNED' && !emp.resignedDate) {
    fields.push({ label: '퇴사일', status: '미확인' })
    issueCount++
  } else if (emp.status !== 'RESIGNED' && emp.resignedDate) {
    fields.push({ label: '퇴사일', status: '미확인', detail: `재직 상태인데 퇴사일(${emp.resignedDate})이 입력돼 있음 — 확인 필요` })
    issueCount++
  } else if (emp.status === 'RESIGNED' && emp.resignedDate) {
    fields.push({ label: '퇴사일', status: '입력됨', detail: emp.resignedDate })
  } else {
    fields.push({ label: '퇴사일', status: '해당없음' })
  }

  // 휴직구간 — ON_LEAVE인데 활성 parental_leave 규칙이 없으면 확인 필요
  const leaveRule = rules.find(r => r.ruleType === 'parental_leave')
  if (emp.status === 'ON_LEAVE') {
    if (leaveRule) {
      fields.push({ label: '휴직구간', status: '입력됨', detail: `${leaveRule.validFrom || '?'} ~ ${leaveRule.validTo || '진행 중'}` })
    } else {
      fields.push({ label: '휴직구간', status: '미확인', detail: '휴직 상태인데 휴직 기간 규칙이 없음' })
      issueCount++
    }
  } else {
    fields.push({
      label: '휴직구간',
      status: leaveRule ? '입력됨' : '해당없음',
      detail: leaveRule ? `${leaveRule.validFrom || '?'} ~ ${leaveRule.validTo || '진행 중'}` : undefined,
    })
  }

  // 직책변경 — manager_exemption 규칙 존재 여부 + validFrom을 근사 "최근 변경일"로
  const leaderRule = rules.find(r => r.ruleType === 'manager_exemption')
  fields.push({
    label: '직책변경',
    status: leaderRule ? '입력됨' : '해당없음',
    detail: leaderRule ? `직책자 적용 시작(근사치): ${leaderRule.validFrom || '미상'}` : undefined,
  })

  // 근무제배정 — 미배정은 "표준" 기본값, 확인 필요 아님(플랜에 명시된 규칙)
  const scheduleRule = rules.find(r => !!r.workScheduleId)
  fields.push({
    label: '근무제배정',
    status: scheduleRule ? '입력됨' : '해당없음',
    detail: scheduleRule ? '별도 근무제 배정됨' : '표준(미배정)',
  })

  return { fields, issueCount, lastTitleChangeDate: leaderRule?.validFrom || null }
}
