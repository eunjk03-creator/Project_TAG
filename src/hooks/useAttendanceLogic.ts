'use client'
import { useMemo } from 'react'
import type { PolicySettings, RawRecord, ProcessedRecord, AggregatedStats, EmployeeAttributeOverrides } from '@/types/tag'
import { EMPLOYEES } from '@/data/orgChart'
import { processRecord } from '@/lib/processRecord'
export { processRecord }

function filterByDateRange(records: RawRecord[], fromDate: string, toDate: string): RawRecord[] {
  return records.filter(r => r.date >= fromDate && r.date <= toDate)
}

function aggregate(records: ProcessedRecord[], label: string, empCount: number): AggregatedStats {
  const regularHours  = records.reduce((s, r) => s + r.regularHours,  0)
  const overtimeHours = records.reduce((s, r) => s + r.overtimeHours, 0)
  const nightHours    = records.reduce((s, r) => s + r.nightHours,    0)
  const holidayHours  = records.reduce((s, r) => s + r.holidayHours,  0)
  return { label, totalHours: regularHours + overtimeHours, regularHours, overtimeHours, nightHours, holidayHours, employeeCount: empCount }
}

export function useAttendanceLogic(
  rawRecords: RawRecord[],
  policy: PolicySettings,
  fromDate: string,
  toDate: string,
  otExemptIds: Set<string> = new Set(),
  slackNoteMap: Map<string, { note: string; rawText: string }[]> = new Map(),
  employeeAttrMap: Map<string, EmployeeAttributeOverrides> = new Map(),
) {
  return useMemo(() => {
    let mergedOtExemptIds = otExemptIds
    if (employeeAttrMap.size > 0) {
      mergedOtExemptIds = new Set(otExemptIds)
      for (const [empId, attrs] of employeeAttrMap) {
        if (attrs.isLeader || attrs.isEasyLogis) mergedOtExemptIds.add(empId)
      }
    }

    const filtered  = filterByDateRange(rawRecords, fromDate, toDate)
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
      const ids  = EMPLOYEES.filter(e => e.division === div).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, div, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const teamKeys = [...new Set(EMPLOYEES.map(e => `${e.division}||${e.team}`))]
    const byTeam: AggregatedStats[] = teamKeys.map(key => {
      const [div, team] = key.split('||')
      const ids  = EMPLOYEES.filter(e => e.division === div && e.team === team).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, `${div} / ${team}`, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const partKeys = [...new Set(EMPLOYEES.filter(e => e.part).map(e => `${e.division}||${e.team}||${e.part}`))]
    const byPart: AggregatedStats[] = partKeys.map(key => {
      const [div, team, part] = key.split('||')
      const ids  = EMPLOYEES.filter(e => e.division === div && e.team === team && e.part === part).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, `${team} / ${part}`, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const byIndividual: AggregatedStats[] = Object.entries(byEmpId).map(([id, recs]) => {
      const emp = EMPLOYEES.find(e => e.id === id)
      return aggregate(recs, emp ? `${emp.name} (${emp.division})` : id, 1)
    })

    const flagCounts = {
      LATE:            processed.filter(r => r.flag === 'LATE').length,
      NO_CLOCK_IN:     processed.filter(r => r.flag === 'NO_CLOCK_IN').length,
      NO_CLOCK_OUT:    processed.filter(r => r.flag === 'NO_CLOCK_OUT').length,
      EARLY_DEPARTURE: processed.filter(r => r.flag === 'EARLY_DEPARTURE').length,
    }

    return { processed, total, byDivision, byTeam, byPart, byIndividual, flagCounts }
  }, [rawRecords, policy, fromDate, toDate, otExemptIds, slackNoteMap, employeeAttrMap])
}
