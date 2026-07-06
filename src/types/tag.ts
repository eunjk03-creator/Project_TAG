export interface CompanyHoliday {
  date:  string   // 'YYYY-MM-DD'
  label: string   // e.g. '5월 전사휴무'
}

export interface PolicySettings {
  flexStart: string
  flexEnd: string
  lunchStart: string
  lunchEnd: string
  standardHours: number
  dinnerGraceMinutes: number
  otUnitMinutes: number
  nightStart: string
  nightEnd: string
  otRate: number
  nightRate: number
  holidayRate: number
  holidayExcessRate: number
  companyHolidays: CompanyHoliday[]
  /** Slack subteam/usergroup ID → division name. Resolves <subteam^ID> mentions in Slack messages for 동명이인 disambiguation. */
  slackGroupMap?: Record<string, string>
}

export const DEFAULT_POLICY: PolicySettings = {
  flexStart: '08:00',
  flexEnd: '09:00',
  lunchStart: '12:30',
  lunchEnd: '13:30',
  standardHours: 8,
  dinnerGraceMinutes: 60,
  otUnitMinutes: 30,
  nightStart: '22:00',
  nightEnd: '06:00',
  otRate: 1.5,
  nightRate: 0.5,
  holidayRate: 1.5,
  holidayExcessRate: 2.0,
  companyHolidays: [],
  slackGroupMap: {},
}

export type DayType = 'WEEKDAY' | 'WEEKEND' | 'HOLIDAY'
export type SieveFlag =
  | 'LATE'
  | 'NO_CLOCK_IN'               // weekday, no leave, no clock-in record → 근태이상
  | 'NO_CLOCK_OUT'              // weekday, clock-in exists, no clock-out record → 근태이상
  | 'EARLY_DEPARTURE'           // mild: 0–30 min before standard end → 조기퇴근
  | 'ATTENDANCE_ANOMALY'        // severe: >30 min before standard end → 근태이상
  | 'LATE_AND_EARLY_DEPARTURE'  // combined: late + mild early
  | 'LATE_AND_ANOMALY'          // combined: late + severe early → 근태이상
  | null

/**
 * T.A.G. final attendance status — one canonical value per daily record.
 *
 * CATEGORY 1 — NORMAL (정상): no HR violation
 * CATEGORY 2 — ANOMALY (근태이상): requires HR action
 * CATEGORY 3 — HOLIDAY_WORK (휴일근무): worked on weekend/public holiday
 */
export type FinalStatus =
  // ── Category 1: Normal ──────────────────────────────────────────────────
  | '정상'       // standard weekday, no issues
  | '연장근로'   // OT with approved ERP application
  | '연차'       // full-day leave (ERP or Slack)
  | '오전반차'   // AM half-day
  | '오후반차'   // PM half-day
  | '외근'       // off-site work — anomaly cleared by Slack confirmation
  // ── Category 2: Anomaly ─────────────────────────────────────────────────
  | '지각'          // clock-in exceeds flexEnd
  | '조기퇴근'      // 0–30 min before standard end
  | '근태이상'      // >30 min before standard end, or combined late+severe early
  | '지각+조기퇴근' // combined: late + mild early departure
  | '출퇴근누락'    // missing clock-in or clock-out (no ERP leave to justify)
  // ── Category 3: Holiday Work ────────────────────────────────────────────
  | '휴일근무'    // worked on weekend or public holiday
  // ── Non-working states ───────────────────────────────────────────────────
  | '주말'       // weekend with no attendance
  | '공휴일'     // public holiday with no attendance

export type FinalStatusCategory = 'NORMAL' | 'ANOMALY' | 'HOLIDAY_WORK' | 'NON_WORKING'

