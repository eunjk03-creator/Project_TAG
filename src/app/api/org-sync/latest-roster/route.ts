import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 조직도 페이지용 — 가장 최근에 반영된 스냅샷의 전체 로스터(매칭 안 된 사람 포함)를 그대로 반환. */
export async function GET() {
  try {
    const snapshot = await prisma.orgChartSnapshot.findFirst({
      orderBy: { syncedAt: 'desc' },
      select: { tabName: true, syncedAt: true, sheetTotals: true, parsedRows: true },
    })
    if (!snapshot) return NextResponse.json({ tabName: null, syncedAt: null, sheetTotals: {}, rows: [] })
    return NextResponse.json({
      tabName: snapshot.tabName,
      syncedAt: snapshot.syncedAt,
      sheetTotals: snapshot.sheetTotals,
      rows: snapshot.parsedRows,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
