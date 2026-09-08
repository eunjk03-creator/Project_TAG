/**
 * 대시보드 그리드/탭용 읽기 API — daily_attendance를 직접 SQL로 조회한다
 * (getProcessedRecords.ts, export 라우트가 이미 쓰던 것과 동일 패턴).
 * shared_data_store의 processed_data(JSON 캐시) 대신 이걸 소스로 쓰면
 * CAPS/ERP 업로드가 daily_attendance만 갱신해도 화면에 바로 반영된다.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getProcessedRecords } from '@/lib/getProcessedRecords'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const from = searchParams.get('from') ?? undefined
    const to   = searchParams.get('to')   ?? undefined

    // 이 라우트의 유일한 호출부(useScopedProcessedRecordsWithStatus)는 records만 쓰고
    // employees/finalAttrMap은 안 쓴다(AttendanceSourceContext가 이미 employees를 들고 있음).
    // recordsOnly로 employees/exceptionRule 조회 자체를 건너뛴다 — buildEmployeeRoster()
    // (caps_daily_logs distinct, 67k+행 스캔)만 요청마다 1~1.6초였다(2026-09-08 실측,
    // 화면 이동 로딩 체감의 실제 최대 원인).
    const { records } = await getProcessedRecords({ from, to, recordsOnly: true })
    return NextResponse.json({ records, fetchedAt: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
