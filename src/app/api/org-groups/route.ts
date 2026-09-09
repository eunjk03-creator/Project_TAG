import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const groups = await prisma.orgGroup.findMany({ orderBy: [{ order: 'asc' }] })
    const members = await prisma.orgGroupMember.findMany({
      where: { validTo: null },
      include: { employee: { select: { name: true } } },
    })
    const membersByGroup = new Map<string, typeof members>()
    for (const m of members) {
      const list = membersByGroup.get(m.groupId) ?? []
      list.push(m)
      membersByGroup.set(m.groupId, list)
    }
    const result = groups.map(g => ({
      id: g.id, name: g.name, parentId: g.parentId, order: g.order,
      members: (membersByGroup.get(g.id) ?? []).map(m => ({
        id: m.id, employeeRawId: m.employeeRawId, name: m.employee.name,
        jobTitle: m.jobTitle, hasApprovalAuthority: m.hasApprovalAuthority,
      })),
    }))
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.name?.trim()) return NextResponse.json({ error: '그룹명이 필요합니다.' }, { status: 400 })
    const created = await prisma.orgGroup.create({
      data: { name: body.name.trim(), parentId: body.parentId ?? null, order: body.order ?? 0 },
    })
    return NextResponse.json(created, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
