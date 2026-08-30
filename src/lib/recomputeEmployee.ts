/**
 * override/예외규칙 저장 직후 그 직원 1명분만 재계산해서 DailyAttendance에 반영한다.
 * attendance-overrides PUT, exception-rules 생성/수정/삭제 라우트에서 호출.
 *
 * 실제 재계산은 recomputeFromNormalized.ts의 recomputeEmployeesFromNormalizedTables()에
 * 위임 — CAPS/ERP 원본이 caps_daily_logs/erp_applications(정규화 테이블)로 이관된 뒤로는
 * shared_data_store의 attendance_data(JSON 스냅샷)가 더 이상 갱신되지 않으므로 그쪽을
 * 읽으면 안 된다. employeeId는 "${사원번호}_${정규화이름}" 합성 문자열이라, 정규화 테이블
 * 조회에 필요한 사원번호만 앞부분에서 추출한다.
 */
import { recomputeEmployeesFromNormalizedTables } from '@/lib/recomputeFromNormalized'

export async function recomputeEmployeeAttendance(employeeId: string): Promise<void> {
  const rawId = employeeId.split('_')[0]
  if (!rawId) return
  await recomputeEmployeesFromNormalizedTables([rawId])
}
