/**
 * CAPS/ERP 업로드 진입점 — caps_daily_logs/erp_applications에 upsert(진짜 누적, dedup은
 * DB unique 제약이 보장) 후, 이번 배치에 등장한 사원번호(=영향받은 직원)만 골라서
 * daily_attendance를 증분 재계산한다. 예전(shared_data_store JSON 스냅샷 통째로 병합·재기록
 * + 전체 재계산) 방식을 대체 — 자세한 배경은 plans/functional-roaming-boot.md 참고.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  upsertCapsRows, upsertErpRows, deleteCapsRows, recomputeEmployeesFromNormalizedTables,
} from '@/lib/recomputeFromNormalized'
import type { CapsRow, ErpUnifiedRow } from '@/types/tag'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { caps?: CapsRow[]; erp?: ErpUnifiedRow[] }
    const caps = body.caps ?? []
    const erp  = body.erp  ?? []
    if (caps.length === 0 && erp.length === 0) {
      return NextResponse.json({ error: 'caps 또는 erp 중 최소 하나는 있어야 합니다.' }, { status: 400 })
    }

    const [capsCounts, erpCounts] = await Promise.all([upsertCapsRows(caps), upsertErpRows(erp)])

    const affectedRawIds = [...new Set([
      ...caps.map(r => String(r.사원번호 ?? '').trim()),
      ...erp.map(r => String(r.사원번호 ?? '').trim()),
    ])].filter(Boolean)

    const { processedCount, skippedCount, erpOtMatchCount } =
      await recomputeEmployeesFromNormalizedTables(affectedRawIds)

    return NextResponse.json({
      ok: true,
      affectedEmployees: affectedRawIds.length,
      processedRecords: processedCount,
      skippedCount,
      erpOtMatchCount,
      caps: capsCounts,
      erp: erpCounts,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * "업로드한 파일 되돌리기" — CsvUploader가 파일 슬롯을 지울 때 그 파일이 등록한
 * caps_daily_logs 행만 삭제하고, 영향받은 직원들의 daily_attendance를 재계산한다.
 * keys는 CsvUploader.extractCapsKeys()가 만드는 `${사원번호}_${이름}_${근무일자}` 형식 —
 * caps_daily_logs 삭제엔 사원번호(첫 '_' 앞)와 근무일자(마지막 '_' 뒤, YYYY-MM-DD라 '_'가
 * 없어 안전)만 필요해서 이름 부분은 무시한다.
 */
export async function DELETE(req: NextRequest) {
  try {
    const { keys } = await req.json() as { keys?: string[] }
    if (!keys?.length) return NextResponse.json({ deletedCount: 0 })

    const pairs = keys.map(k => {
      const employeeId = k.slice(0, k.indexOf('_'))
      const workDate    = k.slice(k.lastIndexOf('_') + 1)
      return { employeeId, workDate }
    }).filter(p => p.employeeId && p.workDate)

    const deletedCount = await deleteCapsRows(pairs)
    const affectedRawIds = [...new Set(pairs.map(p => p.employeeId))]
    await recomputeEmployeesFromNormalizedTables(affectedRawIds)

    return NextResponse.json({ deletedCount })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
