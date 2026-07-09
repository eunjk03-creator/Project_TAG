'use client'

import { useState, useRef, useEffect } from 'react'
import type { DateRange } from '@/types/tag'

interface Props {
  dateRange: DateRange
  divisions: string[]
}

type LoadingType = null | 'pptx' | 'excel' | 'productivity'

export default function StatusExportButton({ dateRange, divisions }: Props) {
  const [open,        setOpen]        = useState(false)
  const [selectedDiv, setSelectedDiv] = useState<string>('')
  const [fromDate,    setFromDate]    = useState(dateRange.from)
  const [toDate,      setToDate]      = useState(dateRange.to)
  const [loading,     setLoading]     = useState<LoadingType>(null)
  const ref = useRef<HTMLDivElement>(null)

  // dateRange 변경 시 내부 상태 동기화
  useEffect(() => {
    setFromDate(dateRange.from)
    setToDate(dateRange.to)
  }, [dateRange.from, dateRange.to])

  // 바깥 클릭 시 닫기
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  async function download(type: 'pptx' | 'excel' | 'productivity') {
    setLoading(type)
    try {
      const endpoint =
        type === 'pptx'        ? '/api/export/status-slides' :
        type === 'productivity' ? '/api/export/productivity-report' :
        '/api/export/dept-report'

      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          dept: selectedDiv || undefined,
          from: fromDate,
          to:   toDate,
        }),
      })

      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: '오류' }))
        alert(error ?? '파일 생성에 실패했습니다')
        return
      }

      const blob        = await res.blob()
      const url         = URL.createObjectURL(blob)
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match       = disposition.match(/filename\*=UTF-8''(.+)/)
      const ext         = type === 'pptx' ? '.pptx' : '.xlsx'
      const filename    = match ? decodeURIComponent(match[1]) : `근태현황${ext}`

      const a       = document.createElement('a')
      a.href        = url
      a.download    = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setOpen(false)
    } finally {
      setLoading(null)
    }
  }

  const sortedDivisions = [...divisions].sort((a, b) => a.localeCompare(b, 'ko'))

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-3 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors text-xs font-medium"
        title="현황 보고서를 슬라이드 또는 Excel로 다운로드"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
        </svg>
        현황 내보내기
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-4 flex flex-col gap-3">
          <p className="text-xs font-semibold text-gray-700">현황 내보내기</p>

          {/* 부서 선택 */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">부서</label>
            <select
              value={selectedDiv}
              onChange={e => setSelectedDiv(e.target.value)}
              className="text-xs border border-gray-200 rounded px-2 py-1.5 text-gray-700 bg-white focus:outline-none focus:border-indigo-400"
            >
              <option value="">전체 부서</option>
              {sortedDivisions.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          {/* 기간 선택 */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">기간</label>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 text-gray-700 focus:outline-none focus:border-indigo-400"
              />
              <span className="text-gray-300 text-xs shrink-0">~</span>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 text-gray-700 focus:outline-none focus:border-indigo-400"
              />
            </div>
          </div>

          {/* 다운로드 버튼 */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => download('pptx')}
              disabled={loading !== null}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading === 'pptx' ? (
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
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/>
                  </svg>
                  슬라이드
                </>
              )}
            </button>

            <button
              onClick={() => download('excel')}
              disabled={loading !== null}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {loading === 'excel' ? (
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
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                  </svg>
                  Excel
                </>
              )}
            </button>
          </div>

          <button
            onClick={() => download('productivity')}
            disabled={loading !== null}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-sky-600 text-white text-xs font-medium hover:bg-sky-700 disabled:opacity-50 transition-colors"
          >
            {loading === 'productivity' ? (
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
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14"/>
                </svg>
                근로시간 활용현황 Excel
              </>
            )}
          </button>

          <p className="text-[10px] text-gray-400 text-center leading-tight">
            슬라이드는 구글 슬라이드에서 바로 열 수 있어요
          </p>
        </div>
      )}
    </div>
  )
}
