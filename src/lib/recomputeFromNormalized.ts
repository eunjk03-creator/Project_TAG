/**
 * caps_daily_logs / erp_applications(정규화 테이블) → daily_attendance 증분 재계산.
 *
 * recomputeEmployee.ts의 "그 직원 1명만 재계산" 패턴을 여러 사원번호로 일반화하고,
 * 소스를 shared_data_store의 attendance_data(JSON 스냅샷) 대신 이 정규화 테이블로 바꾼 것.
 *
 * 핵심 원칙: parseAttendanceData()/processRecord()/buildRecordSet() 내부 로직은 절대 안 건드림 —
 * 이 함수들은 "몇 명분이 들어오든" 처리하는 순수 함수라, 입력을 "영향받은 직원들의 전체
 * CAPS/ERP 이력만" 걸러서 넣으면 코드 변경 없이 그대로 증분 처리에 재사용된다.
 *
 * dataParser.ts가 fuzzy-key로 읽는 신청일/시작시간/종료시간은 ErpUnifiedRow 타입엔 없지만
 * 실데이터엔 있는 컬럼이라(buildOtMap의 연장근로 신청일 검증 등) erp_applications에도
 * 그대로 보관해뒀다가 여기서 복원한다 — 빠뜨리면 그 검증 로직이 조용히 느슨해진다.
 */
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet } from '@/lib/buildRecordSet'
import { upsertAttendanceRows } from '@/lib/upsertAttendanceRows'
import { parseAttendanceData, type ParseResult } from '@/utils/dataParser'
import { DEFAULT_POLICY } from '@/types/tag'
import type { CapsRow, ErpUnifiedRow } from '@/types/tag'

export interface UpsertCounts {
  insertedCount: number
  updatedCount:  number
}

/** employee_master에 없는 신규 사원번호를 최소 정보로 upsert — CAPS/ERP 업로드에서 처음 보는 사람도
 *  caps_daily_logs/erp_applications의 FK(employee_id → employee_master.raw_id)를 만족시켜야 함.
 *  이미 있는 행은 손대지 않는다 — 조직도 시트 동기화 쪽이 더 신뢰도 높은 소스라 덮어쓰지 않음. */
async function ensureEmployeeMasterStubs(rows: { rawId: string; name: string }[]): Promise<void> {
  const uniq = new Map<string, string>()
  for (const r of rows) if (r.rawId) uniq.set(r.rawId, r.name)
  if (uniq.size === 0) return

  const rawIds = [...uniq.keys()]
  const names  = [...uniq.values()]
  const sources = rawIds.map(() => 'caps_auto')

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO employee_master (raw_id, name, source)
    SELECT * FROM unnest(${rawIds}::text[], ${names}::text[], ${sources}::text[])
    ON CONFLICT (raw_id) DO NOTHING
  `)
}

/** insertedCount/updatedCount는 RETURNING (xmax = 0)으로 판별 — 같은 트랜잭션 내 신규 INSERT면
 *  xmax가 0, ON CONFLICT DO UPDATE로 기존 행을 갱신한 경우면 0이 아니다. */
async function upsertCapsRows(rows: CapsRow[]): Promise<UpsertCounts> {
  if (rows.length === 0) return { insertedCount: 0, updatedCount: 0 }
  await ensureEmployeeMasterStubs(rows.map(r => ({ rawId: String(r.사원번호 ?? '').trim(), name: String(r.이름 ?? '').trim() })))

  const employeeIds = rows.map(r => String(r.사원번호 ?? '').trim())
  const names       = rows.map(r => String(r.이름 ?? '').trim())
  const workDates   = rows.map(r => r.근무일자)
  const clockIns    = rows.map(r => r.출근 ?? null)
  const clockOuts   = rows.map(r => r.퇴근 ?? null)
  const rawDepts    = rows.map(r => r.부서 ?? null)
  const jobTitles   = rows.map(r => r.직급 ?? null)

  const result = await prisma.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
    INSERT INTO caps_daily_logs (id, employee_id, name, work_date, clock_in, clock_out, raw_dept, job_title)
    SELECT gen_random_uuid(), * FROM unnest(
      ${employeeIds}::text[], ${names}::text[], ${workDates}::text[],
      ${clockIns}::text[], ${clockOuts}::text[], ${rawDepts}::text[], ${jobTitles}::text[]
    )
    ON CONFLICT (employee_id, work_date) DO UPDATE SET
      name       = EXCLUDED.name,
      clock_in   = EXCLUDED.clock_in,
      clock_out  = EXCLUDED.clock_out,
      raw_dept   = EXCLUDED.raw_dept,
      job_title  = EXCLUDED.job_title,
      uploaded_at = now()
    RETURNING (xmax = 0) AS inserted
  `)
  const insertedCount = result.filter(r => r.inserted).length
  return { insertedCount, updatedCount: result.length - insertedCount }
}

