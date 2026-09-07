import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

type TableKey = 'caps' | 'erp' | 'daily' | 'export'

// 정렬 허용 필드 화이트리스트 — sortField는 클라이언트 입력이라 임의 컬럼 주입 방지용.
const FIELD_WHITELIST: Record<TableKey, string[]> = {
  caps: ['employeeId', 'name', 'workDate', 'clockIn', 'clockOut', 'rawDept', 'jobTitle', 'uploadedAt'],
  erp: [
    'employeeId', 'name', 'leaveType', 'approvalStatus', 'startDate', 'startTime',
    'endDate', 'endTime', 'submitDate', 'recognizedTime', 'leaveDays', 'category', 'syncedAt',
  ],
  daily: [
    'employeeId', 'workDate', 'dayType', 'clockIn', 'clockOut', 'effectiveClockIn',
    'regularHours', 'overtimeHours', 'nightHours', 'holidayHours', 'erpOtApplied',
    'leaveType', 'erpLeaveAmount', 'isUnpaidLeave', 'isLeader', 'finalStatus', 'flag', 'calculatedAt',
  ],
  export: ['reportType', 'format', 'dept', 'dateFrom', 'dateTo', 'createdAt'],
}
const DEFAULT_SORT: Record<TableKey, string> = {
  caps: 'uploadedAt', erp: 'syncedAt', daily: 'calculatedAt', export: 'createdAt',
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const table = searchParams.get('table') as TableKey

  if (!FIELD_WHITELIST[table]) {
    return NextResponse.json({ error: '알 수 없는 테이블입니다' }, { status: 400 })
  }

  const q          = (searchParams.get('q') ?? '').trim()
  const page       = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)
  const pageSize   = Math.min(200, Math.max(10, Number(searchParams.get('pageSize') ?? '50') || 50))
  const sortField  = searchParams.get('sortField')
  const sortDir    = searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc'
  const orderField = sortField && FIELD_WHITELIST[table].includes(sortField) ? sortField : DEFAULT_SORT[table]
  const orderBy    = { [orderField]: sortDir } as Record<string, 'asc' | 'desc'>
  const skip       = (page - 1) * pageSize

  let where: Record<string, unknown> = {}
  if (q) {
    if (table === 'caps' || table === 'erp') {
      where = { OR: [
        { employeeId: { contains: q, mode: 'insensitive' } },
        { name:       { contains: q, mode: 'insensitive' } },
      ] }
    } else if (table === 'daily') {
      where = { employeeId: { contains: q, mode: 'insensitive' } }
    } else {
      where = { OR: [
        { reportType: { contains: q, mode: 'insensitive' } },
        { dept:       { contains: q, mode: 'insensitive' } },
      ] }
    }
  }

  try {
    let rows: unknown[]
    let total: number
    if (table === 'caps') {
      ;[rows, total] = await Promise.all([
        prisma.capsDailyLog.findMany({ where, orderBy: orderBy as never, skip, take: pageSize }),
        prisma.capsDailyLog.count({ where }),
      ])
    } else if (table === 'erp') {
      ;[rows, total] = await Promise.all([
        prisma.erpApplication.findMany({ where, orderBy: orderBy as never, skip, take: pageSize }),
        prisma.erpApplication.count({ where }),
      ])
    } else if (table === 'daily') {
      ;[rows, total] = await Promise.all([
        prisma.dailyAttendance.findMany({ where, orderBy: orderBy as never, skip, take: pageSize }),
        prisma.dailyAttendance.count({ where }),
      ])
    } else {
      ;[rows, total] = await Promise.all([
        prisma.exportHistory.findMany({ where, orderBy: orderBy as never, skip, take: pageSize }),
        prisma.exportHistory.count({ where }),
      ])
    }

    return NextResponse.json({ rows, total, page, pageSize })
  } catch (err) {
    console.error('[raw-data]', err)
    return NextResponse.json({ error: '조회 실패' }, { status: 500 })
  }
}