export const FINAL_STATUS_CATEGORY: Readonly<Record<FinalStatus, FinalStatusCategory>> = {
  '정상':     'NORMAL',  '연장근로': 'NORMAL',  '연차':     'NORMAL',
  '오전반차': 'NORMAL',  '오후반차': 'NORMAL',  '외근': 'NORMAL',
  '지각':     'ANOMALY', '조기퇴근': 'ANOMALY', '근태이상': 'ANOMALY',
  '지각+조기퇴근': 'ANOMALY', '출퇴근누락': 'ANOMALY',
  '휴일근무': 'HOLIDAY_WORK',
  '주말':     'NON_WORKING', '공휴일': 'NON_WORKING',
}

/**
 * Leave / absence types recognised by the ERP 신청구분 column.
 * Superset of the legacy inline union — all existing values remain valid.
 */
export type ErpLeaveType =
  | '연차'
  | '반차'       // combined half-day (0.5) — 오전+오후 반반차 합산 결과
  | '오전반차'   // morning half-day (0.5)
  | '오후반차'   // afternoon half-day (0.5)
  | '오전반반차' // morning quarter-day (0.25)
  | '오후반반차' // afternoon quarter-day (0.25)

export interface Employee {
  /** Composite primary key: "${employeeId}_${normalizeName(name)}" */
  id: string
  /** Original 사원번호 from the source file — use for display only, NOT for lookups */
  rawId?: string
  name: string
  division: string
  team: string
  part?: string
  jobTitle: string
  /** True when jobTitle matches a managerial role — exempted from 미신청OT flagging */
  isLeader?: boolean
  /** Original 부서 value from CSV before org-structure mapping */
  rawDept?: string
}

export interface RawRecord {
  employeeId: string
  date: string
  dayType: DayType
  dayLabel: string
  clockIn: string | null
  clockOut: string | null
  erpOtApplied: boolean
  /** Approved OT hours from the ERP overtime file (HH.MM decoded to decimal) */
  erpApprovedOtHours?: number
  leaveType?: ErpLeaveType | null
  isHolidayWork?: boolean
  isLeader?: boolean
  /** Cross-check flags: '출퇴근 누락' | '휴가 중 출근' | '연장 미신청' */
  verificationNote?: string[]
  /** Fractional leave days as provided directly by ERP '일수' column.
   *  Bypasses the hardcoded LEAVE_AMOUNT table — use this for all exports. */
  erpLeaveAmount?: number
  /** True when the ERP leave code contains '무급' — contributes 0h instead of 8h in 근무B. */
  isUnpaidLeave?: boolean
  /** Original ERP 근태코드 before mapping (e.g. '배우자 출산휴가', '리프레쉬휴가(3년)') */
  rawLeaveCode?: string
  /** Individual ERP leave codes actually submitted for this date, in submission order.
   *  `leaveType`/`erpLeaveAmount` collapse same-day multi-request combos (e.g. 오전반차+오후반차
   *  → '연차' 1.0) for calculation purposes — this array preserves the original 1+ requests
   *  so the UI can show exactly what was applied for, not just the merged total. */
  leaveCodesDetail?: ErpLeaveType[]
}

export interface ProcessedRecord extends RawRecord {
  effectiveClockIn: string | null
  regularHours: number
  overtimeHours: number
  /** Exact overtime minutes before 30-min truncation. Undefined when OT is 0. */
  rawOvertimeMinutes?: number
  nightHours: number
  holidayHours: number
  breakMinutes: number   // actual deducted break time in minutes
  lunchDeducted: boolean
  dinnerDeducted: boolean
  flag: SieveFlag
  finalStatus: FinalStatus
}

export interface AggregatedStats {
  label: string
  totalHours: number
  regularHours: number
  overtimeHours: number
  nightHours: number
  holidayHours: number
  employeeCount: number
}

export type DrilldownLevel = '전체' | '본부' | '팀' | '파트' | '개인'
export type PeriodType = '1일' | '1주' | '2주' | '3주' | '4주' | '1개월'
export type DateRange = { from: string; to: string }

