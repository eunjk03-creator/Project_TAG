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

// 사원번호(rawId) 형식 = "E" + 입사년도(YY) + 입사월(MM) + 입사일(DD) + 그날 순번(NN).
// 조직도 시트의 hireDate가 비어있는 경우가 많아서(엑셀에 그 칼럼이 없거나 미기입), rawId에서
// 역산한 값을 폴백으로 채운다 — 시트에 실제 입력된 hireDate가 있으면 그게 항상 우선.
function deriveHireDateFromRawId(rawId: string): string | null {
  const m = /^E(\d{2})(\d{2})(\d{2})\d{2}$/.exec(rawId)
  if (!m) return null
  const [, yy, mm, dd] = m
  const month = Number(mm)
  const day   = Number(dd)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `20${yy}-${mm}-${dd}`
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
        hireDate: e.hireDate ?? deriveHireDateFromRawId(e.rawId), resignedDate: e.resignedDate,
      }
    })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
