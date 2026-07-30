import { useMemo } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { processRecord } from '@/lib/processRecord'
import { usePolicy } from '@/context/PolicyContext'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import { leaveTypeOverrideFields, synthesizeOverrideRecord } from '@/utils/attendanceCalc'
import { getDayInfo } from '@/utils/dataParser'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'

// 이 파일에 처음부터 있던 하드코딩 기본값 — admin/page.tsx의 것과 반드시 동일하게 유지할 것.
// (Settings > 예외 규칙 미설정 상태에서도 항상 적용되는 전사 기본값)
const DEFAULT_GLOBAL_EXCLUSIONS = new Set([
  'E22100401', 'E22082202', 'E24010202', 'E23080702', 'E24031802',
  'E22061503', 'E24031806', 'E24010203', 'E18090302', 'E24111802', 'E24100705',
])
const DEFAULT_FIXED_A  = new Set(['E25122301'])
const DEFAULT_FIXED_B  = new Set(['E26030501', 'E24011001'])
const DEFAULT_PREGNANT = new Set(['E25060901', 'E22080101', 'E25060902'])

export interface ProcessedAttendance {
  employees:         Employee[]
  /** override 반영 + hire-date/deletedKeys 필터까지 끝난 최종 레코드 (전역제외 직원은 아직 안 빠짐 — globalExclusionIds로 직접 필터할 것) */
  records:           ProcessedRecord[]
  finalAttrMap:      Map<string, EmployeeAttributeOverrides>
  otExemptIds:       Set<string>
  globalExclusionIds: Set<string>
}

/**
 * admin/page.tsx의 그리드/테이블/현황/수당집계와 새 Overview 페이지가 공유하는 단일 데이터
 * 파이프라인 — override 병합(erpLeaveType/clockIn/clockOut/erpOtApplied), 원본 없는 수기입력
 * 합성(synthesizeOverrideRecord), 예외규칙/하드코딩 기본값 병합(finalAttrMap/otExemptIds),
 * hire-date 이전 레코드 제외, 삭제 마킹 제외까지 한 곳에서 계산한다.
 *
 * from/to는 각 호출부가 원하는 기간을 독립적으로 넘긴다 — DateRangeContext에 직접 의존하지
 * 않으므로, 메인 대시보드와 새 Overview 페이지가 서로 다른 기간을 보면서도 로직은 하나만 존재한다.
 */
