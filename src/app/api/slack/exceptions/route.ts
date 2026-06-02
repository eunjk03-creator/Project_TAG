import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET — 저장된 Slack 예외 전체 로드
export async function GET() {
  const rows = await prisma.slackException.findMany({
    select: { empId: true, empName: true, date: true, type: true, note: true, rawText: true },
    orderBy: { syncedAt: 'desc' },
  })
  return NextResponse.json(rows)
}

// POST — 동기화 결과 저장 (기존 전체 교체)
export async function POST(req: NextRequest) {
  const exceptions = await req.json() as {
    empId: string; empName: string; date: string
    type: string; note: string; rawText: string
  }[]

  // 기존 데이터 전부 삭제 후 새로 저장
  await prisma.slackException.deleteMany({})
  if (exceptions.length > 0) {
    await prisma.slackException.createMany({ data: exceptions })
  }

  return NextResponse.json({ saved: exceptions.length })
}
