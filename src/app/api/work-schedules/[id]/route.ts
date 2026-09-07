import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recomputeEmployeeAttendance } from '@/lib/recomputeEmployee'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const row = await prisma.workSchedule.findUnique({
      where: { id },
      include: { members: { orderBy: { employeeName: 'asc' } } },
    })
    if (!row) return NextResponse.json({ error: '근무제를 찾을 수 없습니다.' }, { status: 404 })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** 근무제 파라미터 수정 — 배정된 전체 멤버를 증분 재계산한다(파라미터가 ExceptionRule에
 *  직접 복사돼 있지 않고 근무제 쪽에만 있으므로, 여기서 고치면 멤버 개개인 규칙엔 반영 안
 *  됨 — 이번 라운드는 "이름/설명/기본 파라미터"만 관리하는 스코프라 멤버 규칙 자체를
 *  일괄 재기록하지는 않는다. 재계산은 안전을 위해 트리거만 해둔다. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (body.name           !== undefined) data.name           = body.name
    if (body.description    !== undefined) data.description    = body.description
    if (body.ruleType       !== undefined) data.ruleType       = body.ruleType
    if (body.shortenedHours !== undefined) data.shortenedHours = body.shortenedHours
    if (body.excludeFromOt  !== undefined) data.excludeFromOt  = body.excludeFromOt

    const row = await prisma.workSchedule.update({
      where: { id },
      data,
      include: { members: { orderBy: { employeeName: 'asc' } } },
    })

    for (const member of row.members) {
      try {
        await recomputeEmployeeAttendance(member.employeeId)
      } catch (err) {
        console.error('[work-schedules] 증분 재계산 실패:', err)
      }
    }

    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** 배정 인원이 있으면 삭제를 막는다 — 소속 인원의 예외규칙이 고아가 되는 걸 방지. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const memberCount = await prisma.exceptionRule.count({ where: { workScheduleId: id } })
    if (memberCount > 0) {
      return NextResponse.json(
        { error: `배정된 인원이 ${memberCount}명 있어 삭제할 수 없습니다. 먼저 인원을 제외해주세요.` },
        { status: 400 },
      )
    }
    await prisma.workSchedule.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
