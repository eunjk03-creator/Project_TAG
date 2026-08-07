/**
 * 로컬 파서 검증 스크립트 — DB에 아무것도 쓰지 않는다.
 * 지금은 gws로 캡처한 fixture JSON을 읽지만, 프로덕션에서는 이 자리를
 * googleSheetsClient.ts의 실제 Sheets API 호출로 교체한다(Task #3, 서비스계정 발급 후).
 *
 * 실행: npx tsx scripts/preview_org_sheet.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseOrgChartSheet } from '../src/lib/orgSheet/parseOrgChartSheet'

const fixturePath = join(__dirname, 'fixtures', 'org_sheet_8_5.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  tabName: string
  values: string[][]
}

const result = parseOrgChartSheet(fixture.values, fixture.tabName)

console.log(`\n=== 파싱 결과: ${fixture.tabName} ===`)
console.log(`총 인원 행: ${result.rows.length}`)

console.log('\n--- 시트 상단 집계(sheetTotals) ---')
console.log(result.sheetTotals)

console.log('\n--- division별 파싱 카운트 vs 시트 신고 카운트 ---')
const byDivision = new Map<string, number>()
for (const row of result.rows) {
  byDivision.set(row.division, (byDivision.get(row.division) ?? 0) + 1)
}
const divisionDeclared = new Map(result.declaredCounts.filter(d => !d.label.includes('/')).map(d => [d.label, d.count]))
let parsedTotal = 0
for (const [division, count] of byDivision) {
  const declared = divisionDeclared.get(division)
  const mark = declared === count ? 'OK' : `MISMATCH (신고=${declared})`
  console.log(`  ${division.padEnd(12, ' ')} 파싱=${count}\t${mark}`)
  parsedTotal += count
}
console.log(`\n파싱된 전체 인원(중복 포함, concurrent 별도 표기 인물도 1행으로 카운트): ${parsedTotal}`)
console.log(`시트 상단 "총 인원": ${result.sheetTotals['총 인원']}`)

const concurrentRows = result.rows.filter(r => r.isConcurrent)
console.log(`\n--- 겸임(*) 표시된 행 (${concurrentRows.length}건, 중복집계 후보) ---`)
for (const row of concurrentRows) {
  console.log(`  ${row.name} — ${row.division}/${row.team} (${row.title})`)
}

if (result.warnings.length) {
  console.log(`\n--- 경고 (${result.warnings.length}건) ---`)
  for (const w of result.warnings) console.log(`  ${w}`)
}

console.log('\n--- 샘플 5건 ---')
for (const row of result.rows.slice(0, 5)) {
  console.log(`  ${JSON.stringify(row)}`)
}
