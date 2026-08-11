import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 퇴사 승인/재직 등록/조직정보 수정 등 — body: { name?, status?, resignedDate?, contractType?,
 *  departmentId?, jobTitle?, hireDate? }.
 *  upsert인 이유: 조직도 마스터에 행 자체가 없는 사람(과거 퇴사자로 추정되는, 마스터에도
 *  CAPS 최근 활동에도 없는 인원)을 이 엔드포인트로 "퇴사 확정"할 때 새로 생성해야 함 —
 *  기존 유일 호출부(OrgSyncTab.approveResignation)는 이미 있는 행만 다루므로 update와
 *  동일하게 동작해 하위호환 문제 없음. name은 생성 분기에서만 쓰임(기존 행엔 영향 없음). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ rawId: string }> }) {
  try {
    const { rawId } = await params
    const body = await req.json()
    const data = {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.resignedDate !== undefined ? { resignedDate: body.resignedDate } : {}),
      ...(body.contractType !== undefined ? { contractType: body.contractType } : {}),
      ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
      ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle } : {}),
      ...(body.hireDate !== undefined ? { hireDate: body.hireDate } : {}),
    }
    const row = await prisma.employeeMaster.upsert({
      where:  { rawId },
      update: data,
      create: { rawId, name: body.name ?? rawId, source: 'manual', ...data },
    })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
