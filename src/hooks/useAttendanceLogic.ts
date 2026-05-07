'use client'
import { useMemo } from 'react'
import type { PolicySettings, RawRecord, ProcessedRecord, AggregatedStats, SieveFlag } from '@/types/tag'
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

export function processRecord(record: RawRecord, policy: PolicySettings): ProcessedRecord {
  const { clockIn, clockOut, dayType, erpOtApplied } = record

  const base = { ...record, effectiveClockIn: null, regularHours: 0, overtimeHours: 0, nightHours: 0, holidayHours: 0, lunchDeducted: false, dinnerDeducted: false }

  if (dayType !== 'WEEKDAY') return { ...base, flag: null }
  if (!clockIn) return { ...base, flag: 'NO_CLOCK_OUT' }

  const flexStartMins = parseTime(policy.flexStart)
  const flexEndMins = parseTime(policy.flexEnd)
  const lunchStartMins = parseTime(policy.lunchStart)
  const lunchEndMins = parseTime(policy.lunchEnd)
  const nightStartMins = parseTime(policy.nightStart)
  const nightEndMins = parseTime(policy.nightEnd) + 1440

  const actualInMins = parseTime(clockIn)
  const effectiveInMins = Math.max(actualInMins, flexStartMins)
  const isLate = actualInMins > flexEndMins

  if (!clockOut) return { ...base, effectiveClockIn: clockIn, flag: 'NO_CLOCK_OUT' }

  const outMins = parseTime(clockOut)
  const standardOutMins = effectiveInMins + policy.standardHours * 60 + (lunchEndMins - lunchStartMins)
  const dinnerEndMins = standardOutMins + policy.dinnerGraceMinutes

  // Net worked time (deduct lunch if present)
  const lunchDeducted = outMins > lunchEndMins && effectiveInMins < lunchStartMins
  let elapsed = outMins - effectiveInMins
  if (lunchDeducted) elapsed -= (lunchEndMins - lunchStartMins)

  const regularHours = Math.min(Math.max(elapsed, 0), policy.standardHours * 60) / 60

  // OT: after dinner grace, floor to otUnit
  const rawOtMins = Math.max(0, outMins - dinnerEndMins)
  const otMins = Math.floor(rawOtMins / policy.otUnitMinutes) * policy.otUnitMinutes
  const overtimeHours = otMins / 60
  const dinnerDeducted = outMins > standardOutMins  // worked past standard quitting time

  // Night hours 22:00~06:00
  const nightWorkStart = Math.max(effectiveInMins, nightStartMins)
  const nightWorkEnd = Math.min(outMins, nightEndMins)
  const nightHours = Math.max(0, nightWorkEnd - nightWorkStart) / 60

  const holidayHours = 0

  const isEarlyDeparture = outMins < standardOutMins - 30

  let flag: SieveFlag = null
  if (isLate) flag = 'LATE'
  else if (isEarlyDeparture) flag = 'EARLY_DEPARTURE'
  if (overtimeHours > 0 && !erpOtApplied) flag = 'UNAPPROVED_OT'

  return {
    ...record,
    effectiveClockIn: fmtMins(effectiveInMins),
    regularHours,
    overtimeHours,
    nightHours,
    holidayHours,
    lunchDeducted,
    dinnerDeducted,
    flag,
  }
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
) {
  return useMemo(() => {
    const filtered = filterByDateRange(rawRecords, fromDate, toDate)
    const processed = filtered.map(r => processRecord(r, policy))

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
  }, [rawRecords, policy, fromDate, toDate])
}
