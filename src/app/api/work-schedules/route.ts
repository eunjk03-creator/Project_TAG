import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.workSchedule.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { members: true } } },
    })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.name || !body.ruleType) {
      return NextResponse.json({ error: 'name과 ruleType은 필수입니다.' }, { status: 400 })
    }
    const row = await prisma.workSchedule.create({
      data: {
        name:           body.name,
        description:    body.description    ?? '',
        ruleType:       body.ruleType,
        shortenedHours: body.shortenedHours ?? null,
        excludeFromOt:  body.excludeFromOt  ?? false,
      },
    })
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
