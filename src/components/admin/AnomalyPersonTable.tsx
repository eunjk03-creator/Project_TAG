'use client'
import { useEffect, useState } from 'react'

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
  rows, showDivisionCol = false, pageSize,
}: {
  rows: AnomalyPersonRow[]
  showDivisionCol?: boolean
  /** 지정하면 이 개수 단위로 페이지네이션(이전/다음 버튼). 미지정 시 전부 한 번에 표시(기존 동작). */
  pageSize?: number
}) {
  const [page, setPage] = useState(0)
  const totalPages = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1

  // rows가 바뀌면(기간/카드 전환 등) 페이지를 1페이지로 되돌린다 — 이전 카드의 3페이지가
  // 그대로 남아 빈 화면으로 보이는 것을 방지.
  useEffect(() => { setPage(0) }, [rows])

  if (rows.length === 0) {
    return <p className="text-xs text-gray-300 text-center py-6">이 기간 이상치 없음</p>
  }

  const clampedPage = Math.min(page, totalPages - 1)
  const pageRows = pageSize ? rows.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize) : rows

  return (
    <div>
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
          {pageRows.map(r => (
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
      {pageSize && totalPages > 1 && (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-50">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
            className="text-[11px] font-medium text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400 px-1.5"
          >
            ‹ 이전
          </button>
          <span className="text-[10px] text-gray-300 tabular-nums">{clampedPage + 1} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={clampedPage >= totalPages - 1}
            className="text-[11px] font-medium text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400 px-1.5"
          >
            다음 ›
          </button>
        </div>
      )}
    </div>
  )
}
