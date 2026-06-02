import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.exceptionRule.findMany({
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const row = await prisma.exceptionRule.create({
      data: {
        employeeId:     body.employeeId,
        employeeName:   body.employeeName,
        jobTitle:       body.jobTitle       ?? '',
        division:       body.division       ?? '',
        team:           body.team           ?? '',
        ruleType:       body.ruleType,
        excludeFromOt:  body.excludeFromOt  ?? false,
        shortenedHours: body.shortenedHours ?? 0,
        validFrom:      body.validFrom      ?? '',
        validTo:        body.validTo        ?? '',
      },
    })
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Bulk delete: DELETE /api/exception-rules  body: { ids: string[] } */
export async function DELETE(req: NextRequest) {
  try {
    const { ids } = await req.json() as { ids: string[] }
    if (!ids?.length) return NextResponse.json({ deleted: 0 })
    const result = await prisma.exceptionRule.deleteMany({
      where: { id: { in: ids } },
    })
    return NextResponse.json({ deleted: result.count })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
