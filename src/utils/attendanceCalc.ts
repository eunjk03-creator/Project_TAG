/**
 * Canonical attendance calculation — 4-step time math (Steps 1-4)
 * + Step 3 anomaly threshold engine (computeStatusN).
 *
 * Single source of truth for both the UI table and Excel export.
 * All hour values are decimal (e.g. 8h 30m = 8.5).
 */
import type { DayType, ErpLeaveType, RawRecord, ProcessedRecord, SieveFlag, Employee, EmployeeAttributeOverrides } from '@/types/tag'

export type AnomalyCategory = 'late' | 'shortage' | 'notag'

/**
 * SieveFlag → 3종 체계(지각/근무시간미달/미태깅) 분류. 혼합 플래그(LATE_AND_*)는 두 카테고리
 * 모두에 집계된다. EARLY_DEPARTURE/LATE_AND_EARLY_DEPARTURE는 재계산 전 캐시된 레코드에서만
 * 남아있을 수 있는 하위호환 값 — 근무시간미달로 통합.
 *
 * 예전엔 SummaryTab.tsx/deptReportExcel.ts/admin/page.tsx/AttendanceResultTable.tsx 4곳에
 * 각자 따로 정의돼 있던 걸 여기 하나로 통합함 — 새 집계 코드는 반드시 이 함수를 재사용할 것.
 */
/**
 * 직책자 여부를 발령일(leaderFrom)/해임일(leaderTo) 기준으로 판별. 날짜 범위가 하나라도
 * 설정돼 있으면 CSV 자동감지(emp.isLeader)나 예외규칙 boolean보다 우선 적용된다 — 발령일
 * 이전/해임일 이후 기록은 비직책자로, 그 사이는 직책자로 정확히 갈린다. 범위 미설정 시에는
 * 예외규칙 boolean → CSV 자동감지 순으로 폴백(전 기간 직책자/비직책자 고정).
 *
 * 예전엔 AttendanceResultTable.tsx/AllowanceTab.tsx/EmployeeCalendarGrid.tsx/
 * productivityReportExcel.ts 4곳에 각자 따로 정의돼 있던 걸 여기 하나로 통합함.
 */
export function isLeaderOnDate(
  attrs: EmployeeAttributeOverrides | undefined,
  emp:   Employee | undefined,
  date:  string,
): boolean {
  const from = attrs?.leaderFrom
  const to   = attrs?.leaderTo
  if (from || to) return (!from || date >= from) && (!to || date <= to)
  return attrs?.isLeader === true || emp?.isLeader === true
}

export function flagToAnomalyCategories(flag: SieveFlag): AnomalyCategory[] {
  if (flag === 'LATE')                     return ['late']
  if (flag === 'EARLY_DEPARTURE')          return ['shortage']
  if (flag === 'LATE_AND_EARLY_DEPARTURE') return ['late', 'shortage']
  if (flag === 'ATTENDANCE_ANOMALY')       return ['shortage']
  if (flag === 'LATE_AND_ANOMALY')         return ['late', 'shortage']
  if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') return ['notag']
  return []
}

/** Parse "HH:MM" or "+HH:MM" (next-day punch) → total minutes from midnight. */
export function parseTimeToMins(t: string): number {
  const isNext = t.startsWith('+')
  const clean  = isNext ? t.slice(1) : t
  const [h, m] = clean.split(':').map(Number)
  return (isNext ? 1440 : 0) + h * 60 + m
}

/**
 * Step 1 — 근무A (Stay Duration).
 * Returns 0 when clockIn or clockOut is null/empty (missing punch).
 */
export function computeWorkA(
  clockIn:  string | null | undefined,
  clockOut: string | null | undefined,
): number {
  if (!clockIn || !clockOut) return 0
  return Math.max(0, parseTimeToMins(clockOut) - parseTimeToMins(clockIn)) / 60
}

/**
 * Step 2 — 근무B (Gross Hours).
 * leaveAmt is the fractional leave days from ERP (e.g. 0.5, 1.0).
 * isUnpaid comes from r.isUnpaidLeave, which is set when the raw ERP
 * 근태코드 contains "(무급)" (e.g. "병가(무급)", "난임휴가(무급)").
 * When isUnpaid is true the multiplier is 0 — unpaid leave contributes no hours.
 */
export function computeWorkB(workA: number, leaveAmt: number, isUnpaid: boolean): number {
  const leaveAdd = isUnpaid ? 0 : leaveAmt * 8
  return workA + leaveAdd
}

/**
 * Step 3 — 휴게 (Break Time) bracket rule, applied to 근무B.
 *   근무B < 4h     → 0h
 *   4h ≤ 근무B < 8.5h → 0.5h
 *   8.5h ≤ 근무B < 12h → 1.0h
 *   근무B ≥ 12h    → 2.0h
 */
export function computeBreakH(workB: number): number {
  if (workB < 4)   return 0
  if (workB < 8.5) return 0.5
  if (workB < 12)  return 1.0
  return 2.0
}

/**
 * Step 4 — 최종근무(값).
 * MAX(근무B − 휴게, 0) — never negative.
 */
export function computeFinalWork(workB: number, breakH: number): number {
  return Math.max(0, workB - breakH)
}

