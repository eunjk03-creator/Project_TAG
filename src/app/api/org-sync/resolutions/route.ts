import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * 시트 이름/부서 ↔ CAPS rawId 수동 확정. SlackNameResolution upsert 패턴과 동일하게
 * matchKey unique로 upsert — 다음 동기화부터 이 확정이 최우선 적용된다.
 * body: { matchKey, sheetName, sheetDept, resolvedRawId }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const row = await prisma.sheetNameResolution.upsert({
      where: { matchKey: body.matchKey },
      create: {
        matchKey: body.matchKey,
        sheetName: body.sheetName,
        sheetDept: body.sheetDept,
        resolvedRawId: body.resolvedRawId,
      },
      update: {
        resolvedRawId: body.resolvedRawId,
      },
    })
    return NextResponse.json(row)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET() {
  try {
    const rows = await prisma.sheetNameResolution.findMany({ orderBy: { resolvedAt: 'desc' } })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
