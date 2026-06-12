import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildDeptReportBuffer } from '@/utils/deptReportExcel'
import type { ProcessedRecord, Employee } from '@/types/tag'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { dept, from, to } = body as { dept?: string; from?: string; to?: string }

    // ── 직원 목록 + 청크 수 읽기
    const metaRow = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
    if (!metaRow?.data) return NextResponse.json({ error: '업로드된 데이터가 없습니다' }, { status: 404 })

    const { employees, chunkCount } = metaRow.data as unknown as { employees: Employee[]; chunkCount: number }

    // ── 원본 레코드 청크 전체 읽기
    const rawRecords: ProcessedRecord[] = []
    for (let i = 0; i < chunkCount; i++) {
      const chunk = await prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
      if (chunk?.data) {
        const { records } = chunk.data as unknown as { records: ProcessedRecord[] }
        rawRecords.push(...records)
      }
    }

    // ── 처리 결과 읽기 (processed_data 우선, 없으면 rawRecords 사용)
    const processedRow = await prisma.sharedDataStore.findUnique({ where: { key: 'processed_data' } })
    let records: ProcessedRecord[] = rawRecords

    if (processedRow?.data) {
      const { processed } = processedRow.data as unknown as { processed: ProcessedRecord[] }
      if (processed?.length > 0) records = processed
    }

    // ── 부문 필터
    const empMap = new Map(employees.map(e => [e.id, e]))
    const deptEmpIds = dept
      ? new Set(employees.filter(e => e.division === dept).map(e => e.id))
      : null

    let filteredRecords = deptEmpIds
      ? records.filter(r => deptEmpIds.has(r.employeeId))
      : records

    // ── 날짜 필터
    if (from) filteredRecords = filteredRecords.filter(r => r.date >= from)
    if (to)   filteredRecords = filteredRecords.filter(r => r.date <= to)

    if (filteredRecords.length === 0) {
      return NextResponse.json({ error: '해당 조건의 데이터가 없습니다' }, { status: 404 })
    }

    // ── 해당 직원만 추출
    const usedEmpIds = new Set(filteredRecords.map(r => r.employeeId))
    const filteredEmployees = employees.filter(e => usedEmpIds.has(e.id))

    // ── Excel 생성
    const buffer = buildDeptReportBuffer(filteredRecords, filteredEmployees)

    // ── 파일명
    const deptLabel = dept ?? '전체'
    const fromLabel = (from ?? filteredRecords.map(r => r.date).sort()[0] ?? '').replace(/-/g, '').slice(2)
    const toLabel   = (to   ?? [...filteredRecords.map(r => r.date)].sort().at(-1) ?? '').replace(/-/g, '').slice(2)
    const filename  = encodeURIComponent(`${deptLabel} 근태결과_${fromLabel}-${toLabel}.xlsx`)

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      },
    })
  } catch (err) {
    console.error('[dept-report]', err)
    return NextResponse.json({ error: '보고서 생성 실패' }, { status: 500 })
  }
}
