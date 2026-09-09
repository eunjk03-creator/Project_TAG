import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  try {
    const { employeeRawId, newGroupId } = await req.json() as { employeeRawId: string; newGroupId: string }
    if (!employeeRawId || !newGroupId) {
      return NextResponse.json({ error: 'employeeRawId, newGroupId가 필요합니다.' }, { status: 400 })
    }
    const current = await prisma.orgGroupMember.findFirst({
      where: { employeeRawId, validTo: null, isPrimary: true },
    })
    if (!current) return NextResponse.json({ error: '현재 소속 정보를 찾을 수 없습니다.' }, { status: 404 })
    if (current.groupId === newGroupId) return NextResponse.json(current)

    const now = new Date()
    const [, created] = await prisma.$transaction([
      prisma.orgGroupMember.update({ where: { id: current.id }, data: { validTo: now } }),
      prisma.orgGroupMember.create({
        data: {
          groupId: newGroupId, employeeRawId, jobTitle: current.jobTitle,
          isPrimary: true, hasApprovalAuthority: current.hasApprovalAuthority,
          validFrom: now, validTo: null,
        },
      }),
    ])
    return NextResponse.json(created)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
