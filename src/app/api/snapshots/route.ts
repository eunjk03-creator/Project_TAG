import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'crypto'
import type { ProcessedRecord, Employee, CompanyHoliday } from '@/types/tag'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      label,
      leaderIds           = [] as string[],
      globalExclusionIds  = [] as string[],
      otExemptIds         = [] as string[],
      companyHolidays     = [] as CompanyHoliday[],
    } = body as {
      label?:              string
      leaderIds?:          string[]
      globalExclusionIds?: string[]
      otExemptIds?:        string[]
      companyHolidays?:    CompanyHoliday[]
    }

    // Load pre-computed processedRecords
    const pdRow = await prisma.sharedDataStore.findUnique({ where: { key: 'processed_data' } })
    if (!pdRow?.data) {
      return NextResponse.json({ error: 'processed_data not found — run compute first' }, { status: 404 })
    }
    const { processed } = pdRow.data as unknown as { processed: ProcessedRecord[]; processedAt: string }

    // Load employees
    const attRow = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
    const { employees = [] } = (attRow?.data ?? {}) as unknown as { employees: Employee[] }

    const id        = randomUUID()
    const createdAt = new Date().toISOString()

    await prisma.sharedDataStore.create({
      data: {
        key:  `snapshot_${id}`,
        data: { processed, employees, leaderIds, globalExclusionIds, otExemptIds, companyHolidays, createdAt, label: label ?? null } as object,
      },
    })

    return NextResponse.json({ id, url: `/share/${id}`, createdAt })
  } catch (err) {
    console.error('[snapshots POST]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'error' }, { status: 500 })
  }
}
