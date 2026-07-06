/**
 * 내보내기 라우트 공용: DB 원본 청크 → processRecord 온디맨드 실행
 * processed_data 캐시에 의존하지 않으므로 달 경계 누락 없음.
 */
import { prisma }           from '@/lib/prisma'
import { processRecord }    from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { DEFAULT_POLICY }   from '@/types/tag'
import type { PolicySettings, RawRecord, Employee, ProcessedRecord } from '@/types/tag'

interface AttendanceMeta {
  employees:   Employee[]
  rawRecords?: RawRecord[]   // legacy single-object format
  chunkCount?: number
}

export async function getProcessedRecords(opts?: {
  from?:   string
  to?:     string
  policy?: Partial<PolicySettings>
}): Promise<{ employees: Employee[]; records: ProcessedRecord[] }> {
  const policy: PolicySettings = { ...DEFAULT_POLICY, ...(opts?.policy ?? {}) }

  // 1. 직원 목록 + 청크 수
  const metaRow = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  if (!metaRow?.data) return { employees: [], records: [] }

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
  const raw = rawAll.filter(r =>
    (!opts?.from || r.date >= opts.from) &&
    (!opts?.to   || r.date <= opts.to),
  )
  if (raw.length === 0) return { employees, records: [] }

  // 3. 예외규칙 + 직책자 맵
  const dbRules = await prisma.exceptionRule.findMany()
  const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

  // 4. 관리자 수동 수정 반영
  const overrides   = await prisma.attendanceOverride.findMany()
  const overrideMap = new Map(overrides.map(ov => [`${ov.employeeId}_${ov.workDate}`, ov]))
  const overridden  = raw.map(r => {
    const ov = overrideMap.get(`${r.employeeId}_${r.date}`)
    if (!ov) return r
    return {
      ...r,
      clockIn:      ov.clockIn      ?? r.clockIn,
      clockOut:     ov.clockOut     ?? r.clockOut,
      erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
    }
  })

  // 5. Slack 노트 맵
  const slackExcs   = await prisma.slackException.findMany()
  const slackNoteMap = new Map<string, { note: string; rawText: string }[]>()
  for (const s of slackExcs) {
    const key = `${s.empId}_${s.date}`
    const arr = slackNoteMap.get(key) ?? []
    arr.push({ note: s.note, rawText: s.rawText })
    slackNoteMap.set(key, arr)
  }

  // 6. processRecord 실행
  const records = overridden.map(r =>
    processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
  )

  return { employees, records }
}
