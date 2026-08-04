/**
 * ProcessedRecord[] → daily_attendance 테이블 배치 upsert.
 *
 * 개별 prisma.dailyAttendance.upsert()를 4~5만 번 반복하면 그만큼 DB 왕복이 생겨
 * connection_limit=1 목표와 정면 충돌한다. 대신 Postgres unnest()로 여러 행을 한 번의
 * INSERT ... ON CONFLICT DO UPDATE로 처리 — 배치(BATCH_SIZE)마다 한 번의 왕복만 발생한다.
 * 배치 전체를 하나의 트랜잭션으로 묶지 않는다 — 커넥션을 오래 쥐고 있게 되어
 * connection_limit=1과 다시 충돌하기 때문(배치 단위 각각은 그 자체로 원자적).
 *
 * extra 컬럼에는 자주 필터링/집계되지 않는 나머지 필드를 보관한다 — 무엇이 real
 * column이고 무엇이 extra인지는 prisma/schema.prisma의 DailyAttendance 모델 주석과
 * src/lib/buildRecordSet.ts 참고. dayLabel은 저장하지 않는다(순수 함수라 읽을 때
 * getDayInfo()로 재계산 — src/lib/getProcessedRecords.ts 참고).
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ProcessedRecord } from '@/types/tag'

const BATCH_SIZE = 500

export interface AttendanceExtra {
  verificationNote?:   string[]
  leaveCodesDetail?:   string[]
  rawLeaveCode?:       string
  breakMinutes?:       number
  lunchDeducted?:      boolean
  dinnerDeducted?:     boolean
  rawOvertimeMinutes?: number
  erpApprovedOtHours?: number
  isHolidayWork?:      boolean
}

export function toExtra(r: ProcessedRecord): AttendanceExtra {
  return {
    verificationNote:   r.verificationNote,
    leaveCodesDetail:   r.leaveCodesDetail,
    rawLeaveCode:       r.rawLeaveCode,
    breakMinutes:       r.breakMinutes,
    lunchDeducted:      r.lunchDeducted,
    dinnerDeducted:     r.dinnerDeducted,
    rawOvertimeMinutes: r.rawOvertimeMinutes,
    erpApprovedOtHours: r.erpApprovedOtHours,
    isHolidayWork:      r.isHolidayWork,
  }
}

async function upsertBatch(batch: ProcessedRecord[]): Promise<void> {
  if (batch.length === 0) return

  const employeeIds       = batch.map(r => r.employeeId)
  const workDates         = batch.map(r => r.date)
  const dayTypes          = batch.map(r => r.dayType)
  const clockIns          = batch.map(r => r.clockIn ?? null)
  const clockOuts         = batch.map(r => r.clockOut ?? null)
  const effectiveClockIns = batch.map(r => r.effectiveClockIn ?? null)
  const regularHoursArr   = batch.map(r => r.regularHours)
  const overtimeHoursArr  = batch.map(r => r.overtimeHours)
  const nightHoursArr     = batch.map(r => r.nightHours)
  const holidayHoursArr   = batch.map(r => r.holidayHours)
  const erpOtAppliedArr   = batch.map(r => r.erpOtApplied)
  const leaveTypes        = batch.map(r => r.leaveType ?? null)
  const erpLeaveAmounts   = batch.map(r => r.erpLeaveAmount ?? null)
  const isUnpaidLeaves    = batch.map(r => r.isUnpaidLeave ?? false)
  const isLeaders         = batch.map(r => r.isLeader ?? false)
  const finalStatuses     = batch.map(r => r.finalStatus)
  const flags             = batch.map(r => r.flag ?? null)
  const extras            = batch.map(r => JSON.stringify(toExtra(r)))

  const query = Prisma.sql`
    INSERT INTO daily_attendance (
      id, employee_id, work_date, day_type, clock_in, clock_out, effective_clock_in,
      regular_hours, overtime_hours, night_hours, holiday_hours, erp_ot_applied,
      leave_type, erp_leave_amount, is_unpaid_leave, is_leader, final_status, flag, extra
    )
    SELECT gen_random_uuid(), * FROM unnest(
      ${employeeIds}::text[], ${workDates}::text[], ${dayTypes}::text[],
      ${clockIns}::text[], ${clockOuts}::text[], ${effectiveClockIns}::text[],
      ${regularHoursArr}::double precision[], ${overtimeHoursArr}::double precision[],
      ${nightHoursArr}::double precision[], ${holidayHoursArr}::double precision[],
      ${erpOtAppliedArr}::boolean[], ${leaveTypes}::text[], ${erpLeaveAmounts}::double precision[],
      ${isUnpaidLeaves}::boolean[], ${isLeaders}::boolean[],
      ${finalStatuses}::text[], ${flags}::text[], ${extras}::jsonb[]
    )
    ON CONFLICT (employee_id, work_date) DO UPDATE SET
      day_type            = EXCLUDED.day_type,
      clock_in             = EXCLUDED.clock_in,
      clock_out            = EXCLUDED.clock_out,
      effective_clock_in   = EXCLUDED.effective_clock_in,
      regular_hours        = EXCLUDED.regular_hours,
      overtime_hours       = EXCLUDED.overtime_hours,
      night_hours          = EXCLUDED.night_hours,
      holiday_hours        = EXCLUDED.holiday_hours,
      erp_ot_applied       = EXCLUDED.erp_ot_applied,
      leave_type           = EXCLUDED.leave_type,
      erp_leave_amount     = EXCLUDED.erp_leave_amount,
      is_unpaid_leave      = EXCLUDED.is_unpaid_leave,
      is_leader            = EXCLUDED.is_leader,
      final_status         = EXCLUDED.final_status,
      flag                 = EXCLUDED.flag,
      extra                = EXCLUDED.extra,
      calculated_at        = now()
  `
  await prisma.$executeRaw(query)
}

/** records를 BATCH_SIZE 단위로 나눠 순차 upsert하고 처리한 총 건수를 반환한다. */
export async function upsertAttendanceRows(records: ProcessedRecord[]): Promise<number> {
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    await upsertBatch(records.slice(i, i + BATCH_SIZE))
  }
  return records.length
}
