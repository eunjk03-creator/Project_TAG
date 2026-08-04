'use client'
import { useState, useEffect } from 'react'
import { useSlack, type SlackConfig } from '@/context/SlackContext'
import { usePolicy } from '@/context/PolicyContext'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { matchEmployeesToSlackUsers, type SlackUserLite, type MatchResult } from '@/utils/slackUserMatch'
import { PaginationBar } from './PaginationBar'

const MAPPINGS_PAGE_SIZE   = 20
const EXCEPTIONS_PAGE_SIZE = 25

interface SavedMapping {
  employeeId: string; employeeName: string
  slackUserId: string; slackName: string; matchedBy: string
}

export function SlackIntegrationTab() {
  const {
    config, setConfig,
    exceptions, ambiguousMatches,
    isLoading, lastSynced, syncedRange, error,
    fetchAndParse, clearExceptions, saveNameResolution,
  } = useSlack()
  const { policy, setPolicy } = usePolicy()
  const { employees } = useAttendanceSource()

  const [draft, setDraft] = useState<SlackConfig>({ ...config })
  const [groupIdInput,  setGroupIdInput]  = useState('')
  const [groupDivInput, setGroupDivInput] = useState('')

  // ── 동명이인 확인 (OOO 메시지 파싱 결과) ────────────────────────────────
  // key(match.key) → 관리자가 드롭다운에서 고른 empId. 초기값은 저장된/자동판별 결과.
  const [nameResPick, setNameResPick] = useState<Record<string, string>>({})

  // ── 직원 ↔ Slack 개인계정 매칭 ─────────────────────────────────────────
  const [savedMappings,  setSavedMappings]  = useState<SavedMapping[]>([])
  const [matchResult,    setMatchResult]    = useState<MatchResult | null>(null)
  const [isMatching,     setIsMatching]     = useState(false)
  const [matchError,     setMatchError]     = useState('')
  const [manualPick,     setManualPick]     = useState<Record<string, string>>({}) // employeeId → slackUserId ('__manual__' = 직접입력)
  const [manualIdText,   setManualIdText]   = useState<Record<string, string>>({}) // employeeId → 직접 입력한 ID (U... 또는 D...)
  const [unmatchedIdText, setUnmatchedIdText] = useState<Record<string, string>>({}) // 미매칭 직원용 직접입력

  const [mapPage, setMapPage] = useState(0)
  const [excPage, setExcPage] = useState(0)

  const mapPageCount = Math.max(1, Math.ceil(savedMappings.length / MAPPINGS_PAGE_SIZE))
  const mapSafePage  = Math.min(mapPage, mapPageCount - 1)
  const pageMappings = savedMappings.slice(mapSafePage * MAPPINGS_PAGE_SIZE, mapSafePage * MAPPINGS_PAGE_SIZE + MAPPINGS_PAGE_SIZE)

  const excPageCount   = Math.max(1, Math.ceil(exceptions.length / EXCEPTIONS_PAGE_SIZE))
  const excSafePage    = Math.min(excPage, excPageCount - 1)
  const pageExceptions = exceptions.slice(excSafePage * EXCEPTIONS_PAGE_SIZE, excSafePage * EXCEPTIONS_PAGE_SIZE + EXCEPTIONS_PAGE_SIZE)

  useEffect(() => {
    fetch('/api/slack/user-mappings').then(r => r.json()).then(setSavedMappings).catch(() => {})
  }, [])

  async function handleMatchUsers() {
    setIsMatching(true); setMatchError(''); setMatchResult(null)
    try {
      const res  = await fetch('/api/slack/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: draft.token }),
      })
      const data = await res.json() as { ok: boolean; error?: string; users?: SlackUserLite[] }
      if (!data.ok || !data.users) { setMatchError(data.error ?? '매칭 실패'); return }
      const alreadyMapped = new Set(savedMappings.map(m => m.employeeId))
      const targets = employees.filter(e => !alreadyMapped.has(e.id))
      setMatchResult(matchEmployeesToSlackUsers(targets, data.users))
    } catch (err) {
      setMatchError(String(err))
    } finally {
      setIsMatching(false)
    }
  }

  async function saveMappings(mappings: { employeeId: string; employeeName: string; slackUserId: string; slackName?: string; matchedBy: string }[]) {
    if (!mappings.length) return
    const res = await fetch('/api/slack/user-mappings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mappings }),
    })
    if (res.ok) {
      const fresh = await fetch('/api/slack/user-mappings').then(r => r.json())
      setSavedMappings(fresh)
    }
  }

  async function deleteMapping(employeeId: string) {
    await fetch('/api/slack/user-mappings', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [employeeId] }),
    })
    setSavedMappings(prev => prev.filter(m => m.employeeId !== employeeId))
  }

  const isDirty = JSON.stringify(draft) !== JSON.stringify(config)

  function patch(partial: Partial<SlackConfig>) {
    setDraft(prev => ({ ...prev, ...partial }))
  }

  function addGroupMapping() {
    const id  = groupIdInput.trim()
    const div = groupDivInput.trim()
    if (!id || !div) return
    setPolicy({ ...policy, slackGroupMap: { ...(policy.slackGroupMap ?? {}), [id]: div } })
    setGroupIdInput(''); setGroupDivInput('')
  }

  function removeGroupMapping(id: string) {
    const next = { ...(policy.slackGroupMap ?? {}) }
    delete next[id]
    setPolicy({ ...policy, slackGroupMap: next })
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

      {/* ── 직원 ↔ Slack 개인계정 매칭 (DM 발송용) ── */}
      <div>
        <h2 className="text-base font-semibold text-gray-800">직원 ↔ Slack 계정 매칭</h2>
        <p className="text-xs text-gray-400 mt-1">
          테이블에서 &quot;미상신 연차 알림&quot;을 개인 DM으로 보내려면, 먼저 직원과 Slack 계정을 연결해야 합니다.
          이름이 유니크하게 하나의 계정과만 일치하면 자동으로 연결하고, 동명이인 등으로 애매하면 직접 골라주세요.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">
            연결됨 <span className="font-semibold text-gray-700">{savedMappings.length}</span>명
          </span>
          <button
            onClick={handleMatchUsers}
            disabled={isMatching || !draft.token || employees.length === 0}
            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg
              hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isMatching ? '매칭 중…' : '나머지 직원 자동매칭 시도'}
          </button>
        </div>

        {matchError && <p className="text-xs text-red-500">{matchError}</p>}

        {matchResult && (
          <div className="space-y-3 pt-1 border-t border-gray-100">
            <p className="text-[11px] text-gray-500">
              자동매칭 <span className="font-semibold text-emerald-600">{matchResult.matched.length}</span>명 ·
              확인필요 <span className="font-semibold text-amber-600">{matchResult.ambiguous.length}</span>명 ·
              미매칭 <span className="font-semibold text-gray-500">{matchResult.unmatched.length}</span>명
            </p>

            {matchResult.matched.length > 0 && (
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <span className="text-xs text-emerald-700">
                  {matchResult.matched.map(m => m.employeeName).join(', ')}
                </span>
                <button
                  onClick={() => saveMappings(matchResult.matched.map(m => ({ ...m, matchedBy: 'auto' })))}
                  className="shrink-0 ml-3 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-white border border-emerald-300 rounded-md hover:bg-emerald-100 transition-colors"
                >
                  전체 저장
                </button>
              </div>
            )}

            {matchResult.ambiguous.length > 0 && (
              <ul className="space-y-1.5">
                {matchResult.ambiguous.map(a => {
                  const isManual = manualPick[a.employeeId] === '__manual__'
                  const resolvedId = isManual ? (manualIdText[a.employeeId] ?? '').trim() : manualPick[a.employeeId]
                  return (
                    <li key={a.employeeId} className="flex flex-col gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-amber-800 w-24 shrink-0 truncate">{a.employeeName}</span>
                        <select
                          value={manualPick[a.employeeId] ?? ''}
                          onChange={e => setManualPick(prev => ({ ...prev, [a.employeeId]: e.target.value }))}
                          className="flex-1 text-xs border border-amber-300 rounded-md px-2 py-1 bg-white"
                        >
                          <option value="">계정 선택…</option>
                          {a.candidates.map(c => (
                            <option key={c.slackUserId} value={c.slackUserId}>{c.slackName} ({c.slackUserId})</option>
                          ))}
                          <option value="__manual__">직접 입력 (DM/User ID)…</option>
                        </select>
                        <button
                          disabled={!resolvedId}
                          onClick={() => {
                            const cand = a.candidates.find(c => c.slackUserId === resolvedId)
                            saveMappings([{ employeeId: a.employeeId, employeeName: a.employeeName, slackUserId: resolvedId, slackName: cand?.slackName, matchedBy: 'manual' }])
                          }}
                          className="shrink-0 px-2.5 py-1 text-[11px] font-semibold text-amber-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 disabled:opacity-40 transition-colors"
                        >
                          저장
                        </button>
                      </div>
                      {isManual && (
                        <input
                          type="text"
                          placeholder="예: D0BHL8MDQTA 또는 U09CFA51XTM"
                          value={manualIdText[a.employeeId] ?? ''}
                          onChange={e => setManualIdText(prev => ({ ...prev, [a.employeeId]: e.target.value }))}
                          className="text-xs font-mono border border-amber-300 rounded-md px-2 py-1 bg-white"
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {matchResult.unmatched.length > 0 && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 space-y-1.5">
                <p className="text-[11px] text-gray-500">
                  Slack에서 이름이 안 잡힌 직원 — 닉네임이 다르면 직접 ID를 찾아서 입력하세요:
                </p>
                <ul className="space-y-1.5">
                  {matchResult.unmatched.map(u => (
                    <li key={u.employeeId} className="flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-700 w-24 shrink-0 truncate">{u.employeeName}</span>
                      <input
                        type="text"
                        placeholder="예: D0BHL8MDQTA 또는 U09CFA51XTM"
                        value={unmatchedIdText[u.employeeId] ?? ''}
                        onChange={e => setUnmatchedIdText(prev => ({ ...prev, [u.employeeId]: e.target.value }))}
                        className="flex-1 text-xs font-mono border border-gray-300 rounded-md px-2 py-1 bg-white"
                      />
                      <button
                        disabled={!(unmatchedIdText[u.employeeId] ?? '').trim()}
                        onClick={() => saveMappings([{
                          employeeId: u.employeeId, employeeName: u.employeeName,
                          slackUserId: (unmatchedIdText[u.employeeId] ?? '').trim(), matchedBy: 'manual',
                        }])}
                        className="shrink-0 px-2.5 py-1 text-[11px] font-semibold text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 transition-colors"
                      >
                        저장
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {savedMappings.length > 0 && (
          <div className="pt-1 border-t border-gray-100 -mx-4">
            <ul className="space-y-1 px-4">
              {pageMappings.map(m => (
                <li key={m.employeeId} className="flex items-center justify-between px-3 py-1.5 hover:bg-gray-50 rounded-lg">
                  <span className="text-xs text-gray-700">
                    {m.employeeName}
                    <span className="text-gray-400 ml-2">→ {m.slackName || m.slackUserId}</span>
                    <span className="text-[10px] text-gray-300 ml-2">({m.matchedBy === 'auto' ? '자동' : '수동'})</span>
                  </span>
                  <button
                    onClick={() => deleteMapping(m.employeeId)}
                    className="text-[11px] text-red-400 hover:text-red-600 transition-colors"
                  >
                    삭제
                  </button>
                </li>
              ))}
            </ul>
            <PaginationBar
              page={mapSafePage}
              pageCount={mapPageCount}
              onPageChange={setMapPage}
              startItem={mapSafePage * MAPPINGS_PAGE_SIZE + 1}
              endItem={Math.min((mapSafePage + 1) * MAPPINGS_PAGE_SIZE, savedMappings.length)}
              totalCount={savedMappings.length}
              unit="명"
            />
          </div>
        )}
      </div>

      {/* ── Slack Group Map (동명이인 부서 구분) ── */}
      <div>
        <h2 className="text-base font-semibold text-gray-800">동명이인 부서 구분</h2>
        <p className="text-xs text-gray-400 mt-1">
          Slack 메시지의 <code className="bg-gray-100 px-1 rounded text-[11px]">@그룹멘션</code>이
          {' '}<code className="bg-gray-100 px-1 rounded text-[11px]">&lt;subteam^ID&gt;</code> 형식으로 변환됩니다.
          아래에 ID → 부서명 매핑을 등록하면 동명이인 구분에 활용됩니다.
        </p>
        <p className="text-[11px] text-blue-500 mt-1">
          콘솔 경고 예시: <code>부서 컨텍스트로도 구분 불가 (deptMatches=0)</code> → 메시지에서 subteam ID 복사 후 등록
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        {/* Add row */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-[11px] text-gray-400 mb-1">Subteam ID</label>
            <input
              type="text"
              placeholder="예: S0GQJ67UBA9"
              value={groupIdInput}
              onChange={e => setGroupIdInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addGroupMapping()}
              className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] text-gray-400 mb-1">부서명 (Employee.division 포함 문자열)</label>
            <input
              type="text"
              placeholder="예: 뷰티사업부문"
              value={groupDivInput}
              onChange={e => setGroupDivInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addGroupMapping()}
              className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg
                focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={addGroupMapping}
            disabled={!groupIdInput.trim() || !groupDivInput.trim()}
            className="px-4 py-1.5 text-sm font-semibold bg-blue-600 text-white rounded-lg
              hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            추가
          </button>
        </div>

        {/* Existing mappings */}
        {Object.keys(policy.slackGroupMap ?? {}).length === 0 ? (
          <p className="text-xs text-gray-300 text-center py-3">등록된 매핑이 없습니다.</p>
        ) : (
          <ul className="space-y-1.5">
            {Object.entries(policy.slackGroupMap ?? {}).map(([id, div]) => (
              <li key={id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                <div className="flex items-center gap-3">
                  <code className="text-xs font-mono text-blue-700 bg-blue-50 px-2 py-0.5 rounded">{id}</code>
                  <span className="text-gray-400 text-xs">→</span>
                  <span className="text-xs font-medium text-gray-700">{div}</span>
                </div>
                <button
                  onClick={() => removeGroupMapping(id)}
                  className="text-xs text-red-400 hover:text-red-600 transition-colors"
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
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

      {/* ── 동명이인 확인 (OOO 메시지 파싱) ── */}
      {ambiguousMatches.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-1">
            동명이인 확인 — {ambiguousMatches.length}건
          </h3>
          <p className="text-xs text-gray-400 mb-3">
            같은 이름의 직원이 여러 명이라 자동판별한 결과입니다. 자동판별도 틀릴 수 있으니 확인 후
            맞는 직원을 골라 저장해 주세요 — 저장한 선택은 다음 재동기화에도 유지됩니다.
          </p>
          <ul className="space-y-2">
            {ambiguousMatches.map(m => {
              const picked = nameResPick[m.key] ?? m.resolvedId ?? ''
              const badge = m.isConfirmed
                ? { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: '✓ 확인됨' }
                : m.autoPickId
                ? { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: '자동판별 (미확인)' }
                : { cls: 'bg-red-50 text-red-700 border-red-200', label: '미해결' }
              return (
                <li key={m.key} className="bg-white border border-gray-200 rounded-xl px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-800">{m.empName}</span>
                    <span className="text-[11px] text-gray-400 tabular-nums">
                      {m.dates.length > 1 ? `${m.dates[0]} ~ ${m.dates[m.dates.length - 1]}` : m.dates[0]}
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      {m.note}
                    </span>
                    <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 truncate" title={m.rawText}>
                    {m.rawText.length > 80 ? m.rawText.slice(0, 80) + '…' : m.rawText}
                  </p>
                  <div className="flex items-center gap-2">
                    <select
                      value={picked}
                      onChange={e => setNameResPick(prev => ({ ...prev, [m.key]: e.target.value }))}
                      className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white"
                    >
                      <option value="">직원 선택…</option>
                      {m.candidates.map(c => (
                        <option key={c.empId} value={c.empId}>
                          {c.empName} — {c.division}{c.team && c.team !== c.division ? ` / ${c.team}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={!picked}
                      onClick={() => {
                        const cand = m.candidates.find(c => c.empId === picked)
                        if (cand) saveNameResolution(m, cand.empId, cand.empName)
                      }}
                      className="shrink-0 px-3 py-1.5 text-xs font-semibold text-blue-600 bg-white
                        border border-blue-200 rounded-md hover:bg-blue-50 disabled:opacity-40
                        disabled:cursor-not-allowed transition-colors"
                    >
                      저장
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

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
                {pageExceptions.map((ex, i) => (
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
            <PaginationBar
              page={excSafePage}
              pageCount={excPageCount}
              onPageChange={setExcPage}
              startItem={excSafePage * EXCEPTIONS_PAGE_SIZE + 1}
              endItem={Math.min((excSafePage + 1) * EXCEPTIONS_PAGE_SIZE, exceptions.length)}
              totalCount={exceptions.length}
            />
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
