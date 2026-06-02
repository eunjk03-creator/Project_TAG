import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/attendance-notes → 전체 목록 (헤더 길이 제한 회피)
export async function GET() {
  const notes = await prisma.attendanceNote.findMany({
    select: { employeeId: true, workDate: true, note: true },
  })
  return NextResponse.json(notes)
}

// PUT /api/attendance-notes  { employeeId, workDate, note }
export async function PUT(req: NextRequest) {
  const body = await req.json()
  const { employeeId, workDate, note } = body as {
    employeeId: string
    workDate:   string
    note:       string
  }

  if (!employeeId || !workDate) {
    return NextResponse.json({ error: 'employeeId and workDate required' }, { status: 400 })
  }

  const result = await prisma.attendanceNote.upsert({
    where:  { employeeId_workDate: { employeeId, workDate } },
    update: { note },
    create: { employeeId, workDate, note },
    select: { employeeId: true, workDate: true, note: true },
  })

  return NextResponse.json(result)
}
