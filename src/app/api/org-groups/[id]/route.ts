import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    if (!body.name?.trim()) return NextResponse.json({ error: '그룹명이 필요합니다.' }, { status: 400 })
    const updated = await prisma.orgGroup.update({ where: { id }, data: { name: body.name.trim() } })
    return NextResponse.json(updated)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const childCount = await prisma.orgGroup.count({ where: { parentId: id } })
    if (childCount > 0) {
      return NextResponse.json({ error: `하위 그룹이 ${childCount}개 있어 삭제할 수 없습니다.` }, { status: 400 })
    }
    const memberCount = await prisma.orgGroupMember.count({ where: { groupId: id, validTo: null } })
    if (memberCount > 0) {
      return NextResponse.json({ error: `소속 인원이 ${memberCount}명 있어 삭제할 수 없습니다.` }, { status: 400 })
    }
    await prisma.orgGroup.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