export interface EditHistoryEntry {
  timestamp:   string        // ISO 8601
  adminName:   string
  oldValue:    { clockIn: string | null; clockOut: string | null }
  newValue:    { clockIn: string | null; clockOut: string | null }
  reason:      string
  action?:     string        // pre-computed smart audit log (e.g. "[CAPS] 입실 09:08→08:50 / [상태] 지각→정상")
}

export type ResolutionData = {
  reasonLabel: string
  memo:        string
}

// ── Risk view ──────────────────────────────────────────────────────────────

export type RiskView = 'hr' | 'exec'

export interface RiskThresholds {
  view:            RiskView
  /** Period total hours per employee — amber (legal limit is still the hard red) */
  totalAmberH:     number
  /** Single-day overtime hours in the table view — triggers ⚠️ */
  dailyOtWarnH:    number
  /** Per-employee / division avg OT — amber */
  otAmberH:        number
  /** Per-employee / division avg OT — red */
  otRedH:          number
  /** Workload intensity % — amber */
  intensityAmber:  number
  /** Workload intensity % — red */
  intensityRed:    number
}

export const HR_THRESHOLDS: RiskThresholds = {
  view:           'hr',
  totalAmberH:    45,
  dailyOtWarnH:   5,
  otAmberH:       5,
  otRedH:         10,
  intensityAmber: 90,
  intensityRed:   100,
}

export const EXEC_THRESHOLDS: RiskThresholds = {
  view:           'exec',
  totalAmberH:    50,
  dailyOtWarnH:   12,
  otAmberH:       10,
  otRedH:         15,
  intensityAmber: 100,
  intensityRed:   110,
}

// ── Per-employee processing attribute overrides ────────────────────────────
// Stored in EmployeeExceptionsContext, passed to useAttendanceLogic so that
// toggling a flag in the drawer triggers an immediate re-computation.

export interface EmployeeAttributeOverrides {
  /** 직책자: OT 30분 절삭 없음, 수당집계에서 연장수당 미지급 (리포팅 전용) */
  isLeader?:            boolean
  /** 육아휴직자: exempt from ALL anomaly checks — always shows 정상/연차 */
  isParentalLeave?:     boolean
  parentalLeaveFrom?:   string  // YYYY-MM-DD
  parentalLeaveTo?:     string
  /** 단축근로: override policy.standardHours with shortenedHoursValue */
  isShortenedHours?:    boolean
  /** Effective hours/day when isShortenedHours is true (default 6) */
  shortenedHoursValue?: number
  shortenedHoursFrom?:  string
  shortenedHoursTo?:    string
  /** 10시 출근자: snap effectiveIn to 10:00; LATE / OT thresholds shift accordingly */
  isTenAMStarter?:      boolean
  /** 파견자: skip NO_CLOCK_OUT flag — missing punch is expected */
  isDispatchedWorker?:  boolean
  dispatchedWorkerFrom?: string
  dispatchedWorkerTo?:   string
  /** 이지로지스: special subsidiary — suppress all anomaly flags */
  isEasyLogis?:         boolean
  /** 특수근무제 A: In 08:00 snap, Out ≥ 16:00, Break 30 min, Late >08:00 */
  isFixedScheduleA?:  boolean
  /** 특수근무제 B: In 08:30 snap, Out ≥ 12:30, Break 0 min, Late >08:30 */
  isFixedScheduleB?:  boolean
  /** 임산부: (actual + leave-equiv) ≥ 360 min required; otherwise ATTENDANCE_ANOMALY */
  isPregnantReduced?: boolean
  /** 임신기 단축근로 적용 시작일 (YYYY-MM-DD, 없으면 항상 적용) */
  pregnantReducedFrom?: string
  /** 임신기 단축근로 적용 종료일 (YYYY-MM-DD, 없으면 항상 적용) */
  pregnantReducedTo?: string
  /** 전체 제외: record is silently skipped from all aggregation and flagging */
  isGlobalExclusion?: boolean
  /** 퇴사자: same as global exclusion — completely filtered from all output */
  isResigned?: boolean
  resignedFrom?: string  // 퇴사일 (YYYY-MM-DD) — 이 날 이후로 적용
}

