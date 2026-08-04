/**
 * override/예외규칙 저장 직후 그 직원 1명분만 재계산해서 DailyAttendance에 반영한다.
 * attendance-overrides PUT, exception-rules 생성/수정/삭제 라우트에서 호출 — "전체 재계산"
 * 버튼이 필요한 경우 자체를 CAPS/ERP 재업로드 등 정말 드문 경우로 줄이는 게 목적이다.
 *
 * 원본 raw 레코드는 청크(4000건 단위) blob 저장이라 employeeId로 바로 조회할 방법이 없어
 * 전체 청크는 불가피하게 fetch하지만(I/O 바운드, 가벼움), processRecord()/upsert는 그
 * 직원분(보통 수백 건 이하)에만 실행돼서 compute-attendance 전체 재계산보다 훨씬 가볍다.
 *
 * policy는 DEFAULT_POLICY를 쓴다 — getProcessedRecords.ts/recompute_processed_data.ts와
 * 동일한 기존 관례(서버 트리거 재계산 경로는 DEFAULT_POLICY, 대화형 클라이언트 대시보드만
 * PolicyContext의 커스텀 정책을 씀). 정책을 커스터마이즈해서 쓰는 경우가 드물어서 당장은
 * 이 단순화가 안전하다고 판단했다 — 필요해지면 이 함수에 policy 파라미터를 추가하고
 * 호출부(라우트)가 요청 바디로 policy를 받아 넘기도록 확장하면 된다.
 */
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet } from '@/lib/buildRecordSet'
import { upsertAttendanceRows } from '@/lib/upsertAttendanceRows'
import { DEFAULT_POLICY } from '@/types/tag'
import type { Employee, RawRecord } from '@/types/tag'

interface AttendanceMeta {
  employees:   Employee[]
  rawRecords?: RawRecord[]
  chunkCount?: number
}

export async function recomputeEmployeeAttendance(employeeId: string): Promise<void> {
  const rawStore = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  if (!rawStore?.data) return
  const stored       = rawStore.data as unknown as AttendanceMeta
  const allEmployees = stored.employees ?? []
  const employee     = allEmployees.find(e => e.id === employeeId)
  if (!employee) return

  let rawAll: RawRecord[] = []
  if (stored.rawRecords?.length) {
    rawAll = stored.rawRecords
  } else if (stored.chunkCount) {
    const chunks = await Promise.all(
      Array.from({ length: stored.chunkCount }, (_, i) =>
        prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
          .then(r => (r?.data as { records?: RawRecord[] } | null)?.records ?? [])
          .catch(() => [] as RawRecord[]),
      ),
    )
    rawAll = chunks.flat()
  }
  const rawRecords = rawAll.filter(r => r.employeeId === employeeId)

  // exception_rules/attendance_overrides/slack_exceptions는 실제 SQL 테이블이라 employeeId로
  // 바로 필터링해서 가져올 수 있다 (raw 근태 blob과 달리 여기는 진짜 "필요한 것만" 조회).
  const [dbRules, overrides, slackExcs] = await Promise.all([
    prisma.exceptionRule.findMany({ where: { employeeId } }),
    prisma.attendanceOverride.findMany({ where: { employeeId } }),
    prisma.slackException.findMany({ where: { empId: employeeId } }),
  ])
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap([employee], dbRules)

  const { records: mergedRecords, slackNoteMap } = buildRecordSet({
    employees: [employee], rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs,
    policy: DEFAULT_POLICY,
  })
  if (mergedRecords.length === 0) return

  const processed = mergedRecords.map(r =>
    processRecord(r, DEFAULT_POLICY, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )
  await upsertAttendanceRows(processed)
}
