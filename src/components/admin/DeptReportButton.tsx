'use client'

import { useState, useRef, useEffect } from 'react'
import type { DateRange } from '@/types/tag'

interface Props {
  dateRange:  DateRange
  divisions:  string[]
}

export default function DeptReportButton({ dateRange, divisions }: Props) {
  const [open,        setOpen]        = useState(false)
  const [selectedDiv, setSelectedDiv] = useState<string>('')
  const [loading,     setLoading]     = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 바깥 클릭 시 닫기
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  async function download() {
    setLoading(true)
    try {
      const res = await fetch('/api/export/dept-report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          dept: selectedDiv || undefined,
          from: dateRange.from,
          to:   dateRange.to,
        }),
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: '오류' }))
        alert(error ?? '보고서 생성에 실패했습니다')
        return
      }
      const blob        = await res.blob()
      const url         = URL.createObjectURL(blob)
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match       = disposition.match(/filename\*=UTF-8''(.+)/)
      const filename    = match ? decodeURIComponent(match[1]) : '근태보고서.xlsx'
      const a           = document.createElement('a')
      a.href            = url
      a.download        = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-3 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:border-red-400 hover:text-red-600 hover:bg-red-50 transition-colors text-xs font-medium"
        title="부문별 근태 보고서를 Excel로 다운로드"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
        </svg>
        부문 보고서
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-3 flex flex-col gap-2">
          <p className="text-xs font-semibold text-gray-600">부문 보고서 다운로드</p>

          <select
            value={selectedDiv}
            onChange={e => setSelectedDiv(e.target.value)}
            className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-700 bg-white focus:outline-none focus:border-red-400"
          >
            <option value="">전체 부문</option>
            {divisions.sort((a, b) => a.localeCompare(b, 'ko')).map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          <div className="text-xs text-gray-400">
            기간: {dateRange.from} ~ {dateRange.to}
          </div>

          <button
            onClick={download}
            disabled={loading}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-red-600 text-white text-xs font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                생성 중...
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                Excel 다운로드
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
