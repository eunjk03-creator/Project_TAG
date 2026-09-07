import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.exportHistory.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[export-history]', err)
    return NextResponse.json({ error: '내보내기 이력 조회 실패' }, { status: 500 })
  }
}
