import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recomputeEmployeeAttendance } from '@/lib/recomputeEmployee'

// GET /api/attendance-overrides  → 전체 목록 (관리자 수정 이력 복원용)
export async function GET() {
  const rows = await prisma.attendanceOverride.findMany({
    select: {
      employeeId:  true,
      workDate:    true,
      reasonLabel: true,
      memo:        true,
      clockIn:     true,
      clockOut:    true,
      erpOtApplied: true,
      erpLeaveType: true,
      editHistory:  true,
    },
  })
  return NextResponse.json(rows)
}

// PUT /api/attendance-overrides  → upsert 1건
export async function PUT(req: NextRequest) {
  const body = await req.json()
  const { employeeId, workDate, reasonLabel, memo, clockIn, clockOut, erpOtApplied, erpLeaveType, editHistory } = body

  if (!employeeId || !workDate) {
    return NextResponse.json({ error: 'employeeId and workDate required' }, { status: 400 })
  }

  const result = await prisma.attendanceOverride.upsert({
    where:  { employeeId_workDate: { employeeId, workDate } },
    update: { reasonLabel, memo, clockIn, clockOut, erpOtApplied, erpLeaveType, editHistory },
    create: { employeeId, workDate, reasonLabel, memo, clockIn, clockOut, erpOtApplied, erpLeaveType, editHistory: editHistory ?? [] },
    select: { employeeId: true, workDate: true },
  })

  // 증분 재계산 — 이 직원 1명분만 다시 처리해서 DailyAttendance에 반영(best-effort).
  // await 없이 던져두면 Vercel 서버리스 함수가 응답 직후 바로 정리돼서 완료 전에 죽을 수
  // 있어 반드시 await한다. 실패해도 override 저장 자체는 이미 끝났으니 응답은 그대로
  // 내려준다 — 다음 전체 재계산 때 어차피 다시 맞춰진다.
  try {
    await recomputeEmployeeAttendance(employeeId)
  } catch (err) {
    console.error('[attendance-overrides] 증분 재계산 실패:', err)
  }

  return NextResponse.json(result)
}
