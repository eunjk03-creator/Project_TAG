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

    const { employees, records } = await getProcessedRecords({ from, to })
    return NextResponse.json({ employees, records, fetchedAt: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
