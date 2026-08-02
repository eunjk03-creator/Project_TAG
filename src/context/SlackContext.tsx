'use client'
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react'
import type { SlackException, SlackAmbiguousMatch } from '@/utils/slackApi'
import { fetchSlackMessages, parseSlackExceptions } from '@/utils/slackApi'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { usePolicy } from '@/context/PolicyContext'

// ── Types ─────────────────────────────────────────────────────────────────

export interface SlackConfig {
  token:     string
  channelId: string
  startDate: string  // YYYY-MM-DD  (message fetch window start)
  endDate:   string  // YYYY-MM-DD  (message fetch window end)
}

export interface SyncedRange {
  start: string   // YYYY-MM-DD
  end:   string   // YYYY-MM-DD
}

interface SlackContextValue {
  config:          SlackConfig
  setConfig:       (c: SlackConfig) => void
  exceptions:      SlackException[]
  slackNoteMap:    Map<string, { note: string; rawText: string }[]>
  ambiguousMatches: SlackAmbiguousMatch[]
  isLoading:       boolean
  lastSynced:      string | null       // human-readable timestamp
  syncedRange:     SyncedRange | null  // machine-readable range that was last synced
  error:           string | null
  fetchAndParse:   () => Promise<void>
  clearExceptions: () => void
  /** Admin picks (or overrides) which employee an ambiguous 동명이인 match belongs to. */
  saveNameResolution: (match: SlackAmbiguousMatch, empId: string, empName: string) => Promise<void>
}

// ── Defaults ──────────────────────────────────────────────────────────────

