import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { buildRecordSet } from '@/lib/buildRecordSet'
import { DEFAULT_POLICY } from '@/types/tag'
import type { PolicySettings, RawRecord, Employee } from '@/types/tag'

// 전체 재계산은 4~5만 건 전량을 한 요청에서 순회한다 — Vercel 기본 타임아웃(플랜별 상이,
// 명시 안 하면 Hobby 10s/Pro 15s)로는 부족해서 조용히 504로 죽던 문제(B14)가 있었음.
// Hobby 플랜이면 이 값이 60s로 클램프되니, 그래도 타임아웃되면 플랜 업그레이드나 배치
// 분할(레코드를 나눠 여러 번 호출)이 필요하다 — 이 숫자를 더 올리는 걸로는 해결 안 됨.
export const maxDuration = 300

interface StoredAttendance {
  employees:   Employee[]
  rawRecords?: RawRecord[]  // legacy: all records in one row
  chunkCount?: number        // new: records split across attendance_records_N keys
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { policy: rawPolicy } = body as { policy?: Partial<PolicySettings> }
    // Merge with DEFAULT_POLICY so missing fields never cause undefined errors
    const policy: PolicySettings = { ...DEFAULT_POLICY, ...(rawPolicy ?? {}) }

    // 1. Load raw attendance data
    const rawStore = await prisma.sharedDataStore.findUnique({
      where: { key: 'attendance_data' },
    })
    if (!rawStore?.data) {
      return NextResponse.json({ error: 'no attendance data found' }, { status: 404 })
    }

    const stored = rawStore.data as unknown as StoredAttendance
    const employees: Employee[] = stored.employees ?? []

    // Support both legacy (rawRecords in one row) and new chunked format
    let rawRecords: RawRecord[] = []
    if (stored.rawRecords?.length) {
      rawRecords = stored.rawRecords
    } else if (stored.chunkCount != null && stored.chunkCount > 0) {
      const chunkRows = await Promise.all(
        Array.from({ length: stored.chunkCount }, (_, i) =>
          prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
            .then(r => {
              const d = r?.data as unknown as { records?: RawRecord[] } | null
              return d?.records ?? []
            })
            .catch(() => [] as RawRecord[]),
        ),
      )
      rawRecords = chunkRows.flat()
    }

    if (!rawRecords.length) {
      return NextResponse.json({ ok: true, count: 0, processedAt: new Date().toISOString() })
    }

    // 2. Load exception rules and build attribute maps
    const dbRules = await prisma.exceptionRule.findMany()
    const { finalAttrMap, otExemptIds } = buildFinalAttrMap(employees, dbRules)

    // 3. Load admin overrides + Slack notes, merge (getProcessedRecords.ts와 공용 로직 —
    // 퇴사자 제외 필터를 여기서도 적용하도록 통합됨. 예전엔 이 라우트에만 그 필터가 빠져 있어서
    // 퇴사일 이후 수기입력이 대시보드엔 보이는데 엑셀 내보내기엔 안 보이는 불일치가 있었음.)
    const overrides = await prisma.attendanceOverride.findMany()
    const slackExcs  = await prisma.slackException.findMany()
    const { records: mergedRecords, slackNoteMap } = buildRecordSet({
      employees, rawRecords, finalAttrMap, overrides, slackExceptions: slackExcs, policy,
    })

    // 4. Process all records server-side
    const processed = mergedRecords.map(r =>
      processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
    )

    const processedAt = new Date().toISOString()

    // 5. Persist computed results
    await prisma.sharedDataStore.upsert({
      where:  { key: 'processed_data' },
      create: { key: 'processed_data', data: { processed, processedAt } as object },
      update: { data: { processed, processedAt } as object },
    })

    return NextResponse.json({ ok: true, count: processed.length, processedAt })
  } catch (err) {
    console.error('[compute-attendance] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    )
  }
}
