import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recomputeEmployeeAttendance } from '@/lib/recomputeEmployee'

export async function GET() {
  try {
    const rows = await prisma.exceptionRule.findMany({
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const row = await prisma.exceptionRule.create({
      data: {
        employeeId:     body.employeeId,
        employeeName:   body.employeeName,
        jobTitle:       body.jobTitle       ?? '',
        division:       body.division       ?? '',
        team:           body.team           ?? '',
        ruleType:       body.ruleType,
        excludeFromOt:  body.excludeFromOt  ?? false,
        shortenedHours: body.shortenedHours ?? 0,
        validFrom:      body.validFrom      ?? '',
        validTo:        body.validTo        ?? '',
      },
    })

    // 증분 재계산 — 새 규칙이 적용된 직원 1명분만 다시 처리(best-effort). 실패해도 규칙
    // 저장 자체는 이미 끝났으니 응답은 그대로 내려준다.
    try {
      await recomputeEmployeeAttendance(row.employeeId)
    } catch (err) {
      console.error('[exception-rules] 증분 재계산 실패:', err)
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Bulk delete: DELETE /api/exception-rules  body: { ids: string[] } */
export async function DELETE(req: NextRequest) {
  try {
    const { ids } = await req.json() as { ids: string[] }
    if (!ids?.length) return NextResponse.json({ deleted: 0 })

    // 삭제 전에 영향받는 직원 목록을 먼저 확보 — 삭제 후엔 어느 직원 규칙이었는지 알 수 없다.
    const rules = await prisma.exceptionRule.findMany({ where: { id: { in: ids } }, select: { employeeId: true } })
    const affectedEmployeeIds = [...new Set(rules.map(r => r.employeeId))]

    const result = await prisma.exceptionRule.deleteMany({
      where: { id: { in: ids } },
    })

    for (const employeeId of affectedEmployeeIds) {
      try {
        await recomputeEmployeeAttendance(employeeId)
      } catch (err) {
        console.error('[exception-rules] 증분 재계산 실패:', err)
      }
    }

    return NextResponse.json({ deleted: result.count })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
