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
export type SieveFlag = 'LATE' | 'NO_CLOCK_OUT' | 'UNAPPROVED_OT' | 'EARLY_DEPARTURE' | null

export interface Employee {
  id: string
  name: string
  division: string
  team: string
  part?: string
  jobTitle: string
}

export interface RawRecord {
  employeeId: string
  date: string
  dayType: DayType
  dayLabel: string
  clockIn: string | null
  clockOut: string | null
  erpOtApplied: boolean
}

export interface ProcessedRecord extends RawRecord {
  effectiveClockIn: string | null
  regularHours: number
  overtimeHours: number
  nightHours: number
  holidayHours: number
  lunchDeducted: boolean
  dinnerDeducted: boolean
  flag: SieveFlag
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
