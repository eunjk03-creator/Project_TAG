import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (body.employeeId     !== undefined) data.employeeId     = body.employeeId
    if (body.employeeName   !== undefined) data.employeeName   = body.employeeName
    if (body.jobTitle       !== undefined) data.jobTitle       = body.jobTitle
    if (body.division       !== undefined) data.division       = body.division
    if (body.team           !== undefined) data.team           = body.team
    if (body.ruleType       !== undefined) data.ruleType       = body.ruleType
    if (body.excludeFromOt  !== undefined) data.excludeFromOt  = body.excludeFromOt
    if (body.shortenedHours !== undefined) data.shortenedHours = body.shortenedHours
    if (body.validFrom      !== undefined) data.validFrom      = body.validFrom
    if (body.validTo        !== undefined) data.validTo        = body.validTo

    const row = await prisma.exceptionRule.update({ where: { id }, data })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    await prisma.exceptionRule.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
