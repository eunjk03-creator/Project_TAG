import type { UnmatchedErpEntry } from '@/utils/dataParser'

/** 사람(rawId+ERP성명) 단위로 합산한 미매칭 ERP 신청 — /admin/employees 카드와 업로드 직후
 *  요약 배지 둘 다 이 형태를 그린다. dept는 호출부가 원하면 DB 조회로 채워 넣는다(옵션). */
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

export function groupUnmatchedErp(entries: UnmatchedErpEntry[]): ErpUnmatchedGroup[] {
  const groups = new Map<string, ErpUnmatchedGroup>()
  for (const e of entries) {
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
  list.forEach(g => g.dates.sort())
  list.sort((a, b) => (b.otHours + b.leaveDays * 8) - (a.otHours + a.leaveDays * 8))
  return list
}
