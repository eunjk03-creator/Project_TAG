/**
 * 1회성 백필: shared_data_store의 caps_data/erp_data(JSON 청크, CapsRow[]/ErpUnifiedRow[]
 * 원본 스냅샷)를 caps_daily_logs/erp_applications(정규화 테이블)로 이관한다.
 *
 * daily_attendance는 이미 최신이라 이 스크립트에선 안 건드림 — 백필 후 필요하면
 * /api/compute-attendance(전체 재계산)를 한 번 돌려서 정합성을 재확인할 것.
 *
 * 실행: npx tsx scripts/migrate_to_normalized_tables.ts
 * 주의: caps_daily_logs/erp_applications에 실제로 INSERT/UPDATE를 수행한다 —
 * DATABASE_URL이 가리키는 DB(현재 .env 기준 운영 Supabase)에 직접 반영됨.
 */
import { prisma } from '../src/lib/prisma'
import { upsertCapsRows, upsertErpRows } from '../src/lib/recomputeFromNormalized'
import type { CapsRow, ErpUnifiedRow } from '../src/types/tag'

async function loadChunked<T>(metaKey: string, chunkPrefix: string): Promise<T[]> {
  const metaRow = await prisma.sharedDataStore.findUnique({ where: { key: metaKey } })
  const meta = metaRow?.data as { chunkCount?: number; rows?: T[] } | null
  if (!meta) return []
  if (meta.rows?.length) return meta.rows // legacy: 청크 없이 통째로 저장된 경우

  const chunkCount = meta.chunkCount ?? 0
  if (chunkCount === 0) return []

  const BATCH = 4 // Supabase pooler 동시연결 스파이크 방지 — 기존 코드 컨벤션과 동일
  const out: T[] = []
  for (let start = 0; start < chunkCount; start += BATCH) {
    const idx = Array.from({ length: Math.min(BATCH, chunkCount - start) }, (_, j) => start + j)
    const batch = await Promise.all(
      idx.map(i =>
        prisma.sharedDataStore.findUnique({ where: { key: `${chunkPrefix}_${i}` } })
          .then(r => (r?.data as { records?: T[] } | null)?.records ?? [])
          .catch(() => [] as T[]),
      ),
    )
    for (const recs of batch) out.push(...recs)
    console.log(`  ${metaKey}: 청크 ${start + idx.length}/${chunkCount} 로드`)
  }
  return out
}

async function main() {
  console.log('CAPS 원본 로드 중...')
  const capsRows = await loadChunked<CapsRow>('caps_data', 'caps_records')
  console.log(`CAPS 원본 ${capsRows.length}건 로드 완료`)

  console.log('ERP 원본 로드 중...')
  const erpRows = await loadChunked<ErpUnifiedRow>('erp_data', 'erp_records')
  console.log(`ERP 원본 ${erpRows.length}건 로드 완료`)

  if (capsRows.length === 0 && erpRows.length === 0) {
    console.log('이관할 원본 데이터가 없습니다 (caps_data/erp_data 비어있음). 종료.')
    return
  }

  // upsertCapsRows/upsertErpRows는 배열 전체를 한 번에 unnest()로 upsert하므로 크기가
  // 커도(수만 건) 한 번의 왕복으로 처리된다 — AttendanceSourceContext.tsx의 청크(4000건)
  // 분할과 달리 여기선 body 크기 제한(Vercel 4.5MB)이 없는 로컬 실행이라 안 나눔.
  console.log('caps_daily_logs로 이관 중...')
  const capsCounts = await upsertCapsRows(capsRows)
  console.log(`  삽입 ${capsCounts.insertedCount}건, 갱신 ${capsCounts.updatedCount}건`)

  console.log('erp_applications로 이관 중...')
  const erpCounts = await upsertErpRows(erpRows)
  console.log(`  삽입 ${erpCounts.insertedCount}건, 갱신 ${erpCounts.updatedCount}건`)

  const [capsCount, erpCount, empCount] = await Promise.all([
    prisma.capsDailyLog.count(),
    prisma.erpApplication.count(),
    prisma.employeeMaster.count(),
  ])
  console.log('─'.repeat(40))
  console.log(`검증: caps_daily_logs ${capsCount}건 (원본 ${capsRows.length}건)`)
  console.log(`검증: erp_applications ${erpCount}건 (원본 ${erpRows.length}건)`)
  console.log(`검증: employee_master ${empCount}건`)
  if (capsCount < capsRows.length) {
    console.warn('⚠ caps_daily_logs 건수가 원본보다 적습니다 — 같은 (사원번호, 근무일자) 중복 원본이 있었을 수 있습니다(정상: dedup 효과). 건수 차이가 크면 원본 파싱 문제를 의심하세요.')
  }
  console.log('✅ 백필 완료')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
