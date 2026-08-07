/**
 * 실제로 받은 조직도 엑셀 파일을 브라우저 업로드 없이 로컬에서 미리 확인하는 스크립트.
 * DB에 아무것도 쓰지 않는다 — OrgSyncTab의 "미리보기"와 동일한 로직만 CLI에서 재현.
 *
 * 실행: npx tsx scripts/preview_real_org_file.ts "<파일경로>" [탭이름]
 */
import { readFileSync } from 'fs'
import { PrismaClient } from '@prisma/client'
import { readOrgChartWorkbook } from '../src/lib/orgSheet/readOrgChartExcel'
import { parseOrgChartSheet } from '../src/lib/orgSheet/parseOrgChartSheet'
import { matchEmployees, type CapsEmployeeLite } from '../src/lib/orgSheet/matchEmployees'

const prisma = new PrismaClient()

;(async () => {
  const filePath = process.argv[2]
  if (!filePath) { console.error('사용법: npx tsx scripts/preview_real_org_file.ts "<파일경로>" [탭이름]'); process.exit(1) }
  const forcedTabName = process.argv[3]

  const buf = readFileSync(filePath)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const tabs = readOrgChartWorkbook(arrayBuffer as ArrayBuffer)

  console.log(`파일: ${filePath}`)
  console.log(`시트(탭) 목록: ${tabs.map(t => t.tabName).join(', ')}`)

  const tab = forcedTabName ? tabs.find(t => t.tabName === forcedTabName) : tabs[tabs.length - 1]
  if (!tab) { console.error(`탭을 찾을 수 없음: ${forcedTabName}`); process.exit(1) }
  console.log(`\n사용할 탭: "${tab.tabName}" (${tab.values.length}행)\n`)

  const parsed = parseOrgChartSheet(tab.values, tab.tabName)
  console.log(`파싱된 인원 행: ${parsed.rows.length}`)
  console.log('시트 상단 집계:', parsed.sheetTotals)
  if (parsed.warnings.length) {
    console.log(`\n경고 ${parsed.warnings.length}건:`)
    for (const w of parsed.warnings.slice(0, 20)) console.log(`  ${w}`)
  }

  const byDivision = new Map<string, number>()
  for (const row of parsed.rows) byDivision.set(row.division, (byDivision.get(row.division) ?? 0) + 1)
  const declared = new Map(parsed.declaredCounts.filter(d => !d.label.includes('/')).map(d => [d.label, d.count]))
  console.log('\ndivision별 파싱 vs 신고:')
  for (const [div, count] of byDivision) {
    const dec = declared.get(div)
    console.log(`  ${div.padEnd(14, ' ')} 파싱=${count}\t신고=${dec ?? '?'}${dec === count ? ' OK' : ''}`)
  }

  const attendanceData = await prisma.sharedDataStore.findUnique({ where: { key: 'attendance_data' } })
  const capsEmployees = ((attendanceData?.data as { employees?: CapsEmployeeLite[] } | null)?.employees) ?? []
  console.log(`\nCAPS 직원 수: ${capsEmployees.length}`)

  const resolutions = await prisma.sheetNameResolution.findMany()
  const result = matchEmployees(parsed.rows, capsEmployees, resolutions.map(r => ({ matchKey: r.matchKey, resolvedRawId: r.resolvedRawId })))

  console.log(`\n자동매칭: ${result.matched.length} / ${parsed.rows.length} (${((result.matched.length / parsed.rows.length) * 100).toFixed(1)}%)`)
  console.log(`동명이인 큐: ${result.ambiguous.length}`)
  console.log(`신규입사자(CAPS 미등록) 후보: ${result.newHires.length}`)

  if (result.ambiguous.length) {
    console.log('\n--- 동명이인 큐 ---')
    for (const a of result.ambiguous) {
      console.log(`  "${a.sheetName}" (${a.sheetDept}) → ${a.candidates.map(c => `${c.name}/${c.division}/${c.team}(${c.rawId})`).join(', ')} | autoPick=${a.autoPickId ?? '없음'}`)
    }
  }
  if (result.newHires.length) {
    console.log('\n--- 신규입사자 후보 ---')
    for (const n of result.newHires) console.log(`  ${n.name} — ${n.division}/${n.team} (${n.title})`)
  }

  const activeMaster = await prisma.employeeMaster.findMany({ where: { status: 'ACTIVE' }, select: { rawId: true, name: true, lastSeenSheetAt: true } })
  console.log(`\n현재 EmployeeMaster ACTIVE 인원: ${activeMaster.length} (아직 한 번도 반영 전이면 0)`)

  await prisma.$disconnect()
})()