export function useProcessedAttendance(from: string, to: string): ProcessedAttendance {
  const { policy } = usePolicy()
  const { excludeFromOtIds, employeeAttrMap, exceptionRules } = useEmployeeExceptions()
  const { recordOverrides, deletedKeys } = useAttendanceData()
  const {
    employees: baseEmployees, rawRecords: baseRecords,
    processedRecords: serverProcessed,
  } = useAttendanceSource()
  const { slackNoteMap } = useSlack()

  const companyHolsMap = useMemo(
    () => new Map((policy.companyHolidays ?? []).map(h => [h.date, h.label])),
    [policy.companyHolidays],
  )

  const overriddenRawRecords = useMemo(() => {
    const mapped = baseRecords.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn,
        clockOut:     ov.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? (ov.erpOtApplied as boolean) : r.erpOtApplied,
        ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
      }
    })

    const baseKeys = new Set(baseRecords.map(r => `${r.employeeId}_${r.date}`))
    for (const [key, ov] of Object.entries(recordOverrides)) {
      if (baseKeys.has(key) || (!ov.clockIn && !ov.clockOut && !ov.erpLeaveType)) continue
      const date  = key.slice(-10)
      const empId = key.slice(0, -(10 + 1))
      const { dayType, dayLabel } = getDayInfo(date, companyHolsMap)
      mapped.push(synthesizeOverrideRecord(empId, date, dayType, dayLabel, ov))
    }
    return mapped
  }, [recordOverrides, baseRecords, companyHolsMap])

  const { finalAttrMap, remappedExcludeIds } = useMemo(() => {
    const normName = (s: string) => s.trim().replace(/\s+/g, '')
    const nameToId = new Map(baseEmployees.map(e => [normName(e.name), e.id]))
    const liveIds  = new Set(baseEmployees.map(e => e.id))

    const toLive = new Map<string, string>()
    for (const rule of exceptionRules) {
      if (liveIds.has(rule.employeeId)) {
        toLive.set(rule.employeeId, rule.employeeId)
      } else {
        const liveId = nameToId.get(normName(rule.employeeName))
        if (liveId) toLive.set(rule.employeeId, liveId)
      }
    }

    const remappedAttr = new Map<string, EmployeeAttributeOverrides>()

    for (const emp of baseEmployees) {
      const rawId = emp.rawId ?? emp.id.split('_')[0]
      let def: EmployeeAttributeOverrides | null = null
      if (DEFAULT_GLOBAL_EXCLUSIONS.has(rawId))   def = { isGlobalExclusion: true }
      else if (DEFAULT_FIXED_A.has(rawId))         def = { isFixedScheduleA: true }
      else if (DEFAULT_FIXED_B.has(rawId))         def = { isFixedScheduleB: true }
      else if (DEFAULT_PREGNANT.has(rawId))        def = { isPregnantReduced: true }
      if (def) remappedAttr.set(emp.id, def)
    }

    for (const [staleId, attrs] of employeeAttrMap) {
      const liveId = toLive.get(staleId) ?? staleId
      remappedAttr.set(liveId, { ...(remappedAttr.get(liveId) ?? {}), ...attrs })
    }

    const remappedExclude = new Set<string>()
    for (const staleId of excludeFromOtIds) {
      remappedExclude.add(toLive.get(staleId) ?? staleId)
    }

    return { finalAttrMap: remappedAttr, remappedExcludeIds: remappedExclude }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeAttrMap, excludeFromOtIds, exceptionRules, baseEmployees])

  const globalExclusionIds = useMemo(
    () => new Set(
      [...finalAttrMap.entries()]
        .filter(([, attrs]) => attrs.isGlobalExclusion)
        .map(([id]) => id),
    ),
    [finalAttrMap],
  )

  const otExemptIds = useMemo(() => new Set([
    ...remappedExcludeIds,
    ...baseEmployees.filter(e => e.isLeader).map(e => e.id),
  ]), [remappedExcludeIds, baseEmployees])

  const { processed: clientProcessed } = useAttendanceLogic(
    serverProcessed ? [] : overriddenRawRecords,
    policy, from, to, otExemptIds, slackNoteMap, finalAttrMap,
  )

  // finalAttrMap에 항목이 있는 직원(퇴사자/직책자/단축근로 등 예외규칙 적용 대상)은 캐시된
  // serverProcessed가 그 규칙을 반영하기 전 상태일 수 있으므로 매번 재처리 대상에 포함한다.
  // 그렇지 않으면 관리자가 퇴사일/직책자 발령일 등을 바꿔도 "전체 재계산"을 다시 돌리기
  // 전까지 화면에 반영이 안 된다 — 예외규칙 적용 인원은 소수라 재처리 비용은 무시할 만함.
  const attrOverrideEmployeeIds = useMemo(() => new Set(finalAttrMap.keys()), [finalAttrMap])

  const allProcessed = useMemo<ProcessedRecord[]>(() => {
    if (!serverProcessed) return clientProcessed

    const dateFiltered = serverProcessed.filter(r => r.date >= from && r.date <= to)

    const compHolDates = new Set((policy.companyHolidays ?? []).map(h => h.date))

    const needsAnyReprocess =
      Object.keys(recordOverrides).length > 0 || compHolDates.size > 0 || attrOverrideEmployeeIds.size > 0
    const reprocessedExisting = !needsAnyReprocess ? dateFiltered : dateFiltered.map(r => {
      const ov = recordOverrides[`${r.employeeId}_${r.date}`]
      const needsHolReprocess  = compHolDates.has(r.date) && r.dayType === 'WEEKDAY'
      const needsAttrReprocess = attrOverrideEmployeeIds.has(r.employeeId)
      if (!ov && !needsHolReprocess && !needsAttrReprocess) return r
      return processRecord(
        {
          ...r,
          ...(ov ? {
            clockIn:      ov.clockIn      ?? r.clockIn,
            clockOut:     ov.clockOut     ?? r.clockOut,
            erpOtApplied: ov.erpOtApplied !== null ? (ov.erpOtApplied as boolean) : r.erpOtApplied,
            ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
          } : {}),
        },
        policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId),
      )
    })

    if (Object.keys(recordOverrides).length === 0) return reprocessedExisting
    const existingKeys = new Set(dateFiltered.map(r => `${r.employeeId}_${r.date}`))
    const synthesized: ProcessedRecord[] = []
    for (const [key, ov] of Object.entries(recordOverrides)) {
      if (existingKeys.has(key)) continue
      const date = key.slice(-10)
      if (date < from || date > to) continue
      if (!ov.clockIn && !ov.clockOut && !ov.erpLeaveType) continue
      const empId = key.slice(0, -(10 + 1))
      const { dayType, dayLabel } = getDayInfo(date, companyHolsMap)
      const raw = synthesizeOverrideRecord(empId, date, dayType, dayLabel, ov)
      synthesized.push(processRecord(raw, policy, otExemptIds, slackNoteMap, finalAttrMap.get(empId)))
    }
    return synthesized.length ? [...reprocessedExisting, ...synthesized] : reprocessedExisting
  }, [serverProcessed, clientProcessed, from, to, recordOverrides, policy, otExemptIds, slackNoteMap, finalAttrMap, companyHolsMap, attrOverrideEmployeeIds])

  const hireDateMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of baseEmployees) {
      if (!e.rawId) continue
      const m = e.rawId.match(/^E(\d{2})(\d{2})(\d{2})\d+$/)
      if (m) map.set(e.id, `20${m[1]}-${m[2]}-${m[3]}`)
    }
    return map
  }, [baseEmployees])

  const scopedEmployeeIds = useMemo(
    () => new Set(baseEmployees.map(e => e.id)),
    [baseEmployees],
  )

  const records = useMemo(
    () => allProcessed.filter(r => {
      if (!scopedEmployeeIds.has(r.employeeId)) return false
      if (deletedKeys.has(`${r.employeeId}_${r.date}`)) return false
      const hd = hireDateMap.get(r.employeeId)
      if (hd && r.date < hd) return false
      return true
    }),
    [allProcessed, scopedEmployeeIds, deletedKeys, hireDateMap],
  )

  return { employees: baseEmployees, records, finalAttrMap, otExemptIds, globalExclusionIds }
}
