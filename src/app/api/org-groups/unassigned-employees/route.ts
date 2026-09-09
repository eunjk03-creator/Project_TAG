import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** OrgGroupMember가 없는(=조직도에 배치 안 된) 재직/휴직 직원 목록 — 신규입사자 배치용 풀. */
export async function GET() {
  try {
    const active = await prisma.orgGroupMember.findMany({
      where: { validTo: null },
      select: { employeeRawId: true },
    })
    const activeSet = new Set(active.map(a => a.employeeRawId))

    const candidates = await prisma.employeeMaster.findMany({
      where: { status: { not: 'RESIGNED' } },
      select: { rawId: true, name: true, status: true, hireDate: true },
      orderBy: { name: 'asc' },
    })
    const unassigned = candidates.filter(c => !activeSet.has(c.rawId))
    return NextResponse.json(unassigned)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
