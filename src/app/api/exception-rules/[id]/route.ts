import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recomputeEmployeeAttendance } from '@/lib/recomputeEmployee'

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

    // employeeId 자체가 바뀔 수도 있는 드문 케이스까지 대비해 수정 전 소유자도 기억해둔다.
    const before = await prisma.exceptionRule.findUnique({ where: { id }, select: { employeeId: true } })
    const row = await prisma.exceptionRule.update({ where: { id }, data })

    const affectedIds = [...new Set([before?.employeeId, row.employeeId].filter((v): v is string => !!v))]
    for (const employeeId of affectedIds) {
      try {
        await recomputeEmployeeAttendance(employeeId)
      } catch (err) {
        console.error('[exception-rules] 증분 재계산 실패:', err)
      }
    }

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
    const existing = await prisma.exceptionRule.findUnique({ where: { id }, select: { employeeId: true } })
    await prisma.exceptionRule.delete({ where: { id } })

    if (existing) {
      try {
        await recomputeEmployeeAttendance(existing.employeeId)
      } catch (err) {
        console.error('[exception-rules] 증분 재계산 실패:', err)
      }
    }

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
