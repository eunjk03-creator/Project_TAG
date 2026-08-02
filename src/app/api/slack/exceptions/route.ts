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

const CREATE_BATCH_SIZE = 1000

// POST — 동기화 결과 저장 (기존 전체 교체)
export async function POST(req: NextRequest) {
  const exceptions = await req.json() as {
    empId: string; empName: string; date: string
    type: string; note: string; rawText: string
  }[]

  // 삭제 + 재삽입을 하나의 트랜잭션으로 묶음 — 예전엔 delete만 성공하고 createMany가
  // 실패(대용량 단일 쿼리 타임아웃 등)하면 테이블이 통째로 빈 채 남는 사고가 있었음
  // (2026-08-03, 외근 Slack 보정이 서버 재계산에서 전부 무시되는 문제로 발견됨).
  // createMany도 한 번에 수천 건을 넣으면 파라미터 한도/타임아웃 위험이 있어 배치로 나눔.
  try {
    const chunks: (typeof exceptions)[] = []
    for (let i = 0; i < exceptions.length; i += CREATE_BATCH_SIZE) {
      chunks.push(exceptions.slice(i, i + CREATE_BATCH_SIZE))
    }
    await prisma.$transaction(async (tx) => {
      await tx.slackException.deleteMany({})
      for (const chunk of chunks) {
        await tx.slackException.createMany({ data: chunk })
      }
    }, { timeout: 30_000 })
  } catch (e) {
    console.error('[TAG] /api/slack/exceptions POST 실패 — DB 그대로 유지됨:', e)
    return NextResponse.json(
      { error: 'DB 저장 실패', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  return NextResponse.json({ saved: exceptions.length })
}
