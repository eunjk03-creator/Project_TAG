import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const ALLOWED_KEYS = ['caps_data', 'erp_data'] as const

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  if (!ALLOWED_KEYS.includes(key as typeof ALLOWED_KEYS[number])) {
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
  if (!ALLOWED_KEYS.includes(key as typeof ALLOWED_KEYS[number])) {
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