async function upsertErpRows(rows: ErpUnifiedRow[]): Promise<UpsertCounts> {
  if (rows.length === 0) return { insertedCount: 0, updatedCount: 0 }
  await ensureEmployeeMasterStubs(rows.map(r => ({ rawId: String(r.사원번호 ?? '').trim(), name: String(r.성명 ?? '').trim() })))

  const loose = rows as unknown as Record<string, string>[]
  const findKey = (r: Record<string, string>, name: string) =>
    Object.keys(r).find(k => k.replace(/\s+/g, '') === name) ?? name

  const employeeIds      = rows.map(r => String(r.사원번호 ?? '').trim())
  const names            = rows.map(r => String(r.성명 ?? '').trim())
  const leaveTypes       = rows.map(r => r.근태코드)
  const approvalStatuses = rows.map(r => r.승인상태)
  const startDates       = rows.map(r => r.시작일)
  const startTimes       = loose.map(r => String(r[findKey(r, '시작시간')] ?? '').trim())
  const endDates         = rows.map(r => r.종료일 ?? null)
  const endTimes         = loose.map(r => (r[findKey(r, '종료시간')] ?? null))
  const submitDates      = loose.map(r => (r[findKey(r, '신청일')] ?? null))
  const recognizedTimes  = rows.map(r => r.인정시간 ?? null)
  const leaveDaysArr     = rows.map(r => r.일수 ?? null)
  const categories       = rows.map(r => r.근태구분 ?? null)

  const result = await prisma.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
    INSERT INTO erp_applications (
      id, employee_id, name, leave_type, approval_status, start_date, start_time,
      end_date, end_time, submit_date, recognized_time, leave_days, category
    )
    SELECT gen_random_uuid(), * FROM unnest(
      ${employeeIds}::text[], ${names}::text[], ${leaveTypes}::text[], ${approvalStatuses}::text[],
      ${startDates}::text[], ${startTimes}::text[],
      ${endDates}::text[], ${endTimes}::text[], ${submitDates}::text[],
      ${recognizedTimes}::text[], ${leaveDaysArr}::text[], ${categories}::text[]
    )
    ON CONFLICT (employee_id, leave_type, start_date, start_time) DO UPDATE SET
      name             = EXCLUDED.name,
      approval_status  = EXCLUDED.approval_status,
      end_date         = EXCLUDED.end_date,
      end_time         = EXCLUDED.end_time,
      submit_date      = EXCLUDED.submit_date,
      recognized_time  = EXCLUDED.recognized_time,
      leave_days       = EXCLUDED.leave_days,
      category         = EXCLUDED.category,
      synced_at        = now()
    RETURNING (xmax = 0) AS inserted
  `)
  const insertedCount = result.filter(r => r.inserted).length
  return { insertedCount, updatedCount: result.length - insertedCount }
}

/**
 * caps_daily_logs/erp_applications를 CapsRow[]/ErpUnifiedRow[]로 복원해 parseAttendanceData()에
 * 넘긴 결과를 그대로 돌려준다. rawIds를 생략하면 전체 직원 대상(compute-attendance 전체 재계산,
 * 화면 raw records 조회용) — 지정하면 그 사원번호들만(업로드 증분 재계산용).
 */
async function buildEmployeesAndRawRecords(rawIds?: string[]): Promise<ParseResult> {
  const where = rawIds ? { employeeId: { in: [...new Set(rawIds.filter(Boolean))] } } : undefined
  const [capsRows, erpRows] = await Promise.all([
    prisma.capsDailyLog.findMany({ where }),
    prisma.erpApplication.findMany({ where }),
  ])
  // parseAttendanceData의 employee 추출은 CAPS 기준 — CAPS 이력이 없는 사람(ERP만 있음)은
  // 기존 로직에서도 애초에 직원으로 잡히지 않는다. 동일하게 스킵.
  if (capsRows.length === 0) return { employees: [], rawRecords: [], skippedCount: 0, erpOtMatchCount: 0 }

  const capsForParser: CapsRow[] = capsRows.map(r => ({
    사원번호: r.employeeId,
    이름:     r.name,
    부서:     r.rawDept ?? '',
    직급:     r.jobTitle ?? '',
    근무일자: r.workDate,
    출근:     r.clockIn,
    퇴근:     r.clockOut,
  }))

  const erpForParser = erpRows.map(r => ({
    사원번호:  r.employeeId,
    성명:      r.name,
    근태코드:  r.leaveType,
    승인상태:  r.approvalStatus,
    시작일:    r.startDate,
    종료일:    r.endDate ?? undefined,
    인정시간:  r.recognizedTime ?? undefined,
    일수:      r.leaveDays ?? undefined,
    근태구분:  r.category ?? undefined,
    시작시간:  r.startTime || undefined,
    종료시간:  r.endTime ?? undefined,
    신청일:    r.submitDate ?? undefined,
  })) as unknown as ErpUnifiedRow[]

  return parseAttendanceData(capsForParser, erpForParser, DEFAULT_POLICY)
}

/**
 * CsvUploader의 "업로드한 파일 되돌리기" — employeeId(사원번호)+workDate 쌍으로 caps_daily_logs
 * 행을 지운다. daily_attendance 자체는 여기서 안 건드림 — 호출부가 영향받은 employeeId들을
 * recomputeEmployeesFromNormalizedTables에 넘겨 재계산해야 그 삭제가 반영된다.
 */
async function deleteCapsRows(pairs: { employeeId: string; workDate: string }[]): Promise<number> {
  if (pairs.length === 0) return 0
  const employeeIds = pairs.map(p => p.employeeId)
  const workDates    = pairs.map(p => p.workDate)
  const result = await prisma.$executeRaw(Prisma.sql`
    DELETE FROM caps_daily_logs
    WHERE (employee_id, work_date) IN (
      SELECT * FROM unnest(${employeeIds}::text[], ${workDates}::text[])
    )
  `)
  return result
}

export interface RecomputeResult {
  processedCount:  number
  skippedCount:    number
  erpOtMatchCount: number
}

/** 영향받은 사원번호들의 daily_attendance를 정규화 테이블 기준으로 재계산한다. */
async function recomputeEmployeesFromNormalizedTables(rawIds: string[]): Promise<RecomputeResult> {
  const empty: RecomputeResult = { processedCount: 0, skippedCount: 0, erpOtMatchCount: 0 }
  if (rawIds.filter(Boolean).length === 0) return empty

  const { employees, rawRecords, skippedCount, erpOtMatchCount } = await buildEmployeesAndRawRecords(rawIds)
  if (employees.length === 0) return { ...empty, skippedCount, erpOtMatchCount }

  const compositeIds = employees.map(e => e.id)
  const [dbRules, overrides, slackExcs] = await Promise.all([
    prisma.exceptionRule.findMany({ where: { employeeId: { in: compositeIds } } }),
    prisma.attendanceOverride.findMany({ where: { employeeId: { in: compositeIds } } }),
    prisma.slackException.findMany({ where: { empId: { in: compositeIds } } }),
  ])
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  const { records: mergedRecords, slackNoteMap } = buildRecordSet({
    employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy: DEFAULT_POLICY,
  })
  if (mergedRecords.length === 0) return { ...empty, skippedCount, erpOtMatchCount }

  const processed = mergedRecords.map(r =>
    processRecord(r, DEFAULT_POLICY, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )
  await upsertAttendanceRows(processed)
  return { processedCount: processed.length, skippedCount, erpOtMatchCount }
}

export {
  upsertCapsRows, upsertErpRows, deleteCapsRows, recomputeEmployeesFromNormalizedTables,
  ensureEmployeeMasterStubs, buildEmployeesAndRawRecords,
}
