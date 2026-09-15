import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildEmployeesAndRawRecords } from '@/lib/recomputeFromNormalized'

// GET /api/erp-unmatched → CAPS와 매칭 안 돼서 조용히 버려지던 ERP 연장근로/휴가 신청 목록.
// 전체 CAPS/ERP를 다시 파싱해야 하는 무거운 조회라(dataParser.ts의 rawId 폴백을 거치고도
// 남은 진짜 미매칭만 추려냄) /admin/overview에서 폴링하지 않고 수동 새로고침으로만 쓴다.
export interface ErpUnmatchedGroup {
  rawId:      string
  erpName:    string
  dept:       string | null
  reason:     'no_caps' | 'ambiguous'
  candidates?: { id: string; name: string }[]
  otHours:    number
  leaveDays:  number
  dates:      string[]
}

export async function GET() {
  const { unmatchedErp } = await buildEmployeesAndRawRecords()

  const groups = new Map<string, ErpUnmatchedGroup>()
  for (const e of unmatchedErp) {
    const gk = `${e.rawId}_${e.erpName}`
    const g = groups.get(gk) ?? {
      rawId: e.rawId, erpName: e.erpName, dept: null, reason: e.reason,
      candidates: e.candidates, otHours: 0, leaveDays: 0, dates: [],
    }
    if (e.kind === 'ot') g.otHours += e.amount
    else g.leaveDays += e.amount
    if (!g.dates.includes(e.startDate)) g.dates.push(e.startDate)
    groups.set(gk, g)
  }

  const list = [...groups.values()]
  if (list.length > 0) {
    const masters = await prisma.employeeMaster.findMany({
      where:   { rawId: { in: list.map(g => g.rawId) } },
      select:  { rawId: true, department: { select: { division: true, team: true } } },
    })
    const deptByRawId = new Map(masters.map(m => [
      m.rawId,
      m.department ? [m.department.division, m.department.team].filter(Boolean).join(' · ') : null,
    ]))
    for (const g of list) g.dept = deptByRawId.get(g.rawId) ?? null
  }

  list.forEach(g => g.dates.sort())
  list.sort((a, b) => (b.otHours + b.leaveDays * 8) - (a.otHours + a.leaveDays * 8))

  return NextResponse.json(list)
}