// ── Step 3: Anomaly Threshold Engine ─────────────────────────────────────
//
// Computes Column N (근태 상태) directly from raw record fields.
// Returns one of 8 restricted values, or null for non-working days.
//
// '외근' and '휴일근무' are NOT returned here — they are injected by the
// Step 4 Slack/holiday override layer in the callers.

export type DisplayStatus =
  | '정상' | '지각' | '조기퇴근' | '지각+조기퇴근'
  | '미태깅' | '이상치' | '외근' | '휴일근무'


/**
 * Lateness and 근무시간 미달 thresholds by leave type. 3종 체계(지각/근무시간미달/미태깅) —
 * 조기퇴근은 근무시간미달로 통합 폐지, 여유(grace) 없이 1분이라도 못 채우면 즉시 판정.
 *
 * Late threshold (clock-in must be ≤ this time):
 *   오전반반차   → 11:00   오전반차  → 14:00
 *   isTenAMStarter → 10:00   default   → 09:00
 *   (leave-type rules take priority over the employee exception flag)
 *
 * 근무시간 미달 threshold (duration-based, no grace):
 *   오전반차/오후반차/반차(합산) → workA ≥ 4.5h   오전반반차/오후반반차 → workA ≥ 6.0h
 *   default → workA ≥ 9.0h
 *
 * Catch-all: finalWorkH < 8.0 with NO leave and NO explicit flags → 이상치.
 *
 * @param finalWorkH     Pre-computed value from computeFinalWork() (Step 2).
 * @param isTenAMStarter True when the employee's standard start time is 10:00.
 */
export function computeStatusN(p: {
  dayType:         DayType
  clockIn:         string | null | undefined
  clockOut:        string | null | undefined
  leaveType:       ErpLeaveType | null | undefined
  erpLeaveAmount:  number | undefined
  finalWorkH:      number
  isTenAMStarter?: boolean
}): Exclude<DisplayStatus, '외근' | '휴일근무'> | null {
  const { dayType, clockIn, clockOut, leaveType, erpLeaveAmount, finalWorkH, isTenAMStarter } = p

  // Non-working days: caller handles 주말/공휴일/휴일근무 display
  if (dayType !== 'WEEKDAY') return null

  const leaveAmt = erpLeaveAmount ?? 0

  // Full-day leave (including 무급) → 정상, skip all attendance checks
  if (leaveAmt >= 1.0) return '정상'

  // ── 1. Missing punch ────────────────────────────────────────────────────
  if (!clockIn || !clockOut) return '미태깅'

  // ── 2. Lateness threshold ────────────────────────────────────────────────
  // Leave-type-based rules take priority over the employee exception list
  const lateThreshold: string =
    leaveType === '오전반차'   ? '14:00' :
    leaveType === '오전반반차' ? '11:00' :
    isTenAMStarter             ? '10:00' :
    '09:00'

  const isLate = parseTimeToMins(clockIn) > parseTimeToMins(lateThreshold)

  // ── 3. 근무시간 미달 (마감선을 1분이라도 못 채우면 즉시 판정 — 여유(grace) 없음) ──────
  let isInsufficient = false

  {
    // Duration-based: required stay hours depend on leave type
    // 반차 (half-day, 합산 포함): 4h30min   반반차 (quarter-day): 6h   default: 9h
    const requiredH: number =
      leaveType === '오전반차'   ? 4.5 :
      leaveType === '오후반차'   ? 4.5 :
      leaveType === '반차'       ? 4.5 :
      leaveType === '오전반반차' ? 6.0 :
      leaveType === '오후반반차' ? 6.0 :
      9.0

    const workA = computeWorkA(clockIn, clockOut)
    if (workA < requiredH) isInsufficient = true
  }

  // Fires only when no other flags are set AND there is no leave credit
  const isCatchAll = !isLate && !isInsufficient && leaveAmt === 0 && finalWorkH < 8.0

  // ── 4. Priority resolution — 3종 체계(지각/근무시간미달/미태깅), 조기퇴근 폐지 ────────
  if (isInsufficient || isCatchAll) return '이상치'
  if (isLate)                       return '지각'
  return '정상'
}

// ── Zone 2: Payroll Reference Metrics ────────────────────────────────────
//
// Two-track architecture: Zone 1 (columns 1-12) = exact T.A.G. data.
// Zone 2 (columns 13-16) = payroll reference with meal deduction + 30-min floor.

export interface PayrollMetrics {
  /** Col 13 — exact system OT: max(0, finalWorkH − 8.0), no truncation */
  systemOtH:     number
  /** Col 14 — payroll OT: elapsed-threshold with 30-min floor truncation */
  payrollOtH:    number
  /** Col 15 — payroll night hours after 22:00 with 30-min floor truncation */
  payrollNightH: number
}

/**
 * Computes Zone 2 payroll-reference metrics from a ProcessedRecord's fields.
 *
 * Col 14 thresholds (elapsed = clockOut − effectiveClockIn):
 *   반반차  → 8 h  (6 h work + 1 h lunch + 1 h dinner)
 *   반차    → 6 h  (4 h work + 1 h lunch + 1 h dinner)
 *   default → 10 h (8 h work + 1 h lunch + 1 h dinner)
 *
 * 30-min floor: Math.floor(value / 0.5) * 0.5
 */
