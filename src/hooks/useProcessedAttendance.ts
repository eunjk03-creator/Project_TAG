import { useEffect, useMemo, useRef, useState } from 'react'
import { useAttendanceLogic } from '@/hooks/useAttendanceLogic'
import { processRecord } from '@/lib/processRecord'
import { usePolicy } from '@/context/PolicyContext'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { useAttendanceData } from '@/context/AttendanceDataContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useSlack } from '@/context/SlackContext'
import { leaveTypeOverrideFields, synthesizeOverrideRecord, clockOverrideFields } from '@/utils/attendanceCalc'
import { getDayInfo } from '@/utils/dataParser'
import type { Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'

/** [from, to] 범위만 daily_attendance에서 직접 받아온다 — 예전엔 context가 들고 있던 연간
 *  전체 processedRecords를 여기서 날짜로 다시 필터링했는데, 화면마다(그리드 주간/Overview
 *  기간+YTD/수당집계 월별) 필요한 범위가 다 달라서 "일단 다 받고 나중에 자르기"가 매번
 *  전체를 전송하는 낭비였다(2026-08-30 실측 — 초기 로딩 지연의 주 원인). from/to가 바뀌거나
 *  dataVersion이 바뀌면(업로드/전체 재계산 완료) 다시 받아온다. */
export function useScopedProcessedRecords(from: string, to: string, dataVersion: number): ProcessedRecord[] | null {
  const { records } = useScopedProcessedRecordsWithStatus(from, to, dataVersion)
  return records
}

/** useScopedProcessedRecords와 동일하지만 "아직 로딩 중"과 "받아봤더니 진짜 비어있음"을
 *  구분해서 알려준다 — 폴백 경로(서버에 아직 daily_attendance가 없을 때 클라이언트에서
 *  직접 계산)가 로딩 중에 성급하게 발동하지 않게 하려면 이 구분이 필요하다. */
function useScopedProcessedRecordsWithStatus(
  from: string, to: string, dataVersion: number,
): { records: ProcessedRecord[] | null; isLoading: boolean } {
  const [records, setRecords]     = useState<ProcessedRecord[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const reqIdRef = useRef(0)

  useEffect(() => {
    const reqId = ++reqIdRef.current
    setIsLoading(true)
    fetch(`/api/attendance-records?from=${from}&to=${to}`)
      .then(res => res.ok ? res.json() as Promise<{ records: ProcessedRecord[] }> : null)
      .then(json => {
        if (reqIdRef.current !== reqId) return // 응답 도착 전에 from/to가 또 바뀜 — 낡은 응답 무시
        setRecords(json?.records?.length ? json.records : null)
        setIsLoading(false)
      })
      .catch(() => {
        if (reqIdRef.current !== reqId) return
        setRecords(null)
        setIsLoading(false)
      })
  }, [from, to, dataVersion])

  return { records, isLoading }
}

/** serverProcessed가 정말로 없을 때만(로딩 중이 아니라 진짜 데이터가 없을 때만) 쓰는
 *  폴백 — 이 경우에만 원본 전체를 가져와 클라이언트에서 직접 계산한다. 정상 운영 중엔
 *  daily_attendance가 항상 최신이라 이 경로를 탈 일이 거의 없다(최초 세팅 직후 등 예외적
 *  상황 전용) — 그래서 흔치 않은 이 경로에서는 범위 제한 없이 전체를 받아도 괜찮다고 판단. */
function useFallbackRawRecords(shouldFetch: boolean) {
  const [records, setRecords] = useState<import('@/types/tag').RawRecord[]>([])

  useEffect(() => {
    if (!shouldFetch) return
    let cancelled = false
    fetch('/api/attendance-raw-records?full=1')
      .then(res => res.ok ? res.json() as Promise<{ rawRecords: import('@/types/tag').RawRecord[] }> : null)
      .then(json => { if (!cancelled && json?.rawRecords) setRecords(json.rawRecords) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [shouldFetch])

  return records
}

/** 전 직원 rawRecords가 실제로 필요한 화면(anomalies, fast) 전용 — 남용 금지. dataVersion이
 *  바뀌면(업로드/재계산 완료) 다시 받아온다. */
export function useFullRawRecords(dataVersion: number): import('@/types/tag').RawRecord[] {
  const [records, setRecords] = useState<import('@/types/tag').RawRecord[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/attendance-raw-records?full=1')
      .then(res => res.ok ? res.json() as Promise<{ rawRecords: import('@/types/tag').RawRecord[] }> : null)
      .then(json => { if (!cancelled && json?.rawRecords) setRecords(json.rawRecords) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dataVersion])

  return records
}

// 이 파일에 처음부터 있던 하드코딩 기본값 — admin/page.tsx의 것과 반드시 동일하게 유지할 것.
// (Settings > 예외 규칙 미설정 상태에서도 항상 적용되는 전사 기본값)
const DEFAULT_GLOBAL_EXCLUSIONS = new Set([
  'E22100401', 'E22082202', 'E24010202', 'E23080702', 'E24031802',
  'E22061503', 'E24031806', 'E24010203', 'E18090302', 'E24100705',
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
  const { employees: baseEmployees, dataVersion } = useAttendanceSource()
  const { slackNoteMap } = useSlack()

  const { records: serverProcessed, isLoading: isServerProcessedLoading } =
    useScopedProcessedRecordsWithStatus(from, to, dataVersion)
  // 서버에 daily_attendance가 아직 없을 때만(로딩 중이 아니라 정말 없을 때만) 원본 전체를
  // 받아 클라이언트에서 계산 — 정상 운영 중엔 거의 안 타는 경로라 범위 제한 없이 받아도 된다.
  const baseRecords = useFallbackRawRecords(!isServerProcessedLoading && !serverProcessed)

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
        ...clockOverrideFields(ov),
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

    // 서버 조회 자체가 이미 [from, to]로 스코프돼 있어(useScopedProcessedRecords) 재필터 불필요.
    const dateFiltered = serverProcessed

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
            ...clockOverrideFields(ov),
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
