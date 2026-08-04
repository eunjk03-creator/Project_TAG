/**
 * 내보내기 라우트 공용: DB 원본 청크 → processRecord 온디맨드 실행
 * processed_data 캐시에 의존하지 않으므로 달 경계 누락 없음.
 */
import { prisma }           from '@/lib/prisma'
import { processRecord }    from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet }   from '@/lib/buildRecordSet'
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

  // 2. 원본 레코드 (전체) 읽기 — 날짜 필터는 buildRecordSet 내부에서 적용
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

  // 3. 예외규칙 + 직책자 맵
  const dbRules = await prisma.exceptionRule.findMany()
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  // 4. 관리자 수동 수정 + Slack 노트
  const overrides = await prisma.attendanceOverride.findMany()
  const slackExcs  = await prisma.slackException.findMany()

  // 5. override 병합 + 퇴사자 필터 + 합성 레코드 (compute-attendance/route.ts, 배치 재계산과 공용)
  const { visibleEmployees, records: mergedRecords, slackNoteMap } = buildRecordSet({
    employees, rawRecords: rawAll, finalAttrMap, overrides, slackExceptions: slackExcs, policy,
    range: { from: opts?.from, to: opts?.to },
  })

  if (mergedRecords.length === 0) return { employees: visibleEmployees, records: [], finalAttrMap }

  // 6. processRecord 실행
  const records = mergedRecords.map(r =>
    processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )

  return { employees: visibleEmployees, records, finalAttrMap }
}