export function computePayrollMetrics(p: {
  effectiveClockIn: string | null | undefined
  clockOut:         string | null | undefined
  leaveType:        ErpLeaveType | null | undefined
  finalWorkH:       number
  nightHours:       number
}): PayrollMetrics {
  const { effectiveClockIn, clockOut, leaveType, finalWorkH, nightHours } = p

  let systemOtH = 0
  let payrollOtH = 0
  if (effectiveClockIn && clockOut) {
    // 오전반차/반반차: 표준출근시각으로 클램핑 (조기출근 OT 과산정 방지)
    const otStdInMins: number | null =
      leaveType === '오전반차'   ? 840 :
      leaveType === '오전반반차' ? 660 :
      null
    const rawInMins = parseTimeToMins(effectiveClockIn)
    const otInMins  = otStdInMins !== null ? Math.max(rawInMins, otStdInMins) : rawInMins
    const outMins   = parseTimeToMins(clockOut)
    const elapsed   = Math.max(0, (outMins - otInMins) / 60)
    const otClockIn = `${String(Math.floor(otInMins / 60)).padStart(2, '0')}:${String(otInMins % 60).padStart(2, '0')}`
    // 소정근로 (실근무 기준, 저녁 미포함)
    const stdWorkH: number =
      (leaveType === '오전반반차' || leaveType === '오후반반차') ? 6.0 :
      (leaveType === '오전반차'   || leaveType === '오후반차')   ? 4.0 :
      8.0
    // 점심 공제 (클램핑된 출근 기준)
    const lunchDeductH = computeLunchDeductMins(otClockIn) / 60
    const threshold = stdWorkH + lunchDeductH + 1.0  // +저녁 1h
    const rawOT = Math.max(0, elapsed - threshold)
    systemOtH  = rawOT
    payrollOtH = Math.floor(rawOT / 0.5) * 0.5
  }

  const payrollNightH = Math.floor(nightHours / 0.5) * 0.5

  return { systemOtH, payrollOtH, payrollNightH }
}

/**
 * Normalises a raw leave-text string (from an ERP note or Slack message) into one
 * of the canonical ErpLeaveType values.  Returns null when no leave keyword is found.
 *
 * Rule priority (most specific first):
 *   1. 반반차 (quarter-day) — checked before 반차 so "오전반반차" text is never
 *      mis-classified by the half-day branch.
 *   2. 연차 (full-day)
 *   3. 반차 (half-day) — direction from 오전/오후 keyword, then clock-time fallback.
 *
 * Clock-time fallback (only when direction keyword is absent):
 *   clockOut ≤ 14:00  →  오후반차  (left early → took afternoon off)
 *   clockIn  ≥ 12:00  →  오전반차  (arrived late → took morning off)
 *   otherwise         →  오전반차  (safe default)
 */
/** erpLeaveType 문자열(단일 또는 comma-separated) → erpLeaveAmount 숫자 변환.
 *  관리자 override(erpLeaveType)를 적용하는 모든 화면(admin/page.tsx, admin/fast/page.tsx)이
 *  같은 금액 산정 기준을 쓰도록 여기 한 곳에서만 정의한다. */
export function erpLeaveTypeToAmount(leaveType: string): number {
  if (leaveType === '없음') return 0
  if (leaveType.includes(',')) {
    return leaveType.split(',').reduce((sum, t) => sum + erpLeaveTypeToAmount(t.trim()), 0)
  }
  if (leaveType === '오전반반차' || leaveType === '오후반반차') return 0.25
  if (leaveType === '연차') return 1.0
  return 0.5  // 오전반차, 오후반차, 생일반차, 기타 반차류
}

/** erpLeaveType override 문자열 → { leaveType, erpLeaveAmount }. amount>=1.0(오전+오후 반차 합산 등)이면
 *  buildLeaveMap 정규화와 일관되게 '연차'로 통일.
 *  admin/page.tsx, admin/fast/page.tsx, compute-attendance route, recompute 스크립트, 리포트 export가
 *  모두 이 함수 하나만 참조하도록 단일 정의로 공유한다 (과거 페이지마다 따로 정의했던 것을 통합). */
export function leaveTypeOverrideFields(erpLeaveType: string): { leaveType: ErpLeaveType | null; erpLeaveAmount: number } {
  const amount = erpLeaveTypeToAmount(erpLeaveType)
  const primaryType: ErpLeaveType | null = erpLeaveType === '없음' ? null
    : amount >= 1.0 ? '연차'
    : (erpLeaveType.split(',')[0].trim() as ErpLeaveType)
  return { leaveType: primaryType, erpLeaveAmount: amount }
}

/** 관리자 override의 clockIn/clockOut/erpOtApplied/erpLeaveType 필드 형태 — 클라이언트 RecordOverride와
 *  Prisma AttendanceOverride 행 양쪽 모두 구조적으로 호환된다. */
export interface OverridePatch {
  clockIn:      string | null
  clockOut:     string | null
  erpOtApplied: boolean | null
  erpLeaveType: string | null
  memo?:        string | null
}

/** admin이 clockIn/clockOut을 명시적으로 override했는지 표시하는 플래그.
 *  processRecord.ts의 외근(Slack) 자동 클램프(최소 09~18시 보장)는 이 플래그가 없는 필드에만
 *  적용된다 — 관리자가 실제 시각을 직접 수정하면(2차 수정) 그 값을 그대로 사용한다. */