export type RecordOverride = {
  clockIn:      string | null
  clockOut:     string | null
  erpOtApplied: boolean | null  // null = not overridden; true/false = explicit admin override
  erpLeaveType: string | null   // null = not overridden; '없음' = explicitly cleared; other = set to that type
  editHistory:  EditHistoryEntry[]
  memo?:        string
  reasonLabel?: string
}

// ── CSV raw row shapes ─────────────────────────────────────────────────────
// These mirror the exact column headers from the uploaded files so parsers
// can be typed end-to-end without casting.

/**
 * One row from the CAPS raw clockin/out export (RAW .xls).
 * Actual column headers from the export: 부서 · 직급 · 사원번호 · 이름 · 근무일자 · 근무일명칭 · 출근 · 퇴근 · …
 */
export interface CapsRow {
  사원번호: string
  이름:     string
  부서:     string
  직급:     string
  근무일자: string        // raw date — 'YYYY-MM-DD', 'YYYY/MM/DD', or 'M/D/YYYY'
  출근:     string | null // empty string or null when not clocked in
  퇴근:     string | null
}

/**
 * One row from the ERP leave export (File 2 — leave/absence only).
 * 근태코드 = leave type: 연차 | 오전반차 | 출장 | 재택근무 | …
 */
export interface ErpRow {
  사원번호: string
  성명:     string
  근태코드: string   // leave type code
  승인상태: string   // '승인' | '신청' | '반려' | '취소' | …
  시작일:   string
  시작시간: string   // 'HH:MM' or empty
  종료일:   string
  종료시간: string
}

/**
 * One row from the ERP overtime export (File 3 — 연장근로 only).
 * 인정시간 uses HH.MM notation: "2.30" = 2 h 30 min (NOT 2.3 h).
 */
export interface ErpOtRow {
  사원번호: string
  성명:     string
  근태코드: string   // '연장근로'
  승인상태: string   // '승인' | '신청' | …
  시작일:   string
  종료일:   string
  인정시간: string   // HH.MM — "1.00" = 1 h, "2.30" = 2.5 h
}

/**
 * Unified ERP row — single APPLY.xlsx export that contains BOTH leave and overtime rows.
 * Parser categorises each row by 근태코드:
 *   • OT_CODE_SET (연장근로, 휴일근로, …) → OT map
 *   • ERP_LEAVE_TYPE_MAP keys            → leave map
 * 종료일 is optional (absent for OT rows), 인정시간 optional (absent for leave rows).
 */
export interface ErpUnifiedRow {
  사원번호:  string
  성명:      string
  근태코드:  string
  승인상태:  string
  시작일:    string
  종료일?:   string
  인정시간?: string
  일수?:     string   // fractional leave days as provided by ERP (e.g. "0.5", "1", "2")
  근태구분?: string   // '일' (day-based) | '시간' (time-based) — time-based rows skip leave pipeline
}

/**
 * ERP 신청구분 values that represent approved overtime when 승인상태 === '승인'.
 * Maps to RawRecord.erpOtApplied = true.
 */
export const ERP_OT_TYPES = ['연장근무', '시간외근무', '연장근로'] as const
export type ErpOtType = (typeof ERP_OT_TYPES)[number]

/**
 * ERP 승인상태 values that count as accepted (approved or pending).
 * '상신' = submitted/forwarded; '신청' = applied.
 * Rejection criteria: any value containing '취소' or '반려'.
 */
export const ERP_APPROVED_STATUSES = ['승인', '신청', '상신'] as const

/**
 * ERP 신청구분 values that map to ErpLeaveType (absence records).
 * Values must be present in ErpLeaveType.
 */
