/**
 * 내보내기 라우트 공용: DB 원본 청크 → processRecord 온디맨드 실행
 * processed_data 캐시에 의존하지 않으므로 달 경계 누락 없음.
 */
import { prisma }           from '@/lib/prisma'
import { processRecord }    from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { leaveTypeOverrideFields, synthesizeOverrideRecord } from '@/utils/attendanceCalc'
import { getDayInfo }       from '@/utils/dataParser'
import { DEFAULT_POLICY }   from '@/types/tag'
import type { PolicySettings, RawRecord, Employee, ProcessedRecord, EmployeeAttributeOverrides } from '@/types/tag'

interface AttendanceMeta {
  employees:   Employee[]
  rawRecords?: RawRecord[]   // legacy single-object format
  chunkCount?: number
}

export async function getProcessedRecords(opts?: {
  from?:   string
  to?:     string
  policy?: Partial<PolicySettings>
}): Promise<{ employees: Employee[]; records: ProcessedRecord[]; finalAttrMap: Map<string, EmployeeAttributeOverrides> }> {
  const policy: PolicySettings = { ...DEFAULT_POLICY, ...(opts?.policy ?? {}) }

  // 1. 직원 목록 + 청크 수
  const metaRow = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  if (!metaRow?.data) return { employees: [], records: [], finalAttrMap: new Map() }

  const meta       = metaRow.data as unknown as AttendanceMeta
  const employees  = meta.employees ?? []

  // 2. 원본 레코드 (전체) 읽기 — 날짜 필터는 처리 전 적용
  let rawAll: RawRecord[] = []
  if (meta.rawRecords?.length) {
    rawAll = meta.rawRecords
  } else if (meta.chunkCount) {
    const chunks = await Promise.all(
      Array.from({ length: meta.chunkCount }, (_, i) =>
        prisma.sharedDataStore
          .findUnique({ where: { key: `attendance_records_${i}` } })
          .then(r => ((r?.data as { records?: RawRecord[] } | null)?.records) ?? [])
          .catch(() => [] as RawRecord[]),
      ),
    )
    rawAll = chunks.flat()
  }

  // 날짜 필터 — 요청 범위만 처리해서 서버 부담 최소화
  const dateFiltered = rawAll.filter(r =>
    (!opts?.from || r.date >= opts.from) &&
    (!opts?.to   || r.date <= opts.to),
  )
  // 3. 예외규칙 + 직책자 맵
  const dbRules = await prisma.exceptionRule.findMany()
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  // 퇴사자 완전 제외 — 퇴사일 미설정 시(대부분의 경우) 무조건 제외.
  // 퇴사일이 있으면 그 이전 기간은 포함(기존 admin 화면과 동일한 규칙).
  const resignedExcludedIds = new Set(
    employees
      .filter(e => {
        const attrs = finalAttrMap.get(e.id)
        return attrs?.isResigned && (!attrs.resignedFrom || (!!opts?.from && attrs.resignedFrom < opts.from))
      })
      .map(e => e.id),
  )
  const visibleEmployees = employees.filter(e => !resignedExcludedIds.has(e.id))
  const raw = dateFiltered.filter(r => !resignedExcludedIds.has(r.employeeId))

  if (raw.length === 0) return { employees: visibleEmployees, records: [], finalAttrMap }

  // 4. 관리자 수동 수정 반영
  const overrides   = await prisma.attendanceOverride.findMany()
  const overrideMap = new Map(overrides.map(ov => [`${ov.employeeId}_${ov.workDate}`, ov]))
  const overridden: RawRecord[] = raw.map(r => {
    const ov = overrideMap.get(`${r.employeeId}_${r.date}`)
    if (!ov) return r
    return {
      ...r,
      clockIn:      ov.clockIn      ?? r.clockIn,
      clockOut:     ov.clockOut     ?? r.clockOut,
      erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      // erpLeaveType 반영 누락 버그 수정 — 화면엔 연차로 보이는데 내보내기엔 안 나오던 원인
      ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
    }
  })

  // 원본 CAPS/ERP 행이 아예 없는 override(결근일/주말 수기입력)는 위 map에서 재계산될 기회가
  // 없었다 — 그리드/대시보드와 동일하게 합성 레코드를 추가해서 내보내기 결과가 일치하도록 함.
  const companyHolsMap = new Map((policy.companyHolidays ?? []).map(h => [h.date, h.label]))
  const rawKeys = new Set(raw.map(r => `${r.employeeId}_${r.date}`))
  const synthesized: RawRecord[] = []
  for (const ov of overrides) {
    if (ov.reasonLabel === '__DELETED__') continue
    if (resignedExcludedIds.has(ov.employeeId)) continue
    if (opts?.from && ov.workDate < opts.from) continue
    if (opts?.to   && ov.workDate > opts.to)   continue
    const key = `${ov.employeeId}_${ov.workDate}`
    if (rawKeys.has(key)) continue
    if (!ov.clockIn && !ov.clockOut && !ov.erpLeaveType) continue
    const { dayType, dayLabel } = getDayInfo(ov.workDate, companyHolsMap)
    synthesized.push(synthesizeOverrideRecord(ov.employeeId, ov.workDate, dayType, dayLabel, ov))
  }

  // 5. Slack 노트 맵
  const slackExcs   = await prisma.slackException.findMany()
  const slackNoteMap = new Map<string, { note: string; rawText: string }[]>()
  for (const s of slackExcs) {
    const key = `${s.empId}_${s.date}`
    const arr = slackNoteMap.get(key) ?? []
    arr.push({ note: s.note, rawText: s.rawText })
    slackNoteMap.set(key, arr)
  }

  // 6. processRecord 실행 (기존 레코드 + 원본 없는 수기입력 합성 레코드)
  const records = [...overridden, ...synthesized].map(r =>
    processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )

  return { employees: visibleEmployees, records, finalAttrMap }
}