export function clockOverrideFields(
  ov: Pick<OverridePatch, 'clockIn' | 'clockOut'>,
): { clockInOverridden?: boolean; clockOutOverridden?: boolean } {
  return {
    ...(ov.clockIn  != null ? { clockInOverridden:  true } : {}),
    ...(ov.clockOut != null ? { clockOutOverridden: true } : {}),
  }
}

/**
 * 관리자가 수기 입력한 근태(예: 재택근무·연차)인데 원본 CAPS/ERP 행이 아예 없는 경우를 위한
 * 합성 RawRecord 생성. dayType/dayLabel은 호출부가 dataParser.getDayInfo()로 미리 계산해 전달한다
 * (attendanceCalc.ts는 dataParser.ts가 이미 import하고 있어 순환참조를 피하려고 직접 import하지 않음).
 */
export function synthesizeOverrideRecord(
  employeeId: string,
  date:       string,
  dayType:    DayType,
  dayLabel:   string,
  ov:         OverridePatch,
): RawRecord {
  return {
    employeeId,
    date,
    dayType,
    dayLabel,
    clockIn:          ov.clockIn  ?? null,
    clockOut:         ov.clockOut ?? null,
    erpOtApplied:     ov.erpOtApplied ?? false,
    verificationNote: [ov.memo ? `수기 입력: ${ov.memo}` : '수기 입력'],
    ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
    ...clockOverrideFields(ov),
  }
}

export function normalizeLeaveType(
  text: string | null | undefined,
  clockIn?: string | null,
  clockOut?: string | null,
): ErpLeaveType | null {
  if (!text) return null
  const t = text.trim()

  if (t.includes('반반차')) {
    if (t.includes('오전')) return '오전반반차'
    if (t.includes('오후')) return '오후반반차'
    return '오전반반차'
  }

  if (t.includes('연차')) return '연차'

  if (t.includes('반차')) {
    if (t.includes('오전')) return '오전반차'
    if (t.includes('오후')) return '오후반차'
    if (clockOut && parseTimeToMins(clockOut) <= parseTimeToMins('14:00')) return '오후반차'
    if (clockIn  && parseTimeToMins(clockIn)  >= parseTimeToMins('12:00')) return '오전반차'
    return '오전반차'
  }

  return null
}

/**
 * 4/1/4/1 슬라이딩 휴게 (테이블 인정시간/실제값 전용).
 * 근무 시작 기준 상대적 구간:
 *   +4h~+5h   → 점심 (최대 60m)
 *   +9h~+10h  → 저녁 (최대 60m)
 * 분단위 연속 계산 — 0/30/60/120 이산값 아님.
 */
export function compute4141BreakMins(
  elapsedMins: number,
  lunchThresholdMins = 240,
  dinnerThresholdMins = 540,
  capMins = 60,
): number {
  const lunch  = Math.min(Math.max(0, elapsedMins - lunchThresholdMins), capMins)
  const dinner = Math.min(Math.max(0, elapsedMins - dinnerThresholdMins), capMins)
  return lunch + dinner
}

export interface RealHoursOtResult {
  stayMins:         number   // 순체류
  realWorkMins:     number   // 실근무 (순체류 − 4/1/4/1 휴게)
  otherMins:        number   // 소정외(1.0x) raw, 1분 단위
  otMins:           number   // 법정연장(1.5x) raw, 1분 단위
  nightMins:        number   // 야간(+0.5x) raw, 1분 단위 (22:00~익일06:00 실제 겹침)
  payOtherH:        number   // 급여용 소정외 (ERP연장신청 게이트 + 30분 절삭)
  payOtH:           number   // 급여용 법정연장 (ERP연장신청 게이트 + 30분 절삭)
  payNightH:        number   // 급여용 야간 (ERP연장신청 게이트 + 30분 절삭)
  approvedWorkRawH: number   // 승인근무(원본) — 실근무 − 미신청 연장, 1분 단위
  approvedWorkPayH: number   // 승인근무(급여용) — 당일 소정시간 + 급여용 소정외 + 급여용 법정연장
  paidRecognizedH:  number   // 유급인정시간 — 승인근무(급여용) + 휴가 Credit
}

/**
 * 실근무시간 기준 소정외(1.0x)/법정연장(1.5x) 이원 계산.
 * 반차/반반차의 조기출근 보정(13:00/10:00 스냅)은 없음 — 전사 공통 08:00 floor만 유지, 그 외엔
 * 실제 clockIn 그대로 사용. credit(휴가 유급인정)은 ERP 승인 + 무급 아님일 때만 반영되고,
 * 소정근로 = 8h−credit, 소정외는 그 이후부터 실근무 8h까지, 법정연장은 실근무 8h 초과분.
 * 급여용 3종은 ERP 연장신청 승인 게이트 + 30분 절삭 — 단, 직책자는 OT를 급여 계산에 아예
 * 반영하지 않으므로(재량근로, 별도 리포팅) 급여용 3종/승인근무(급여용)/유급인정시간은 항상
 * 0으로 고정한다. 대신 승인근무(원본)은 "승인 여부와 무관하게 실근무 그대로"를 보여줘
 * 순수 실근무 시간(연장 포함) 파악 용도로 쓴다.
 */
