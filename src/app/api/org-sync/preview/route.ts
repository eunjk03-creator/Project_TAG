import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildEmployeesAndRawRecords } from '@/lib/recomputeFromNormalized'
import type { OrgChartTab } from '@/lib/orgSheet/readOrgChartExcel'
import { parseOrgChartSheet } from '@/lib/orgSheet/parseOrgChartSheet'
import { matchEmployees, findPossiblyResigned } from '@/lib/orgSheet/matchEmployees'

/**
 * DB에 아무것도 쓰지 않는 미리보기 엔드포인트 — 관리자가 커밋 전에 sanity check/동명이인
 * 큐/신규입사자/퇴사후보를 먼저 확인할 수 있게 한다. 실제 반영은 POST /api/org-sync/commit.
 *
 * body: { tabName, values } — 엑셀 파일은 브라우저에서 클라이언트 사이드로 미리 파싱해서
 * grid만 넘긴다(CAPS/ERP 업로드와 동일 컨벤션, CsvUploader.tsx 참고) — 서버에 원본 파일을
 * 보내지 않는다.
 */
export async function POST(req: NextRequest) {
  try {
    const tab = await req.json() as OrgChartTab
    const parsed = parseOrgChartSheet(tab.values, tab.tabName)

    const { employees } = await buildEmployeesAndRawRecords()
    const capsEmployees = employees.map(e => ({
      rawId: e.rawId ?? e.id.split('_')[0], name: e.name, rawDept: e.rawDept, division: e.division, team: e.team,
    }))

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
