import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** Department는 "본부 > 팀" 2단계 트리 — 부모 없으면 이 자체가 division, 있으면 이 자체가
 *  team이고 부모가 division. active-roster/route.ts의 resolveToRootName과 동일 컨벤션. */
function resolveOrgPath(
  deptId: string | null,
  byId: Map<string, { name: string; parentId: string | null }>,
): { division: string; team: string } {
  if (!deptId) return { division: '—', team: '' }
  const dept = byId.get(deptId)
  if (!dept) return { division: '—', team: '' }
  if (!dept.parentId) return { division: dept.name, team: '' }
  const parent = byId.get(dept.parentId)
  return { division: parent?.name ?? '—', team: dept.name }
}

export interface RosterRow {
  rawId:        string
  name:         string
  division:     string
  team:         string
  jobTitle:     string
  contractType: string
  status:       string
  hireDate:     string | null
  resignedDate: string | null
}

/** 상시인력 명단용 — 전체 EmployeeMaster를 부서 트리까지 resolve해서 반환.
 *  검색/페이지네이션은 규모(약 400명)상 클라이언트에서 처리(다른 화면들과 동일 컨벤션). */
export async function GET() {
  try {
    const [rows, departments] = await Promise.all([
      prisma.employeeMaster.findMany({
        select: {
          rawId: true, name: true, departmentId: true, jobTitle: true,
          contractType: true, status: true, hireDate: true, resignedDate: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.department.findMany({ select: { id: true, name: true, parentId: true } }),
    ])
    const byId = new Map(departments.map(d => [d.id, { name: d.name, parentId: d.parentId }]))
    const result: RosterRow[] = rows.map(e => {
      const { division, team } = resolveOrgPath(e.departmentId, byId)
      return {
        rawId: e.rawId, name: e.name, division, team,
        jobTitle: e.jobTitle, contractType: e.contractType, status: e.status,
        hireDate: e.hireDate, resignedDate: e.resignedDate,
      }
    })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
