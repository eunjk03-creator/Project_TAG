import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/** 경영진 현황 부서 카드 인사이트 메모 — division+granularity+기간 단위로 저장/조회.
 *  GET은 그 기간에 저장된 전체 부서 메모를 한 번에 반환(카드 10장 분량). */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const granularity = searchParams.get('granularity')
  const from = searchParams.get('from')
  const to   = searchParams.get('to')
  if (!granularity || !from || !to) {
    return NextResponse.json({ error: 'granularity, from, to가 필요합니다' }, { status: 400 })
  }
  try {
    const notes = await prisma.overviewNote.findMany({
      where: { granularity, periodFrom: from, periodTo: to },
    })
    return NextResponse.json({ notes })
  } catch (err) {
    console.error('[overview-notes GET]', err)
    return NextResponse.json({ error: '조회 실패' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json() as {
      division?: string; granularity?: string; periodFrom?: string; periodTo?: string; note?: string
    }
    const { division, granularity, periodFrom, periodTo, note } = body
    if (!division || !granularity || !periodFrom || !periodTo || note === undefined) {
      return NextResponse.json({ error: 'division, granularity, periodFrom, periodTo, note가 필요합니다' }, { status: 400 })
    }
    const saved = await prisma.overviewNote.upsert({
      where: { division_granularity_periodFrom_periodTo: { division, granularity, periodFrom, periodTo } },
      update: { note },
      create: { division, granularity, periodFrom, periodTo, note },
    })
    return NextResponse.json({ note: saved })
  } catch (err) {
    console.error('[overview-notes PUT]', err)
    return NextResponse.json({ error: '저장 실패' }, { status: 500 })
  }
}
