import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 종합현황의 "조직 정합성" 섹션용 — status=ACTIVE 전원을 division 해석까지 마쳐서 반환. */
export async function GET() {
  try {
    const [employees, departments] = await Promise.all([
      prisma.employeeMaster.findMany({ where: { status: 'ACTIVE' }, select: { rawId: true, name: true, departmentId: true } }),
      prisma.department.findMany({ select: { id: true, division: true } }),
    ])
    const divisionById = new Map(departments.map(d => [d.id, d.division]))
    const rows = employees.map(e => ({
      rawId: e.rawId,
      name: e.name,
      division: (e.departmentId && divisionById.get(e.departmentId)) ?? '—',
    }))
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
