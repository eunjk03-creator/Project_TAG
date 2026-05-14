'use client'

type Props = {
  selectedBU:   string | null
  selectedRank: string | null
  onBUChange:   (bu: string | null) => void
  onRankChange: (rank: string | null) => void
}

export function DrilldownBreadcrumb({ selectedBU, selectedRank, onBUChange, onRankChange }: Props) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <button
        onClick={() => { onBUChange(null); onRankChange(null) }}
        className={`font-semibold transition-colors ${
          selectedBU ? 'text-blue-500 hover:text-blue-700' : 'text-gray-500 cursor-default'
        }`}
      >
        전체
      </button>

      {selectedBU && (
        <>
          <span className="text-gray-300">/</span>
          <button
            onClick={() => onRankChange(null)}
            className={`font-semibold transition-colors ${
              selectedRank ? 'text-blue-500 hover:text-blue-700' : 'text-gray-700 cursor-default'
            }`}
          >
            {selectedBU}
          </button>
        </>
      )}

      {selectedRank && (
        <>
          <span className="text-gray-300">/</span>
          <span className="text-gray-700 font-semibold">{selectedRank}</span>
        </>
      )}

      {selectedBU && (
        <button
          onClick={() => { onBUChange(null); onRankChange(null) }}
          className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          전체 보기
        </button>
      )}
    </div>
  )
}
