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

    // getProcessedRecords()가 돌려주는 employees는 export 라우트들(직원 이름/부서 표기용)을
    // 위한 것 — 이 화면용 훅(useScopedProcessedRecordsWithStatus)은 records만 쓰고 employees는
    // 버린다(AttendanceSourceContext가 이미 들고 있음). 그런데도 매 호출마다 400명+ 전체를
    // JSON에 실어 보내던 게 순수 낭비였다(2026-09-08, 화면 이동 로딩 체감 원인 중 하나로 발견 —
    // Overview 페이지는 이 요청을 4번 동시에 보내므로 4배로 낭비됨). 여기선 빼고 응답한다.
    const { records } = await getProcessedRecords({ from, to })
    return NextResponse.json({ records, fetchedAt: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
