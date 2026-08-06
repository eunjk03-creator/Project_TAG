import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchLatestOrgChartTab } from '@/lib/orgSheet/googleSheetsClient'
import { parseOrgChartSheet } from '@/lib/orgSheet/parseOrgChartSheet'
import { matchEmployees, findPossiblyResigned, type CapsEmployeeLite } from '@/lib/orgSheet/matchEmployees'

/**
 * DB에 아무것도 쓰지 않는 미리보기 엔드포인트 — 관리자가 커밋 전에 sanity check/동명이인
 * 큐/신규입사자/퇴사후보를 먼저 확인할 수 있게 한다. 실제 반영은 POST /api/org-sync/commit.
 */
export async function POST() {
  try {
    const tab = await fetchLatestOrgChartTab()
    const parsed = parseOrgChartSheet(tab.values, tab.tabName)

    const attendanceData = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
    const capsEmployees = ((attendanceData?.data as { employees?: CapsEmployeeLite[] } | null)?.employees) ?? []

    const resolutions = await prisma.sheetNameResolution.findMany()
    const result = matchEmployees(
      parsed.rows,
      capsEmployees,
      resolutions.map(r => ({ matchKey: r.matchKey, resolvedRawId: r.resolvedRawId })),
    )

    const activeMaster = await prisma.employeeMaster.findMany({
      where: { status: 'ACTIVE' },
      select: { rawId: true, name: true, lastSeenSheetAt: true },
    })
    const possiblyResigned = findPossiblyResigned(activeMaster, result.matched)

    return NextResponse.json({
      tabName: tab.tabName,
      sheetTotals: parsed.sheetTotals,
      declaredCounts: parsed.declaredCounts,
      parsedRowCount: parsed.rows.length,
      warnings: parsed.warnings,
      matchedCount: result.matched.length,
      ambiguous: result.ambiguous,
      newHires: result.newHires,
      possiblyResigned,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