export function computeRealHoursOt(params: {
  clockIn:             string | null | undefined
  clockOut:            string | null | undefined
  leaveType:           ErpLeaveType | null | undefined
  erpLeaveAmount:      number | null | undefined
  isUnpaidLeave:       boolean | null | undefined
  isErpLeaveApproved:  boolean
  erpOtApplied:        boolean | null | undefined
  isLeader?:           boolean
  /** 관리자가 clockIn을 명시적으로 override한 경우(2차 수정) — true면 아래 08:00 floor를
   *  건너뛰고 입력한 시각을 그대로 사용한다. processRecord.ts의 동일 원칙과 통일. */
  clockInOverridden?:  boolean | null
  // ── OT 엔진 통합(2026-09) — 아래는 전부 선택 파라미터, 기본값이 기존 하드코딩과 동일해서
  // 안 넘기면 예전과 100% 같게 동작한다(그리드/테이블/CSV는 아직 기본값 사용 — 근태규정.md
  // §3-3, 다음 라운드에서 effectiveStdH 반영 예정). processRecord.ts만 실제 정책/직원별
  // 예외값을 넘긴다.
  /** 최소 출근 floor(분) — policy.flexStart 파싱값. 기본 480(08:00) */
  flexStartMins?:      number
  /** 표준근무시간(분) — effectiveStdH*60(단축근무/임신부 등 예외 반영). 기본 480(8h) */
  stdWorkBaseMins?:    number
  /** 야간 시작(분) — policy.nightStart 파싱값. 기본 1320(22:00) */
  nightStartMins?:     number
  /** 야간 종료(분, 1440 이상 = 익일) — policy.nightEnd 파싱값 + 1440. 기본 1800(익일06:00) */
  nightEndMins?:       number
  otBreakLunchThresholdMins?: number
  otBreakDinnerThresholdMins?: number
  otBreakCapMins?:     number
}): RealHoursOtResult {
  const {
    clockIn, clockOut, leaveType, erpLeaveAmount, isUnpaidLeave, isErpLeaveApproved, erpOtApplied, isLeader, clockInOverridden,
    flexStartMins = 480, stdWorkBaseMins = 480, nightStartMins = 1320, nightEndMins = 1800,
    otBreakLunchThresholdMins = 240, otBreakDinnerThresholdMins = 540, otBreakCapMins = 60,
  } = params
  const empty = {
    stayMins: 0, realWorkMins: 0, otherMins: 0, otMins: 0, nightMins: 0,
    payOtherH: 0, payOtH: 0, payNightH: 0,
    approvedWorkRawH: 0, approvedWorkPayH: 0, paidRecognizedH: 0,
  }
  if (!clockIn || !clockOut) return empty

  const inMins  = clockInOverridden ? parseTimeToMins(clockIn) : Math.max(parseTimeToMins(clockIn), flexStartMins)
  const outMins = parseTimeToMins(clockOut)
  const stayMins = Math.max(0, outMins - inMins)
  const breakMins = compute4141BreakMins(stayMins, otBreakLunchThresholdMins, otBreakDinnerThresholdMins, otBreakCapMins)
  const realWorkMins = Math.max(0, stayMins - breakMins)

  const creditMins  = (leaveType && isErpLeaveApproved && !isUnpaidLeave) ? (erpLeaveAmount ?? 0) * 8 * 60 : 0
  const stdWorkMins = Math.max(0, stdWorkBaseMins - creditMins)
  const otherMins = Math.min(Math.max(0, realWorkMins - stdWorkMins), stdWorkBaseMins - stdWorkMins)
  const otMins    = Math.max(0, realWorkMins - stdWorkBaseMins)

  const nightMins = Math.max(0, Math.min(outMins, nightEndMins) - Math.max(inMins, nightStartMins))

  // 급여용 게이트 — 직책자는 OT를 급여 계산에 반영하지 않으므로 항상 잠김(0).
  const payGate = isLeader !== true && erpOtApplied === true
  const payOtherH = payGate ? floorTo30(otherMins / 60) : 0
  const payOtH    = payGate ? floorTo30(otMins    / 60) : 0
  const payNightH = payGate ? floorTo30(nightMins / 60) : 0

  // 승인근무(원본) 게이트 — 직책자는 승인 개념 자체가 없어 항상 열림(실근무 그대로),
  // 비직책자는 연장신청 승인 시에만 열림(미신청 시 소정외+법정연장 제외한 소정시간만 인정).
  const rawApproveGate = isLeader === true || erpOtApplied === true
  const approvedWorkRawH = rawApproveGate ? realWorkMins / 60 : (realWorkMins - otherMins - otMins) / 60
  // 승인근무(급여용)/유급인정시간 — 직책자는 급여용 OT를 아예 계산하지 않으므로 0 고정.
  const approvedWorkPayH = isLeader === true ? 0 : stdWorkMins / 60 + payOtherH + payOtH
  const paidRecognizedH  = isLeader === true ? 0 : approvedWorkPayH + creditMins / 60

  return {
    stayMins, realWorkMins, otherMins, otMins, nightMins, payOtherH, payOtH, payNightH,
    approvedWorkRawH, approvedWorkPayH, paidRecognizedH,
  }
}

/**
 * computeRealHoursOt의 ProcessedRecord 래퍼 — AttendanceResultTable.tsx/exportCsv.ts/
 * EmployeeCalendarGrid.tsx 3곳에서 동일하게 재사용. 휴일근무(dayType!=='WEEKDAY')는
 * 소정외=0, 법정연장 슬롯에 기존 r.holidayHours(이미 검증된 값)를 그대로 사용 —
 * 순체류/실근무/야간은 휴일이어도 실제 시각 기준 그대로 계산.
 */
