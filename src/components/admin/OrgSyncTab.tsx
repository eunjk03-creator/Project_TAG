'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { readOrgChartWorkbook, type OrgChartTab } from '@/lib/orgSheet/readOrgChartExcel'

interface PreviewResult {
  tabName: string
  sheetTotals: Record<string, number>
  parsedRowCount: number
  warnings: string[]
  matchedCount: number
  ambiguous: {
    matchKey: string
    sheetName: string
    sheetDept: string
    candidates: { rawId: string; name: string; division: string; team: string }[]
    autoPickId: string | null
  }[]
  newHires: { name: string; division: string; team: string; title: string }[]
  possiblyResigned: { rawId: string; name: string; lastSeenSheetAt: string | null }[]
}

interface CommitResult {
  snapshotId: string
  tabName: string
  sanityPassed: boolean
  matchedCount: number
  ambiguousCount: number
  newHireCount: number
  possiblyResignedCount: number
}

interface Snapshot {
  id: string
  tabName: string
  syncedAt: string
  syncTrigger: string
  sanityPassed: boolean
}

export function OrgSyncTab() {
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [error, setError] = useState('')
  const [picks, setPicks] = useState<Record<string, string>>({}) // matchKey → 선택한 rawId

  // ── 엑셀 파일: 브라우저에서 직접 읽는다(CAPS/ERP 업로드와 동일 — 서버에 원본 파일 전송 안 함) ──
  const [tabs, setTabs] = useState<OrgChartTab[]>([])
  const [selectedTabName, setSelectedTabName] = useState('')
  const [fileName, setFileName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedTab = tabs.find(t => t.tabName === selectedTabName) ?? null

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(''); setPreview(null); setCommitResult(null)
    try {
      const buf = await file.arrayBuffer()
      const parsedTabs = readOrgChartWorkbook(buf)
      setTabs(parsedTabs)
      setSelectedTabName(parsedTabs[parsedTabs.length - 1]?.tabName ?? '') // 기본값: 마지막 시트
      setFileName(file.name)
    } catch (err) {
      setError(`엑셀 파일을 읽지 못했습니다: ${String(err)}`)
    }
  }

  const loadSnapshots = useCallback(() => {
    fetch('/api/org-sync/snapshots').then(r => r.json()).then(setSnapshots).catch(() => {})
  }, [])

  useEffect(() => { loadSnapshots() }, [loadSnapshots])

  async function runPreview() {
    if (!selectedTab) return
    setIsPreviewing(true); setError(''); setPreview(null); setCommitResult(null)
    try {
      const res = await fetch('/api/org-sync/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedTab),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? '미리보기 실패'); return }
      setPreview(data)
      const initial: Record<string, string> = {}
      for (const a of data.ambiguous ?? []) if (a.autoPickId) initial[a.matchKey] = a.autoPickId
      setPicks(initial)
    } catch (err) {
      setError(String(err))
    } finally {
      setIsPreviewing(false)
    }
  }

  async function runCommit() {
    if (!selectedTab) return
    setIsCommitting(true); setError('')
    try {
      const res = await fetch('/api/org-sync/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedTab),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? '반영 실패'); return }
      setCommitResult(data)
      loadSnapshots()
    } catch (err) {
      setError(String(err))
    } finally {
      setIsCommitting(false)
    }
  }

  async function confirmResolution(a: PreviewResult['ambiguous'][number]) {
    const resolvedRawId = picks[a.matchKey]
    if (!resolvedRawId) return
    await fetch('/api/org-sync/resolutions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchKey: a.matchKey, sheetName: a.sheetName, sheetDept: a.sheetDept, resolvedRawId }),
    })
    setPreview(p => p ? { ...p, ambiguous: p.ambiguous.filter(x => x.matchKey !== a.matchKey) } : p)
  }

  async function approveResignation(rawId: string) {
    await fetch(`/api/employee-master/${rawId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'RESIGNED', resignedDate: new Date().toISOString().slice(0, 10) }),
    })
    setPreview(p => p ? { ...p, possiblyResigned: p.possiblyResigned.filter(x => x.rawId !== rawId) } : p)
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-gray-800">조직도 동기화</h2>
        <p className="text-xs text-gray-400 mt-1">
          HR이 넘겨준 조직도 엑셀 파일(기존 Google Sheet와 동일한 박스형 조직도)을 업로드해
          CAPS 직원 목록과 매칭하고 인력 마스터(부서·직책)를 갱신합니다. 외부 API 연동 없이
          파일을 그때그때 받아서 필요할 때만 반영하는 방식입니다.
        </p>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 mb-6">
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">조직도 엑셀 파일</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            className="text-xs text-gray-600 file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border-0
              file:bg-gray-100 file:text-gray-700 file:text-xs file:font-medium hover:file:bg-gray-200"
          />
        </div>
        {tabs.length > 1 && (
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">시트(탭) 선택</label>
            <select
              value={selectedTabName}
              onChange={e => setSelectedTabName(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-[7px]"
            >
              {tabs.map(t => <option key={t.tabName} value={t.tabName}>{t.tabName}</option>)}
            </select>
          </div>
        )}
        {fileName && !error && (
          <span className="text-[11px] text-gray-400 mb-1.5">
            "{fileName}" 불러옴 · {selectedTab?.values.length ?? 0}행
          </span>
        )}
      </div>

      <div className="flex gap-2 mb-6">
        <button
          onClick={runPreview}
          disabled={isPreviewing || !selectedTab}
          className="px-4 py-1.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          {isPreviewing ? '확인 중…' : '미리보기'}
        </button>
        <button
          onClick={runCommit}
          disabled={isCommitting || !selectedTab}
          className="px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {isCommitting ? '반영 중…' : '지금 동기화'}
        </button>
      </div>

      {commitResult && (
        <div className="mb-6 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 text-xs text-emerald-800">
          <p className="font-medium">"{commitResult.tabName}" 탭 반영 완료</p>
          <p className="mt-1">
            매칭 {commitResult.matchedCount}명 · 동명이인 확인필요 {commitResult.ambiguousCount}건 ·
            신규입사자 후보 {commitResult.newHireCount}명 · 퇴사후보 {commitResult.possiblyResignedCount}명
            {!commitResult.sanityPassed && (
              <span className="ml-1 text-amber-700">
                (⚠ 시트 상단 집계와 차이 있음 — 겸임 표기 등으로 정상일 수 있으니 아래 미리보기에서 확인)
              </span>
            )}
          </p>
        </div>
      )}

      {preview && (
        <div className="space-y-5">
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600">
            <p>탭: <strong>{preview.tabName}</strong> · 파싱된 인원 {preview.parsedRowCount}명 · 자동매칭 {preview.matchedCount}명</p>
            <p className="mt-1 text-gray-400">
              시트 상단 신고: {Object.entries(preview.sheetTotals).map(([k, v]) => `${k} ${v}`).join(' · ')}
            </p>
            {preview.warnings.length > 0 && (
              <p className="mt-1 text-amber-600">경고 {preview.warnings.length}건: {preview.warnings[0]}</p>
            )}
          </div>

          {preview.ambiguous.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">동명이인 확인 ({preview.ambiguous.length}건)</p>
              <ul className="space-y-1.5">
                {preview.ambiguous.map(a => (
                  <li key={a.matchKey} className="flex flex-col gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-700">
                      <strong>{a.sheetName}</strong> — {a.sheetDept}
                    </span>
                    <div className="flex items-center gap-2">
                      <select
                        value={picks[a.matchKey] ?? ''}
                        onChange={e => setPicks(p => ({ ...p, [a.matchKey]: e.target.value }))}
                        className="text-xs border border-gray-200 rounded-lg px-2 py-1"
                      >
                        <option value="">선택 안 함</option>
                        {a.candidates.map(c => (
                          <option key={c.rawId} value={c.rawId}>
                            {c.name} ({c.division}/{c.team}, {c.rawId})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => confirmResolution(a)}
                        disabled={!picks[a.matchKey]}
                        className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40"
                      >
                        확정
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.newHires.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">신규입사자 후보 ({preview.newHires.length}명, 참고용)</p>
              <p className="text-[11px] text-gray-400 mb-1.5">
                시트엔 있지만 아직 CAPS에 없는 사람 — 다음 CAPS 업로드에서 자동으로 매칭됩니다.
              </p>
              <ul className="space-y-1">
                {preview.newHires.map((n, i) => (
                  <li key={i} className="text-xs text-gray-600 px-3 py-1.5 bg-gray-50 rounded-lg">
                    {n.name} — {n.division}/{n.team} ({n.title})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.possiblyResigned.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">퇴사 후보 ({preview.possiblyResigned.length}명)</p>
              <p className="text-[11px] text-gray-400 mb-1.5">
                마스터엔 재직중인데 최신 시트에 없는 사람 — 급여에 영향을 주므로 확인 후 승인하세요.
              </p>
              <ul className="space-y-1.5">
                {preview.possiblyResigned.map(r => (
                  <li key={r.rawId} className="flex items-center justify-between text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <span>{r.name} ({r.rawId})</span>
                    <button
                      onClick={() => approveResignation(r.rawId)}
                      className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-300 rounded-lg hover:bg-red-100"
                    >
                      퇴사 승인
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {snapshots.length > 0 && (
        <div className="mt-8">
          <p className="text-xs font-semibold text-gray-700 mb-2">최근 동기화 이력</p>
          <ul className="text-xs text-gray-500 space-y-1">
            {snapshots.map(s => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg">
                <span className="font-medium text-gray-700">{s.tabName}</span>
                <span>{new Date(s.syncedAt).toLocaleString('ko-KR')}</span>
                <span className="text-gray-400">({s.syncTrigger === 'cron' ? '자동' : '수동'})</span>
                {!s.sanityPassed && <span className="text-amber-600">⚠ 집계 불일치</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
