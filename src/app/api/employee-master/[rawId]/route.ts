import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 인사카드(직원 인사정보) 화면용 단건 조회 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ rawId: string }> }) {
  try {
    const { rawId } = await params
    const row = await prisma.employeeMaster.findUnique({
      where: { rawId },
      include: { department: true },
    })
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** 퇴사 승인 등 — body: { status?, resignedDate?, contractType?, hireDate? } */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ rawId: string }> }) {
  try {
    const { rawId } = await params
    const body = await req.json()
    const row = await prisma.employeeMaster.update({
      where: { rawId },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.resignedDate !== undefined ? { resignedDate: body.resignedDate } : {}),
        ...(body.contractType !== undefined ? { contractType: body.contractType } : {}),
        ...(body.hireDate !== undefined ? { hireDate: body.hireDate } : {}),
      },
    })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
