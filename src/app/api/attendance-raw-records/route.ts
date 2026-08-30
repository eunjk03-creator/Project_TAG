/**
 * AttendanceSourceContext의 employees/rawRecords(가공 전 원본) 로드용. 세 가지 모드:
 *
 *  - 기본(파라미터 없음): 화면 초기 로딩용 경량 응답 — 직원 목록 + 원본 건수 + 날짜 범위만.
 *    caps_daily_logs 6만+ 행 전체를 매번 끌어올 필요가 없는 화면(그리드/업로드 배지 등)이 씀.
 *  - ?employeeId=E123: 그 직원 한 명분만 — EmployeeDrawer(직원 상세) 전용.
 *  - ?full=1: 예전처럼 전체 — admin/anomalies처럼 전 직원 원본이 실제로 필요한 화면 전용.
 *    남용하지 말 것(캡스 6만+행을 매번 파싱해서 느림).
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  buildEmployeesAndRawRecords, buildEmployeeRoster, countCapsDailyLogs, getWorkDateBounds,
} from '@/lib/recomputeFromNormalized'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const employeeId = searchParams.get('employeeId')
    const full       = searchParams.get('full')

    if (employeeId) {
      const { employees, rawRecords } = await buildEmployeesAndRawRecords([employeeId])
      return NextResponse.json({ employees, rawRecords, fetchedAt: new Date().toISOString() })
    }

    if (full) {
      const { employees, rawRecords } = await buildEmployeesAndRawRecords()
      return NextResponse.json({ employees, rawRecords, fetchedAt: new Date().toISOString() })
    }

    const [employees, rawRecordCount, dateBounds] = await Promise.all([
      buildEmployeeRoster(), countCapsDailyLogs(), getWorkDateBounds(),
    ])
    return NextResponse.json({ employees, rawRecordCount, dateBounds, fetchedAt: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
