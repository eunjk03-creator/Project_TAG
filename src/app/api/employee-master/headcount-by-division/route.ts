import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 파서가 division명을 orgChart.ts의 DIVISIONS 표기와 동일하게 저장하므로 별도 정규화 불필요. */
export async function GET() {
  try {
    const [employees, departments] = await Promise.all([
      prisma.employeeMaster.findMany({ where: { status: 'ACTIVE' }, select: { departmentId: true } }),
      prisma.department.findMany({ select: { id: true, division: true } }),
    ])
    const divisionById = new Map(departments.map(d => [d.id, d.division]))

    const counts: Record<string, number> = {}
    for (const emp of employees) {
      const division = emp.departmentId ? divisionById.get(emp.departmentId) : null
      if (!division) continue
      counts[division] = (counts[division] ?? 0) + 1
    }
    return NextResponse.json(counts)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
