/**
 * 매칭 엔진 로컬 검증 — DB에 쓰지 않음. 실제 CAPS 직원 목록(shared_data_store.attendance_data)과
 * 시트 fixture 파싱 결과를 매칭해서 자동매칭 비율/동명이인/신규입사자 후보를 확인한다.
 *
 * 실행: npx tsx scripts/preview_org_match.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { parseOrgChartSheet } from '../src/lib/orgSheet/parseOrgChartSheet'
import { matchEmployees, type CapsEmployeeLite } from '../src/lib/orgSheet/matchEmployees'

const prisma = new PrismaClient()

;(async () => {
  const fixturePath = join(__dirname, 'fixtures', 'org_sheet_8_5.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as { tabName: string; values: string[][] }
  const { rows } = parseOrgChartSheet(fixture.values, fixture.tabName)

  const row = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  const data = row?.data as { employees: CapsEmployeeLite[] } | undefined
  const capsEmployees = data?.employees ?? []
  console.log(`CAPS 직원 수: ${capsEmployees.length}, 시트 파싱 행 수: ${rows.length}`)

  const result = matchEmployees(rows, capsEmployees, [])

  console.log(`\n자동매칭: ${result.matched.length} (${((result.matched.length / rows.length) * 100).toFixed(1)}%)`)
  console.log(`동명이인 큐: ${result.ambiguous.length}`)
  console.log(`신규입사자(CAPS 미등록) 후보: ${result.newHires.length}`)

  const byConfidence = new Map<string, number>()
  for (const m of result.matched) byConfidence.set(m.confidence, (byConfidence.get(m.confidence) ?? 0) + 1)
  console.log('매칭 신뢰도 분포:', Object.fromEntries(byConfidence))

  if (result.ambiguous.length) {
    console.log('\n--- 동명이인 큐 샘플 ---')
    for (const a of result.ambiguous.slice(0, 10)) {
      console.log(`  "${a.sheetName}" (${a.sheetDept}) → 후보 ${a.candidates.length}명: ${a.candidates.map(c => `${c.name}/${c.division}/${c.team}(${c.rawId})`).join(', ')} | autoPick=${a.autoPickId ?? '없음'}`)
    }
  }

  if (result.newHires.length) {
    console.log('\n--- 신규입사자 후보 샘플 ---')
    for (const n of result.newHires.slice(0, 15)) {
      console.log(`  ${n.name} — ${n.division}/${n.team} (${n.title})`)
    }
  }

  await prisma.$disconnect()
})()
