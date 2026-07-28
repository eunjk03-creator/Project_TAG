import type { Employee } from '@/types/tag'

// ── Types ──────────────────────────────────────────────────────────────────

export interface SlackMessage {
  ts:       string
  text:     string
  user?:    string
  subtype?: string  // 'bot_message' | 'channel_join' | etc.
}

export type SlackExcType = 'half_day' | 'quarter_day' | 'outside' | 'confirmed' | 'holiday_work' | 'annual_leave'

export interface SlackException {
  empId:    string
  empName:  string
  date:     string         // YYYY-MM-DD
  type:     SlackExcType
  note:     string         // display label e.g. "오전반차", "외근·행사"
  rawText:  string
}

export interface SlackAmbiguousCandidate {
  empId:    string
  empName:  string
  division: string
  team:     string
}

/**
 * A 동명이인(same-name) name-group found in one Slack message, surfaced for admin
 * review regardless of whether the 4-tier heuristic managed to auto-resolve it —
 * an auto-resolved pick can still be WRONG, so it's shown too, not just failures.
 */
export interface SlackAmbiguousMatch {
  /** `${slack message ts}::${employee name}` — stable per name-group per message,
   *  used as the key for admin-saved resolutions (SlackNameResolution table). */
  key:        string
  empName:    string
  dates:      string[]
  type:       SlackExcType
  note:       string
  rawText:    string
  candidates: SlackAmbiguousCandidate[]
  /** Best guess from the 4-tier dept heuristic — null if it couldn't narrow to 1. */
  autoPickId: string | null
  /** True when an admin has explicitly saved a resolution for this key. */
  isConfirmed: boolean
  /** Final applied choice: the saved resolution if present, else the auto-pick. */
  resolvedId: string | null
}

// ── Keyword patterns ───────────────────────────────────────────────────────

const AM_HALF_RE        = /오전\s*반\s*차/
const PM_HALF_RE        = /오후\s*반\s*차/
const HALF_RE           = /반\s*차/                              // generic half-day
const QUARTER_RE        = /반\s*반\s*차|빈\s*반\s*차|반\s*휴/   // quarter-day + typos
const HOLIDAY_WORK_RE   = /휴일\s*근무/
const ANNUAL_LEAVE_RE   = /연차|공가|리프레시|경조|병가|육아|예비군|민방위|포상휴가|대체휴가|기타휴가|휴가/
const TRIP_RE           = /출장/
const OUTSIDE_RE        = /외근|외부교육|교육|직출|직퇴|감리|공장|미팅|방문|외부|생산|참관|현장|정기|audit|행사|참석|세미나|컨퍼런스|포럼|견학|출입|인터뷰/i

function classifyMessage(text: string): { type: SlackExcType; note: string } | null {
  if (HOLIDAY_WORK_RE.test(text)) return { type: 'holiday_work', note: '휴일근무'  }
  if (QUARTER_RE.test(text))      return { type: 'quarter_day',  note: '반반차'    }
  if (AM_HALF_RE.test(text))      return { type: 'half_day',     note: '오전반차'  }
  if (PM_HALF_RE.test(text))      return { type: 'half_day',     note: '오후반차'  }
  if (HALF_RE.test(text))         return { type: 'half_day',     note: '반차'      }
  if (ANNUAL_LEAVE_RE.test(text)) return { type: 'annual_leave', note: '연차'      }
  if (TRIP_RE.test(text))         return { type: 'outside',      note: '출장'      }
  if (OUTSIDE_RE.test(text))      return { type: 'outside',      note: '외근·행사' }
  return null
}

// ── Department keyword → division disambiguation map ──────────────────────
//
// Keys are shorthand codes / aliases that appear in Slack messages.
// Values are substrings of Employee.division — matched with .includes() so
// "SCM본부", "GTM팀", etc. all resolve correctly.

const DEPT_KEYWORD_MAP: { keywords: string[]; division: string }[] = [
  { keywords: ['HM', 'HMR', 'HMR사업부문'],           division: 'HMR사업부문'      },
  { keywords: ['HC', '헬스케어', '헬스케어사업부문'],  division: '헬스케어사업부문'  },
  { keywords: ['RF', '음료사업부문'],                  division: '음료사업부문'      },
  { keywords: ['신사업', '신사업본부'],                division: '신사업본부'        },
  { keywords: ['BT', '뷰티', '뷰티사업부문'],         division: '뷰티사업부문'      },
  { keywords: ['HQ'],                                  division: 'HQ'               },
  { keywords: ['PE', '피플', '피플본부'],              division: '피플본부'          },
  { keywords: ['PL', '경영기획', '경영기획본부'],      division: '경영기획본부'      },
  { keywords: ['GTM'],                                 division: 'GTM'              },
  { keywords: ['SCM'],                                 division: 'SCM'              },
]

