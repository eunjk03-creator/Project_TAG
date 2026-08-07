import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { OrgChartTab } from './readOrgChartExcel'
import { parseOrgChartSheet, type SheetPersonRow } from './parseOrgChartSheet'
import { matchEmployees, findPossiblyResigned, type CapsEmployeeLite, type MatchedRow } from './matchEmployees'

export interface SyncResult {
  snapshotId: string
  tabName: string
  sanityPassed: boolean
  matchedCount: number
  ambiguousCount: number
  newHireCount: number
  possiblyResignedCount: number
}

/** 시트에 나온 사람 그대로 + 매칭된 CAPS 사원번호(없으면 null) — 조직도 페이지가 이걸로
 *  "시트엔 있지만 아직 CAPS/마스터에 없는 사람"까지 전부 보여주고, 미매칭자만 흐리게 구분한다. */
export type EnrichedSheetPersonRow = SheetPersonRow & { rawId: string | null }

const deptCache = new Map<string, string>() // `${parentId ?? 'root'}::${name}` → Department.id

async function upsertDepartment(name: string, parentId: string | null, level: number, order: number): Promise<string> {
  const cacheKey = `${parentId ?? 'root'}::${name}`
  const cached = deptCache.get(cacheKey)
  if (cached) return cached

  const existing = await prisma.department.findFirst({ where: { name, parentId } })
  const dept = existing ?? await prisma.department.create({ data: { name, parentId, level, order } })
  deptCache.set(cacheKey, dept.id)
  return dept.id
}

/** division/team 구조를 Department 트리로 반영하고, team → departmentId 맵을 반환한다. */
async function syncDepartments(rows: SheetPersonRow[]): Promise<Map<string, string>> {
  deptCache.clear()
  const teamDeptId = new Map<string, string>() // `${division}::${team}` → departmentId

  const divisions = [...new Set(rows.map(r => r.division))]
  for (let i = 0; i < divisions.length; i++) {
    const division = divisions[i]
    const divisionDeptId = await upsertDepartment(division, null, 0, i)

    const teams = [...new Set(rows.filter(r => r.division === division).map(r => r.team))]
    for (let j = 0; j < teams.length; j++) {
      const team = teams[j]
      const deptId = team === division
        ? divisionDeptId
        : await upsertDepartment(team, divisionDeptId, 1, j)
      teamDeptId.set(`${division}::${team}`, deptId)
    }
  }
  return teamDeptId
}

/**
 * 겸임(*)으로 같은 사람이 여러 행에 등장하면 department가 마지막 처리분으로 덮어써진다 —
 * v1에서는 EmployeeMaster가 사람당 department 1개만 가지므로 의도된 단순화다. 우선순위:
 * 겸임이 아닌 행(본직)을 겸임 행보다 나중에 처리해서 본직 소속이 최종적으로 남게 한다.
 */
function orderForMasterUpsert(matched: MatchedRow[]): MatchedRow[] {
  return [...matched].sort((a, b) => Number(a.sheetRow.isConcurrent) - Number(b.sheetRow.isConcurrent))
}

async function upsertEmployeeMaster(matched: MatchedRow[], teamDeptId: Map<string, string>, now: Date) {
  for (const m of orderForMasterUpsert(matched)) {
    const departmentId = teamDeptId.get(`${m.sheetRow.division}::${m.sheetRow.team}`) ?? null
    await prisma.employeeMaster.upsert({
      where: { rawId: m.rawId },
      create: {
        rawId: m.rawId,
        name: m.sheetRow.name,
        departmentId,
        jobTitle: m.sheetRow.title,
        source: 'sheet',
        lastSeenSheetAt: now,
      },
      update: {
        name: m.sheetRow.name,
        departmentId,
        jobTitle: m.sheetRow.title,
        status: 'ACTIVE', // 최신 시트에 다시 나타났으므로 재직 확정(퇴사 취소 포함)
        lastSeenSheetAt: now,
      },
    })
  }
}

export async function syncOrgChart(tab: OrgChartTab): Promise<SyncResult> {
  const now = new Date()
  const parsed = parseOrgChartSheet(tab.values, tab.tabName)

  const attendanceData = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  const capsEmployees = ((attendanceData?.data as { employees?: CapsEmployeeLite[] } | null)?.employees) ?? []

  const resolutions = await prisma.sheetNameResolution.findMany()
  const matchResult = matchEmployees(
    parsed.rows,
    capsEmployees,
    resolutions.map(r => ({ matchKey: r.matchKey, resolvedRawId: r.resolvedRawId })),
  )

  const activeMaster = await prisma.employeeMaster.findMany({
    where: { status: 'ACTIVE' },
    select: { rawId: true, name: true, lastSeenSheetAt: true },
  })
  const possiblyResigned = findPossiblyResigned(activeMaster, matchResult.matched)

  const teamDeptId = await syncDepartments(parsed.rows)
  await upsertEmployeeMaster(matchResult.matched, teamDeptId, now)

  // 시트 원본 각 행에 매칭 결과(rawId, 없으면 null)를 붙여서 보관 — 조직도 페이지가
  // EmployeeMaster(매칭된 사람만 존재)가 아니라 이 enriched 로스터를 그대로 렌더링해서
  // CAPS에 없는 사람도 화면에서 안 빠지고 연하게 표시되게 한다.
  const rawIdByRow = new Map(matchResult.matched.map(m => [m.sheetRow, m.rawId]))
  const enrichedRows: EnrichedSheetPersonRow[] = parsed.rows.map(row => ({ ...row, rawId: rawIdByRow.get(row) ?? null }))

  // Sanity: 시트의 겸임(*) 표기 때문에 정확히 0이 되진 않는다(설계상 허용 — B-3 참고).
  // 허용 오차를 넘으면 sanityPassed=false로만 기록하고 동기화는 계속 진행한다.
  const declaredTotal = parsed.sheetTotals['총 인원'] ?? null
  const diff = declaredTotal != null ? Math.abs(parsed.rows.length - declaredTotal) : null
  const sanityPassed = diff != null && diff <= 5

  const snapshot = await prisma.orgChartSnapshot.upsert({
    where: { tabName: tab.tabName },
    create: {
      tabName: tab.tabName,
      tabDate: tab.tabName, // TODO: "M/D" → "YYYY-MM-DD" 변환은 pickLatestTab의 연도추정 로직과 통일해서 후속 PR에서 정리
      rawGrid: tab.values,
      parsedRows: enrichedRows as unknown as Prisma.InputJsonValue,
      sheetTotals: parsed.sheetTotals,
      parsedTotals: { rowCount: parsed.rows.length, byDivision: countByDivision(parsed.rows) },
      sanityPassed,
      syncTrigger: 'manual',
    },
    update: {
      rawGrid: tab.values,
      parsedRows: enrichedRows as unknown as Prisma.InputJsonValue,
      sheetTotals: parsed.sheetTotals,
      parsedTotals: { rowCount: parsed.rows.length, byDivision: countByDivision(parsed.rows) },
      sanityPassed,
      syncTrigger: 'manual',
      syncedAt: now,
    },
  })

  return {
    snapshotId: snapshot.id,
    tabName: tab.tabName,
    sanityPassed,
    matchedCount: matchResult.matched.length,
    ambiguousCount: matchResult.ambiguous.length,
    newHireCount: matchResult.newHires.length,
    possiblyResignedCount: possiblyResigned.length,
  }
}

function countByDivision(rows: SheetPersonRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.division] = (out[r.division] ?? 0) + 1
  return out
}