export function computeRealHoursOtForRecord(r: {
  dayType:           DayType
  clockIn?:          string | null
  clockOut?:         string | null
  effectiveClockIn?: string | null
  leaveType?:        ErpLeaveType | null
  erpLeaveAmount?:   number | null
  isUnpaidLeave?:    boolean | null
  verificationNote?: string[] | null
  holidayHours?:     number | null
  erpOtApplied?:     boolean | null
  clockInOverridden?: boolean | null
}, isLeader = false): RealHoursOtResult {
  const isSlackInjected    = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
  const isErpLeaveApproved = r.leaveType ? !isSlackInjected : true
  // r.clockIn 우선 — 이 함수는 "조기보정 없는 실제 출근시각"이 기준이라, processRecord.ts가
  // 일반 근무일에도 채워두는 effectiveClockIn(반차 등 정책상 스냅 포함)을 그냥 쓰면 안 된다.
  // 다만 외근(직출·직퇴)은 CAPS 입실 태그 자체가 없어 clockIn이 null인 게 정상인 케이스라,
  // 그때만 applyOffsiteEntry가 계산해 둔 effectiveClockIn(보정 출근시각)으로 대체한다 —
  // 안 그러면 태그가 없다는 이유로 실근무/승인근무 등이 전부 0(화면엔 "—")으로 빈다.
  const base = computeRealHoursOt({
    clockIn: r.clockIn ?? r.effectiveClockIn, clockOut: r.clockOut, leaveType: r.leaveType,
    erpLeaveAmount: r.erpLeaveAmount, isUnpaidLeave: r.isUnpaidLeave,
    isErpLeaveApproved, erpOtApplied: r.erpOtApplied, isLeader,
    clockInOverridden: r.clockInOverridden,
  })
  if (r.dayType === 'WEEKDAY') return base
  // 휴일근로는 ERP 연장신청 체계 밖 — 구글폼으로 수기 확인하는 별도 프로세스라
  // erpOtApplied 게이트를 걸지 않고 항상 표시한다 (미신청 이슈 자체가 없음). 승인/소정시간
  // 개념도 적용되지 않으므로 승인근무·유급인정은 실근무 그대로.
  return {
    ...base,
    otherMins: 0,
    otMins:    (r.holidayHours ?? 0) * 60,
    payOtherH: 0,
    payOtH:    floorTo30(r.holidayHours ?? 0),
    payNightH: 0,
    approvedWorkRawH: base.realWorkMins / 60,
    approvedWorkPayH: base.realWorkMins / 60,
    paidRecognizedH:  base.realWorkMins / 60,
  }
}

/** 30분 단위 절삭 (시간 단위 입력) — EmployeeCalendarGrid.tsx/AllowanceTab.tsx/SummaryTab.tsx에
 *  각자 따로 있던 동일 구현을 여기로 통합. 새 집계 코드는 이걸 재사용할 것. */
export function floorTo30(h: number): number {
  return Math.floor(h * 2) / 2
}

/**
 * "총 근로시간" 확정 공식(§4) — 레코드 1건의 인정시간을 하루치로 환산한다.
 *   직책자: netRecH(uncapped) + credit
 *   비직책자: 연장근로 발생일(approvedOt>0) → 8h + approvedOt (credit 이중계상 방지)
 *            없는 날 → min(netRecH,8) + credit
 *   휴일근무: floorTo30(holidayHours), 그 외 비근무일: 0
 * EmployeeCalendarGrid.tsx의 52h/209h 초과자 필터와 동일 공식 — 원래 그 필터 안에 인라인으로만
 * 있던 걸 여기로 추출해서 Overview 등 다른 화면도 정확히 같은 기준으로 재사용할 수 있게 함.
 */
export function computeDailyRecognizedHours(r: ProcessedRecord, isLeaderToday: boolean): number {
  const isSlackInj    = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
  const isErpApproved = r.leaveType ? !isSlackInj : true
  const credit        = (isErpApproved && !r.isUnpaidLeave && r.erpLeaveAmount) ? r.erpLeaveAmount * 8 : 0

  if (r.dayType !== 'WEEKDAY') {
    return r.finalStatus === '휴일근무' ? floorTo30(r.holidayHours ?? 0) : 0
  }
  const effClockInStr = r.effectiveClockIn ?? r.clockIn
  const ciEff = effClockInStr ? parseTimeToMins(effClockInStr) : null
  const co    = r.clockOut ? parseTimeToMins(r.clockOut) : null
  if (ciEff === null || co === null) return credit

  const elapsed = Math.max(0, co - ciEff)
  const netRecH = Math.max(0, elapsed - compute4141BreakMins(elapsed)) / 60
  if (isLeaderToday) return netRecH + credit

  const approvedOt = r.erpOtApplied ? (r.overtimeHours ?? 0) : 0
  return approvedOt > 0 ? (8 + approvedOt) : (Math.min(netRecH, 8) + credit)
}

/**
 * §4 공식에서 "연장(초과)근로" 부분만 분리한 값 — computeDailyRecognizedHours()의 정산용
 * 총시간(8h+연장 또는 min(netRecH,8)+credit)에서 8h 표준분을 뺀 순수 초과분이다.
 *   비직책자: 미승인이면 0 (총시간 계산에서도 OT를 안 더하는 것과 동일 기준) —
 *             승인이면 r.overtimeHours 그대로(이미 30분 절삭 + ERP 가드 적용됨)
 *   직책자:   netRecH(uncapped) - 8, 음수면 0 (절삭 없음)
 *   휴일근무/비근무일: 0 — 휴일근로는 별도 지표(holidayHours)로 집계한다.
 */
