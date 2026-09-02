/**
 * compute-attendance/route.ts, getProcessedRecords.ts, scripts/recompute_processed_data.ts
 * 세 곳에 각자 따로 있던 "override 병합 + 퇴사자 필터 + 합성 레코드 + Slack 노트 병합" 로직을
 * 하나로 통합한다. 새로 추가되는 재계산 경로(증분 재계산, 배치 재계산)는 반드시 이 함수를
 * 재사용할 것 — 네 번째/다섯 번째 중복 사본을 만들지 말 것.
 *
 * 이 함수는 processRecord() 직전까지만 책임진다: 원본 raw 레코드 목록 + Prisma에서 읽어온
 * override/Slack 예외 원본을 받아 processRecord()에 바로 넘길 수 있는 RawRecord[]로 만들어
 * 돌려준다. DB 조회 자체(prisma.*.findMany 등)는 호출부 책임 — 호출부마다 이미 읽어온
 * 데이터의 출처(청크 fetch, 서버 컨텍스트 등)가 달라서 여기서 강제로 통일하지 않는다.
 *
 * 퇴사자 필터 버그 수정: compute-attendance/route.ts와 recompute_processed_data.ts는
 * 이 통합 전까지 퇴사자의 수기입력(override-only) 레코드를 걸러내지 않아서, 퇴사일 이후
 * 수기입력이 대시보드(processed_data)엔 보이는데 엑셀 내보내기(getProcessedRecords)에선
 * 빠지는 불일치가 있었다 — getProcessedRecords.ts에만 있던 resignedExcludedIds 필터를
 * 여기서 공통 적용해 수정.
 */
import type { Employee, RawRecord, EmployeeAttributeOverrides, PolicySettings } from '@/types/tag'
import { leaveTypeOverrideFields, synthesizeOverrideRecord, clockOverrideFields } from '@/utils/attendanceCalc'
import { getDayInfo } from '@/utils/dataParser'

/** attendance_overrides 테이블 행 — Prisma가 생성하는 정확한 타입 대신 실제 쓰는 필드만 최소 정의 */
export interface OverrideRow {
  employeeId:   string
  workDate:     string
  reasonLabel:  string | null
  memo:         string | null
  clockIn:      string | null
  clockOut:     string | null
  erpOtApplied: boolean | null
  erpLeaveType: string | null
}

/** slack_exceptions 테이블 행 */
export interface SlackExceptionRow {
  empId:   string
  date:    string
  note:    string
  rawText: string
}

export interface BuildRecordSetParams {
  employees:        Employee[]
  rawRecords:       RawRecord[]
  finalAttrMap:     Map<string, EmployeeAttributeOverrides>
  overrides:        OverrideRow[]
  slackExceptions:  SlackExceptionRow[]
  policy:           PolicySettings
  /** 지정하면 이 범위로 좁혀서 처리(엑셀 내보내기 등). 생략하면 전체 처리(전체 재계산 등). */
  range?: { from?: string; to?: string }
}

export interface BuildRecordSetResult {
  /** 퇴사자(완전 제외 대상) 제외된 직원 목록 */
  visibleEmployees: Employee[]
  /** processRecord()에 바로 넘길 수 있는 최종 레코드 목록 (override 병합 + 합성 레코드 포함) */
  records:          RawRecord[]
  slackNoteMap:      Map<string, { note: string; rawText: string }[]>
}

export function buildRecordSet(params: BuildRecordSetParams): BuildRecordSetResult {
  const { employees, rawRecords, finalAttrMap, overrides, slackExceptions, policy, range } = params

  // 퇴사자 완전 제외 — 퇴사일 미설정 시(대부분의 경우) 무조건 제외.
  // 퇴사일이 있으면 그 이전 기간은 포함(processRecord.ts의 날짜 비교와 동일 규칙).
  const resignedExcludedIds = new Set(
    employees
      .filter(e => {
        const attrs = finalAttrMap.get(e.id)
        return attrs?.isResigned && (!attrs.resignedFrom || (!!range?.from && attrs.resignedFrom < range.from))
      })
      .map(e => e.id),
  )
  const visibleEmployees = employees.filter(e => !resignedExcludedIds.has(e.id))

  const dateFiltered = rawRecords.filter(r =>
    !resignedExcludedIds.has(r.employeeId) &&
    (!range?.from || r.date >= range.from) &&
    (!range?.to   || r.date <= range.to),
  )

  // 관리자 수동 수정 반영
  const overrideMap = new Map(overrides.map(ov => [`${ov.employeeId}_${ov.workDate}`, ov]))
  const overridden: RawRecord[] = dateFiltered.map(r => {
    const ov = overrideMap.get(`${r.employeeId}_${r.date}`)
    if (!ov) return r
    return {
      ...r,
      clockIn:      ov.clockIn      ?? r.clockIn,
      clockOut:     ov.clockOut     ?? r.clockOut,
      erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      // erpLeaveType 반영 누락 버그 수정 — null=미수정, '없음'=명시적 삭제, 그 외=해당 연차유형으로 교체
      ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
      ...clockOverrideFields(ov),
    }
  })

  // 원본 CAPS/ERP 행이 아예 없는 override(결근일/주말 수기입력)는 위 map에서 재계산될 기회가
  // 없었다 — 대응하는 새 레코드를 합성해서 추가.
  const companyHolsMap = new Map((policy.companyHolidays ?? []).map(h => [h.date, h.label]))
  const rawKeys = new Set(dateFiltered.map(r => `${r.employeeId}_${r.date}`))
  const synthesizedRecords: RawRecord[] = []
  for (const ov of overrides) {
    if (ov.reasonLabel === '__DELETED__') continue
    if (resignedExcludedIds.has(ov.employeeId)) continue
    if (range?.from && ov.workDate < range.from) continue
    if (range?.to   && ov.workDate > range.to)   continue
    const key = `${ov.employeeId}_${ov.workDate}`
    if (rawKeys.has(key)) continue
    if (!ov.clockIn && !ov.clockOut && !ov.erpLeaveType) continue
    const { dayType, dayLabel } = getDayInfo(ov.workDate, companyHolsMap)
    synthesizedRecords.push(synthesizeOverrideRecord(ov.employeeId, ov.workDate, dayType, dayLabel, ov))
  }

  const slackNoteMap = new Map<string, { note: string; rawText: string }[]>()
  for (const s of slackExceptions) {
    const key = `${s.empId}_${s.date}`
    const arr = slackNoteMap.get(key) ?? []
    arr.push({ note: s.note, rawText: s.rawText })
    slackNoteMap.set(key, arr)
  }

  return {
    visibleEmployees,
    records: [...overridden, ...synthesizedRecords],
    slackNoteMap,
  }
}
