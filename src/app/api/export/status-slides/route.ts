import { NextRequest, NextResponse } from 'next/server'
import { buildStatusSlidePptxBuffer } from '@/utils/statusSlidePptx'
import { getProcessedRecords }        from '@/lib/getProcessedRecords'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { dept, from, to } = body as { dept?: string; from?: string; to?: string }

    // 원본 청크에서 직접 처리 — processed_data 캐시 무관, 달 경계 누락 없음
    const { employees, records: allRecords } = await getProcessedRecords({ from, to })

    if (allRecords.length === 0) {
      return NextResponse.json({ error: '해당 조건의 데이터가 없습니다' }, { status: 404 })
    }

    // 부문 필터
    const deptEmpIds = dept
      ? new Set(employees.filter(e => e.division === dept).map(e => e.id))
      : null
    const filteredRecords   = deptEmpIds ? allRecords.filter(r => deptEmpIds.has(r.employeeId)) : allRecords
    const usedEmpIds        = new Set(filteredRecords.map(r => r.employeeId))
    const filteredEmployees = employees.filter(e => usedEmpIds.has(e.id))

    if (filteredRecords.length === 0) {
      return NextResponse.json({ error: '해당 조건의 데이터가 없습니다' }, { status: 404 })
    }

    // 날짜 범위 확정
    const sorted   = filteredRecords.map(r => r.date).sort()
    const dateFrom = from ?? sorted[0]         ?? ''
    const dateTo   = to   ?? sorted.at(-1) ?? ''

    // PPTX 생성
    const buffer = await buildStatusSlidePptxBuffer(filteredRecords, filteredEmployees, dateFrom, dateTo, dept)

    // 파일명
    const deptLabel = dept ?? '전체'
    const fromLabel = dateFrom.replace(/-/g, '').slice(2)
    const toLabel   = dateTo.replace(/-/g, '').slice(2)
    const filename  = encodeURIComponent(`${deptLabel} 근태현황_${fromLabel}-${toLabel}.pptx`)

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      },
    })
  } catch (err) {
    console.error('[status-slides]', err)
    return NextResponse.json({ error: '슬라이드 생성 실패' }, { status: 500 })
  }
}
