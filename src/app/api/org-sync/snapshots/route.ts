import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.orgChartSnapshot.findMany({
      orderBy: { syncedAt: 'desc' },
      take: 5,
      select: { id: true, tabName: true, syncedAt: true, syncTrigger: true, sanityPassed: true, sheetTotals: true, parsedTotals: true },
    })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
