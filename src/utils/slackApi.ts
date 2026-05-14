import type { Employee } from '@/types/tag'

// ── Types ──────────────────────────────────────────────────────────────────

export interface SlackMessage {
  ts:       string
  text:     string
  user?:    string
  subtype?: string  // 'bot_message' | 'channel_join' | etc.
}

export type SlackExcType = 'half_day' | 'quarter_day' | 'outside' | 'confirmed'

export interface SlackException {
  empId:    string
  empName:  string
  date:     string         // YYYY-MM-DD
  type:     SlackExcType
  note:     string         // display label e.g. "오전반차", "외근·행사"
  rawText:  string
}

// ── Keyword patterns ───────────────────────────────────────────────────────

const AM_HALF_RE    = /오전\s*반\s*차/
const PM_HALF_RE    = /오후\s*반\s*차/
const HALF_RE       = /반\s*차/                              // generic half-day
const QUARTER_RE    = /반\s*반\s*차|빈\s*반\s*차|반\s*휴/   // quarter-day + typos
const OUTSIDE_RE    = /미팅|행사\s*참석|직출|외근/

function classifyMessage(text: string): { type: SlackExcType; note: string } | null {
  if (QUARTER_RE.test(text))  return { type: 'quarter_day', note: '반반차'   }
  if (AM_HALF_RE.test(text))  return { type: 'half_day',    note: '오전반차' }
  if (PM_HALF_RE.test(text))  return { type: 'half_day',    note: '오후반차' }
  if (HALF_RE.test(text))     return { type: 'half_day',    note: '반차'     }
  if (OUTSIDE_RE.test(text))  return { type: 'outside',     note: '외근·행사' }
  return null
}

// ── Name fuzzy matching ────────────────────────────────────────────────────

/**
 * Converts a masked employee name to a RegExp.
 * Each '*' represents exactly one masked character.
 *   "기*미"  → /기.미/
 *   "김**룡" → /김..룡/
 */
function maskedNameToRegex(name: string): RegExp {
  const pattern = name
    .split('*')
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.')
  return new RegExp(pattern)
}

// ── Date extraction ────────────────────────────────────────────────────────

function extractDate(text: string, year: number): string | null {
  // Match "M/D" or "MM/DD" (possibly followed by "(화)" day-of-week)
  const m = text.match(/(\d{1,2})\/(\d{1,2})/)
  if (!m) return null
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

// ── Slack API fetch (calls our own /api/slack/history proxy) ───────────────

interface SlackHistoryResponse {
  ok:                  boolean
  messages?:           SlackMessage[]
  has_more?:           boolean
  response_metadata?:  { next_cursor?: string }
  error?:              string
}

export async function fetchSlackMessages(
  token:     string,
  channelId: string,
  oldest:    number,   // Unix timestamp (seconds)
  latest:    number,   // Unix timestamp (seconds)
): Promise<SlackMessage[]> {
  const all: SlackMessage[] = []
  let cursor: string | undefined

  do {
    const res = await fetch('/api/slack/history', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token, channelId, oldest, latest, cursor }),
    })

    const data: SlackHistoryResponse = await res.json()
    if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`)

    // Skip bot messages, channel joins, etc.
    const msgs = (data.messages ?? []).filter(m => !m.subtype)
    all.push(...msgs)

    cursor = data.has_more ? data.response_metadata?.next_cursor : undefined
  } while (cursor)

  return all
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse Slack OOO channel messages into per-employee per-date exceptions.
 *
 * Matching strategy (strict, 2-factor):
 *  1. Extract YYYY-MM-DD from the "M/D(요일)" prefix.
 *  2. Classify the exception type from keywords.
 *  3. Collect ALL employees whose name-regex matches the message.
 *     - If exactly 1 match → unambiguous, safe to record.
 *     - If >1 matches → require department context disambiguation:
 *         a. Filter to employees whose division or team name appears in the message.
 *         b. If exactly 1 survives → use it.
 *         c. Otherwise → skip (log warning). Never guess.
 *     - If 0 matches → skip silently.
 */
export function parseSlackExceptions(
  messages:  SlackMessage[],
  employees: Employee[],
  year:      number,
): SlackException[] {
  // Pre-build per-employee regex (only once per parse)
  const employeePatterns = employees.map(e => ({
    emp:   e,
    regex: maskedNameToRegex(e.name),
  }))

  const results: SlackException[] = []
  let noDateCount    = 0
  let noKeywordCount = 0
  let noMatchCount   = 0
  let ambiguousCount = 0

  console.log(`[TAG Slack] ▶ 파싱 시작 — 메시지 ${messages.length}건 / 직원 ${employees.length}명 / ${year}년`)

  for (const msg of messages) {
    const text = msg.text
    if (!text?.trim()) continue

    const date = extractDate(text, year)
    if (!date) { noDateCount++; continue }

    const cls = classifyMessage(text)
    if (!cls) { noKeywordCount++; continue }

    // ── Step 1: collect all name-regex matches ─────────────────────────
    const nameMatches = employeePatterns.filter(({ regex }) => regex.test(text))

    if (nameMatches.length === 0) {
      noMatchCount++
      // Debug: show messages that had a date + keyword but no name match
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`[TAG Slack] 이름 미매칭 (${date} / ${cls.note}): "${text.slice(0, 80)}"`)
      }
      continue
    }

    if (nameMatches.length === 1) {
      const { emp } = nameMatches[0]
      results.push({ empId: emp.id, empName: emp.name, date, type: cls.type, note: cls.note, rawText: text })
      continue
    }

    // ── Step 2: ambiguous — require department context ─────────────────
    const deptMatches = nameMatches.filter(({ emp }) =>
      text.includes(emp.division) || text.includes(emp.team),
    )

    if (deptMatches.length === 1) {
      const { emp } = deptMatches[0]
      results.push({ empId: emp.id, empName: emp.name, date, type: cls.type, note: cls.note, rawText: text })
      continue
    }

    // ── Step 3: still ambiguous — skip to protect data integrity ───────
    ambiguousCount++
    const candidateInfo = nameMatches.map(m => `${m.emp.name}(${m.emp.division})`).join(', ')
    console.warn(
      `[TAG Slack] ⚠ 이름 매칭 충돌 — ${nameMatches.length}명 후보 (${date}): ${candidateInfo}\n` +
      `  부서 컨텍스트로도 구분 불가 (deptMatches=${deptMatches.length}). 행 스킵.\n` +
      `  메시지: "${text.slice(0, 100)}"`,
    )
  }

  // Deduplicate: same empId+date → keep last
  const deduped = new Map<string, SlackException>()
  for (const ex of results) {
    deduped.set(`${ex.empId}_${ex.date}`, ex)
  }
  const final = [...deduped.values()]

  console.log(
    `[TAG Slack] ✅ 파싱 완료 — 매칭 ${final.length}건` +
    ` | 날짜없음 ${noDateCount} | 키워드없음 ${noKeywordCount}` +
    ` | 이름미매칭 ${noMatchCount} | 중복/충돌 ${ambiguousCount}`,
  )
  if (final.length > 0) {
    console.log('[TAG Slack] 매칭 샘플:', final.slice(0, 5).map(e => `${e.empName}/${e.date}/${e.note}`).join(', '))
  }

  return final
}
