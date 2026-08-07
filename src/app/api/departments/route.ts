import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const rows = await prisma.department.findMany({
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      select: { id: true, name: true, level: true, parentId: true, order: true },
    })
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
