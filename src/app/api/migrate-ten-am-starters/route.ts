import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const TEN_AM_RAW_IDS = new Set([
  'E25081103', 'E25120104', 'E26010511', 'E25021702',
  'E25011501', 'E22121901', 'E25110301',
])

interface StoredEmployee {
  id:        string
  rawId?:    string
  name:      string
  jobTitle?: string
  division?: string
  team?:     string
}

interface AttendanceDataMeta {
  employees: StoredEmployee[]
}

/** One-time migration: insert ten_am_starter exception rules for hard-coded employees.
 *  Safe to call multiple times — skips employees already in exception_rules. */
export async function GET() {
  try {
    const stored = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
    if (!stored) {
      return NextResponse.json({ error: 'attendance_data not found. Upload CAPS data first.' }, { status: 404 })
    }

    const meta = stored.data as unknown as AttendanceDataMeta
    const employees: StoredEmployee[] = meta.employees ?? []

    const existing = await prisma.exceptionRule.findMany({ where: { ruleType: 'ten_am_starter' } })
    const existingEmpIds = new Set(existing.map(r => r.employeeId))

    const toInsert = employees.filter(emp => {
      const rawId = emp.rawId ?? emp.id.split('_')[0]
      return TEN_AM_RAW_IDS.has(rawId) && !existingEmpIds.has(emp.id)
    })

    if (toInsert.length === 0) {
      return NextResponse.json({
        message: 'Already migrated — all employees found in exception_rules.',
        existing: existing.map(r => ({ id: r.employeeId, name: r.employeeName })),
      })
    }

    const result = await prisma.exceptionRule.createMany({
      data: toInsert.map(emp => ({
        employeeId:     emp.id,
        employeeName:   emp.name,
        jobTitle:       emp.jobTitle   ?? '',
        division:       emp.division   ?? '',
        team:           emp.team       ?? '',
        ruleType:       'ten_am_starter',
        excludeFromOt:  false,
        shortenedHours: 0,
        validFrom:      '',
        validTo:        '',
      })),
    })

    return NextResponse.json({
      inserted: result.count,
      employees: toInsert.map(e => ({ id: e.id, name: e.name })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
