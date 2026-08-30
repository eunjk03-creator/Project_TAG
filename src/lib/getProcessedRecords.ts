/**
 * 내보내기 라우트 공용: DailyAttendance(정규화 테이블)에서 범위만 SQL로 조회.
 *
 * 예전엔 JSON blob 전체(청크 전부)를 fetch한 뒤 JS에서 날짜로 filter했다 — processRecord()
 * 자체는 이미 그 필터된 범위에서만 돌았지만(CPU는 원래도 안 비쌌음), 매 호출마다 4~5만 건
 * 전체를 네트워크로 끌어오는 I/O 비용이 진짜 병목이었다. 이제 `WHERE work_date BETWEEN`으로
 * Postgres가 필요한 행만 찾아 돌려준다.
 *
 * 정확성은 compute-attendance/route.ts의 배치 재계산 + override·예외규칙 저장 시
 * src/lib/recomputeEmployee.ts의 증분 재계산으로 DailyAttendance를 항상 최신 상태로
 * 유지하는 데 의존한다(이전엔 이 함수가 매번 처음부터 재계산해서 항상 최신이었음 —
 * 이제는 "쓰기 시점에 최신으로 유지"로 책임이 이동했다는 뜻).
 */
import { prisma }            from '@/lib/prisma'
import { Prisma }            from '@prisma/client'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { getDayInfo }        from '@/utils/dataParser'
import { buildEmployeeRoster } from '@/lib/recomputeFromNormalized'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'

interface AttendanceExtra {
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

/** raw SQL로 조회한 daily_attendance 행 — 컬럼을 camelCase로 alias해서 Prisma 모델과 같은 모양으로 맞춤. */
interface DailyAttendanceRow {
  employeeId:       string
  workDate:         string
  dayType:          string
  clockIn:          string | null
  clockOut:         string | null
  effectiveClockIn: string | null
  regularHours:     number
  overtimeHours:    number
  nightHours:       number
  holidayHours:     number
  erpOtApplied:     boolean
  leaveType:        string | null
  erpLeaveAmount:   number | null
  isUnpaidLeave:    boolean
  isLeader:         boolean
  finalStatus:      string
  flag:             string | null
  extra:            unknown
}

/** DailyAttendance row → ProcessedRecord 완전 복원. dayLabel은 저장 안 하므로 재계산(순수 함수). */
function reassemble(row: DailyAttendanceRow): ProcessedRecord {
  const extra = (row.extra ?? {}) as AttendanceExtra
  const { dayLabel } = getDayInfo(row.workDate)
  return {
    employeeId:         row.employeeId,
    date:               row.workDate,
    dayType:            row.dayType as ProcessedRecord['dayType'],
    dayLabel,
    clockIn:            row.clockIn,
    clockOut:           row.clockOut,
    erpOtApplied:       row.erpOtApplied,
    leaveType:          (row.leaveType ?? undefined) as ProcessedRecord['leaveType'],
    isHolidayWork:      extra.isHolidayWork,
    isLeader:           row.isLeader,
    verificationNote:   extra.verificationNote,
    erpLeaveAmount:     row.erpLeaveAmount ?? undefined,
    isUnpaidLeave:      row.isUnpaidLeave,
    rawLeaveCode:       extra.rawLeaveCode,
    leaveCodesDetail:   extra.leaveCodesDetail as ProcessedRecord['leaveCodesDetail'],
    effectiveClockIn:   row.effectiveClockIn,
    regularHours:       row.regularHours,
    overtimeHours:      row.overtimeHours,
    rawOvertimeMinutes: extra.rawOvertimeMinutes,
    nightHours:         row.nightHours,
    holidayHours:       row.holidayHours,
    breakMinutes:       extra.breakMinutes ?? 0,
    lunchDeducted:      extra.lunchDeducted ?? false,
    dinnerDeducted:     extra.dinnerDeducted ?? false,
    flag:               row.flag as ProcessedRecord['flag'],
    finalStatus:        row.finalStatus as ProcessedRecord['finalStatus'],
  }
}

export async function getProcessedRecords(opts?: {
  from?: string
  to?:   string
}): Promise<{ employees: Employee[]; records: ProcessedRecord[]; finalAttrMap: Map<string, EmployeeAttributeOverrides> }> {
  // 1. 직원 목록 — caps_daily_logs에서 직원당 1행만 distinct로 가져와 재구성(경량 경로).
  // buildEmployeesAndRawRecords()(전체 6만+행 파싱)를 쓰면 daily_attendance 조회엔 필요
  // 없는 rawRecords/leaveMap/otMap까지 매번 다시 만들어서 훨씬 느리다.
  const employees = await buildEmployeeRoster()
  if (employees.length === 0) return { employees: [], records: [], finalAttrMap: new Map() }

  // 2. 예외규칙 + 직책자 맵
  const dbRules = await prisma.exceptionRule.findMany()
  const { finalAttrMap } = buildFinalAttrMap(employees, dbRules)

  // 3. 퇴사자 완전 제외(직원 목록 기준) — buildRecordSet()과 동일 규칙. 레코드 자체는
  // upsertAttendanceRows 시점(buildRecordSet)에서 이미 걸러진 채로 저장돼 있으므로
  // 여기서 레코드를 다시 필터링할 필요는 없다.
  const resignedExcludedIds = new Set(
    employees
      .filter(e => {
        const attrs = finalAttrMap.get(e.id)
        return attrs?.isResigned && (!attrs.resignedFrom || (!!opts?.from && attrs.resignedFrom < opts.from))
      })
      .map(e => e.id),
  )
  const visibleEmployees = employees.filter(e => !resignedExcludedIds.has(e.id))

  // 4. 범위만 SQL로 조회 — 이게 진짜 성능 이득 지점. Prisma ORM(findMany)이 6만+ 행을
  // JS 객체로 매핑하는 데만 6~700ms 오버헤드가 실측돼서(2026-08-30), raw SQL로 직접 조회 —
  // 같은 데이터를 훨씬 적은 비용으로 가져온다. 컬럼은 camelCase로 alias해서 reassemble()이
  // Prisma 모델을 받을 때와 동일하게 동작하게 맞춤.
  const conditions: Prisma.Sql[] = []
  if (opts?.from) conditions.push(Prisma.sql`work_date >= ${opts.from}`)
  if (opts?.to)   conditions.push(Prisma.sql`work_date <= ${opts.to}`)
  const whereClause = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty

  const rows = await prisma.$queryRaw<DailyAttendanceRow[]>(Prisma.sql`
    SELECT
      employee_id AS "employeeId", work_date AS "workDate", day_type AS "dayType",
      clock_in AS "clockIn", clock_out AS "clockOut", effective_clock_in AS "effectiveClockIn",
      regular_hours AS "regularHours", overtime_hours AS "overtimeHours", night_hours AS "nightHours",
      holiday_hours AS "holidayHours", erp_ot_applied AS "erpOtApplied", leave_type AS "leaveType",
      erp_leave_amount AS "erpLeaveAmount", is_unpaid_leave AS "isUnpaidLeave", is_leader AS "isLeader",
      final_status AS "finalStatus", flag, extra
    FROM daily_attendance
    ${whereClause}
  `)

  const records = rows.map(reassemble)

  return { employees: visibleEmployees, records, finalAttrMap }
}