export function computeDailyRecognizedOtHours(r: ProcessedRecord, isLeaderToday: boolean): number {
  if (r.dayType !== 'WEEKDAY') return 0
  if (isLeaderToday) {
    const effClockInStr = r.effectiveClockIn ?? r.clockIn
    const ciEff = effClockInStr ? parseTimeToMins(effClockInStr) : null
    const co    = r.clockOut ? parseTimeToMins(r.clockOut) : null
    if (ciEff === null || co === null) return 0
    const elapsed = Math.max(0, co - ciEff)
    const netRecH = Math.max(0, elapsed - compute4141BreakMins(elapsed)) / 60
    return Math.max(0, netRecH - 8)
  }
  return r.erpOtApplied ? (r.overtimeHours ?? 0) : 0
}

// ── GAS pipeline utilities (leave-last model) ────────────────────────────
// Break is computed on raw Work-A before leave credit, matching the GAS
// leave-last formula used in Col 10 (근로A) and Col 12 (근로B).

const GAS_LUNCH_START = 750  // 12:30
const GAS_LUNCH_END   = 810  // 13:30

/**
 * Engine B display break (집계·엑셀 출력용).
 * Returns one of {0, 30, 60, 120} minutes.
 *
 * Bracket (근무A 구간):
 *   < 4h  → 0분
 *   4–8h  → 30분 (단, 점심 12:30~13:30을 60분 완전히 걸치면 60분)
 *   8–12h → 60분
 *   ≥12h  → 120분 (점심+저녁)
 *
 * 반차/반반차 저녁 추가:
 *   GAS 임계값(effectiveClockIn + 6h/반차, 8h/반반차)을 clockOut이 넘으면
 *   저녁까지 근무한 것으로 보아 120분으로 올림.
 */
export function computeDisplayBreakMins(
  workAMins:    number | null,
  clockInMins:  number | null,
  clockOutMins: number | null,
  leaveType?:   string | null,
): number {
  if (!workAMins || workAMins <= 0) return 0

  // Base bracket
  // 저녁 휴게(60분)는 표준퇴근(clockIn+9h) 이후 퇴근 시 공제 — 연차없음 기준
  // 반차/반반차는 아래 별도 임계값으로 처리
  let baseMins: number
  if (workAMins >= 720) {
    baseMins = 120                           // 12h+ → 점심+저녁 (저녁 grace zone 처리는 그리드에서 별도)
  } else if (workAMins >= 480) {
    baseMins = 60                            // 8–9h → 점심
  } else if (workAMins >= 240) {
    // 4–8h → 기본 30분, 점심 60분 완전 겹침 시 60분
    if (clockInMins !== null && clockOutMins !== null) {
      const lunchOverlap = Math.max(0,
        Math.min(clockOutMins, GAS_LUNCH_END) - Math.max(clockInMins, GAS_LUNCH_START)
      )
      baseMins = lunchOverlap >= 60 ? 60 : 30
    } else {
      baseMins = 30
    }
  } else {
    baseMins = 0
  }

  // 반차/반반차 저녁 휴게: GAS 임계값 초과 시 120분으로 올림
  // 반차  = effectiveClockIn + 6h (4h 실근무 + 점심 1h + 저녁 1h)
  // 반반차 = effectiveClockIn + 8h (6h 실근무 + 점심 1h + 저녁 1h)
  if (baseMins < 120 && leaveType && clockInMins !== null && clockOutMins !== null) {
    const isHalf    = leaveType.includes('반차') && !leaveType.includes('반반차')
    const isQuarter = leaveType.includes('반반차')
    if (isHalf || isQuarter) {
      const dinnerThreshMins = clockInMins + (isHalf ? 360 : 480)
      if (clockOutMins > dinnerThreshMins) {
        baseMins = 120  // 점심 + 저녁
      }
    }
  }

  return baseMins
}

export function computeGasOtThreshMins(leaveDays: number): number {
  if (leaveDays >= 0.5) return 360   // 반차: 6h (4h 실근무 + 점심 1h + 저녁 1h)
  if (leaveDays >= 0.25) return 480  // 반반차: 8h
  return 600                          // 기본: 10h
}

export function computeGasNightMins(clockOut: string | null | undefined, isLeader?: boolean): number {
  if (!clockOut) return 0
  const outMins = parseTimeToMins(clockOut)
  if (outMins <= 1320) return 0
  const raw = outMins - 1320
  return isLeader ? raw : Math.floor(raw / 30) * 30
}

// 출근 시각 기반 점심 공제 계산 (방법 A — EmployeeCalendarGrid 등 레거시 호출용)
function computeLunchDeductMins(clockIn?: string | null): number {
  if (!clockIn) return 60
  const inMins = parseTimeToMins(clockIn)
  if (inMins >= GAS_LUNCH_END)  return 0
  if (inMins > GAS_LUNCH_START) return GAS_LUNCH_END - inMins
  return 60
}

