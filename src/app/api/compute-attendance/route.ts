import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processRecord } from '@/lib/processRecord'
import { buildFinalAttrMap } from '@/lib/attendanceDefaults'
import { DEFAULT_POLICY } from '@/types/tag'
import type { PolicySettings, RawRecord, Employee } from '@/types/tag'

interface StoredAttendance {
  employees:  Employee[]
  rawRecords: RawRecord[]
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
    const { employees = [], rawRecords = [] } = stored

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
    const overriddenRecords = rawRecords.map(r => {
      const ov = overrideMap.get(`${r.employeeId}_${r.date}`)
      if (!ov) return r
      return {
        ...r,
        clockIn:      ov.clockIn      ?? r.clockIn,
        clockOut:     ov.clockOut     ?? r.clockOut,
        erpOtApplied: ov.erpOtApplied !== null ? ov.erpOtApplied : r.erpOtApplied,
      }
    })

    // 4. Load Slack notes
    const slackExcs = await prisma.slackException.findMany()
    const slackNoteMap = new Map<string, { note: string; rawText: string }[]>()
    for (const s of slackExcs) {
      const key = `${s.empId}_${s.date}`
      const arr = slackNoteMap.get(key) ?? []
      arr.push({ note: s.note, rawText: s.rawText })
      slackNoteMap.set(key, arr)
    }

    // 5. Process all records server-side
    const processed = overriddenRecords.map(r =>
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
