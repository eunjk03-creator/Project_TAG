'use client'

interface PaginationBarProps {
  page:         number   // 0-indexed
  pageCount:    number
  onPageChange: (page: number) => void
  startItem:    number
  endItem:      number
  totalCount:   number
  unit?:        string
}

/** AttendanceResultTable의 페이지네이션 바와 동일한 스타일을 공유하는 범용 버전. */
export function PaginationBar({ page, pageCount, onPageChange, startItem, endItem, totalCount, unit = '건' }: PaginationBarProps) {
  if (pageCount <= 1) return null

  const pages: (number | '…')[] = []
  for (let p = 0; p < pageCount; p++) {
    if (p === 0 || p === pageCount - 1 || (p >= page - 2 && p <= page + 2)) pages.push(p)
    else if (pages[pages.length - 1] !== '…') pages.push('…')
  }

  return (
    <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-between gap-4">
      <span className="text-xs text-gray-400 tabular-nums">
        {startItem}–{endItem} / {totalCount}{unit}
      </span>
      <div className="flex items-center gap-1">
        <button onClick={() => onPageChange(0)} disabled={page === 0}
          className="px-2 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">«</button>
        <button onClick={() => onPageChange(page - 1)} disabled={page === 0}
          className="px-2.5 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">이전</button>

        {pages.map((p, idx) =>
          p === '…' ? (
            <span key={`e${idx}`} className="px-1 text-xs text-gray-300">…</span>
          ) : (
            <button key={p} onClick={() => onPageChange(p as number)}
              className={`min-w-[28px] px-2 py-1 text-xs rounded border transition-colors ${
                p === page ? 'bg-blue-600 border-blue-600 text-white font-semibold' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}>{(p as number) + 1}</button>
          ),
        )}

        <button onClick={() => onPageChange(page + 1)} disabled={page >= pageCount - 1}
          className="px-2.5 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">다음</button>
        <button onClick={() => onPageChange(pageCount - 1)} disabled={page >= pageCount - 1}
          className="px-2 py-1 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">»</button>
      </div>
    </div>
  )
}