/**
 * Given a message text, returns the division substring that any dept keyword
 * in the message resolves to, or null if no keyword matches.
 * Longer/more-specific keywords are checked first within each entry so that
 * e.g. "HMR" is preferred over the shorter "HM" alias.
 */
function detectDivisionFromText(text: string): string | null {
  const textLower = text.toLowerCase()
  for (const { keywords, division } of DEPT_KEYWORD_MAP) {
    // Sort descending by length so longer aliases match before shorter ones
    const sorted = [...keywords].sort((a, b) => b.length - a.length)
    if (sorted.some(kw => textLower.includes(kw.toLowerCase()))) return division
  }
  return null
}

// ── Name fuzzy matching ────────────────────────────────────────────────────

/**
 * Converts a masked employee name to a RegExp with strict Korean word boundaries.
 * Each '*' is replaced by [가-힣] (exactly one Korean syllable — not any char).
 * The whole pattern is wrapped in negative lookbehind/lookahead so it only
 * matches a standalone name, never a substring inside a longer Korean word.
 *
 *   "이*로"  → /(?<![가-힣])이[가-힣]로(?![가-힣])/   — "이지로지스" → NO MATCH
 *   "이*"    → /(?<![가-힣])이[가-힣](?![가-힣])/      — "이현지"     → NO MATCH
 *   "김**룡" → /(?<![가-힣])김[가-힣][가-힣]룡(?![가-힣])/
 */
function maskedNameToRegex(name: string): RegExp {
  // Strip internal spaces so "구 권모" in CAPS still matches "구권모" in Slack
  const normalized = name.replace(/\s+/g, '')
  const pattern = normalized
    .split('*')
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[가-힣]')
  return new RegExp(`(?<![가-힣])${pattern}(?![가-힣])`)
}

// ── Date extraction ────────────────────────────────────────────────────────

