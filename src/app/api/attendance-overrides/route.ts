import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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

  return NextResponse.json(result)
}
