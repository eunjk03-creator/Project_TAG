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
}

export type DayType = 'WEEKDAY' | 'WEEKEND' | 'HOLIDAY'
export type SieveFlag =
  | 'LATE'
  | 'NO_CLOCK_OUT'
  | 'UNAPPROVED_OT'
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
  | '출장'       // business trip
  | '재택근무'   // remote work
  // ── Category 2: Anomaly ─────────────────────────────────────────────────
  | '지각'          // clock-in exceeds flexEnd
  | '조기퇴근'      // 0–30 min before standard end
  | '근태이상'      // >30 min before standard end, or combined late+severe early
  | '지각+조기퇴근' // combined: late + mild early departure
  | '출퇴근누락'    // missing clock-in or clock-out (no ERP leave to justify)
  | 'OT미신청'      // overtime worked but no ERP application
  // ── Category 3: Holiday Work ────────────────────────────────────────────
  | '휴일근무'    // worked on weekend or public holiday
  // ── Non-working states ───────────────────────────────────────────────────
  | '주말'       // weekend with no attendance
  | '공휴일'     // public holiday with no attendance

export type FinalStatusCategory = 'NORMAL' | 'ANOMALY' | 'HOLIDAY_WORK' | 'NON_WORKING'

export const FINAL_STATUS_CATEGORY: Readonly<Record<FinalStatus, FinalStatusCategory>> = {
  '정상':     'NORMAL',  '연장근로': 'NORMAL',  '연차':     'NORMAL',
  '오전반차': 'NORMAL',  '오후반차': 'NORMAL',  '출장':     'NORMAL', '재택근무': 'NORMAL',
  '지각':     'ANOMALY', '조기퇴근': 'ANOMALY', '근태이상': 'ANOMALY',
  '지각+조기퇴근': 'ANOMALY', '출퇴근누락': 'ANOMALY', 'OT미신청': 'ANOMALY',
  '휴일근무': 'HOLIDAY_WORK',
  '주말':     'NON_WORKING', '공휴일': 'NON_WORKING',
}

/**
 * Leave / absence types recognised by the ERP 신청구분 column.
 * Superset of the legacy inline union — all existing values remain valid.
 */
export type ErpLeaveType = '연차' | '오전반차' | '오후반차' | '출장' | '재택근무'

export interface Employee {
  /** Composite primary key: "${maskedEmpId}_${normalizeName(name)}" — unique even when masked IDs collide */
  id: string
  /** Original masked 사원번호 from the source file — use for display only, NOT for lookups */
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
  /** 직책자: exempt from LATE flag + UNAPPROVED_OT */
  isLeader?:            boolean
  /** 육아휴직자: exempt from ALL anomaly checks — always shows 정상/연차 */
  isParentalLeave?:     boolean
  /** 단축근로: override policy.standardHours with shortenedHoursValue */
  isShortenedHours?:    boolean
  /** Effective hours/day when isShortenedHours is true (default 6) */
  shortenedHoursValue?: number
  /** 10시 출근자: snap effectiveIn to 10:00; LATE / OT thresholds shift accordingly */
  isTenAMStarter?:      boolean
  /** 파견자: skip NO_CLOCK_OUT flag — missing punch is expected */
  isDispatchedWorker?:  boolean
  /** 이지로지스: special subsidiary — suppress all anomaly flags */
  isEasyLogis?:         boolean
  /** 특수근무제 A: In 08:00 snap, Out ≥ 16:00, Break 30 min, Late >08:00 */
  isFixedScheduleA?:  boolean
  /** 특수근무제 B: In 08:30 snap, Out ≥ 12:30, Break 0 min, Late >08:30 */
  isFixedScheduleB?:  boolean
  /** 임산부: (actual + leave-equiv) ≥ 360 min required; otherwise ATTENDANCE_ANOMALY */
  isPregnantReduced?: boolean
  /** 전체 제외: record is silently skipped from all aggregation and flagging */
  isGlobalExclusion?: boolean
}

export type RecordOverride = {
  clockIn:      string | null
  clockOut:     string | null
  erpOtApplied: boolean | null  // null = not overridden; true/false = explicit admin override
  erpLeaveType: string          // '없음' | '연차' | '반차'
  editHistory:  EditHistoryEntry[]
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
 * ERP 신청구분 values that represent approved overtime when 승인상태 === '승인'.
 * Maps to RawRecord.erpOtApplied = true.
 */
export const ERP_OT_TYPES = ['연장근무', '시간외근무', '연장근로'] as const
export type ErpOtType = (typeof ERP_OT_TYPES)[number]

/**
 * ERP 승인상태 values that count as approved.
 */
export const ERP_APPROVED_STATUSES = ['승인'] as const

/**
 * ERP 신청구분 values that map to ErpLeaveType (absence records).
 * Values must be present in ErpLeaveType.
 */
export const ERP_LEAVE_TYPE_MAP: Record<string, ErpLeaveType> = {
  // Standard types
  연차:         '연차',
  오전반차:     '오전반차',
  오후반차:     '오후반차',
  출장:         '출장',
  재택근무:     '재택근무',
  // Quarter-day variants — treated as the nearest half-day
  오전반반차:   '오전반차',
  오후반반차:   '오후반차',
  // Special leave types — treated as 연차 for attendance purposes
  공가:              '연차',
  경조휴가:          '연차',
  생일반차휴가:      '오전반차',
  예비군훈련:        '연차',
  건강검진휴가:      '연차',
  '리프레쉬휴가(3년)': '연차',
  태아검진휴가:      '연차',
  '병가(무급)':      '연차',
  병가:              '연차',
}

/** Tailwind bg + text classes for each FinalStatus — used in dashboard table cells */
export const STATUS_COLORS: Record<FinalStatus, string> = {
  '정상':           'bg-green-100  text-green-800',
  '연장근로':       'bg-green-100  text-green-800',
  '연차':           'bg-blue-100   text-blue-800',
  '오전반차':       'bg-blue-100   text-blue-800',
  '오후반차':       'bg-blue-100   text-blue-800',
  '출장':           'bg-blue-100   text-blue-800',
  '재택근무':       'bg-blue-100   text-blue-800',
  '지각':           'bg-yellow-100 text-yellow-800',
  '조기퇴근':       'bg-orange-100 text-orange-800',
  '지각+조기퇴근':  'bg-amber-700  text-white',
  '근태이상':       'bg-red-100    text-red-800',
  '출퇴근누락':     'bg-red-100    text-red-800',
  'OT미신청':       'bg-red-100    text-red-800',
  '휴일근무':       'bg-purple-100 text-purple-800',
  '주말':           'bg-gray-100   text-gray-500',
  '공휴일':         'bg-gray-100   text-gray-500',
}
