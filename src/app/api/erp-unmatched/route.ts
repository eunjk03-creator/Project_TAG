import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildEmployeesAndRawRecords } from '@/lib/recomputeFromNormalized'
import { groupUnmatchedErp, type ErpUnmatchedGroup } from '@/utils/erpUnmatchedGrouping'

export type { ErpUnmatchedGroup }

// GET /api/erp-unmatched → CAPS와 매칭 안 돼서 조용히 버려지던 ERP 연장근로/휴가 신청 목록
// (전체 이력 기준). 전체 CAPS/ERP를 다시 파싱해야 하는 무거운 조회라 /admin/employees에서
// 페이지 진입 시 1회만 부르고, 폴링하지 않는다.
export async function GET() {
  const { unmatchedErp } = await buildEmployeesAndRawRecords()
  const list = groupUnmatchedErp(unmatchedErp)

  if (list.length > 0) {
    const masters = await prisma.employeeMaster.findMany({
      where:   { rawId: { in: list.map(g => g.rawId) } },
      select:  { rawId: true, department: { select: { division: true, team: true } } },
    })
    const deptByRawId = new Map(masters.map(m => [
      m.rawId,
      m.department ? [m.department.division, m.department.team].filter(Boolean).join(' · ') : null,
    ]))
    for (const g of list) g.dept = deptByRawId.get(g.rawId) ?? null
  }

  return NextResponse.json(list)
}
