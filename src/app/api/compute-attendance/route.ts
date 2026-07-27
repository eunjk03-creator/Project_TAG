import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { leaveTypeOverrideFields, synthesizeOverrideRecord } from '@/utils/attendanceCalc'
import { getDayInfo } from '@/utils/dataParser'
import { DEFAULT_POLICY } from '@/types/tag'
import type { PolicySettings, RawRecord, Employee } from '@/types/tag'

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

    // 3. Load admin overrides and apply to raw records
    const overrides = await prisma.attendanceOverride.findMany()
    const overrideMap = new Map(
      overrides.map(ov => [`${ov.employeeId}_${ov.workDate}`, ov]),
    )
    const overriddenRecords: RawRecord[] = rawRecords.map(r => {
      const ov = overrideMap.get(`${r.employeeId}_${r.date}`)
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn      ?? r.clockIn,
        clockOut:     ov.clockOut     ?? r.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
        // erpLeaveType 반영 누락 버그 수정 — null=미수정, '없음'=명시적 삭제, 그 외=해당 연차유형으로 교체
        ...(ov.erpLeaveType !== null ? leaveTypeOverrideFields(ov.erpLeaveType) : {}),
      }
    })

    // 원본 CAPS/ERP 행이 아예 없는 override(예: 결근일/주말 수기입력)는 위 map에서 재계산될 기회가
    // 없었다 — 대응하는 새 레코드를 합성해서 추가.
    const companyHolsMap = new Map((policy.companyHolidays ?? []).map(h => [h.date, h.label]))
    const rawKeys = new Set(rawRecords.map(r => `${r.employeeId}_${r.date}`))
    const synthesizedRecords: RawRecord[] = []
    for (const ov of overrides) {
      if (ov.reasonLabel === '__DELETED__') continue
      const key = `${ov.employeeId}_${ov.workDate}`
      if (rawKeys.has(key)) continue
      if (!ov.clockIn && !ov.clockOut && !ov.erpLeaveType) continue
      const { dayType, dayLabel } = getDayInfo(ov.workDate, companyHolsMap)
      synthesizedRecords.push(synthesizeOverrideRecord(ov.employeeId, ov.workDate, dayType, dayLabel, ov))
    }

    // 4. Load Slack notes
    const slackExcs = await prisma.slackException.findMany()
    const slackNoteMap = new Map<string, { note: string; rawText: string }[]>()
    for (const s of slackExcs) {
      const key = `${s.empId}_${s.date}`
      const arr = slackNoteMap.get(key) ?? []
      arr.push({ note: s.note, rawText: s.rawText })
      slackNoteMap.set(key, arr)
    }

    // 5. Process all records server-side (기존 레코드 + 원본 없는 수기입력 합성 레코드)
    const processed = [...overriddenRecords, ...synthesizedRecords].map(r =>
      processRecord(r, policy, otExemptIds, slackNoteMap, finalAttrMap.get(r.employeeId)),
    )

    const processedAt = new Date().toISOString()

    // 6. Persist computed results
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
