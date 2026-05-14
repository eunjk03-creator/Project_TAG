'use client'
import { useMemo } from 'react'
import type { PolicySettings, RawRecord, ProcessedRecord, AggregatedStats, SieveFlag, FinalStatus, EmployeeAttributeOverrides } from '@/types/tag'
import { EMPLOYEES } from '@/data/orgChart'

function parseTime(hhmm: string): number {
  const isNext = hhmm.startsWith('+')
  const clean = isNext ? hhmm.slice(1) : hhmm
  const [h, m] = clean.split(':').map(Number)
  return h * 60 + m + (isNext ? 1440 : 0)
}

function fmtMins(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function processRecord(
  record: RawRecord,
  policy: PolicySettings,
  otExemptIds: Set<string> = new Set(),
  slackNoteMap: Map<string, string> = new Map(),
  attrOverrides?: EmployeeAttributeOverrides,
): ProcessedRecord {
  const { clockIn, dayType, erpOtApplied } = record
  // Defense-in-depth: raw CAPS export sometimes omits '+' for next-day punch-outs.
  // If the parsed clock-out value is numerically less than clock-in, it must be past midnight.
  const clockOut: string | null = (() => {
    const raw = record.clockOut
    if (!raw || raw.startsWith('+') || !clockIn) return raw
    return parseTime(raw) < parseTime(clockIn) ? `+${raw}` : raw
  })()

  // ── Per-employee attribute overrides ──────────────────────────────────────
  const isLeaderEff        = attrOverrides?.isLeader           ?? record.isLeader ?? false
  const isParentalLeave    = attrOverrides?.isParentalLeave    ?? false
  const isShortenedHours   = attrOverrides?.isShortenedHours   ?? false
  const effectiveStdH      = isShortenedHours
    ? (attrOverrides?.shortenedHoursValue ?? 6)
    : policy.standardHours
  const isTenAMStarter     = attrOverrides?.isTenAMStarter     ?? false
  const isDispatchedWorker = attrOverrides?.isDispatchedWorker ?? false
  const isEasyLogis        = attrOverrides?.isEasyLogis        ?? false
  const isFixedScheduleA   = attrOverrides?.isFixedScheduleA   ?? false
  const isFixedScheduleB   = attrOverrides?.isFixedScheduleB   ?? false
  const isPregnantReduced  = attrOverrides?.isPregnantReduced  ?? false
  const isGlobalExclusion  = attrOverrides?.isGlobalExclusion  ?? false

  const bypassAllAnomalies = isParentalLeave

  const policyFlexStartMins = parseTime(policy.flexStart)
  const policyFlexEndMins   = parseTime(policy.flexEnd)
  const snapToStartMins     = isTenAMStarter ? 10 * 60 : policyFlexStartMins
  const lateThresholdMins   = isTenAMStarter ? 10 * 60 : policyFlexEndMins
  const flexStartMins       = snapToStartMins
  const flexEndMins         = lateThresholdMins
  const lunchStartMins = parseTime(policy.lunchStart)
  const lunchEndMins   = parseTime(policy.lunchEnd)
  const nightStartMins = parseTime(policy.nightStart)
  const nightEndMins   = parseTime(policy.nightEnd) + 1440

  const base: ProcessedRecord = {
    ...record,
    effectiveClockIn: null,
    regularHours:  0,
    overtimeHours: 0,
    nightHours:    0,
    holidayHours:  0,
    breakMinutes:  0,
    lunchDeducted: false,
    dinnerDeducted: false,
    flag:        null,
    finalStatus: '정상',
  }

  // ── Global exclusion — silently treat as 정상, no aggregation impact ───────
  if (isGlobalExclusion) return { ...base, finalStatus: '정상', flag: null }

  function computeFinalStatus(r: ProcessedRecord): FinalStatus {
    if (r.dayType !== 'WEEKDAY') {
      if (r.dayType === 'HOLIDAY') return r.clockIn ? '휴일근무' : '공휴일'
      return r.clockIn ? '휴일근무' : '주말'
    }
    if (r.leaveType === '연차')     return '연차'
    if (r.leaveType === '오전반차') return '오전반차'
    if (r.leaveType === '오후반차') return '오후반차'
    if (r.leaveType === '출장')     return '출장'
    if (r.leaveType === '재택근무') return '재택근무'
    if (r.flag === 'NO_CLOCK_OUT')             return '출퇴근누락'
    if (r.flag === 'LATE_AND_ANOMALY')         return '근태이상'
    if (r.flag === 'ATTENDANCE_ANOMALY')       return '근태이상'
    if (r.flag === 'LATE_AND_EARLY_DEPARTURE') return '지각+조기퇴근'
    if (r.flag === 'LATE')                     return '지각'
    if (r.flag === 'EARLY_DEPARTURE')          return '조기퇴근'
    if (r.flag === 'UNAPPROVED_OT')            return 'OT미신청'
    if (r.overtimeHours > 0)                   return '연장근로'
    return '정상'
  }

  function applySlack(r: ProcessedRecord): ProcessedRecord {
    const note = slackNoteMap.get(`${record.employeeId}_${record.date}`)
    if (!note) return { ...r, finalStatus: computeFinalStatus(r) }

    const MORNING_NOTES = new Set(['외근·행사', '오전반차', '반반차', '반차'])
    const isMorningNote = MORNING_NOTES.has(note)

    const clearable = new Set(['UNAPPROVED_OT', 'NO_CLOCK_OUT', 'EARLY_DEPARTURE', 'ATTENDANCE_ANOMALY'])
    let newFlag = r.flag

    if (isMorningNote) {
      if (r.flag === 'LATE')                         newFlag = null
      else if (r.flag === 'LATE_AND_EARLY_DEPARTURE') newFlag = 'EARLY_DEPARTURE'
      else if (r.flag === 'LATE_AND_ANOMALY')         newFlag = 'ATTENDANCE_ANOMALY'
    }
    if (r.flag !== null && clearable.has(r.flag)) newFlag = null

    const slackNote = isMorningNote && (r.flag === 'LATE' || r.flag?.startsWith('LATE_AND'))
      ? `✅ 슬랙 확인: 지각 면제 (${note})`
      : `✅ 슬랙 확인: ${note}`

    const leaveTypeFromNote =
      note === '오전반차' ? '오전반차' as const :
      note === '오후반차' ? '오후반차' as const :
      undefined

    const updated: ProcessedRecord = {
      ...r,
      ...(leaveTypeFromNote !== undefined ? { leaveType: leaveTypeFromNote } : {}),
      flag: newFlag,
      verificationNote: [
        ...(r.verificationNote ?? []).filter(n => n !== '연장 미신청' && n !== '출퇴근 누락'),
        slackNote,
      ],
    }
    return { ...updated, finalStatus: computeFinalStatus(updated) }
  }

  // ── Break time hierarchy ────────────────────────────────────────────────────
  // 1) Gross work > 12 h → 120 min   2) 오전반차 varying   3) 오후반차 → 30 min   4) default 60 min
  function computeBreakMins(ci: number, co: number): number {
    const gross = co - ci
    if (gross > 12 * 60) return 120
    if (record.leaveType === '오전반차') {
      if (co < parseTime('12:30')) return 0
      if (co <= parseTime('13:30')) return 30
      return 60
    }
    if (record.leaveType === '오후반차') return 30
    return 60
  }

  // ── Non-WEEKDAY ───────────────────────────────────────────────────────────
  if (dayType !== 'WEEKDAY') {
    if (clockIn && clockOut) {
      const inMins  = parseTime(clockIn)
      const outMins = parseTime(clockOut)
      const lunchDeducted = outMins > lunchEndMins && inMins < lunchStartMins
      const breakMins = lunchDeducted ? (lunchEndMins - lunchStartMins) : 0
      let elapsed = outMins - inMins - breakMins
      return applySlack({ ...base, holidayHours: Math.max(0, elapsed) / 60, lunchDeducted, breakMinutes: breakMins })
    }
    return applySlack(base)
  }

  // ── WEEKDAY: no clock-in ──────────────────────────────────────────────────
  if (!clockIn) {
    const noClockFlag: SieveFlag = (bypassAllAnomalies || isDispatchedWorker) ? null : 'NO_CLOCK_OUT'
    return applySlack({ ...base, flag: noClockFlag })
  }

  const actualInMins = parseTime(clockIn)

  // ── Fixed Schedule A: In 08:00, Out ≥ 16:00, Break 30 min ──────────────
  if (isFixedScheduleA && !bypassAllAnomalies) {
    const schedIn      = parseTime('08:00')
    const schedNormOut = parseTime('16:00')
    const schedBreak   = 30
    const effectiveIn  = Math.max(actualInMins, schedIn)
    const isSchedLate  = actualInMins > schedIn

    if (!clockOut) {
      return applySlack({ ...base, effectiveClockIn: clockIn, breakMinutes: schedBreak,
        flag: isSchedLate ? 'LATE' : 'NO_CLOCK_OUT' })
    }
    const co = parseTime(clockOut)
    const net = Math.max(0, co - effectiveIn - schedBreak)
    let schedFlag: SieveFlag =
      co <= parseTime('15:30')                              ? (isSchedLate ? 'LATE_AND_ANOMALY'         : 'ATTENDANCE_ANOMALY')  :
      co >= parseTime('15:31') && co <= parseTime('15:59') ? (isSchedLate ? 'LATE_AND_EARLY_DEPARTURE' : 'EARLY_DEPARTURE')     :
      isSchedLate                                          ? 'LATE'                                                              :
      null
    if (isEasyLogis) schedFlag = null
    return applySlack({ ...base, effectiveClockIn: fmtMins(effectiveIn),
      regularHours: net / 60, breakMinutes: schedBreak, flag: schedFlag, finalStatus: '정상' })
  }

  // ── Fixed Schedule B: In 08:30, Out ≥ 12:30, Break 0 min ──────────────
  if (isFixedScheduleB && !bypassAllAnomalies) {
    const schedIn      = parseTime('08:30')
    const schedNormOut = parseTime('12:30')
    const schedBreak   = 0
    const effectiveIn  = Math.max(actualInMins, schedIn)
    const isSchedLate  = actualInMins > schedIn

    if (!clockOut) {
      return applySlack({ ...base, effectiveClockIn: clockIn, breakMinutes: schedBreak,
        flag: isSchedLate ? 'LATE' : 'NO_CLOCK_OUT' })
    }
    const co = parseTime(clockOut)
    const net = Math.max(0, co - effectiveIn - schedBreak)
    let schedFlag: SieveFlag =
      co <= parseTime('12:00')                              ? (isSchedLate ? 'LATE_AND_ANOMALY'         : 'ATTENDANCE_ANOMALY')  :
      co >= parseTime('12:01') && co <= parseTime('12:29') ? (isSchedLate ? 'LATE_AND_EARLY_DEPARTURE' : 'EARLY_DEPARTURE')     :
      isSchedLate                                          ? 'LATE'                                                              :
      null
    if (isEasyLogis) schedFlag = null
    return applySlack({ ...base, effectiveClockIn: fmtMins(effectiveIn),
      regularHours: net / 60, breakMinutes: schedBreak, flag: schedFlag, finalStatus: '정상' })
  }

  // ── Standard flow ─────────────────────────────────────────────────────────
  const effectiveInMins = Math.max(actualInMins, flexStartMins)

  // Late threshold: 오전반차 → 14:00, default → flexEnd (09:00 or 10:00 for exception IDs)
  const effectiveLateThreshold =
    record.leaveType === '오전반차' ? parseTime('14:00') : flexEndMins

  const isLate = !isLeaderEff && !isEasyLogis && !bypassAllAnomalies &&
    actualInMins > effectiveLateThreshold

  if (!clockOut) {
    const noClockFlag: SieveFlag = (bypassAllAnomalies || isDispatchedWorker) ? null : 'NO_CLOCK_OUT'
    return applySlack({ ...base, effectiveClockIn: clockIn, flag: noClockFlag })
  }

  const outMins         = parseTime(clockOut)
  const breakMins       = computeBreakMins(effectiveInMins, outMins)
  const lunchDeducted   = outMins > lunchEndMins && effectiveInMins < lunchStartMins
  const dinnerDeducted  = outMins > (effectiveInMins + effectiveStdH * 60 + (lunchEndMins - lunchStartMins))

  let elapsed = outMins - effectiveInMins
  if (lunchDeducted) elapsed -= (lunchEndMins - lunchStartMins)

  const standardOutMins = effectiveInMins + effectiveStdH * 60 + (lunchEndMins - lunchStartMins)
  const dinnerEndMins   = standardOutMins + policy.dinnerGraceMinutes

  const regularHours   = Math.min(Math.max(elapsed, 0), effectiveStdH * 60) / 60
  const rawOtMins      = Math.max(0, outMins - dinnerEndMins)
  const otMins         = Math.floor(rawOtMins / policy.otUnitMinutes) * policy.otUnitMinutes
  const overtimeHours  = otMins / 60

  const nightWorkStart = Math.max(effectiveInMins, nightStartMins)
  const nightWorkEnd   = Math.min(outMins, nightEndMins)
  const nightHours     = Math.max(0, nightWorkEnd - nightWorkStart) / 60

  // ── Required minimum for half-day leaves ──────────────────────────────────
  // 오전반차: net work ≥ 4 h (240 min);  오후반차: net work ≥ 4 h (240 min)
  const netWork = elapsed - (breakMins - (lunchDeducted ? lunchEndMins - lunchStartMins : 0))
  const leaveMinRequired: number | null =
    record.leaveType === '오전반차' || record.leaveType === '오후반차' ? 4 * 60 : null

  const isEarlyDeparture = !bypassAllAnomalies && !isEasyLogis && (() => {
    if (leaveMinRequired !== null) {
      return netWork < leaveMinRequired - 30
    }
    return record.leaveType !== '오후반차' && outMins < standardOutMins - 30
  })()

  const isEarlyMild = !bypassAllAnomalies && !isEasyLogis && !isEarlyDeparture && (() => {
    if (leaveMinRequired !== null) {
      return netWork < leaveMinRequired
    }
    return outMins < standardOutMins
  })()

  let flag: SieveFlag = null
  if (isLate && isEarlyDeparture)      flag = 'LATE_AND_ANOMALY'
  else if (isLate && isEarlyMild)      flag = 'LATE_AND_EARLY_DEPARTURE'
  else if (isLate)                     flag = 'LATE'
  else if (isEarlyDeparture)           flag = 'ATTENDANCE_ANOMALY'
  else if (isEarlyMild)                flag = 'EARLY_DEPARTURE'

  if (overtimeHours > 0 && !erpOtApplied && !otExemptIds.has(record.employeeId) && flag === null)
    flag = 'UNAPPROVED_OT'

  // ── Pregnant women: minimum 360 min effective work ─────────────────────────
  if (isPregnantReduced && !bypassAllAnomalies) {
    const leaveEquivMins =
      record.leaveType === '오전반차' || record.leaveType === '오후반차' ? 4 * 60 : 0
    const effectiveWork = Math.max(0, elapsed) + leaveEquivMins
    if (effectiveWork < 360) flag = 'ATTENDANCE_ANOMALY'
    else if (flag === 'UNAPPROVED_OT') flag = null  // pregnant exemption overrides OT flag
  }

  if (isEasyLogis || bypassAllAnomalies) flag = null

  return applySlack({
    ...base,
    effectiveClockIn: fmtMins(effectiveInMins),
    regularHours,
    overtimeHours,
    ...(rawOtMins > 0 && { rawOvertimeMinutes: rawOtMins }),
    nightHours,
    holidayHours: 0,
    breakMinutes: breakMins,
    lunchDeducted,
    dinnerDeducted,
    flag,
    finalStatus: '정상',
  })
}

function filterByDateRange(records: RawRecord[], fromDate: string, toDate: string): RawRecord[] {
  return records.filter(r => r.date >= fromDate && r.date <= toDate)
}

function aggregate(records: ProcessedRecord[], label: string, empCount: number): AggregatedStats {
  const regularHours = records.reduce((s, r) => s + r.regularHours, 0)
  const overtimeHours = records.reduce((s, r) => s + r.overtimeHours, 0)
  const nightHours = records.reduce((s, r) => s + r.nightHours, 0)
  const holidayHours = records.reduce((s, r) => s + r.holidayHours, 0)
  return { label, totalHours: regularHours + overtimeHours, regularHours, overtimeHours, nightHours, holidayHours, employeeCount: empCount }
}

export function useAttendanceLogic(
  rawRecords: RawRecord[],
  policy: PolicySettings,
  fromDate: string,
  toDate: string,
  otExemptIds: Set<string> = new Set(),
  slackNoteMap: Map<string, string> = new Map(),
  employeeAttrMap: Map<string, EmployeeAttributeOverrides> = new Map(),
) {
  return useMemo(() => {
    // Merge attr-based OT exemptions (isLeader + isEasyLogis suppress UNAPPROVED_OT)
    let mergedOtExemptIds = otExemptIds
    if (employeeAttrMap.size > 0) {
      mergedOtExemptIds = new Set(otExemptIds)
      for (const [empId, attrs] of employeeAttrMap) {
        if (attrs.isLeader || attrs.isEasyLogis) mergedOtExemptIds.add(empId)
      }
    }

    const filtered = filterByDateRange(rawRecords, fromDate, toDate)
    const processed = filtered.map(r =>
      processRecord(r, policy, mergedOtExemptIds, slackNoteMap, employeeAttrMap.get(r.employeeId)),
    )

    const byEmpId: Record<string, ProcessedRecord[]> = {}
    for (const r of processed) {
      if (!byEmpId[r.employeeId]) byEmpId[r.employeeId] = []
      byEmpId[r.employeeId].push(r)
    }

    const total = aggregate(processed, '전체', Object.keys(byEmpId).length)

    const divisions = [...new Set(EMPLOYEES.map(e => e.division))]
    const byDivision: AggregatedStats[] = divisions.map(div => {
      const ids = EMPLOYEES.filter(e => e.division === div).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, div, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const teamKeys = [...new Set(EMPLOYEES.map(e => `${e.division}||${e.team}`))]
    const byTeam: AggregatedStats[] = teamKeys.map(key => {
      const [div, team] = key.split('||')
      const ids = EMPLOYEES.filter(e => e.division === div && e.team === team).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, `${div} / ${team}`, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const partKeys = [...new Set(EMPLOYEES.filter(e => e.part).map(e => `${e.division}||${e.team}||${e.part}`))]
    const byPart: AggregatedStats[] = partKeys.map(key => {
      const [div, team, part] = key.split('||')
      const ids = EMPLOYEES.filter(e => e.division === div && e.team === team && e.part === part).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, `${team} / ${part}`, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const byIndividual: AggregatedStats[] = Object.entries(byEmpId).map(([id, recs]) => {
      const emp = EMPLOYEES.find(e => e.id === id)
      return aggregate(recs, emp ? `${emp.name} (${emp.division})` : id, 1)
    })

    const flagCounts = {
      LATE: processed.filter(r => r.flag === 'LATE').length,
      NO_CLOCK_OUT: processed.filter(r => r.flag === 'NO_CLOCK_OUT').length,
      UNAPPROVED_OT: processed.filter(r => r.flag === 'UNAPPROVED_OT').length,
      EARLY_DEPARTURE: processed.filter(r => r.flag === 'EARLY_DEPARTURE').length,
    }

    return { processed, total, byDivision, byTeam, byPart, byIndividual, flagCounts }
  }, [rawRecords, policy, fromDate, toDate, otExemptIds, slackNoteMap, employeeAttrMap])
}
