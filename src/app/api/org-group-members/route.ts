import { NextRequest, NextResponse } from 'next/server'
import type { JobTitle } from '@prisma/client'
import { prisma } from '@/lib/prisma'

/** ?employeeRawId=X — 그 사람의 OrgGroupMember 전체 이력(과거+현재), validFrom 오름차순. */
export async function GET(req: NextRequest) {
  try {
    const employeeRawId = req.nextUrl.searchParams.get('employeeRawId')
    if (!employeeRawId) return NextResponse.json({ error: 'employeeRawId가 필요합니다.' }, { status: 400 })
    const rows = await prisma.orgGroupMember.findMany({
      where: { employeeRawId },
      include: { group: { select: { name: true, parentId: true } } },
      orderBy: { validFrom: 'asc' },
    })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** 미배정 직원을 그룹에 처음 배치 — 이미 활성 소속이 있으면 409(소속이동 API를 쓰라고 안내). */
export async function POST(req: NextRequest) {
  try {
    const { employeeRawId, groupId, jobTitle } = await req.json() as {
      employeeRawId: string; groupId: string; jobTitle?: string
    }
    if (!employeeRawId || !groupId) {
      return NextResponse.json({ error: 'employeeRawId, groupId가 필요합니다.' }, { status: 400 })
    }
    const existing = await prisma.orgGroupMember.findFirst({
      where: { employeeRawId, validTo: null },
    })
    if (existing) {
      return NextResponse.json(
        { error: '이미 다른 그룹에 소속되어 있습니다. 소속이동 기능을 사용하세요.' },
        { status: 409 },
      )
    }
    const created = await prisma.orgGroupMember.create({
      data: {
        groupId, employeeRawId,
        jobTitle: (jobTitle ?? 'MEMBER') as JobTitle,
        isPrimary: true, hasApprovalAuthority: false,
        validFrom: new Date(), validTo: null,
      },
    })
    return NextResponse.json(created, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
