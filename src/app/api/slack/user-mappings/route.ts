import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.slackUserMapping.findMany({ orderBy: { employeeName: 'asc' } })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Bulk upsert: POST /api/slack/user-mappings  body: { mappings: {employeeId, employeeName, slackUserId, slackName, matchedBy}[] } */
export async function POST(req: NextRequest) {
  try {
    const { mappings } = await req.json() as {
      mappings: { employeeId: string; employeeName: string; slackUserId: string; slackName?: string; matchedBy?: string }[]
    }
    const rows = await Promise.all(
      mappings.map(m => prisma.slackUserMapping.upsert({
        where:  { employeeId: m.employeeId },
        create: {
          employeeId: m.employeeId, employeeName: m.employeeName,
          slackUserId: m.slackUserId, slackName: m.slackName ?? '',
          matchedBy: m.matchedBy ?? 'manual',
        },
        update: {
          employeeName: m.employeeName, slackUserId: m.slackUserId,
          slackName: m.slackName ?? '', matchedBy: m.matchedBy ?? 'manual',
        },
      })),
    )
    return NextResponse.json(rows, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** DELETE /api/slack/user-mappings  body: { employeeIds: string[] } */
export async function DELETE(req: NextRequest) {
  try {
    const { employeeIds } = await req.json() as { employeeIds: string[] }
    await prisma.slackUserMapping.deleteMany({ where: { employeeId: { in: employeeIds } } })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
