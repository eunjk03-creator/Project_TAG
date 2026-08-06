import { NextRequest, NextResponse } from 'next/server'
import type { OrgChartTab } from '@/lib/orgSheet/readOrgChartExcel'
import { syncOrgChart } from '@/lib/orgSheet/syncOrgChart'

/** body: { tabName, values } — /api/org-sync/preview와 동일하게 클라이언트가 미리 파싱한 grid. */
export async function POST(req: NextRequest) {
  try {
    const tab = await req.json() as OrgChartTab
    const result = await syncOrgChart(tab)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
