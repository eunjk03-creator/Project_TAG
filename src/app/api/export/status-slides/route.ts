import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildStatusSlidePptxBuffer } from '@/utils/statusSlidePptx'
import type { ProcessedRecord, Employee } from '@/types/tag'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { dept, from, to } = body as { dept?: string; from?: string; to?: string }

    // ── 직원 목록 + 청크 수 읽기
    const metaRow = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
    if (!metaRow?.data) return NextResponse.json({ error: '업로드된 데이터가 없습니다' }, { status: 404 })

    const { employees, chunkCount } = metaRow.data as unknown as { employees: Employee[]; chunkCount: number }

    // ── 처리 결과 읽기
    const processedRow = await prisma.sharedDataStore.findUnique({ where: { key: 'processed_data' } })
    let records: ProcessedRecord[] = []

    if (processedRow?.data) {
      const { processed } = processedRow.data as unknown as { processed: ProcessedRecord[] }
      if (processed?.length > 0) records = processed
    }

    // processed_data 없으면 원본 청크에서 읽기
    if (records.length === 0) {
      for (let i = 0; i < chunkCount; i++) {
        const chunk = await prisma.sharedDataStore.findUnique({ where: { key: `attendance_records_${i}` } })
        if (chunk?.data) {
          const { records: recs } = chunk.data as unknown as { records: ProcessedRecord[] }
          records.push(...recs)
        }
      }
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
    const usedEmpIds        = new Set(filteredRecords.map(r => r.employeeId))
    const filteredEmployees = employees.filter(e => usedEmpIds.has(e.id))

    // ── 날짜 범위 확정
    const sorted  = filteredRecords.map(r => r.date).sort()
    const dateFrom = from ?? sorted[0] ?? ''
    const dateTo   = to   ?? sorted.at(-1) ?? ''

    // ── PPTX 생성
    const buffer = await buildStatusSlidePptxBuffer(filteredRecords, filteredEmployees, dateFrom, dateTo, dept)

    // ── 파일명
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
