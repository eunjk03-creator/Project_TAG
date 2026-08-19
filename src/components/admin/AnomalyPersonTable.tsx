/** 종합현황/조직도 공용 — 이름·지각·미달·미태깅·합계 개인별 이상치 표.
 *  overview는 division 컬럼을 포함한 flat 리스트로, 조직도는 이미 division 카드 안에
 *  있으므로 division 컬럼 없이 team만 붙여서 넘긴다. */
export interface AnomalyPersonRow {
  key:       string
  name:      string
  division?: string
  team?:     string
  late:      number
  shortage:  number
  notag:     number
  total:     number
}

export function AnomalyPersonTable({
  rows, showDivisionCol = false,
}: { rows: AnomalyPersonRow[]; showDivisionCol?: boolean }) {
  if (rows.length === 0) {
    return <p className="text-xs text-gray-300 text-center py-6">이 기간 이상치 없음</p>
  }
  return (
    <table className="w-full">
      <thead>
        <tr className="text-[10px] text-gray-300 uppercase tracking-wide border-b border-gray-100">
          {showDivisionCol && <th className="text-left pb-1.5 font-medium">부서</th>}
          <th className="text-left pb-1.5 font-medium">이름</th>
          <th className="text-right pb-1.5 font-medium">지각</th>
          <th className="text-right pb-1.5 font-medium">미달</th>
          <th className="text-right pb-1.5 font-medium">미태깅</th>
          <th className="text-right pb-1.5 font-medium">합계</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map(r => (
          <tr key={r.key}>
            {showDivisionCol && <td className="py-1 text-xs text-gray-400 truncate max-w-[100px]">{r.division}</td>}
            <td className="py-1 text-xs font-medium text-gray-800 whitespace-nowrap">
              {r.name}
              {r.team && <span className="text-gray-300 text-[10px] ml-1">{r.team}</span>}
            </td>
            <td className="py-1 text-xs text-right tabular-nums text-amber-600">{r.late || '—'}</td>
            <td className="py-1 text-xs text-right tabular-nums text-red-600">{r.shortage || '—'}</td>
            <td className="py-1 text-xs text-right tabular-nums text-red-600">{r.notag || '—'}</td>
            <td className="py-1 text-xs text-right tabular-nums font-bold text-gray-800">{r.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