// ── 레거시 OT 함수 (EmployeeCalendarGrid 전용, 신규 급여 지표에는 아래 v2 사용) ─────
export function computeGasPayOtMins(
  workAMins:  number,
  leaveDays:  number,
  status:     string | null | undefined,
  clockIn?:   string | null,
): number {
  void status
  const stdWorkMins = leaveDays >= 0.5 ? 240 : leaveDays >= 0.25 ? 360 : 480
  const allowance   = stdWorkMins + computeLunchDeductMins(clockIn) + 60
  return Math.max(0, Math.floor((workAMins - allowance) / 30) * 30)
}

export function computeLeaderOtMins(
  rawWorkAMins: number,
  leaveDays:    number,
  status:       string | null | undefined,
  clockIn?:     string | null,
): number {
  void status
  const stdWorkMins = leaveDays >= 0.5 ? 240 : leaveDays >= 0.25 ? 360 : 480
  const allowance   = stdWorkMins + computeLunchDeductMins(clockIn) + 60
  return Math.max(0, rawWorkAMins - allowance)
}

// ── 급여 지표 v2: 시차출퇴근제 슬라이딩 타임 블록 ────────────────────────────────
//
// 보정 출근 effIn = MAX(실제출근, 표준출근)
//   연차없음/오후반차/오후반반차: 08:00
//   오전반반차: 10:00
//   오전반차:   13:00
//
// 가상 출근 virtualIn = effIn - 연차 역산
//   반반차(0.25): -2h / 반차(0.5): -5h / 그 외: 0
//
// OT 시작 = virtualIn + 10h (소정8h + 점심1h + 저녁1h)

// ERP 미승인(Slack 주입) 시 오전 반차 혜택 박탈 → 08:00 기준으로 강제 전환
export function computeEffInMins(
  inMins:             number,
  leaveType:          ErpLeaveType | null | undefined,
  isErpLeaveApproved = true,
): number {
  const std =
    (leaveType === '오전반차'   && isErpLeaveApproved) ? 780 :  // 13:00
    (leaveType === '오전반반차' && isErpLeaveApproved) ? 600 :  // 10:00
    480                                                           // 08:00
  return Math.max(inMins, std)
}

/** 분 → "HH:MM" 문자열 변환 (인정시간 표시용) */
export function minsToHHMM(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** clockIn 문자열 → 근무유형별 보정 출근시각 (인정시간 탭 표시·계산 공용) */
export function computeEffClockIn(
  clockIn:            string | null | undefined,
  leaveType:          ErpLeaveType | null | undefined,
  isErpLeaveApproved = true,
): string | null {
  if (!clockIn) return null
  return minsToHHMM(computeEffInMins(parseTimeToMins(clockIn), leaveType, isErpLeaveApproved))
}

// 오전 반차 계열 + ERP 승인 시에만 역산. 오후 반차 계열 및 미승인은 역산 없음.
export function computeVirtualInMins(
  effInMins:          number,
  leaveType:          ErpLeaveType | null | undefined,
  isErpLeaveApproved = true,
): number {
  const backtrack =
    (leaveType === '오전반차'   && isErpLeaveApproved) ? 300 :
    (leaveType === '오전반반차' && isErpLeaveApproved) ? 120 :
    0
  return effInMins - backtrack
}

/** 급여용 연장 — 일반 직원 (30분 절삭). ERP 연장 신청 여부는 호출부에서 처리. */
export function computePayOtMins(
  clockIn:            string | null | undefined,
  clockOut:           string | null | undefined,
  leaveType:          ErpLeaveType | null | undefined,
  isErpLeaveApproved = true,
): number {
  if (!clockIn || !clockOut) return 0
  const inMins  = parseTimeToMins(clockIn)
  const outMins = parseTimeToMins(clockOut)
  const effIn   = computeEffInMins(inMins, leaveType, isErpLeaveApproved)
  const virtIn  = computeVirtualInMins(effIn, leaveType, isErpLeaveApproved)
  const raw     = Math.max(0, outMins - (virtIn + 600))
  return Math.floor(raw / 30) * 30
}

/** 급여용 연장 — 직책자 (절삭 없음, ERP 무관). */
export function computeLeaderPayOtMins(
  clockIn:            string | null | undefined,
  clockOut:           string | null | undefined,
  leaveType:          ErpLeaveType | null | undefined,
  isErpLeaveApproved = true,
): number {
  if (!clockIn || !clockOut) return 0
  const inMins  = parseTimeToMins(clockIn)
  const outMins = parseTimeToMins(clockOut)
  const effIn   = computeEffInMins(inMins, leaveType, isErpLeaveApproved)
  const virtIn  = computeVirtualInMins(effIn, leaveType, isErpLeaveApproved)
  return Math.max(0, outMins - (virtIn + 600))
}

/**
 * 급여용 휴일근로 — '4+1 반복 패턴' 휴게공제
 *   1차 휴게 (4h 초과): MIN(60, MAX(0, 체류 - 240))
 *   2차 휴게 (9h 초과): MIN(60, MAX(0, 체류 - 540))
 * 직책자/비직책자 모두 30분 절삭. noTruncation=true는 실제값 버튼 전용.
 */
export function computeHolidayPayMins(stayMins: number, noTruncation = false): number {
  const d1  = Math.min(60, Math.max(0, stayMins - 240))
  const d2  = Math.min(60, Math.max(0, stayMins - 540))
  const net = Math.max(0, stayMins - d1 - d2)
  return noTruncation ? net : Math.floor(net / 30) * 30
}
