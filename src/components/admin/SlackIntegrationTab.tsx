'use client'
import { useState } from 'react'
import { useSlack, type SlackConfig } from '@/context/SlackContext'

export function SlackIntegrationTab() {
  const {
    config, setConfig,
    exceptions,
    isLoading, lastSynced, syncedRange, error,
    fetchAndParse, clearExceptions,
  } = useSlack()

  const [draft, setDraft] = useState<SlackConfig>({ ...config })

  const isDirty = JSON.stringify(draft) !== JSON.stringify(config)

  function patch(partial: Partial<SlackConfig>) {
    setDraft(prev => ({ ...prev, ...partial }))
  }

  function handleSync() {
    if (isDirty) setConfig(draft)
    fetchAndParse()
  }

  const dateRangeValid = !!draft.startDate && !!draft.endDate && draft.startDate <= draft.endDate
  const canSync = !!draft.token && !!draft.channelId && dateRangeValid

  return (
    <div className="space-y-6 max-w-2xl">

      <div>
        <h2 className="text-base font-semibold text-gray-800">슬랙 연동</h2>
        <p className="text-xs text-gray-400 mt-1">
          슬랙 OOO 채널에서 외근·반차 메시지를 가져와 근태 이상을 자동 해소합니다.
          기간 내 메시지를 모두 조회하여 날짜·이름 기반으로 파싱합니다.
        </p>
      </div>

      {/* ── Config form ── */}
      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">

        {/* Token */}
        <div className="px-5 py-4 flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0 pt-0.5">
            <span className="text-sm font-medium text-gray-800">Bot User OAuth Token</span>
            <p className="text-xs text-gray-400 mt-1">
              Slack App의{' '}
              <code className="bg-gray-100 px-1 rounded text-[11px]">xoxb-</code>로
              시작하는 봇 토큰
            </p>
          </div>
          <input
            type="password"
            placeholder="xoxb-…"
            value={draft.token}
            onChange={e => patch({ token: e.target.value })}
            className="w-56 px-3 py-1.5 text-sm border border-gray-200 rounded-lg
              focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>

        {/* Channel ID */}
        <div className="px-5 py-4 flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0 pt-0.5">
            <span className="text-sm font-medium text-gray-800">채널 ID</span>
            <p className="text-xs text-gray-400 mt-1">
              채널명이 아닌 채널 ID (예:{' '}
              <code className="bg-gray-100 px-1 rounded text-[11px]">C0XXXXXXXX</code>)
            </p>
          </div>
          <input
            type="text"
            placeholder="C0XXXXXXXX"
            value={draft.channelId}
            onChange={e => patch({ channelId: e.target.value })}
            className="w-56 px-3 py-1.5 text-sm border border-gray-200 rounded-lg
              focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>

        {/* Date range */}
        <div className="px-5 py-4 flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0 pt-0.5">
            <span className="text-sm font-medium text-gray-800">조회 기간</span>
            <p className="text-xs text-gray-400 mt-1">
              메시지를 가져올 기간입니다. 이전 달 초 ~ 오늘로 기본 설정됩니다.
              <br />
              4월 말 공유된 5월 근태 메시지도 이 범위 안에 포함됩니다.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="date"
              value={draft.startDate}
              onChange={e => patch({ startDate: e.target.value })}
              className="w-36 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-gray-400 text-sm">~</span>
            <input
              type="date"
              value={draft.endDate}
              onChange={e => patch({ endDate: e.target.value })}
              className="w-36 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        {!dateRangeValid && draft.startDate && draft.endDate && (
          <p className="px-5 pb-3 text-xs text-red-500">시작일이 종료일보다 늦습니다</p>
        )}

        {/* Status + Actions row */}
        <div className="px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            {syncedRange && (
              <span className="text-[11px] text-gray-500">
                조회 범위:{' '}
                <span className="font-medium text-gray-700">
                  {syncedRange.start} ~ {syncedRange.end}
                </span>
              </span>
            )}
            {lastSynced && (
              <span className="text-[11px] text-gray-400">
                동기화 시각: <span className="font-medium text-gray-600">{lastSynced}</span>
              </span>
            )}
            {exceptions.length > 0 && (
              <span className="text-[11px] font-semibold text-emerald-600">
                ✅ {exceptions.length}건 적용 중
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {exceptions.length > 0 && (
              <button
                onClick={clearExceptions}
                className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg
                  hover:bg-gray-50 transition-colors"
              >
                초기화
              </button>
            )}
            {isDirty && (
              <button
                onClick={() => setConfig(draft)}
                className="px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200
                  rounded-lg hover:bg-blue-50 transition-colors"
              >
                설정 저장
              </button>
            )}
            <button
              onClick={handleSync}
              disabled={isLoading || !canSync}
              className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium text-white
                bg-blue-600 rounded-lg hover:bg-blue-700
                disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? (
                <>
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  조회 중…
                </>
              ) : '슬랙 동기화'}
            </button>
          </div>
        </div>

        {isLoading && (
          <p className="px-5 pb-4 text-xs text-blue-500">
            메시지를 페이지 단위로 가져오는 중입니다. 기간이 길수록 더 오래 걸릴 수 있습니다.
          </p>
        )}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-3">
          <p className="text-sm font-semibold text-red-700">오류 발생</p>
          <p className="text-xs text-red-500 mt-1">{error}</p>
        </div>
      )}

      {/* ── How-to hint ── */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3">
        <p className="text-xs font-semibold text-amber-700 mb-1">인식 패턴 안내</p>
        <ul className="text-[11px] text-amber-700 space-y-0.5 list-disc list-inside">
          <li>날짜: <code className="bg-amber-100 px-1 rounded">M/D(요일)</code> 형식 (예: 5/6(화)) — 메시지 발송일과 무관하게 이 날짜로 처리</li>
          <li>반차: <strong>반차</strong>, <strong>오전반차</strong>, <strong>오후반차</strong></li>
          <li>반반차: <strong>반반차</strong>, <strong>빈반차</strong>, <strong>반휴</strong></li>
          <li>외근·행사: <strong>미팅</strong>, <strong>외근</strong>, <strong>직출</strong>, <strong>행사 참석</strong></li>
          <li>이름: 마스킹된 이름 패턴 자동 매칭 (예: <code className="bg-amber-100 px-1 rounded">기*미</code>)</li>
        </ul>
      </div>

      {/* ── Results table ── */}
      {exceptions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            파싱 결과 — {exceptions.length}건
          </h3>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-500">직원</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-500">날짜</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-500">구분</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-500">원문</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {exceptions.map((ex, i) => (
                  <tr key={i} className="hover:bg-gray-50/70 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-gray-800">
                      {ex.empName}
                      <span className="ml-1.5 text-[10px] text-gray-400 font-normal">{ex.empId}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 tabular-nums">{ex.date}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold
                        bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {ex.note}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 max-w-xs truncate" title={ex.rawText}>
                      {ex.rawText.length > 50 ? ex.rawText.slice(0, 50) + '…' : ex.rawText}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!isLoading && exceptions.length === 0 && lastSynced && (
        <div className="flex flex-col items-center justify-center h-28 bg-gray-50 rounded-xl
          border border-dashed border-gray-200 gap-2">
          <p className="text-sm text-gray-500">마지막 동기화에서 매칭된 항목이 없습니다</p>
          <p className="text-xs text-gray-400">
            채널 ID, 기간, 직원 이름 마스킹 패턴을 확인해 주세요
          </p>
        </div>
      )}
    </div>
  )
}
