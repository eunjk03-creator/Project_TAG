import { NextRequest, NextResponse } from 'next/server'
import { upsertCapsRows, recomputeEmployeesFromNormalizedTables } from '@/lib/recomputeFromNormalized'
import type { CapsRow } from '@/types/tag'

// POST /api/erp-unmatched/register
// "CAPS 미등록"(reason: no_caps) 케이스 처리 — 이 사번은 caps_daily_logs에 단 한 건도
// 없어서 이 앱의 Employee 목록 자체에 존재하지 않았다(dataParser.ts extractEmployees가
// CAPS 기준이라). 지정한 날짜들에 출근/퇴근이 빈 stub 행을 만들어 일단 "미태깅" 상태의
// 정상 직원으로 편입시킨다 — 이후 실제 시각은 관리자가 이미 있는 미태깅 인라인 처리
// UI(그리드/테이블/anomalies 어디서든)로 직접 입력한다.
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { rawId, name, dept, dates } = body as { rawId?: string; name?: string; dept?: string; dates?: string[] }

  if (!rawId || !name || !Array.isArray(dates) || dates.length === 0) {
    return NextResponse.json({ error: 'rawId, name, dates(비어있지 않은 배열) 필요' }, { status: 400 })
  }

  const stubRows: CapsRow[] = dates.map(workDate => ({
    사원번호: rawId,
    이름:     name,
    부서:     dept ?? '',
    직급:     '',
    근무일자: workDate,
    출근:     null,
    퇴근:     null,
  }))

  await upsertCapsRows(stubRows)
  await recomputeEmployeesFromNormalizedTables([rawId])

  return NextResponse.json({ ok: true, registeredDates: dates.length })
}
