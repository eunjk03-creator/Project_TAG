import { NextRequest, NextResponse } from 'next/server'
import { buildMonthlyReviewBuffer } from '@/utils/monthlyReviewExcel'
import { buildMonthlyAnomalyBreakdown, buildMonthWeeks, buildWeeklyCapRows } from '@/utils/overviewAggregations'
import { getProcessedRecords } from '@/lib/getProcessedRecords'
import { prisma } from '@/lib/prisma'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 경영진 현황(Overview) 월 탭 다이제스트의 "다운로드" 버튼 전용 — 선택된 부서와 무관하게
 *  항상 그 달 전체 부서 기준으로 만든다(부서 필터는 받는 쪽이 Excel에서 직접 건다). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { from, to } = body as { from?: string; to?: string }
    if (!from || !to) {
      return NextResponse.json({ error: 'from/to가 필요합니다' }, { status: 400 })
    }

    const today = todayStr()
    const asOf  = to < today ? to : today
    const monthWeeks = buildMonthWeeks(from, to, asOf)

    // 마지막 주가 다음 달로 걸치면(예: 8월 5주차 8/30~9/5) 그 며칠 분도 52시간 계산에
    // 필요하다 — daily_attendance는 SQL 범위 조회라 월 경계를 넘겨도 그대로 가져온다.
    const lastWeekEnd = monthWeeks.length > 0 ? monthWeeks[monthWeeks.length - 1].to : to
    const fetchTo = lastWeekEnd < today ? lastWeekEnd : today
    const rangeTo = fetchTo > to ? fetchTo : to

    const { employees, records, finalAttrMap } = await getProcessedRecords({ from, to: rangeTo })
    if (records.length === 0) {
      return NextResponse.json({ error: '해당 기간 데이터가 없습니다' }, { status: 404 })
    }
    const empMap = new Map(employees.map(e => [e.id, e]))

    // 이상치 집계는 그 달 안의 날짜만(다음 달로 걸친 여분은 52시간 계산에만 쓴다)
    const monthRecords = records.filter(r => r.date >= from && r.date <= to)
    const anomalyRows  = buildMonthlyAnomalyBreakdown(monthRecords, empMap)

    const weeklyCap = buildWeeklyCapRows(records, employees, finalAttrMap, monthWeeks)
    // 엑셀 "52시간초과" 시트는 1회성 초과는 빼고 2회 이상만 — 다이제스트의 "초과자(횟수)"
    // 목록(고립된 1회도 포함)과는 별개 기준이다(2026-09-30 사용자 요청).
    const weeklyCapRowsForExcel = weeklyCap.anyOverRows.filter(r => r.overCount >= 2)

    const buffer = buildMonthlyReviewBuffer(anomalyRows, weeklyCapRowsForExcel, monthWeeks)

    const fromLabel = from.replace(/-/g, '').slice(2)
    const toLabel   = to.replace(/-/g, '').slice(2)
    const filename  = encodeURIComponent(`근태상세_이상치검토_${fromLabel}-${toLabel}.xlsx`)

    prisma.exportHistory.create({
      data: { reportType: 'monthly-review', format: 'xlsx', dept: null, dateFrom: from, dateTo: to },
    }).catch(err => console.error('[monthly-review] export history 기록 실패', err))

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      },
    })
  } catch (err) {
    console.error('[monthly-review]', err)
    return NextResponse.json({ error: '보고서 생성 실패' }, { status: 500 })
  }
}
