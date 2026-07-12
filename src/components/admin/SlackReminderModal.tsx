'use client'
import { useEffect, useMemo, useState } from 'react'
import type { ProcessedRecord } from '@/types/tag'

type Props = {
  records:    ProcessedRecord[]   // 선택된 레코드 (ERP 미신청 여부 무관하게 넘어와도 됨 — 내부에서 필터)
  slackToken: string
  onClose:    () => void
}

interface SavedMapping {
  employeeId: string; employeeName: string
  slackUserId: string; slackName: string; matchedBy: string
}

interface PersonDraft {
  employeeId:   string
  employeeName: string
  dates:        { date: string; leaveType: string }[]
  slackUserId:  string | null
  text:         string
}

function buildMessage(greeting: string, dates: { date: string; leaveType: string }[]): string {
  const months = new Set(dates.map(d => Number(d.date.slice(5, 7))))
  const monthLabel = months.size === 1 ? `${[...months][0]}월 ` : ''
  const lines = dates
    .slice().sort((a, b) => a.date.localeCompare(b.date))
    .map(d => `${Number(d.date.slice(5, 7))}월 ${Number(d.date.slice(8, 10))}일 ${d.leaveType}`)
  return `${greeting}\n\n${monthLabel}미상신 연차 금일 중 상신 부탁 드립니다 :bow:\n\n${lines.join('\n')}`
}

export function SlackReminderModal({ records, slackToken, onClose }: Props) {
  const [mappings, setMappings]   = useState<SavedMapping[]>([])
  const [greeting, setGreeting]   = useState('안녕하세요, 인사기획팀입니다.')
  const [drafts,   setDrafts]     = useState<PersonDraft[]>([])
  const [sending,  setSending]    = useState(false)
  const [results,  setResults]    = useState<Record<string, 'ok' | 'fail'> | null>(null)

  const targets = useMemo(() => {
    // ERP 미신청(Slack 공유만 확인된) 연차/반차/반반차 건만 대상
    const isUnsubmitted = (r: ProcessedRecord) =>
      !!r.leaveType && (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
    const byEmp = new Map<string, { employeeName: string; dates: { date: string; leaveType: string }[] }>()
    for (const r of records) {
      if (!isUnsubmitted(r)) continue
      const bucket = byEmp.get(r.employeeId) ?? { employeeName: r.employeeId.split('_')[1] ?? r.employeeId, dates: [] }
      bucket.dates.push({ date: r.date, leaveType: r.leaveType! })
      byEmp.set(r.employeeId, bucket)
    }
    return byEmp
  }, [records])

  useEffect(() => {
    fetch('/api/slack/user-mappings').then(r => r.json()).then(setMappings).catch(() => {})
  }, [])

  useEffect(() => {
    const mapByEmp = new Map(mappings.map(m => [m.employeeId, m.slackUserId]))
    const next: PersonDraft[] = []
    for (const [employeeId, info] of targets) {
      next.push({
        employeeId, employeeName: info.employeeName, dates: info.dates,
        slackUserId: mapByEmp.get(employeeId) ?? null,
        text: buildMessage(greeting, info.dates),
      })
    }
    setDrafts(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, mappings])

  function updateGreetingAll(g: string) {
    setGreeting(g)
    setDrafts(prev => prev.map(d => ({ ...d, text: buildMessage(g, d.dates) })))
  }

  function updateText(employeeId: string, text: string) {
    setDrafts(prev => prev.map(d => d.employeeId === employeeId ? { ...d, text } : d))
  }

  const sendable = drafts.filter(d => d.slackUserId)
  const unsendable = drafts.filter(d => !d.slackUserId)

  async function handleSend() {
    if (!sendable.length) return
    setSending(true)
    try {
      const res = await fetch('/api/slack/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: slackToken,
          items: sendable.map(d => ({ slackUserId: d.slackUserId, text: d.text })),
        }),
      })
      const data = await res.json() as { ok: boolean; results?: { slackUserId: string; ok: boolean }[] }
      const byUser = new Map((data.results ?? []).map(r => [r.slackUserId, r.ok]))
      const next: Record<string, 'ok' | 'fail'> = {}
      for (const d of sendable) next[d.employeeId] = byUser.get(d.slackUserId!) ? 'ok' : 'fail'
      setResults(next)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">미상신 연차 알림 발송</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="px-6 py-3 border-b border-gray-100">
          <label className="block text-[11px] text-gray-400 mb-1">인사말 (전체 메시지 앞부분에 공통 적용)</label>
          <input
            type="text"
            value={greeting}
            onChange={e => updateGreetingAll(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {drafts.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">
              선택한 항목 중 ERP 미신청(Slack 공유만 확인된) 연차/반차/반반차가 없습니다.
            </p>
          )}

          {sendable.map(d => (
            <div key={d.employeeId} className="border border-gray-200 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-800">{d.employeeName}</span>
                {results && (
                  <span className={`text-[11px] font-semibold ${results[d.employeeId] === 'ok' ? 'text-emerald-600' : 'text-red-500'}`}>
                    {results[d.employeeId] === 'ok' ? '✓ 발송됨' : '✗ 실패'}
                  </span>
                )}
              </div>
              <textarea
                value={d.text}
                onChange={e => updateText(d.employeeId, e.target.value)}
                rows={5}
                className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 whitespace-pre-wrap"
              />
            </div>
          ))}

          {unsendable.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-amber-700 mb-1">
                Slack 계정이 연결 안 돼서 발송 불가 ({unsendable.length}명)
              </p>
              <p className="text-[11px] text-amber-600">
                {unsendable.map(d => d.employeeName).join(', ')} — Settings &gt; 슬랙 연동 탭에서 먼저 계정을 연결해주세요.
              </p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">닫기</button>
          <button
            onClick={handleSend}
            disabled={sending || sendable.length === 0}
            className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? '발송 중…' : `${sendable.length}명에게 발송`}
          </button>
        </div>
      </div>
    </div>
  )
}
