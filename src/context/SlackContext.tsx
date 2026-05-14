'use client'
import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react'
import type { SlackException } from '@/utils/slackApi'
import { fetchSlackMessages, parseSlackExceptions } from '@/utils/slackApi'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'

export interface SlackConfig {
  token:     string
  channelId: string
  year:      number
  month:     number
}

interface SlackContextValue {
  config:          SlackConfig
  setConfig:       (c: SlackConfig) => void
  exceptions:      SlackException[]
  slackNoteMap:    Map<string, string>
  isLoading:       boolean
  lastSynced:      string | null
  error:           string | null
  fetchAndParse:   () => Promise<void>
  clearExceptions: () => void
}

const _now = new Date()
const DEFAULT_CONFIG: SlackConfig = {
  token:     '',
  channelId: '',
  year:      _now.getFullYear(),
  month:     _now.getMonth() + 1,
}

const LS_CONFIG     = 'tag_slack_config'
const LS_EXCEPTIONS = 'tag_slack_exceptions'
const LS_LAST_SYNC  = 'tag_slack_last_sync'

function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

const SlackContext = createContext<SlackContextValue | null>(null)

export function SlackProvider({ children }: { children: ReactNode }) {
  const { employees } = useAttendanceSource()

  const [config,     setConfigState] = useState<SlackConfig>(
    () => loadLS<SlackConfig>(LS_CONFIG, DEFAULT_CONFIG),
  )
  const [exceptions, setExceptions]  = useState<SlackException[]>(
    () => loadLS<SlackException[]>(LS_EXCEPTIONS, []),
  )
  const [isLoading,  setIsLoading]   = useState(false)
  const [lastSynced, setLastSynced]  = useState<string | null>(
    () => loadLS<string | null>(LS_LAST_SYNC, null),
  )
  const [error, setError] = useState<string | null>(null)

  function setConfig(c: SlackConfig) {
    setConfigState(c)
    localStorage.setItem(LS_CONFIG, JSON.stringify(c))
  }

  const slackNoteMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const ex of exceptions) {
      map.set(`${ex.empId}_${ex.date}`, ex.note)
    }
    if (map.size > 0 && process.env.NODE_ENV !== 'production') {
      const sample = [...map.entries()].slice(0, 3).map(([k, v]) => `${k}→${v}`).join(', ')
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
      const startDate = new Date(config.year, config.month - 1, 1)
      const endDate   = new Date(config.year, config.month,     0, 23, 59, 59)
      const oldest    = Math.floor(startDate.getTime() / 1000)
      const latest    = Math.floor(endDate.getTime()   / 1000)

      console.log(`[TAG Slack] API 호출: 채널=${config.channelId} 기간=${new Date(oldest*1000).toLocaleDateString('ko-KR')}~${new Date(latest*1000).toLocaleDateString('ko-KR')} 직원수=${employees.length}`)
      const messages = await fetchSlackMessages(config.token, config.channelId, oldest, latest)
      console.log(`[TAG Slack] API 응답: ${messages.length}건 메시지 수신 (bot/join 제외)`)

      const parsed = parseSlackExceptions(messages, employees, config.year)

      setExceptions(parsed)
      localStorage.setItem(LS_EXCEPTIONS, JSON.stringify(parsed))
      console.log(`[TAG Slack] localStorage 저장 완료: ${parsed.length}건 예외 규칙`)

      const ts = new Date().toLocaleString('ko-KR')
      setLastSynced(ts)
      localStorage.setItem(LS_LAST_SYNC, JSON.stringify(ts))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [config, employees])

  function clearExceptions() {
    setExceptions([])
    localStorage.removeItem(LS_EXCEPTIONS)
    setLastSynced(null)
    localStorage.removeItem(LS_LAST_SYNC)
  }

  return (
    <SlackContext.Provider value={{
      config, setConfig,
      exceptions, slackNoteMap,
      isLoading, lastSynced, error,
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