/**
 * Canonical mapping from ERP 근태코드 → ErpLeaveType.
 *
 * DAY-BASED LEAVE (reads '일수' column for the exact fractional amount):
 *   All codes listed below are whitelisted leave codes.  Codes NOT listed here
 *   that are also not in OT_CODE_SET are silently skipped by the parser.
 *
 * TIME-BASED / BLOCKED codes handled elsewhere:
 *   • OT_CODE_SET (dataParser.ts): 연장근로, 시간외근무, 연장근무, 휴일근로 — routed to OT map
 *   • 복직신청: not in this map and not OT → silently discarded by the parser
 *   • 출장 / 재택근무: ERP로 확인하지 않음. 출장은 Slack 감지(→ 외근), 재택은 수기 관리.
 *     이 코드들이 ERP에 들어와도 미인식 코드로 스킵됨.
 */
export const ERP_LEAVE_TYPE_MAP: Record<string, ErpLeaveType> = {
  // ── Standard ──────────────────────────────────────────────────────────────
  연차:         '연차',
  오전반차:     '오전반차',
  오후반차:     '오후반차',
  반일연차:     '오후반차',     // PM half-day alias
  오전반반차:   '오전반반차',
  오후반반차:   '오후반반차',
  // ── 대체휴가 ─────────────────────────────────────────────────────────────
  대체휴가:            '연차',
  '대체휴가(4시간)':   '오전반차',
  '대체휴가(2시간)':   '오전반반차',
  // ── 특별휴가 / 포상 ──────────────────────────────────────────────────────
  기타휴가:            '연차',
  포상휴가:            '연차',
  '포상휴가 (반반차)': '오전반반차',
  경조휴가:            '연차',
  생일반차:            '오전반차',
  생일반차휴가:        '오전반차',
  '리프레쉬휴가(3년)': '연차',
  '리프레쉬휴가(5년)': '연차',
  '리프레쉬휴가(7년)': '연차',
  '리프레쉬휴가(9년)': '연차',
  // ── 군 / 공공 의무 ────────────────────────────────────────────────────────
  예비군훈련:            '연차',
  '예비군훈련 (반반차)': '오전반반차',
  공가:                  '연차',
  // ── 의료 / 출산 / 육아 ───────────────────────────────────────────────────
  난임휴가:        '연차',
  '난임휴가(무급)': '연차',
  // 임신기단축근로: ERP 매핑 제거 — 근무형태(매일 6h 출근)이므로 leaveType 불필요.
  //   isPregnantReduced 예외규칙이 6h 기준 판정을 전담함.
  출산휴가:        '연차',
  육아휴직:        '연차',
  배우자출산휴가:  '연차',
  태아검진휴가:    '연차',
  건강검진휴가:    '연차',
  // ── 상병 ─────────────────────────────────────────────────────────────────
  병가:         '연차',
  '병가(무급)': '연차',
}

/** Tailwind bg + text classes for each FinalStatus — used in dashboard table cells */
export const STATUS_COLORS: Record<FinalStatus, string> = {
  '정상':           'bg-green-100  text-green-800',
  '연장근로':       'bg-green-100  text-green-800',
  '연차':           'bg-blue-100   text-blue-800',
  '오전반차':       'bg-blue-100   text-blue-800',
  '오후반차':       'bg-blue-100   text-blue-800',
  '외근':           'bg-blue-100   text-blue-800',
  '지각':           'bg-yellow-100 text-yellow-800',
  '조기퇴근':       'bg-orange-100 text-orange-800',
  '지각+조기퇴근':  'bg-amber-700  text-white',
  '근태이상':       'bg-red-100    text-red-800',
  '출퇴근누락':     'bg-red-100    text-red-800',
  '휴일근무':       'bg-purple-100 text-purple-800',
  '주말':           'bg-gray-100   text-gray-500',
  '공휴일':         'bg-gray-100   text-gray-500',
}