function localDateStr(d: Date): string {
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

const _now   = new Date()
const _prevM = new Date(_now.getFullYear(), _now.getMonth() - 1, 1)

const DEFAULT_CONFIG: SlackConfig = {
  token:     '',
  channelId: '',
  startDate: localDateStr(_prevM),
  endDate:   localDateStr(_now),
}

// ── LocalStorage keys ─────────────────────────────────────────────────────

const LS_CONFIG      = 'tag_slack_config'
const LS_EXCEPTIONS  = 'tag_slack_exceptions'
const LS_LAST_SYNC   = 'tag_slack_last_sync'
const LS_SYNCED_RANGE = 'tag_slack_synced_range'

function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

// ── Context ───────────────────────────────────────────────────────────────

const SlackContext = createContext<SlackContextValue | null>(null)

export function SlackProvider({ children }: { children: ReactNode }) {
  const { employees, recomputeProcessed, isLiveData } = useAttendanceSource()
  const { policy } = usePolicy()

  const [config,      setConfigState] = useState<SlackConfig>(
    () => {
      const saved = loadLS<Partial<SlackConfig>>(LS_CONFIG, {})
      // Migrate legacy config that has year/month instead of startDate/endDate
      if ('startDate' in saved && 'endDate' in saved) {
        return { ...DEFAULT_CONFIG, ...saved } as SlackConfig
      }
      return { ...DEFAULT_CONFIG, token: saved.token ?? '', channelId: saved.channelId ?? '' }
    },
  )
  const [exceptions,  setExceptions]  = useState<SlackException[]>(
    () => loadLS<SlackException[]>(LS_EXCEPTIONS, []),
  )
  const [ambiguousMatches, setAmbiguousMatches] = useState<SlackAmbiguousMatch[]>([])
  // msgKey(`${ts}::${empName}`) → 관리자가 확정한 empId. 새로고침해도 남아있어야 하므로 DB에서 로드.
  const [nameResolutions, setNameResolutions] = useState<Record<string, string>>({})

  // 마운트 시 DB에서 공유 Slack 예외 로드 (다른 사용자가 동기화한 데이터 반영)
  useEffect(() => {
    fetch('/api/slack/exceptions')
      .then(r => r.json())
      .then((rows: SlackException[]) => {
        if (rows.length > 0) {
          setExceptions(rows)
          try { localStorage.setItem(LS_EXCEPTIONS, JSON.stringify(rows)) } catch { localStorage.removeItem(LS_EXCEPTIONS) }
        }
      })
      .catch(() => {})
  }, [])

  // 마운트 시 동명이인 수동 확정 내역 로드 — 다음 파싱부터 바로 반영되도록
  useEffect(() => {
    fetch('/api/slack/name-resolutions')
      .then(r => r.json())
      .then((rows: { msgKey: string; empId: string }[]) => {
        setNameResolutions(Object.fromEntries(rows.map(r => [r.msgKey, r.empId])))
      })
      .catch(() => {})
  }, [])
  const [isLoading,   setIsLoading]   = useState(false)
  const [lastSynced,  setLastSynced]  = useState<string | null>(
    () => loadLS<string | null>(LS_LAST_SYNC, null),
  )
  const [syncedRange, setSyncedRange] = useState<SyncedRange | null>(
    () => loadLS<SyncedRange | null>(LS_SYNCED_RANGE, null),
  )
  const [error, setError] = useState<string | null>(null)

  function setConfig(c: SlackConfig) {
    setConfigState(c)
    localStorage.setItem(LS_CONFIG, JSON.stringify(c))
  }

  const slackNoteMap = useMemo(() => {
    const map = new Map<string, { note: string; rawText: string }[]>()
    for (const ex of exceptions) {
      const key = `${ex.empId}_${ex.date}`
      const arr = map.get(key) ?? []
      arr.push({ note: ex.note, rawText: ex.rawText })
      map.set(key, arr)
    }
    if (map.size > 0 && process.env.NODE_ENV !== 'production') {
      const sample = [...map.entries()].slice(0, 3)
        .map(([k, vs]) => `${k}→[${vs.map(v => v.note).join(',')}]`).join(', ')
      console.log(`[TAG Slack] slackNoteMap ${map.size}건 (샘플: ${sample})`)
    }
    return map
  }, [exceptions])

  const fetchAndParse = useCallback(async () => {
    if (!config.token || !config.channelId) {
      setError('Bot Token 또는 채널 ID가 설정되지 않았습니다.')
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      // Derive Unix timestamps from the date-string range
      const oldest = Math.floor(new Date(config.startDate + 'T00:00:00').getTime() / 1000)
      const latest = Math.floor(new Date(config.endDate   + 'T23:59:59').getTime() / 1000)

      // Use the year from endDate to resolve bare "M/D" date expressions
      const year = Number(config.endDate.slice(0, 4))

      console.log(
        `[TAG Slack] API 호출: 채널=${config.channelId}` +
        ` 기간=${config.startDate}~${config.endDate}` +
        ` 직원수=${employees.length}`,
      )
      const messages = await fetchSlackMessages(config.token, config.channelId, oldest, latest)
      console.log(`[TAG Slack] API 응답: ${messages.length}건 메시지 수신 (bot/join 제외)`)

      const { exceptions: parsed, ambiguousMatches: ambig } =
        parseSlackExceptions(messages, employees, year, policy.slackGroupMap, nameResolutions)

      setExceptions(parsed)
      setAmbiguousMatches(ambig)
      try {
        localStorage.setItem(LS_EXCEPTIONS, JSON.stringify(parsed))
      } catch {
        // localStorage 용량 초과 시 무시 — DB에서 로드됨
        localStorage.removeItem(LS_EXCEPTIONS)
      }

      // DB에 저장 후 재계산 — await 필수: compute-attendance가 DB에서 Slack 예외를 읽으므로
      // fire-and-forget이면 DB 쓰기 전에 재계산이 실행되어 Slack 반영 안 됨.
      // 예전엔 실패를 완전히 무시해서(catch{}) 서버 재계산이 통째로 빈 Slack 데이터로
      // 조용히 진행돼 외근·Slack반차 보정이 전부 무시되는 걸 아무도 알 수 없었음
      // (2026-08-03 발견) — 이제 실패 시 화면에 명시적으로 알림.
      let dbSaveOk = true
      try {
        const res = await fetch('/api/slack/exceptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.map(e => ({
            empId: e.empId, empName: e.empName, date: e.date,
            type: e.type, note: e.note, rawText: e.rawText,
          }))),
        })
        if (!res.ok) {
          dbSaveOk = false
          const errText = await res.text().catch(() => '응답 없음')
          console.error(`[TAG Slack] DB 저장 실패 HTTP ${res.status}:`, errText.slice(0, 300))
        }
      } catch (e) {
        dbSaveOk = false
        console.error('[TAG Slack] DB 저장 요청 실패:', e)
      }
      if (!dbSaveOk) {
        setError(
          'Slack 파싱은 완료됐지만 DB 저장에 실패했습니다 — 외근·Slack 반차 보정이 서버 ' +
          '재계산에 반영되지 않습니다. 다시 동기화해주세요.',
        )
      }

      const ts    = new Date().toLocaleString('ko-KR')
      const range: SyncedRange = { start: config.startDate, end: config.endDate }
      setLastSynced(ts)
      setSyncedRange(range)
      localStorage.setItem(LS_LAST_SYNC,    JSON.stringify(ts))
      localStorage.setItem(LS_SYNCED_RANGE, JSON.stringify(range))

      // Slack DB 저장 완료 후 재계산 실행 (이제 슬랙 예외가 DB에 반영된 상태)
      if (isLiveData) {
        recomputeProcessed().catch(() => {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [config, employees, nameResolutions])

  function clearExceptions() {
    setExceptions([])
    setLastSynced(null)
    setSyncedRange(null)
    localStorage.removeItem(LS_EXCEPTIONS)
    localStorage.removeItem(LS_LAST_SYNC)
    localStorage.removeItem(LS_SYNCED_RANGE)
  }

  const saveNameResolution = useCallback(async (match: SlackAmbiguousMatch, empId: string, empName: string) => {
    // 1. DB에 저장 — 재동기화해도 유지되도록
    try {
      await fetch('/api/slack/name-resolutions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ resolutions: [{ msgKey: match.key, empId, empName }] }),
      })
    } catch {
      // DB 저장 실패해도 아래 로컬 반영은 진행 — 다음 새로고침 시 유실될 수 있음을 감수
    }
    setNameResolutions(prev => ({ ...prev, [match.key]: empId }))
    setAmbiguousMatches(prev => prev.map(m =>
      m.key === match.key ? { ...m, isConfirmed: true, resolvedId: empId } : m,
    ))

    // 2. 이 메시지로부터 이미 생성된 (잘못됐을 수 있는) exceptions 항목을 제거하고,
    //    확정된 직원 기준으로 다시 채워넣는다.
    setExceptions(prev => {
      const isFromThisMatch = (e: SlackException) =>
        e.rawText === match.rawText && e.type === match.type && e.note === match.note &&
        match.dates.includes(e.date) && match.candidates.some(c => c.empId === e.empId)
      const kept = prev.filter(e => !isFromThisMatch(e))
      const added = match.dates.map(date => ({
        empId, empName, date, type: match.type, note: match.note, rawText: match.rawText,
      }))
      const next = [...kept, ...added]
      try { localStorage.setItem(LS_EXCEPTIONS, JSON.stringify(next)) } catch { /* quota */ }
      // 다른 사용자에게도 반영되도록 DB 전체 교체 — 지금 이 state가 곧 "다음" 전체 목록
      fetch('/api/slack/exceptions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(next.map(e => ({
          empId: e.empId, empName: e.empName, date: e.date,
          type: e.type, note: e.note, rawText: e.rawText,
        }))),
      }).catch(() => {})
      return next
    })

    if (isLiveData) {
      recomputeProcessed().catch(() => {})
    }
  }, [isLiveData, recomputeProcessed])

  return (
    <SlackContext.Provider value={{
      config, setConfig,
      exceptions, slackNoteMap, ambiguousMatches,
      isLoading, lastSynced, syncedRange, error,
      fetchAndParse, clearExceptions, saveNameResolution,
    }}>
      {children}
    </SlackContext.Provider>
  )
}

export function useSlack(): SlackContextValue {
  const ctx = useContext(SlackContext)
  if (!ctx) throw new Error('useSlack must be used inside SlackProvider')
  return ctx
}
