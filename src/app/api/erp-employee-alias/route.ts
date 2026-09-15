import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recomputeEmployeesFromNormalizedTables } from '@/lib/recomputeFromNormalized'

// POST /api/erp-employee-alias
// "매칭 후보 모호"(reason: ambiguous, rawId 하나에 CAPS 직원이 2명 이상) 케이스를 관리자가
// 직접 확정 — 이후 파싱 때마다 dataParser.ts의 rawId 자동 폴백보다 먼저 이 별칭을 확인한다.
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { rawId, erpName, targetEmployeeId } = body as { rawId?: string; erpName?: string; targetEmployeeId?: string }

  if (!rawId || !erpName || !targetEmployeeId) {
    return NextResponse.json({ error: 'rawId, erpName, targetEmployeeId 필요' }, { status: 400 })
  }

  await prisma.erpEmployeeAlias.upsert({
    where:  { rawId_erpName: { rawId, erpName } },
    update: { targetEmployeeId },
    create: { rawId, erpName, targetEmployeeId },
  })

  const targetRawId = targetEmployeeId.split('_')[0]
  await recomputeEmployeesFromNormalizedTables([...new Set([rawId, targetRawId])])

  return NextResponse.json({ ok: true })
}
