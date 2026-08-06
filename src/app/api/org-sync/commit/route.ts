import { NextResponse } from 'next/server'
import { syncOrgChart } from '@/lib/orgSheet/syncOrgChart'

/** 관리자 수동 실행. Cron(/api/cron/org-sync)과 동일한 syncOrgChart()를 공유한다 — trigger만 다르다. */
export async function POST() {
  try {
    const result = await syncOrgChart({ trigger: 'manual' })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
