import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.slackNameResolution.findMany()
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Bulk upsert: POST /api/slack/name-resolutions  body: { resolutions: {msgKey, empId, empName}[] } */
export async function POST(req: NextRequest) {
  try {
    const { resolutions } = await req.json() as {
      resolutions: { msgKey: string; empId: string; empName: string }[]
    }
    const rows = await Promise.all(
      resolutions.map(r => prisma.slackNameResolution.upsert({
        where:  { msgKey: r.msgKey },
        create: { msgKey: r.msgKey, empId: r.empId, empName: r.empName },
        update: { empId: r.empId, empName: r.empName },
      })),
    )
    return NextResponse.json(rows, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
