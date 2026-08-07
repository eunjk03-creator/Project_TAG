import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 퇴사 승인 등 — body: { status?, resignedDate?, contractType? } */
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
      },
    })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
