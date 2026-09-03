/**
 * processRecord.ts/attendanceCalc.ts의 하드코딩 리터럴을 policy_config 참조로 바꾼 리팩터가
 * 실제 계산 결과를 하나도 안 바꿨는지 확인 — DEFAULT_POLICY의 새 필드값이 기존 하드코딩과
 * 정확히 같아야 한다는 전제를 검증. daily_attendance를 스냅샷 → 재계산 → diff.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const before = await prisma.$queryRawUnsafe(`
  SELECT employee_id, work_date, regular_hours, overtime_hours, night_hours, flag, final_status
  FROM daily_attendance ORDER BY employee_id, work_date
`)
console.log(`스냅샷 완료: ${before.length}건`)

const beforeMap = new Map(before.map(r => [`${r.employee_id}_${r.work_date}`, r]))

// 재계산 트리거 — 로컬 dev 서버(localhost:3001)의 compute-attendance를 페이지네이션으로 끝까지 호출
let offset = 0
const limit = 2000
for (;;) {
  const res = await fetch('http://localhost:3001/api/compute-attendance', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset, limit }),
  })
  const json = await res.json()
  if (!res.ok) { console.error('recompute 실패', json); process.exit(1) }
  console.log(`recompute page offset=${offset} count=${json.count ?? json.processed?.length} done=${json.done}`)
  if (json.done) break
  offset += (json.processed?.length ?? limit)
}

const after = await prisma.$queryRawUnsafe(`
  SELECT employee_id, work_date, regular_hours, overtime_hours, night_hours, flag, final_status
  FROM daily_attendance ORDER BY employee_id, work_date
`)
console.log(`재계산 후: ${after.length}건`)

let diffCount = 0
const samples = []
for (const a of after) {
  const key = `${a.employee_id}_${a.work_date}`
  const b = beforeMap.get(key)
  if (!b) continue
  const changed = b.regular_hours !== a.regular_hours || b.overtime_hours !== a.overtime_hours ||
    b.night_hours !== a.night_hours || b.flag !== a.flag || b.final_status !== a.final_status
  if (changed) {
    diffCount++
    if (samples.length < 20) samples.push({ key, before: b, after: a })
  }
}
console.log(`\n총 diff: ${diffCount}건 / ${after.length}건`)
if (samples.length) console.log(JSON.stringify(samples, null, 2))

await prisma.$disconnect()
