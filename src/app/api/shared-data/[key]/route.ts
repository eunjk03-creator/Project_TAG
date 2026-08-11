import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const STATIC_KEYS = new Set(['caps_data', 'erp_data', 'attendance_data', 'processed_data'])

function isAllowedKey(key: string): boolean {
  return STATIC_KEYS.has(key)
    || /^attendance_records_\d+$/.test(key)
    || /^processed_records_\d+$/.test(key)
    // 원본(파싱 전) CAPS/ERP 로우 청크 — CAPS/ERP 중 하나만 재업로드해도 나머지를 여기서
    // 불러와 병합할 수 있게 함 (CsvUploader.tsx의 "한쪽만 업로드" 지원용).
    || /^caps_records_\d+$/.test(key)
    || /^erp_records_\d+$/.test(key)
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  if (!isAllowedKey(key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  const row = await prisma.sharedDataStore.findUnique({ where: { key } })
  if (!row) return NextResponse.json({ data: null, updatedAt: null })

  return NextResponse.json({ data: row.data, updatedAt: row.updatedAt })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  if (!isAllowedKey(key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
  }

  const body = await req.json()
  const { data, updatedBy } = body as { data: unknown; updatedBy?: string }

  const row = await prisma.sharedDataStore.upsert({
    where:  { key },
    create: { key, data: data as object, updatedBy: updatedBy ?? null },
    update: { data: data as object, updatedBy: updatedBy ?? null },
  })

  return NextResponse.json({ ok: true, updatedAt: row.updatedAt })
}
