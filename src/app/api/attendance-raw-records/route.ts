/**
 * AttendanceSourceContext의 employees/rawRecords(가공 전 원본) 로드용.
 * caps_daily_logs/erp_applications(정규화 테이블) 전체를 parseAttendanceData()에 넘긴 결과를
 * 그대로 반환한다 — 예전에 shared_data_store의 attendance_data(JSON 스냅샷)를 읽던 자리.
 */
import { NextResponse } from 'next/server'
import { buildEmployeesAndRawRecords } from '@/lib/recomputeFromNormalized'

export const maxDuration = 60

export async function GET() {
  try {
    const { employees, rawRecords } = await buildEmployeesAndRawRecords()
    return NextResponse.json({ employees, rawRecords, fetchedAt: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
