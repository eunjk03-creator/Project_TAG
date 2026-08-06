import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** Department가 team-level(level 1)이면 division(level 0) 조상까지 올라간다.
 *  파서가 division명을 orgChart.ts의 DIVISIONS 표기와 동일하게 저장하므로 별도 정규화 불필요. */
function resolveToRootName(deptId: string | null, byId: Map<string, { name: string; parentId: string | null }>): string | null {
  let cur = deptId
  let guard = 0
  while (cur && guard++ < 5) {
    const dept = byId.get(cur)
    if (!dept) return null
    if (!dept.parentId) return dept.name
    cur = dept.parentId
  }
  return null
}

export async function GET() {
  try {
    const [employees, departments] = await Promise.all([
      prisma.employeeMaster.findMany({ where: { status: 'ACTIVE' }, select: { departmentId: true } }),
      prisma.department.findMany({ select: { id: true, name: true, parentId: true } }),
    ])
    const byId = new Map(departments.map(d => [d.id, { name: d.name, parentId: d.parentId }]))

    const counts: Record<string, number> = {}
    for (const emp of employees) {
      const division = resolveToRootName(emp.departmentId, byId)
      if (!division) continue
      counts[division] = (counts[division] ?? 0) + 1
    }
    return NextResponse.json(counts)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
