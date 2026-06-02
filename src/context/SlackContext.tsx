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
import type { SlackException } from '@/utils/slackApi'
import { fetchSlackMessages, parseSlackExceptions } from '@/utils/slackApi'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'

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
  isLoading:       boolean
  lastSynced:      string | null       // human-readable timestamp
  syncedRange:     SyncedRange | null  // machine-readable range that was last synced
  error:           string | null
  fetchAndParse:   () => Promise<void>
  clearExceptions: () => void
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
  const { employees } = useAttendanceSource()

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

  // 마운트 시 DB에서 공유 Slack 예외 로드 (다른 사용자가 동기화한 데이터 반영)
  useEffect(() => {
    fetch('/api/slack/exceptions')
      .then(r => r.json())
      .then((rows: SlackException[]) => {
        if (rows.length > 0) {
          setExceptions(rows)
          localStorage.setItem(LS_EXCEPTIONS, JSON.stringify(rows))
        }
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

      const parsed = parseSlackExceptions(messages, employees, year)

      setExceptions(parsed)
      localStorage.setItem(LS_EXCEPTIONS, JSON.stringify(parsed))
      console.log(`[TAG Slack] localStorage 저장 완료: ${parsed.length}건 예외 규칙`)

      // DB에 저장 (다른 사용자와 공유)
      fetch('/api/slack/exceptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.map(e => ({
          empId: e.empId, empName: e.empName, date: e.date,
          type: e.type, note: e.note, rawText: e.rawText,
        }))),
      }).catch(() => {})

      const ts    = new Date().toLocaleString('ko-KR')
      const range: SyncedRange = { start: config.startDate, end: config.endDate }
      setLastSynced(ts)
      setSyncedRange(range)
      localStorage.setItem(LS_LAST_SYNC,    JSON.stringify(ts))
      localStorage.setItem(LS_SYNCED_RANGE, JSON.stringify(range))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [config, employees])

  function clearExceptions() {
    setExceptions([])
    setLastSynced(null)
    setSyncedRange(null)
    localStorage.removeItem(LS_EXCEPTIONS)
    localStorage.removeItem(LS_LAST_SYNC)
    localStorage.removeItem(LS_SYNCED_RANGE)
  }

  return (
    <SlackContext.Provider value={{
      config, setConfig,
      exceptions, slackNoteMap,
      isLoading, lastSynced, syncedRange, error,
      fetchAndParse, clearExceptions,
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
