/**
 * backup_before_normalize.ts가 만든 백업 폴더에서 DB를 되돌린다 — 마이그레이션/백필이
 * 잘못됐을 때의 롤백용. 백업에 들어있는 "모든" 테이블을 TRUNCATE CASCADE 한 뒤 백업
 * 시점 행으로 다시 채운다.
 *
 * 주의: 스키마 자체(테이블 구조)는 안 건드린다 — 마이그레이션으로 테이블을 새로 만들거나
 * 컬럼을 바꿨다면, 먼저 `git checkout master -- prisma/schema.prisma && npx prisma migrate
 * dev`(또는 `prisma db push`)로 스키마를 되돌린 다음에 이 스크립트로 데이터를 복원해야 한다.
 * 스키마가 백업 당시와 다르면(예: 컬럼이 없어졌으면) 그 테이블 복원은 실패한다 — 실패한
 * 테이블 이름은 로그에 그대로 남으니 확인할 것.
 *
 * 실행: npx tsx scripts/restore_from_backup.ts backups/pre_normalize_<timestamp>
 */
import { prisma } from '../src/lib/prisma'
import fs from 'fs'
import path from 'path'

async function main() {
  const dir = process.argv[2]
  if (!dir) {
    console.error('사용법: npx tsx scripts/restore_from_backup.ts <백업폴더경로>')
    process.exit(1)
  }

  const manifestPath = path.join(dir, '_manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.error(`_manifest.json을 찾을 수 없습니다: ${manifestPath}`)
    process.exit(1)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    takenAt: string
    rowCounts: Record<string, number>
  }

  console.log(`백업 시각: ${manifest.takenAt}`)
  console.log('되돌릴 테이블:', Object.keys(manifest.rowCounts).join(', '))
  console.log('⚠ 이 테이블들의 현재 데이터는 전부 삭제되고 백업 시점 데이터로 교체됩니다.')

  const failedTables: string[] = []

  // FK 순서 걱정 없이 truncate/insert 하기 위해 세션 동안 트리거(FK 체크 포함) 비활성화.
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`)

  try {
    for (const tablename of Object.keys(manifest.rowCounts)) {
      const filePath = path.join(dir, `${tablename}.json`)
      if (!fs.existsSync(filePath)) {
        console.warn(`  ${tablename}: 백업 파일 없음 — 스킵`)
        continue
      }
      const rows = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>[]

      try {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${tablename}" CASCADE`)
        if (rows.length === 0) {
          console.log(`  ${tablename}: 0행 (truncate만)`)
          continue
        }

        const columns   = Object.keys(rows[0])
        const colList   = columns.map(c => `"${c}"`).join(', ')
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
        const insertSql = `INSERT INTO "${tablename}" (${colList}) VALUES (${placeholders})`

        for (const row of rows) {
          await prisma.$executeRawUnsafe(insertSql, ...columns.map(c => row[c]))
        }
        console.log(`  ${tablename}: ${rows.length}행 복원`)
      } catch (err) {
        console.error(`  ✗ ${tablename} 복원 실패:`, err instanceof Error ? err.message : err)
        failedTables.push(tablename)
      }
    }
  } finally {
    await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`)
  }

  console.log('─'.repeat(40))
  if (failedTables.length > 0) {
    console.log(`⚠ 일부 실패: ${failedTables.join(', ')} — 스키마가 백업 당시와 다를 수 있습니다. 위 에러 메시지 확인.`)
  } else {
    console.log('✅ 전체 테이블 복원 완료')
  }
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