function ymd(year: number, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/**
 * Extract a date range from a Slack message.
 *
 * Recognises three formats (all with optional Korean day-of-week in parens):
 *   1. Explicit range  "MM/DD[-~]MM/DD"          e.g. "5/11-5/12", "5/11~5/12"
 *   2. Same-month range "MM/DD(요일)[-~]DD(요일)"  e.g. "5/11(월)-12(화)", "5/11-12"
 *   3. Single date     "MM/DD"                    e.g. "5/11", "05/11(수)"
 *
 * Returns { start, end } in YYYY-MM-DD format, or null when no date is found.
 * start and end are identical for single-date messages.
 */
function extractDateRange(text: string, year: number): { start: string; end: string } | null {
  // Priority 1: explicit range  "MM/DD(요일)[-~]MM/DD(요일)"  (요일 괄호 선택)
  const explicit = text.match(
    /(\d{1,2})\/(\d{1,2})(?:\([가-힣]\))?\s*[-~]\s*(\d{1,2})\/(\d{1,2})(?:\([가-힣]\))?/,
  )
  if (explicit) {
    const start = ymd(year, explicit[1], explicit[2])
    const end   = ymd(year, explicit[3], explicit[4])
    if (start <= end) return { start, end }
  }

  // Priority 2: same-month range  "MM/DD(요일)[-~]DD(요일)"
  // The negative lookahead (?![/\d]) prevents matching "5" in "5/11-5/12"
  // (which would be caught by Priority 1 above).
  const sameMonth = text.match(
    /(\d{1,2})\/(\d{1,2})(?:\([가-힣]\))?\s*[-~]\s*(\d{1,2})(?![/\d])(?:\([가-힣]\))?/,
  )
  if (sameMonth) {
    const start = ymd(year, sameMonth[1], sameMonth[2])
    const end   = ymd(year, sameMonth[1], sameMonth[3])
    if (start <= end) return { start, end }
  }

  // Fallback: single date
  const single = text.match(/(\d{1,2})\/(\d{1,2})/)
  if (single) {
    const date = ymd(year, single[1], single[2])
    return { start: date, end: date }
  }

  return null
}

/**
 * Expand a { start, end } range into an array of YYYY-MM-DD strings.
 * Capped at 30 days to guard against pathological inputs.
 */
function expandDateRange(start: string, end: string): string[] {
  const dates: string[] = []
  const cur  = new Date(start + 'T12:00:00Z')
  const last = new Date(end   + 'T12:00:00Z')
  if (isNaN(cur.getTime()) || isNaN(last.getTime()) || cur > last) return [start]
  let guard = 0
  while (cur <= last && guard < 30) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
    guard++
  }
  return dates
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
 *     - If >1 matches (동명이인) → four-tier dept-context disambiguation (see below).
 *       Every 동명이인 name-group is ALSO recorded in `ambiguousMatches` — even when
 *       the heuristic narrows to exactly 1 candidate — because the heuristic can be
 *       wrong; an admin can review/override it in Settings > 슬랙 연동 (persisted via
 *       `nameResolutions`, keyed by `${msg.ts}::${empName}`, so corrections survive
 *       the next re-sync instead of being silently recomputed away).
 *     - If 0 matches → skip silently.
 */
// ── Classification priority (higher = preferred in dedup) ─────────────────
// Leave-specific entries win over generic 'outside' when both cover the same
// employee+date (e.g. the author writes a separate half-day message AND is
// mentioned by name in a generic group-event message).
const CLS_PRIORITY: Record<SlackExcType, number> = {
  holiday_work: 6,
  annual_leave: 5,
  half_day:     4,
  quarter_day:  3,
  outside:      2,
  confirmed:    1,
}

const DEFAULT_OOO_CLS: { type: SlackExcType; note: string } = { type: 'outside', note: '외근·행사' }

/**
 * Extract all Slack subteam IDs from a message text.
 * Matches both <subteam^ID> and <!subteam^ID|label> formats.
 */
function extractSubteamIds(text: string): string[] {
  const ids: string[] = []
  for (const m of text.matchAll(/<[!]?subteam\^([A-Z0-9]+)(?:\|[^>]*)?>(?!\S)/gi)) {
    ids.push(m[1])
  }
  return ids
}

export function parseSlackExceptions(
  messages:  SlackMessage[],
  employees: Employee[],
  year:      number,
  slackGroupMap?: Record<string, string>,
  /** Admin-confirmed 동명이인 picks from a prior session — key: `${msg.ts}::${empName}` → empId.
   *  Applied ahead of (and overriding) the 4-tier heuristic so corrections survive re-sync. */
  nameResolutions: Record<string, string> = {},
): { exceptions: SlackException[]; ambiguousMatches: SlackAmbiguousMatch[] } {
  // Pre-build per-employee regex (only once per parse)
  const employeePatterns = employees.map(e => ({
    emp:   e,
    regex: maskedNameToRegex(e.name),
  }))

  const results: SlackException[] = []
  const ambiguousMatches: SlackAmbiguousMatch[] = []
  let noDateCount    = 0
  let noKeywordCount = 0
  let noMatchCount   = 0
  let ambiguousCount = 0

  console.log(`[TAG Slack] ▶ 파싱 시작 — 메시지 ${messages.length}건 / 직원 ${employees.length}명 / ${year}년`)

  for (const msg of messages) {
    const text = msg.text
    if (!text?.trim()) continue

    // 메시지 타임스탬프로 실제 연도 결정 (endDate 고정 연도 대신)
    // → 2025년 메시지가 2026년 날짜로 잘못 매핑되는 문제 방지
    const msgYear = msg.ts ? new Date(parseFloat(msg.ts) * 1000).getFullYear() : year

    const range = extractDateRange(text, msgYear)
    if (!range) { noDateCount++; continue }
    const dates = expandDateRange(range.start, range.end)

    // Keyword classification: 키워드 없으면 기본 외근·행사로 분류
    // (OOO 채널에서 날짜+이름이 있고 연차/반차가 아니면 외근)
    const cls = classifyMessage(text)
    if (!cls) noKeywordCount++
    const effectiveCls = cls ?? DEFAULT_OOO_CLS

    // ── Step 1: collect all name-regex matches ─────────────────────────
    const regexMatches = employeePatterns.filter(({ regex }) => regex.test(text))

    // Supplement regex matching with token-based extraction for comma/slash separators
    const tokenMatches: typeof regexMatches = []
    const tokens = text.split(/[,/\s]+/).map(t => t.trim()).filter(t => /^[가-힣]{2,4}$/.test(t))
    for (const token of tokens) {
      for (const pat of employeePatterns) {
        if (!regexMatches.some(m => m.emp.id === pat.emp.id) &&
            !tokenMatches.some(m => m.emp.id === pat.emp.id) &&
            pat.regex.test(token)) {
          tokenMatches.push(pat)
        }
      }
    }
    const nameMatches = [...regexMatches, ...tokenMatches]

    if (nameMatches.length === 0) {
      noMatchCount++
      if (process.env.NODE_ENV !== 'production') {
        const rangeStr = range.start === range.end ? range.start : `${range.start}~${range.end}`
        console.debug(`[TAG Slack] 이름 미매칭 (${rangeStr} / ${effectiveCls.note}): "${text.slice(0, 80)}"`)
      }
      continue
    }

    if (nameMatches.length === 1) {
      const { emp } = nameMatches[0]
      for (const date of dates) {
        results.push({ empId: emp.id, empName: emp.name, date, type: effectiveCls.type, note: effectiveCls.note, rawText: text })
      }
      continue
    }

    // ── Step 2: multi-name vs. 동명이인 disambiguation ─────────────────────────
    //
    // Group matches by employee name:
    //   • Different names → all were intentionally mentioned in one message
    //     (e.g. "김다슬, 이재아, 최도담 행사 참석") → record every distinct person.
    //   • Same name, multiple employees (동명이인) → attempt dept disambiguation;
    //     skip the group if still unresolvable.

    const byName = new Map<string, typeof nameMatches>()
    for (const m of nameMatches) {
      if (!byName.has(m.emp.name)) byName.set(m.emp.name, [])
      byName.get(m.emp.name)!.push(m)
    }

    if (process.env.NODE_ENV !== 'production') {
      const rangeStr = range.start === range.end ? range.start : `${range.start}~${range.end}`
      const namesSummary = [...byName.entries()]
        .map(([n, g]) => g.length === 1 ? `${n}✓` : `${n}×${g.length}(동명이인)`)
        .join(', ')
      console.log(`[TAG Slack] 다중이름 매칭 (${rangeStr} / ${effectiveCls.note}): ${namesSummary}`)
      console.log(`  메시지: "${text.slice(0, 100)}"`)
    }

    for (const [groupName, group] of byName) {
      if (group.length === 1) {
        // Unique name among matches — record directly, no disambiguation needed
        const { emp } = group[0]
        for (const date of dates) {
          results.push({ empId: emp.id, empName: emp.name, date, type: effectiveCls.type, note: effectiveCls.note, rawText: text })
        }
      } else {
        // 동명이인: four-tier dept disambiguation
        let deptMatches = group

        // Tier 0: Slack subteam/usergroup ID → division (e.g. <subteam^S0GQJ67UBA9> = @beauty = 뷰티사업부문)
        if (slackGroupMap && Object.keys(slackGroupMap).length > 0) {
          const subteamIds = extractSubteamIds(text)
          for (const id of subteamIds) {
            const div = slackGroupMap[id]
            if (div) {
              const filtered = group.filter(({ emp }) => emp.division.includes(div))
              if (filtered.length === 1) { deptMatches = filtered; break }
              if (filtered.length > 0)   { deptMatches = filtered }
            }
          }
        }

        // Tier 1: 이름 인근 컨텍스트에서 부서코드 탐색 — "최우정(PE_OD)" 형태 처리
        // 이름 매칭 위치 ±30자 안에 부서코드가 있으면 해당 부서 직원으로 좁힘
        const nameInContext = ((): string | null => {
          const reg = group[0].regex
          const m = reg.exec(text)
          if (!m || m.index === undefined) return null
          const start = Math.max(0, m.index - 5)
          const end   = Math.min(text.length, m.index + m[0].length + 30)
          return text.slice(start, end)
        })()
        if (nameInContext) {
          const nearDiv = detectDivisionFromText(nameInContext)
          if (nearDiv) {
            deptMatches = group.filter(({ emp }) => emp.division.includes(nearDiv))
          }
        }

        // Tier 2: 전체 메시지에서 부서코드 탐색
        if (deptMatches.length !== 1) {
          const detectedDivision = detectDivisionFromText(text)
          if (detectedDivision) {
            deptMatches = group.filter(({ emp }) => emp.division.includes(detectedDivision))
          }
        }

        // Tier 3: 메시지에 본부명/팀명이 직접 포함된 경우
        if (deptMatches.length !== 1) {
          deptMatches = group.filter(({ emp }) => text.includes(emp.division) || text.includes(emp.team))
        }

        // 자동판별 결과(성공/실패 무관) — 관리자가 파싱 결과 화면에서 확인/수정할 수 있도록
        // 동명이인 그룹은 항상 ambiguousMatches에 기록한다 (자동판별이 틀렸을 수도 있으므로).
        const autoPickId = deptMatches.length === 1 ? deptMatches[0].emp.id : null
        const resolutionKey = `${msg.ts}::${groupName}`
        const savedPick  = nameResolutions[resolutionKey]
        const isConfirmed = savedPick != null
        const resolvedId  = savedPick ?? autoPickId ?? null
        const resolvedEmp = resolvedId ? group.find(m => m.emp.id === resolvedId)?.emp : undefined

        ambiguousMatches.push({
          key:         resolutionKey,
          empName:     groupName,
          dates,
          type:        effectiveCls.type,
          note:        effectiveCls.note,
          rawText:     text,
          candidates:  group.map(m => ({ empId: m.emp.id, empName: m.emp.name, division: m.emp.division, team: m.emp.team })),
          autoPickId,
          isConfirmed,
          resolvedId:  resolvedEmp ? resolvedEmp.id : null,
        })

        if (resolvedEmp) {
          for (const date of dates) {
            results.push({ empId: resolvedEmp.id, empName: resolvedEmp.name, date, type: effectiveCls.type, note: effectiveCls.note, rawText: text })
          }
        } else {
          ambiguousCount++
          const rangeStr = range.start === range.end ? range.start : `${range.start}~${range.end}`
          const candidateInfo = group.map(m => `${m.emp.name}(${m.emp.division})`).join(', ')
          // Extract any unregistered subteam IDs from this message to help the user configure mappings
          const unknownSubteams = extractSubteamIds(text).filter(id => !slackGroupMap?.[id])
          console.warn(
            `[TAG Slack] ⚠ 동명이인 충돌 — ${group.length}명 (${rangeStr}): ${candidateInfo}\n` +
            `  부서 컨텍스트로도 구분 불가 (deptMatches=${deptMatches.length}). 파싱 결과 > 동명이인 확인에서 지정하세요.\n` +
            `  메시지: "${text.slice(0, 100)}"` +
            (unknownSubteams.length > 0
              ? `\n  💡 미등록 Subteam ID: [${unknownSubteams.join(', ')}] → 설정 > 슬랙 연동 > 동명이인 부서 구분에 등록하세요.`
              : ''),
          )
        }
      }
    }
  }

  // 같은 empId+date에 여러 항목이 있을 수 있음 (반차+외근 등).
  // 완전히 동일한 (empId, date, type, note) 중복만 제거하고 나머지는 모두 보존.
  // 우선순위 내림차순으로 정렬 (휴일근무 > 연차 > 반차 > 외근 순).
  const seen = new Set<string>()
  const deduped: SlackException[] = []
  for (const ex of results) {
    const sig = `${ex.empId}|${ex.date}|${ex.type}|${ex.note}`
    if (!seen.has(sig)) {
      seen.add(sig)
      deduped.push(ex)
    }
  }
  // 동일 직원+날짜 내에서 우선순위 높은 순으로 정렬
  const final = deduped.sort((a, b) => {
    if (a.empId !== b.empId || a.date !== b.date) return 0
    return (CLS_PRIORITY[b.type] ?? 0) - (CLS_PRIORITY[a.type] ?? 0)
  })

  console.log(
    `[TAG Slack] ✅ 파싱 완료 — 매칭 ${final.length}건` +
    ` | 날짜없음 ${noDateCount} | 키워드없음 ${noKeywordCount}` +
    ` | 이름미매칭 ${noMatchCount} | 중복/충돌 ${ambiguousCount}`,
  )
  if (final.length > 0) {
    console.log('[TAG Slack] 매칭 샘플:', final.slice(0, 5).map(e => `${e.empName}/${e.date}/${e.note}`).join(', '))
  }
  if (ambiguousMatches.length > 0) {
    console.log(`[TAG Slack] 동명이인 확인 필요/검토용 ${ambiguousMatches.length}건 (자동판별 ${ambiguousMatches.filter(m => m.resolvedId).length}건 포함)`)
  }

  return { exceptions: final, ambiguousMatches }
}
