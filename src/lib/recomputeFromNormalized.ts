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
import { parseAttendanceData, extractEmployees, isValidEmpId, normalizeDate, type ParseResult } from '@/utils/dataParser'
import { DEFAULT_POLICY } from '@/types/tag'
import type { CapsRow, ErpUnifiedRow, Employee } from '@/types/tag'

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

  // updated_at은 DB 기본값이 없다(Prisma @updatedAt은 Prisma Client 경유 쓰기에만 적용) —
  // raw SQL로 직접 넣을 땐 명시적으로 채워야 NOT NULL 제약을 통과한다.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO employee_master (raw_id, name, source, updated_at)
    SELECT *, now() FROM unnest(${rawIds}::text[], ${names}::text[], ${sources}::text[])
    ON CONFLICT (raw_id) DO NOTHING
  `)
}

/** insertedCount/updatedCount는 RETURNING (xmax = 0)으로 판별 — 같은 트랜잭션 내 신규 INSERT면
 *  xmax가 0, ON CONFLICT DO UPDATE로 기존 행을 갱신한 경우면 0이 아니다. */
async function upsertCapsRows(rowsInRaw: CapsRow[]): Promise<UpsertCounts> {
  // 사원번호가 'E' + 8자리 이상 숫자 형식이 아니면 dataParser.parseAttendanceData()도 항상
  // 무시하는 행이다(방문자/도급사 코드 등) — 여기서 미리 안 걸러내면 employee_master에
  // 매칭되는 stub이 없어서(빈 사원번호는 stub 자체를 안 만듦) FK 위반으로 INSERT가 통째로 실패한다.
  // work_date는 반드시 normalizeDate()로 정규화한 뒤 저장한다 — 원본 CAPS 파일마다
  // "2026-08-01"/"2026/08/01"처럼 날짜 표기가 달라서, 정규화 없이 그대로 저장하면
  // UNIQUE(employee_id, work_date)가 같은 날을 다른 행으로 착각해 중복이 생긴다
  // (2026-08-30 백필 중 실제로 발견 — parseAttendanceData는 항상 정규화된 날짜로 비교하므로
  // 저장 시점에도 반드시 동일하게 정규화해야 한다).
  const rowsIn = rowsInRaw
    .filter(r => isValidEmpId(String(r.사원번호 ?? '').trim()))
    .map(r => ({ ...r, 근무일자: normalizeDate(r.근무일자) }))
    .filter(r => r.근무일자)
  if (rowsIn.length === 0) return { insertedCount: 0, updatedCount: 0 }
  await ensureEmployeeMasterStubs(rowsIn.map(r => ({ rawId: String(r.사원번호 ?? '').trim(), name: String(r.이름 ?? '').trim() })))

  // ON CONFLICT DO UPDATE는 "같은 INSERT 문 안에서" 같은 (employee_id, work_date)가
  // 두 번 나오면 에러가 난다(Postgres 21000) — 같은 배치 안의 중복은 미리 걸러서 마지막
  // 것만 남긴다(기존 mergeCapsRows의 "새 로우가 덮어씀" 규칙과 동일).
  const dedupMap = new Map<string, CapsRow>()
  for (const r of rowsIn) dedupMap.set(`${String(r.사원번호 ?? '').trim()}_${r.근무일자}`, r)
  const rows = [...dedupMap.values()]

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

async function upsertErpRows(rowsInRaw: ErpUnifiedRow[]): Promise<UpsertCounts> {
  const looseInRaw = rowsInRaw as unknown as Record<string, string>[]
  const findKey = (r: Record<string, string>, name: string) =>
    Object.keys(r).find(k => k.replace(/\s+/g, '') === name) ?? name

  // 시작일/종료일/신청일 전부 normalizeDate()로 정규화 후 저장 — caps_daily_logs와 동일한
  // 이유(원본 파일마다 날짜 표기가 달라 정규화 없이는 같은 날이 다른 행으로 중복 저장됨).
  const rowsIn = rowsInRaw
    .map((r, i) => ({
      ...r,
      시작일: normalizeDate(r.시작일),
      종료일: r.종료일 ? normalizeDate(r.종료일) : r.종료일,
      __신청일정규화__: (() => {
        const raw = looseInRaw[i][findKey(looseInRaw[i], '신청일')]
        return raw ? normalizeDate(raw) : raw
      })(),
    }))
    .filter(r => isValidEmpId(String(r.사원번호 ?? '').trim()) && r.시작일)
  if (rowsIn.length === 0) return { insertedCount: 0, updatedCount: 0 }
  await ensureEmployeeMasterStubs(rowsIn.map(r => ({ rawId: String(r.사원번호 ?? '').trim(), name: String(r.성명 ?? '').trim() })))

  const looseIn = rowsIn as unknown as Record<string, string>[]

  // upsertCapsRows와 동일한 이유 — 같은 INSERT 문 안의 (employee_id, leave_type, start_date,
  // start_time) 중복을 미리 제거(마지막 것만 유지).
  const dedupMap = new Map<string, typeof rowsIn[number]>()
  for (let i = 0; i < rowsIn.length; i++) {
    const r = rowsIn[i]
    const startTime = String(looseIn[i][findKey(looseIn[i], '시작시간')] ?? '').trim()
    dedupMap.set(`${String(r.사원번호 ?? '').trim()}_${r.근태코드}_${r.시작일}_${startTime}`, r)
  }
  const rows  = [...dedupMap.values()]
  const loose = rows as unknown as Record<string, string>[]

  const employeeIds      = rows.map(r => String(r.사원번호 ?? '').trim())
  const names            = rows.map(r => String(r.성명 ?? '').trim())
  const leaveTypes       = rows.map(r => r.근태코드)
  const approvalStatuses = rows.map(r => r.승인상태)
  const startDates       = rows.map(r => r.시작일)
  const startTimes       = loose.map(r => String(r[findKey(r, '시작시간')] ?? '').trim())
  const endDates         = rows.map(r => r.종료일 ?? null)
  const endTimes         = loose.map(r => (r[findKey(r, '종료시간')] ?? null))
  const submitDates      = rows.map(r => r.__신청일정규화__ ?? null)
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
 * 직원 목록만 필요할 때(예: daily_attendance 조회에 곁들이는 이름/부서 조회)의 경량 경로 —
 * caps_daily_logs 6만+ 행 전체를 끌어와 parseAttendanceData() 전체를 돌리는 대신, 직원당
 * 1행만 distinct로 가져와 extractEmployees()만 적용한다. 계산 결과(leaveMap/otMap/rawRecords)가
 * 필요 없는 호출부(getProcessedRecords.ts 등)는 반드시 이걸 쓸 것 — buildEmployeesAndRawRecords()는
 * 그 결과까지 전부 만드느라 훨씬 느리다.
 */
async function buildEmployeeRoster(): Promise<Employee[]> {
  const rows = await prisma.capsDailyLog.findMany({
    distinct: ['employeeId'],
    select: { employeeId: true, name: true, rawDept: true, jobTitle: true },
  })
  const capsForParser: CapsRow[] = rows.map(r => ({
    사원번호: r.employeeId, 이름: r.name, 부서: r.rawDept ?? '', 직급: r.jobTitle ?? '',
    근무일자: '', 출근: null, 퇴근: null,
  }))
  return extractEmployees(capsForParser)
}

/**
 * caps_daily_logs/erp_applications를 CapsRow[]/ErpUnifiedRow[]로 복원해 parseAttendanceData()에
 * 넘긴 결과를 그대로 돌려준다. rawIds를 생략하면 전체 직원 대상(compute-attendance 전체 재계산,
 * 화면 raw records 조회용) — 지정하면 그 사원번호들만(업로드 증분 재계산용).
 */
interface CapsDailyLogRow {
  employeeId: string
  name:       string
  workDate:   string
  clockIn:    string | null
  clockOut:   string | null
  rawDept:    string | null
  jobTitle:   string | null
}
interface ErpApplicationRow {
  employeeId:     string
  name:           string
  leaveType:      string
  approvalStatus: string
  startDate:      string
  startTime:      string
  endDate:        string | null
  endTime:        string | null
  submitDate:     string | null
  recognizedTime: string | null
  leaveDays:      string | null
  category:       string | null
}

async function buildEmployeesAndRawRecords(rawIds?: string[]): Promise<ParseResult> {
  // Prisma ORM(findMany)이 6만+ 행을 JS 객체로 매핑하는 오버헤드가 커서(2026-08-30 실측,
  // daily_attendance 기준 초당 수백ms) raw SQL로 직접 조회 — getProcessedRecords.ts와 동일 패턴.
  const idFilter = rawIds
    ? Prisma.sql`WHERE employee_id IN (${Prisma.join([...new Set(rawIds.filter(Boolean))])})`
    : Prisma.empty
  const [capsRows, erpRows] = await Promise.all([
    prisma.$queryRaw<CapsDailyLogRow[]>(Prisma.sql`
      SELECT employee_id AS "employeeId", name, work_date AS "workDate",
             clock_in AS "clockIn", clock_out AS "clockOut", raw_dept AS "rawDept", job_title AS "jobTitle"
      FROM caps_daily_logs ${idFilter}
    `),
    prisma.$queryRaw<ErpApplicationRow[]>(Prisma.sql`
      SELECT employee_id AS "employeeId", name, leave_type AS "leaveType", approval_status AS "approvalStatus",
             start_date AS "startDate", start_time AS "startTime", end_date AS "endDate", end_time AS "endTime",
             submit_date AS "submitDate", recognized_time AS "recognizedTime", leave_days AS "leaveDays", category
      FROM erp_applications ${idFilter}
    `),
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
  ensureEmployeeMasterStubs, buildEmployeesAndRawRecords, buildEmployeeRoster,
}
