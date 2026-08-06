import { NextRequest, NextResponse } from 'next/server'
import { syncOrgChart } from '@/lib/orgSheet/syncOrgChart'

/** Vercel Cron 전용. Vercel이 호출 시 Authorization: Bearer $CRON_SECRET 헤더를 자동으로 붙인다. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  try {
    const result = await syncOrgChart({ trigger: 'cron' })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/org-sync] 동기화 실패:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
