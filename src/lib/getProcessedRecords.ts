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
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { getDayInfo }        from '@/utils/dataParser'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'
import type { DailyAttendance } from '@prisma/client'

interface AttendanceMeta {
  employees: Employee[]
}

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

/** DailyAttendance row → ProcessedRecord 완전 복원. dayLabel은 저장 안 하므로 재계산(순수 함수). */
function reassemble(row: DailyAttendance): ProcessedRecord {
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
  // 1. 직원 목록 — 여전히 JSON(~400명, 병목 아님)
  const metaRow = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  const meta      = metaRow?.data as unknown as AttendanceMeta | undefined
  const employees = meta?.employees ?? []
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

  // 4. 범위만 SQL로 조회 — 이게 진짜 성능 이득 지점
  const rows = await prisma.dailyAttendance.findMany({
    where: (opts?.from || opts?.to) ? {
      workDate: {
        ...(opts?.from ? { gte: opts.from } : {}),
        ...(opts?.to   ? { lte: opts.to }   : {}),
      },
    } : undefined,
  })

  const records = rows.map(reassemble)

  return { employees: visibleEmployees, records, finalAttrMap }
}
