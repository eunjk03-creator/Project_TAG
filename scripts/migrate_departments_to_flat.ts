/**
 * departments 테이블을 트리(name/level/parent_id) → flat(division/team)으로 직접 SQL 이관.
 *
 * prisma migrate dev를 안 쓰는 이유: _prisma_migrations 이력이 2026-05-05 "init" 이후로 안
 * 늘어난 채 그동안 db push(또는 수동 SQL)로만 스키마가 바뀌어 왔다(person_links 드리프트로
 * 확인됨) — 이 상태에서 migrate dev를 돌리면 Prisma가 이력과 실제 DB 상태의 괴리를 어떻게
 * 처리할지 예측이 안 되고, 최악의 경우 "drift 감지 → dev DB reset 제안"으로 이어질 수 있다.
 * raw SQL로 직접 통제하는 게 더 안전하다.
 *
 * 안전장치: 새 컬럼 추가(비파괴) → parent_id로 값 채우기 → **검증해서 하나라도 이상하면
 * 여기서 멈추고 구 컬럼은 그대로 남긴다** → 검증 통과해야만 구 컬럼 삭제(파괴적) 진행.
 *
 * 사전 조건: scripts/backup_before_normalize.ts로 백업을 이미 떠뒀어야 한다(안 떠졌으면
 * 이 스크립트가 먼저 확인하고 중단한다).
 *
 * 실행: npx tsx scripts/migrate_departments_to_flat.ts
 */
import { prisma } from '../src/lib/prisma'
import fs from 'fs'
import path from 'path'

function hasRecentBackup(): boolean {
  const dir = path.join(__dirname, '..', 'backups')
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some(name => name.startsWith('pre_normalize_'))
}

async function main() {
  if (!hasRecentBackup()) {
    console.error('❌ backups/pre_normalize_* 백업이 안 보입니다. scripts/backup_before_normalize.ts부터 실행하세요.')
    process.exit(1)
  }

  const before = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*)::bigint FROM departments`)
  const totalBefore = Number(before[0].count)
  console.log(`이관 대상: departments ${totalBefore}행`)

  console.log('1) division/team 컬럼 추가 (비파괴)...')
  await prisma.$executeRawUnsafe(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS division TEXT`)
  await prisma.$executeRawUnsafe(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS team TEXT`)

  console.log('2) level 0(본부) 행 채우기: division = name...')
  const l0 = await prisma.$executeRawUnsafe(`UPDATE departments SET division = name WHERE level = 0`)
  console.log(`   ${l0}행 갱신`)

  console.log('3) level 1(팀/파트) 행 채우기: parent_id로 본부명 조인...')
  const l1 = await prisma.$executeRawUnsafe(`
    UPDATE departments d
    SET division = p.name, team = d.name
    FROM departments p
    WHERE d.parent_id = p.id AND d.level = 1
  `)
  console.log(`   ${l1}행 갱신`)

  console.log('4) 검증 — division 비어있는 행 / level 2+ 존재 여부 확인...')
  const missing = await prisma.$queryRawUnsafe<{ id: string; name: string; level: number }[]>(
    `SELECT id, name, level FROM departments WHERE division IS NULL`,
  )
  const deeper = await prisma.$queryRawUnsafe<{ id: string; name: string; level: number }[]>(
    `SELECT id, name, level FROM departments WHERE level NOT IN (0, 1)`,
  )
  if (missing.length > 0 || deeper.length > 0) {
    console.error('❌ 검증 실패 — 구 컬럼을 지우지 않고 중단합니다.')
    if (missing.length > 0) console.error('  division 비어있는 행:', missing)
    if (deeper.length > 0)  console.error('  level 0/1이 아닌 행(가정 위반, 수동 확인 필요):', deeper)
    console.error('  (division/team 컬럼은 이미 추가돼 있으니 원인 파악 후 재실행 가능)')
    process.exit(1)
  }
  const after = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*)::bigint FROM departments WHERE division IS NOT NULL`)
  const totalAfter = Number(after[0].count)
  if (totalAfter !== totalBefore) {
    console.error(`❌ 행 수 불일치: 이관 전 ${totalBefore}행, division 채워진 행 ${totalAfter}행 — 중단합니다.`)
    process.exit(1)
  }
  console.log(`   검증 통과: ${totalAfter}행 전부 division 채워짐, level 0/1만 존재`)

  console.log('5) 구 컬럼/제약 삭제 (parent_id FK → level → name) — 여기부터 파괴적...')
  await prisma.$executeRawUnsafe(`ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_parent_id_fkey`)
  await prisma.$executeRawUnsafe(`ALTER TABLE departments DROP COLUMN IF EXISTS parent_id`)
  await prisma.$executeRawUnsafe(`ALTER TABLE departments DROP COLUMN IF EXISTS level`)
  await prisma.$executeRawUnsafe(`ALTER TABLE departments DROP COLUMN IF EXISTS name`)

  console.log('6) division NOT NULL + UNIQUE(division, team) 제약 추가...')
  await prisma.$executeRawUnsafe(`ALTER TABLE departments ALTER COLUMN division SET NOT NULL`)
  await prisma.$executeRawUnsafe(
    `ALTER TABLE departments ADD CONSTRAINT departments_division_team_key UNIQUE (division, team)`,
  )

  console.log('✅ departments flat 이관 완료')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
