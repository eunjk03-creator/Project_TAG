/**
 * Canonical attendance calculation — 4-step time math (Steps 1-4)
 * + Step 3 anomaly threshold engine (computeStatusN).
 *
 * Single source of truth for both the UI table and Excel export.
 * All hour values are decimal (e.g. 8h 30m = 8.5).
 */
import type { DayType, ErpLeaveType } from '@/types/tag'

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
 * Lateness and early-departure thresholds by leave type.
 *
 * Late threshold (clock-in must be ≤ this time):
 *   오전반반차   → 11:00   오전반차  → 14:00
 *   isTenAMStarter → 10:00   default   → 09:00
 *   (leave-type rules take priority over the employee exception flag)
 *
 * Early-departure threshold (duration-based):
 *   오전반차    → workA ≥ 4.5h   오전반반차 → workA ≥ 6.0h
 *   오후반반차  → workA ≥ 6.0h   오후반차   → workA ≥ 4.5h
 *   default     → workA ≥ 9.0h
 *
 * Severity: > 30 min short → 이상치; ≤ 30 min → 조기퇴근.
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

  // ── 3. Early-departure threshold ─────────────────────────────────────────
  let isEarly      = false
  let earlyMinutes = 0

  {
    // Duration-based: required stay hours depend on leave type
    // 반차 (half-day): 4h30min   반반차 (quarter-day): 6h   default: 9h
    const requiredH: number =
      leaveType === '오전반차'   ? 4.5 :
      leaveType === '오후반차'   ? 4.5 :
      leaveType === '오전반반차' ? 6.0 :
      leaveType === '오후반반차' ? 6.0 :
      9.0

    const workA = computeWorkA(clockIn, clockOut)
    if (workA < requiredH) {
      isEarly      = true
      earlyMinutes = Math.round((requiredH - workA) * 60)
    }
  }

  // ── 4. Severity split & catch-all ────────────────────────────────────────
  const isSevere = isEarly && earlyMinutes > 30

  // Fires only when no other flags are set AND there is no leave credit
  const isCatchAll = !isLate && !isEarly && leaveAmt === 0 && finalWorkH < 8.0

  // ── 5. Priority resolution ────────────────────────────────────────────────
  if (isSevere || isCatchAll)  return '이상치'
  if (isLate   && isEarly)     return '지각+조기퇴근'
  if (isLate)                  return '지각'
  if (isEarly)                 return '조기퇴근'
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
export function compute4141BreakMins(elapsedMins: number): number {
  const lunch  = Math.min(Math.max(0, elapsedMins - 240), 60)
  const dinner = Math.min(Math.max(0, elapsedMins - 540), 60)
  return lunch + dinner
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
 * 직책자는 절삭 없음.
 */
export function computeHolidayPayMins(stayMins: number, isLeader?: boolean): number {
  const d1  = Math.min(60, Math.max(0, stayMins - 240))
  const d2  = Math.min(60, Math.max(0, stayMins - 540))
  const net = Math.max(0, stayMins - d1 - d2)
  return isLeader ? net : Math.floor(net / 30) * 30
}
