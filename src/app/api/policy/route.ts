import { NextRequest, NextResponse } from 'next/server'
import { getPolicyFromDB, savePolicyToDB } from '@/lib/policyStore'
import type { PolicySettings } from '@/types/tag'

export async function GET() {
  try {
    const policy = await getPolicyFromDB()
    return NextResponse.json({ policy })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { policy } = await req.json() as { policy?: PolicySettings }
    if (!policy) {
      return NextResponse.json({ error: 'policy가 필요합니다.' }, { status: 400 })
    }
    await savePolicyToDB(policy)
    const saved = await getPolicyFromDB()
    return NextResponse.json({ policy: saved })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
