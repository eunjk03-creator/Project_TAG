import { NextRequest, NextResponse } from 'next/server'
import { buildProductivityReportBuffer } from '@/utils/productivityReportExcel'
import { getProcessedRecords }           from '@/lib/getProcessedRecords'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { dept, from, to } = body as { dept?: string; from?: string; to?: string }

    // 원본 청크에서 직접 처리 — processed_data 캐시 무관, 달 경계 누락 없음
    const { employees, records: allRecords, finalAttrMap } = await getProcessedRecords({ from, to })

    if (allRecords.length === 0) {
      return NextResponse.json({ error: '해당 조건의 데이터가 없습니다' }, { status: 404 })
    }

    // 부문 필터
    const deptEmpIds = dept
      ? new Set(employees.filter(e => e.division === dept).map(e => e.id))
      : null
    const filteredRecords   = deptEmpIds ? allRecords.filter(r => deptEmpIds.has(r.employeeId)) : allRecords
    const usedEmpIds         = new Set(filteredRecords.map(r => r.employeeId))
    const filteredEmployees = employees.filter(e => usedEmpIds.has(e.id))

    if (filteredRecords.length === 0) {
      return NextResponse.json({ error: '해당 조건의 데이터가 없습니다' }, { status: 404 })
    }

    // Excel 생성
    const buffer = buildProductivityReportBuffer(filteredRecords, filteredEmployees, finalAttrMap)

    // 파일명
    const deptLabel = dept ?? '전체'
    const fromLabel = (from ?? filteredRecords.map(r => r.date).sort()[0]         ?? '').replace(/-/g, '').slice(2)
    const toLabel   = (to   ?? [...filteredRecords.map(r => r.date)].sort().at(-1) ?? '').replace(/-/g, '').slice(2)
    const filename  = encodeURIComponent(`${deptLabel} 근로시간활용현황_${fromLabel}-${toLabel}.xlsx`)

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      },
    })
  } catch (err) {
    console.error('[productivity-report]', err)
    return NextResponse.json({ error: '보고서 생성 실패' }, { status: 500 })
  }
}
