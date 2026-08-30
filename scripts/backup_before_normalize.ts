/**
 * 정규화 마이그레이션(prisma migrate) 적용 전 안전망 — public 스키마의 모든 테이블을
 * 통째로 JSON으로 떠서 backups/pre_normalize_<timestamp>/ 에 저장한다. 읽기 전용(SELECT만) —
 * DB에 아무 변경도 가하지 않는다.
 *
 * 실행: npx tsx scripts/backup_before_normalize.ts
 * 롤백 시: scripts/restore_from_backup.ts <백업폴더경로> 참고.
 *
 * backups/는 .gitignore에 등록됨 — 실제 직원 이름/근태 데이터가 그대로 들어있으므로
 * 절대 커밋하거나 외부로 유출하지 말 것.
 */
import { prisma } from '../src/lib/prisma'
import fs from 'fs'
import path from 'path'

function jsonSafe(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

async function main() {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )
  if (tables.length === 0) {
    console.log('public 스키마에 테이블이 없습니다. 종료.')
    return
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(__dirname, '..', 'backups', `pre_normalize_${ts}`)
  fs.mkdirSync(dir, { recursive: true })

  const manifest: Record<string, number> = {}
  for (const { tablename } of tables) {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${tablename}"`)
    fs.writeFileSync(path.join(dir, `${tablename}.json`), JSON.stringify(rows, jsonSafe, 2))
    manifest[tablename] = rows.length
    console.log(`  ${tablename}: ${rows.length}행`)
  }

  fs.writeFileSync(
    path.join(dir, '_manifest.json'),
    JSON.stringify({ takenAt: new Date().toISOString(), tableCount: tables.length, rowCounts: manifest }, null, 2),
  )
  console.log('─'.repeat(40))
  console.log(`✅ 백업 완료: ${dir}`)
  console.log('롤백이 필요하면: npx tsx scripts/restore_from_backup.ts "' + dir + '"')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
