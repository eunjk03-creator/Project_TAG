import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

function resolveToRootName(deptId: string | null, byId: Map<string, { name: string; parentId: string | null }>): string {
  let cur = deptId
  let guard = 0
  while (cur && guard++ < 5) {
    const dept = byId.get(cur)
    if (!dept) return '—'
    if (!dept.parentId) return dept.name
    cur = dept.parentId
  }
  return '—'
}

/** 종합현황의 "조직 정합성" 섹션용 — status=ACTIVE 전원을 division 해석까지 마쳐서 반환. */
export async function GET() {
  try {
    const [employees, departments] = await Promise.all([
      prisma.employeeMaster.findMany({ where: { status: 'ACTIVE' }, select: { rawId: true, name: true, departmentId: true } }),
      prisma.department.findMany({ select: { id: true, name: true, parentId: true } }),
    ])
    const byId = new Map(departments.map(d => [d.id, { name: d.name, parentId: d.parentId }]))
    const rows = employees.map(e => ({ rawId: e.rawId, name: e.name, division: resolveToRootName(e.departmentId, byId) }))
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
