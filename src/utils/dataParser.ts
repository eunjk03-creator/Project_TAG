/**
 * parseAttendanceData
 *
 * Merges CAPS clock-in/out rows with ERP leave rows and ERP overtime rows.
 * Produces { employees, rawRecords } + cross-check verificationNote flags.
 *
 * DESIGN RULES (do not change without testing against real files):
 *  • normalizeDate: replace("/"→"-") then regex-extract YYYY-MM-DD
 *    → handles time suffixes, single-digit day/month, all separator variants
 *  • normalizeId: String().trim() only — no further stripping that could change numeric IDs
 *  • COMPOSITE EMPLOYEE KEY: "${employeeId}_${normalizeName(name)}"
 *    → Employee.id == compositeKey; Employee.rawId == original 사원번호 for display
 *  • Leave/OT lookup key: "${compositeEmpKey}_${normDate}" — built from the same composite
 *  • Leave map: built from BOTH ERP files; skips OT-type codes
 *  • OT map: built from ERP-OT file only; matches '연장근로' code OR non-zero 인정시간
 *  • UTC-only date arithmetic for range expansion — no local-timezone methods
 */

import { getOrganization } from '@/data/orgChart'
import { HOLIDAYS } from '@/data/mockData'
import { normalizeLeaveType } from '@/utils/attendanceCalc'
import type {
  Employee, RawRecord, CapsRow, ErpUnifiedRow, ErpLeaveType, DayType, PolicySettings,
} from '@/types/tag'
import { ERP_LEAVE_TYPE_MAP, DEFAULT_POLICY } from '@/types/tag'

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Convert a normalizeTime() result ("HH:MM" or "+HH:MM") to total minutes.
 * The "+" prefix means next-day (cross-midnight shift), so +24*60 is added.
 */
function toMinutes(timeStr: string): number {
  const nextDay = timeStr.startsWith('+')
  const body    = nextDay ? timeStr.slice(1) : timeStr
  const [h, m]  = body.split(':').map(Number)
  return (nextDay ? 1440 : 0) + h * 60 + m
}

/**
 * Accepted ERP 승인상태 values:
 *   '승인'  — fully approved
 *   '신청'  — applied / pending (e.g. '신청', '신청중')
 *   '상신'  — submitted/forwarded to approver (e.g. '상신', '상신중')
 * Explicitly rejected: '취소' (any variant), '반려'.
 */
function isAcceptedStatus(status: string): boolean {
  if (status.includes('취소') || status.includes('반려')) return false
  return status.includes('승인') || status.includes('신청') || status.includes('상신')
}

/** 근태코드 values that represent overtime (not leave). */
const OT_CODE_SET = new Set(['연장근로', '시간외', '시간외근무', '연장근무', '휴일근로'])

/**
 * Job titles / roles that are exempt from 미신청OT flagging.
 * Leaders are assumed to manage their own schedules.
 */
const LEADER_TITLES = ['CEO', 'CSO', 'CFO', '본부장', '팀장', '부문장', '실장', '센터장']

// ── Complete exclusion rules ──────────────────────────────────────────────

/** Departments whose members are excluded from ALL attendance processing. */
const EXCLUDED_DEPTS = new Set(['임원', '장애인 고용', '임시출입(근태)', '더존'])

/**
 * Valid employee ID format: 'E' followed by ≥ 8 digits.
 * Rejects pure-numeric IDs, very short IDs, and non-E-prefixed entries
 * (e.g. visitor codes, contractor numbers) that occasionally appear in CAPS.
 */
function isValidEmpId(rawId: string): boolean {
  return /^E\d{8,}$/.test(rawId)
}

/**
 * Extracts the hire date from an employee ID in E{YY}{MM}{DD}{SEQ} format.
 * Returns 'YYYY-MM-DD' or null when the format doesn't match.
 * Example: 'E26060101' → '2026-06-01'
 */
function hireDateFromRawId(rawId: string): string | null {
  const m = rawId.match(/^E(\d{2})(\d{2})(\d{2})\d+$/)
  if (!m) return null
  const [, yy, mm, dd] = m
  return `20${yy}-${mm}-${dd}`
}

// ── ID normalisation ──────────────────────────────────────────────────────

function normalizeId(raw: string | null | undefined): string {
  // Simple .trim() exactly as the files use it — do NOT strip internal chars
  // because numeric IDs formatted as text may look like "10001" already.
  return String(raw ?? '').trim()
}

// ── Name normalisation ─────────────────────────────────────────────────────

/**
 * Strips all internal whitespace and trims edges so that
 * "김 철 수" and "김철수" compare equal across systems.
 */
function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, '')
}

// ── Date normalisation ────────────────────────────────────────────────────

/**
 * Converts any date string to canonical YYYY-MM-DD.
 * Returns '' for unparseable input — callers must check.
 *
 * Primary path (covers 99% of Korean Excel exports):
 *   "2026/05/01"  → replace("/"→"-") → match YYYY-M-D → "2026-05-01"
 *   "2026-05-01"  → already has dashes → match → "2026-05-01"
 *   "2026-05-01 00:00:00" → same match, time suffix ignored by no-$ anchor
 *
 * Fallback paths: M/D/YYYY, YYYYMMDD, Excel serial number.
 */
export function normalizeDate(raw: string | null | undefined): string {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s) return ''

  // Step 1 — replace slash separators with dashes (CAPS format: YYYY/MM/DD)
  const dashed = s.replace(/\//g, '-')

  // Step 2 — year-first format: YYYY-MM-DD or YYYY-M-D (with optional time suffix)
  // Using match() WITHOUT $ so "2026-05-01 00:00:00" and "2026-5-1" both match.
  const yFirst = dashed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (yFirst) {
    return `${yFirst[1]}-${yFirst[2].padStart(2, '0')}-${yFirst[3].padStart(2, '0')}`
  }

  // Step 3 — M/D/YYYY or MM/DD/YYYY (Excel US locale — check original for slashes)
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`
  }

  // Step 4 — YYYYMMDD (no separators)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  }

  // Step 5 — Excel date serial number (5-digit integer, ~40 000–60 000 for 2009–2064)
  if (/^\d{5}$/.test(s)) {
    const n = parseInt(s, 10)
    if (n > 40000 && n < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000)
      return (
        d.getUTCFullYear() + '-' +
        String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(d.getUTCDate()).padStart(2, '0')
      )
    }
  }

  return ''
}

// ── Dual-affiliation merge helpers ───────────────────────────────────────

function mergeEarliest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return toMinutes(a) <= toMinutes(b) ? a : b
}

function mergeLatest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return toMinutes(a) >= toMinutes(b) ? a : b
}

// ── UTC-safe next-day arithmetic ──────────────────────────────────────────

function addOneDayUTC(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return (
    next.getUTCFullYear() + '-' +
    String(next.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(next.getUTCDate()).padStart(2, '0')
  )
}

// ── Time normalisation ────────────────────────────────────────────────────

export function normalizeTime(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const s = raw.trim()
  if (!s || s === '-' || s === '—') return null

  const prefix = s.startsWith('+') ? '+' : ''
  const body   = prefix ? s.slice(1) : s

  if (/^\d{2}:\d{2}$/.test(body)) return prefix + body

  const hm = body.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (hm) return `${prefix}${hm[1].padStart(2, '0')}:${hm[2]}`

  if (/^\d{4}$/.test(body)) {
    return `${prefix}${body.slice(0, 2)}:${body.slice(2, 4)}`
  }

  return null
}

// ── Day-type helper ───────────────────────────────────────────────────────

function getDayInfo(
  dateStr: string,
  companyHols: Map<string, string> = new Map(),
): { dayType: DayType; dayLabel: string } {
  // Company-wide holidays take precedence so labels are shown correctly
  if (companyHols.has(dateStr)) return { dayType: 'HOLIDAY', dayLabel: companyHols.get(dateStr)! }
  if (HOLIDAYS.has(dateStr)) {
    const LABELS: Record<string, string> = {
      '2026-01-01': '신정',   '2026-02-16': '설날연휴', '2026-02-17': '설날',
      '2026-02-18': '설날연휴','2026-03-01': '삼일절',   '2026-05-01': '근로자의날','2026-05-05': '어린이날',
      '2026-06-06': '현충일', '2026-08-15': '광복절',   '2026-09-24': '추석연휴',
      '2026-09-25': '추석',   '2026-09-26': '추석연휴', '2026-10-03': '개천절',
      '2026-10-09': '한글날', '2026-12-25': '크리스마스',
    }
    return { dayType: 'HOLIDAY', dayLabel: LABELS[dateStr] ?? '공휴일' }
  }
  // UTC day-of-week — no local timezone involvement
  const [y, m, d] = dateStr.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (dow === 0 || dow === 6) return { dayType: 'WEEKEND', dayLabel: '휴일' }
  return { dayType: 'WEEKDAY', dayLabel: '평일' }
}

// ── injeongTime decoder ───────────────────────────────────────────────────

/**
 * ERP 인정시간 uses HH.MM notation (NOT decimal hours):
 *   "2.30" = 2 h 30 min = 2.5 h   "1.00" = 1 h   "0.30" = 30 min = 0.5 h
 */
export function parseInjeongTime(s: string | null | undefined): number {
  const n = parseFloat(String(s ?? '').trim())
  if (!isFinite(n) || n < 0) return 0
  const hours = Math.floor(n)
  const mins  = Math.round((n - hours) * 100)
  return hours + mins / 60
}

// ── Lookup key builder ────────────────────────────────────────────────────

/** Single composite key used for EVERY lookup — zero chance of outer/inner mismatch. */
function key(empId: string, date: string): string {
  return `${empId}_${date}`
}

// ── Leave accumulation constants ──────────────────────────────────────────

/** Fractional day value for each counted leave type. */
const LEAVE_AMOUNT: Partial<Record<ErpLeaveType, number>> = {
  '연차':      1.0,
  '오전반차':  0.5,
  '오후반차':  0.5,
  '오전반반차': 0.25,
  '오후반반차': 0.25,
  // '출장', '재택근무' are not time-off deductions — no amount
}

// ── Leave map ─────────────────────────────────────────────────────────────

/** Returns a numeric priority for ERP approval statuses (higher = more authoritative). */
function leavePriority(status: string): number {
  if (status.includes('승인')) return 3
  if (status.includes('신청')) return 2
  if (status.includes('상신')) return 1
  return 0
}

/**
 * Builds a flat Map<"empId_date", { type: ErpLeaveType; amount: number }> from the unified ERP array.
 *
 * Two-pass design:
 *
 * Pass 1 — deduplication:
 *   Korean ERP files export BOTH a '신청' (applied) and a '승인' (approved) row
 *   for every approved leave request. Both pass isAcceptedStatus(), so without
 *   deduplication the same 0.5-day leave accumulates to 1.0.
 *   This pass groups by (compositeKey, code, startDate, endDate) and retains only
 *   the row with the highest approval priority (승인 > 신청 > 상신).
 *
 * Pass 2 — accumulation with type inference:
 *   Processes the deduplicated entries. Per-day amount comes from '일수' ÷ range span.
 *   When the ERP code is generic '연차' but '일수' reveals a fractional day on a single-day
 *   request, the effective type is inferred: 0.5 → '오전반차', <0.5 → '오전반반차'.
 *   Multiple distinct leave rows for the same date (e.g. 연차 + 재택) are still summed;
 *   the sum is capped at 1.0.
 *   Codes absent from ERP_LEAVE_TYPE_MAP (e.g. 복직신청) are silently skipped.
 *   OT-type codes are skipped entirely.
 */
function buildLeaveMap(
  rows:           ErpUnifiedRow[],
  employeeMap:    Map<string, Employee>,
  companyHolsMap: Map<string, string> = new Map(),
): Map<string, { type: ErpLeaveType; amount: number; isUnpaid?: boolean; rawCode: string }> {
  const accumMap = new Map<string, { amount: number; type: ErpLeaveType; isUnpaid?: boolean; rawCode: string }>()

  // ── Diagnostic: log ERP column keys from first row (dev only) ──────────
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production' && rows.length > 0) {
    const firstRow = rows[0] as unknown as Record<string, string>
    console.log('[TAG] ERP leaveMap — column keys:', Object.keys(firstRow))
  }

  // ── Pass 1: deduplication ─────────────────────────────────────────────
  type DedupEntry = { compositeKey: string; row: Record<string, string> }
  const dedupMap = new Map<string, DedupEntry>()

  for (const raw of rows) {
    const r = raw as unknown as Record<string, string>

    const rawId   = normalizeId(r['사원번호'])
    const erpName = normalizeName(r['성명'])
    if (!rawId || !erpName) continue

    const compositeKey = `${rawId}_${erpName}`

    // 🔍 이현지 동명이인 ERP 진단 — 매칭 여부와 무관하게 전 건 로그
    if (typeof window !== 'undefined' && erpName.includes('이현지')) {
      console.log(
        `[이현지 ERP Pass1] rawId="${rawId}" compositeKey="${compositeKey}"`,
        `inMap=${employeeMap.has(compositeKey)}`,
        `status="${String(r['승인상태'] ?? '').trim()}"`,
        `code="${String(r['근태코드'] ?? '').normalize('NFKC').trim()}"`,
        `start="${normalizeDate(r[Object.keys(r).find(k => k.replace(/\s+/g,'') === '시작일') ?? '시작일'])}"`,
      )
    }

    if (!employeeMap.has(compositeKey)) {
      console.warn(`[TAG] ⚠ ERP 휴가 미매칭: 사원번호="${rawId}" 성명="${erpName}" → 직원 목록에 없음. 스킵.`)
      continue
    }

    const status = String(r['승인상태'] ?? '').trim()
    if (!isAcceptedStatus(status)) continue

    const code = String(r['근태코드'] ?? '').normalize('NFKC').trim()
    if (OT_CODE_SET.has(code)) continue

    const category = String(r['근태구분'] ?? '').trim()
    if (category === '시간') continue

    // 컬럼명 fuzzy 매칭 (공백/전각문자 차이 대응)
    const startKey = Object.keys(r).find(k => k.replace(/\s+/g, '') === '시작일') ?? '시작일'
    const endKey   = Object.keys(r).find(k => k.replace(/\s+/g, '') === '종료일') ?? '종료일'

    const startDate = normalizeDate(r[startKey])
    if (!startDate) continue
    const endDate = normalizeDate(r[endKey] ?? '') || startDate

    const dk       = `${compositeKey}||${code}||${startDate}||${endDate}`
    const existing = dedupMap.get(dk)
    if (!existing || leavePriority(status) > leavePriority(String(existing.row['승인상태'] ?? '').trim())) {
      dedupMap.set(dk, { compositeKey, row: r })
    }
  }

  // ── Pass 2: accumulation with type inference ──────────────────────────
  for (const { compositeKey, row: r } of dedupMap.values()) {
    // NFKC 정규화: 전각괄호（）→ 반각() 등 fullwidth 문자 변환
    const code = String(r['근태코드'] ?? '').normalize('NFKC').trim()

    const leaveType = ERP_LEAVE_TYPE_MAP[code]
    if (!leaveType) {
      // 휴가 맵에 없는 코드 — 콘솔에 기록해서 확인 가능하게
      if (typeof window !== 'undefined') {
        console.warn(`[TAG ERP] 미인식 근태코드 스킵: "${code}" (${r['성명'] ?? ''}, ${normalizeDate(r['시작일'])})`)
      }
      continue
    }

    const startKey2 = Object.keys(r).find(k => k.replace(/\s+/g, '') === '시작일') ?? '시작일'
    const endKey2   = Object.keys(r).find(k => k.replace(/\s+/g, '') === '종료일') ?? '종료일'
    const startDate = normalizeDate(r[startKey2])
    if (!startDate) continue
    const endDate = normalizeDate(r[endKey2] ?? '') || startDate

    // Directly read the '일수' column — single source of truth for leave amount.
    // Scan all keys normalised to '일수' (handles invisible chars / wrapped headers).
    const iljuKey  = Object.keys(r).find(k => k.replace(/\s+/g, '') === '일수') ?? '일수'
    const iljuStr  = String(r[iljuKey] ?? '').trim()
    const iljuRaw  = parseFloat(iljuStr)

    const baseType: ErpLeaveType = leaveType
    const isSingleDay = (startDate === endDate)

    // Single-day sub-type inference: ERP uses '연차' as a catch-all for all leave grades;
    // the granularity (반차/반반차) lives in '일수'. Only infer on a single-day row.
    const effectiveType: ErpLeaveType =
      (baseType === '연차' && isSingleDay && isFinite(iljuRaw) && iljuRaw > 0 && iljuRaw < 1.0)
        ? (iljuRaw >= 0.5 ? '오전반차' : '오전반반차')
        : baseType

    // Amount per weekday: always use LEAVE_AMOUNT (exact constant — 1.0, 0.5, or 0.25).
    // Multi-day requests divide iljuRaw by calendar days → floating-point error; ignore it.
    // Each WEEKDAY in the range gets the exact semantic amount for this leave type.
    const perDayAmount = LEAVE_AMOUNT[effectiveType] ?? 0

    const isUnpaid = code.includes('무급')

    // 다일 연차(2일 이상)인 경우 프로덕션에서도 로그 출력
    if (typeof window !== 'undefined' && startDate !== endDate) {
      console.log(
        `[TAG ERP 다일연차] "${r['성명'] ?? ''}" 코드="${code}" ${startDate}~${endDate}`,
        `일수=${iljuRaw} type="${effectiveType}" compositeKey="${compositeKey}"`,
      )
    }

    let cur = startDate
    while (cur <= endDate) {
      const { dayType: curDayType } = getDayInfo(cur, companyHolsMap)
      if (curDayType === 'WEEKDAY') {
        const k          = key(compositeKey, cur)
        const existing   = accumMap.get(k)
        const prevAmount = existing?.amount ?? 0
        const newAmount  = Math.min(1.0, prevAmount + perDayAmount)
        const newType: ErpLeaveType = newAmount >= 1.0 ? '연차' : effectiveType
        accumMap.set(k, { amount: newAmount, type: newType, isUnpaid: (existing?.isUnpaid ?? false) || isUnpaid, rawCode: code })
      }
      if (cur === endDate) break
      cur = addOneDayUTC(cur)
    }
  }

  return accumMap
}

// ── OT map ────────────────────────────────────────────────────────────────

/**
 * Builds a flat Map<"empId_date", approvedHours> from the ERP OT file only.
 *
 * A row is counted as applied/approved OT when:
 *   승인상태 is '승인' or '신청'  AND  (근태코드 is OT-type  OR  인정시간 > 0)
 *
 * Map.has() is checked (not value > 0) for erpOtApplied so that an approved
 * application with 인정시간=0 still suppresses the '연장 미신청' flag.
 */
function buildOtMap(
  rows:        ErpUnifiedRow[],
  employeeMap: Map<string, Employee>,
): Map<string, { hours: number; code: string }> {
  const map = new Map<string, { hours: number; code: string }>()

  for (const row of rows) {
    const r = row as unknown as Record<string, string>

    const rawId   = normalizeId(r['사원번호'])
    const erpName = normalizeName(r['성명'])
    if (!rawId || !erpName) continue

    const compositeKey = `${rawId}_${erpName}`
    if (!employeeMap.has(compositeKey)) {
      console.warn(`[TAG] ⚠ ERP 연장근로 미매칭: 사원번호="${rawId}" 성명="${erpName}" → 직원 목록에 없음. 스킵.`)
      continue
    }

    const status = String(r['승인상태'] ?? '').trim()
    if (!isAcceptedStatus(status)) continue

    // 컬럼명 fuzzy 매칭 — buildLeaveMap과 동일하게 (공백/전각문자 차이 대응)
    const codeKey     = Object.keys(r).find(k => k.replace(/\s+/g, '') === '근태코드')  ?? '근태코드'
    const injeongKey  = Object.keys(r).find(k => k.replace(/\s+/g, '') === '인정시간')  ?? '인정시간'
    const startKey    = Object.keys(r).find(k => k.replace(/\s+/g, '') === '시작일')    ?? '시작일'

    const code  = String(r[codeKey]  ?? '').normalize('NFKC').trim()
    const hours = parseInjeongTime(r[injeongKey])

    // Include as OT if code matches OR if non-zero approved hours exist
    const isOT = OT_CODE_SET.has(code) || hours > 0
    if (!isOT) continue

    const startDate = normalizeDate(r[startKey])
    if (!startDate) continue

    const k    = key(compositeKey, startDate)
    const prev = map.get(k)
    map.set(k, { hours: (prev?.hours ?? 0) + hours, code })
  }

  return map
}

// ── Employee extraction ───────────────────────────────────────────────────

function extractEmployees(capsData: CapsRow[]): Employee[] {
  const seen = new Map<string, Employee>()

  for (const row of capsData) {
    const r = row as unknown as Record<string, string>

    const rawId = normalizeId(r['사원번호'])
    // 컬럼명에 숨은 공백·인코딩 차이 대응: '이름' 키를 공백 제거 후 fuzzy 매칭
    const nameKey = Object.keys(r).find(k => k.replace(/\s+/g, '') === '이름') ?? '이름'
    const name    = normalizeName(r[nameKey] ?? r['성명'] ?? '')
    if (!rawId || !name) continue

    // Rule: invalid IDs and excluded departments are silently dropped at parse time
    const dept = String(r['부서'] ?? '').trim()
    if (!isValidEmpId(rawId) || EXCLUDED_DEPTS.has(dept)) continue

    // Composite primary key: employeeId + name → unique per person.
    const compositeKey = `${rawId}_${name}`

    if (seen.has(compositeKey)) continue  // same person appearing in multiple rows — skip

    const { division, team } = getOrganization(dept)

    const jobTitle = String(r['직급'] ?? r['직책'] ?? '').trim()
    const isLeader = LEADER_TITLES.some(t => jobTitle.includes(t)) || undefined

    seen.set(compositeKey, {
      id:    compositeKey,  // canonical unique key used for ALL downstream lookups
      rawId,               // original 사원번호 — display only
      name,                // normalizeName 적용 (NFC + 공백 제거)
      division,
      team,
      jobTitle,
      ...(isLeader && { isLeader }),
      rawDept: dept,
    })
  }

  return [...seen.values()]
}

// ── Main export ───────────────────────────────────────────────────────────

export interface ParseResult {
  employees:      Employee[]
  rawRecords:     RawRecord[]
  skippedCount:   number
  erpOtMatchCount: number   // records where erpOtApplied = true — 0 means OT map empty or no key match
}

export function parseAttendanceData(
  capsData: CapsRow[],
  erpData:  ErpUnifiedRow[],   // single unified ERP array — leave + OT rows mixed
  policy:   PolicySettings = DEFAULT_POLICY,
): ParseResult {
  const employees   = extractEmployees(capsData)
  const employeeMap = new Map(employees.map(e => [e.id, e]))

  // Both maps receive the same unified array; each filters internally by 근태코드
  const companyHolsMap = new Map((policy.companyHolidays ?? []).map(h => [h.date, h.label]))
  const leaveMap    = buildLeaveMap(erpData, employeeMap, companyHolsMap)
  const otMap       = buildOtMap(erpData, employeeMap)

  const rawRecords: RawRecord[] = []
  let   skippedCount = 0

  // Rule 3: E26010101 has dual-department affiliation — same person appears twice per day.
  // Stage their rows here; after the main loop we merge earliest clockIn + latest clockOut.
  const DUAL_AFFIL_PREFIX = 'E26010101_'
  const dualAffilStage = new Map<string, RawRecord>() // key = "compositeKey|date"

  // ── ERP 파싱 결과 요약 (항상 콘솔에 표시) ───────────────────────────────
  if (typeof window !== 'undefined') {
    console.log(
      `[TAG] ERP 파싱 완료 — 휴가 맵 ${leaveMap.size}건 | 연장 맵 ${otMap.size}건 | 직원 ${employees.length}명 | CAPS ${capsData.length}행 | ERP ${erpData.length}행`,
    )
    if (leaveMap.size === 0 && erpData.length > 0) {
      console.warn('[TAG] ⚠ ERP 파일은 있는데 휴가 맵이 0건 — 근태코드·승인상태·컬럼명 확인 필요')
      const firstRow = erpData[0] as unknown as Record<string, string>
      console.warn('[TAG] ERP 첫 행 컬럼명:', Object.keys(firstRow))
      console.warn('[TAG] ERP 첫 행 값:', firstRow)
    }
    if (leaveMap.size > 0) {
      const sample = [...leaveMap.keys()].slice(0, 3)
      console.log('[TAG] 휴가 맵 샘플 키:', sample)
    }
    if (otMap.size === 0 && erpData.length > 0) {
      console.warn('[TAG] ⚠ ERP 파일은 있는데 연장 맵이 0건 — 근태코드·승인상태·시작일 컬럼명 확인 필요')
      const firstRow = erpData[0] as unknown as Record<string, string>
      console.warn('[TAG] ERP 첫 행 컬럼명 (OT 디버그):', Object.keys(firstRow))
    }
    if (otMap.size > 0) {
      const sample = [...otMap.keys()].slice(0, 3)
      console.log('[TAG] 연장 맵 샘플 키:', sample)
    }
  }

  for (const row of capsData) {
    const r = row as unknown as Record<string, string>

    // ── Build composite key — the only key used for ALL lookups ────────────
    const rawId   = String(r['사원번호'] ?? '').trim()
    const nameKey = Object.keys(r).find(k => k.replace(/\s+/g, '') === '이름') ?? '이름'
    const rowName = normalizeName(r[nameKey] ?? r['성명'])
    if (!rawId || !rowName) { skippedCount++; continue }

    // Silent skip for excluded depts / invalid IDs — these were never added to employeeMap,
    // so we drop them here without a console warning to keep logs clean.
    const rowDept = String(r['부서'] ?? '').trim()
    if (!isValidEmpId(rawId) || EXCLUDED_DEPTS.has(rowDept)) { skippedCount++; continue }

    const compositeKey = `${rawId}_${rowName}`
    if (!employeeMap.has(compositeKey)) {
      console.warn(`[TAG] ⚠ CAPS 미등록 직원: 사원번호="${rawId}" 이름="${rowName}" → 직원 목록에 없음. 스킵.`)
      skippedCount++
      continue
    }

    // CAPS dates: "2026/05/01" → replace "/" → "2026-05-01"
    const normDate = normalizeDate(r['근무일자'])
    if (!normDate) { skippedCount++; continue }

    // Skip records that fall before the employee's hire date.
    // Hire date is encoded in rawId: E{YY}{MM}{DD}{SEQ} → 20YY-MM-DD.
    // Masked IDs (asterisks) return null → no filtering applied.
    const hireDate = hireDateFromRawId(rawId)
    if (hireDate && normDate < hireDate) { skippedCount++; continue }

    const lookupKey = key(compositeKey, normDate)

    // 🔍 임시 디버그 — 배영언 lookupKey vs leaveMap
    if (typeof window !== 'undefined' && rowName.includes('배영언') && normDate === '2026-05-26') {
      const found = leaveMap.get(lookupKey)
      console.log(`[DEBUG LOOKUP 배영언] rawId="${rawId}" compositeKey="${compositeKey}" lookupKey="${lookupKey}" → leaveEntry=${found ? JSON.stringify(found) : 'undefined'}`)
      console.log(`[DEBUG LOOKUP 배영언] leaveMap 전체 키 중 배영언 포함:`, [...leaveMap.keys()].filter(k => k.includes('배영언')))
    }

    // 🔍 이현지 동명이인 CAPS 진단 — 날짜별 leave 매칭 결과 전 건 로그
    if (typeof window !== 'undefined' && rowName.includes('이현지')) {
      const leaveHit = leaveMap.get(lookupKey)
      console.log(
        `[이현지 CAPS] rawId="${rawId}" compositeKey="${compositeKey}" date="${normDate}"`,
        `lookupKey="${lookupKey}"`,
        `→ leave=${leaveHit ? JSON.stringify(leaveHit) : 'NONE'}`,
      )
      // leaveMap 전체 중 이현지 포함 키 출력 (최초 1회 기준)
      if (normDate <= '2026-06-01') {
        const ihjKeys = [...leaveMap.keys()].filter(k => k.includes('이현지'))
        console.log(`[이현지 leaveMap 전체 키]`, ihjKeys)
      }
    }

    // ── Debug: trace a specific employee ─────────────────────────────────
    if (typeof window !== 'undefined' &&
        process.env.NODE_ENV !== 'production' &&
        (rawId.includes('2701') || rowName.includes('담'))) {
      console.log(
        `[TAG debug] compositeKey="${compositeKey}" date="${normDate}" lookupKey="${lookupKey}"`,
        `→ leave=${leaveMap.get(lookupKey) ?? 'none'}`,
        `ot=${otMap.get(lookupKey) ?? 'none'}`,
      )
    }

    const { dayType, dayLabel } = getDayInfo(normDate, companyHolsMap)
    // CAPS exports "0:00" (or "00:00") as a zero-fill placeholder for absent days — treat as null
    const rawIn       = (r['출근'] ?? '').trim()
    const rawOut      = (r['퇴근'] ?? '').trim()
    const clockIn     = (rawIn  === '0:00' || rawIn  === '00:00') ? null : normalizeTime(rawIn  || null)
    const rawClockOut = (rawOut === '0:00' || rawOut === '00:00') ? null : normalizeTime(rawOut || null)
    // Auto-detect next-day clock-out: CAPS sometimes exports plain "01:30" (no '+').
    // If the numeric value is strictly less than clock-in, it must be past midnight.
    const clockOut: string | null =
      clockIn && rawClockOut && !rawClockOut.startsWith('+') &&
      toMinutes(rawClockOut) < toMinutes(clockIn)
        ? '+' + rawClockOut
        : rawClockOut

    // ── Leave lookup ──────────────────────────────────────────────────────
    const leaveEntry = leaveMap.get(lookupKey)
    let leaveType: ErpLeaveType | null = leaveEntry?.type ?? null

    // 방향 미명시 반차 재추론: rawCode에 '오전'/'오후'가 없으면 출퇴근 시각으로 방향 결정
    // e.g. '생일반차휴가' → normalizeLeaveType이 퇴근≤14:00이면 '오후반차'로 정정
    // e.g. '건강검진휴가' → normalizeLeaveType이 null 반환 시 시각 직접 추론
    if (
      (leaveType === '오전반차' || leaveType === '오후반차') &&
      leaveEntry?.rawCode &&
      !leaveEntry.rawCode.includes('오전') &&
      !leaveEntry.rawCode.includes('오후')
    ) {
      const inferred = normalizeLeaveType(leaveEntry.rawCode, clockIn, clockOut)
      if (inferred === '오전반차' || inferred === '오후반차') {
        leaveType = inferred
      } else if (inferred === null && (clockIn || clockOut)) {
        // rawCode에 '반차' 키워드 없는 코드(건강검진휴가 등) → 시각으로 직접 추론
        // 퇴근 ≤ 14:00: 오전 근무 후 오후에 자리 비움 → 오후반차
        // 출근 ≥ 12:00: 오후에 출근 → 오전을 쉰 것 → 오전반차
        if (clockOut && toMinutes(clockOut) <= 14 * 60) leaveType = '오후반차'
        else if (clockIn && toMinutes(clockIn) >= 12 * 60) leaveType = '오전반차'
        // else: 기존 '오전반차' 유지
      }
    }

    // erpLeaveAmount: exact semantic amount from LEAVE_AMOUNT[type] — 1.0 / 0.5 / 0.25.
    const erpLeaveAmount: number | undefined = leaveEntry?.amount
    const isUnpaidLeave: boolean = leaveEntry?.isUnpaid ?? false

    // ── Diagnostic: log leave lookup result for every row (dev only) ─────
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production' && leaveEntry) {
      console.log(
        `[TAG] leave hit: empId="${compositeKey}" date="${normDate}"`,
        `→ type="${leaveEntry.type}" amount=${leaveEntry.amount}`,
        `(erpLeaveAmount=${erpLeaveAmount})`,
      )
    }

    // ── OT lookup ─────────────────────────────────────────────────────────
    const otEntry            = otMap.get(lookupKey)
    const erpApprovedOtHours = otEntry?.hours ?? 0
    // Use map.has() so an approved-but-0h entry still suppresses the flag
    const erpOtApplied = otMap.has(lookupKey)
    const erpOtCode    = otEntry?.code ?? null

    // ── Holiday-work flag ─────────────────────────────────────────────────
    const isHolidayWork =
      dayType !== 'WEEKDAY' && (clockIn !== null || clockOut !== null)

    // ── Cross-check verification notes ───────────────────────────────────
    const verificationNote: string[] = []

    // 0. ERP OT/holiday confirmed (승인 or 신청/상신) → memo for column M
    if (erpOtApplied && erpOtCode) {
      if (erpOtCode === '휴일근로') {
        verificationNote.push('ERP 휴일근로 확인')
      } else if (OT_CODE_SET.has(erpOtCode)) {
        verificationNote.push('ERP 연장근로 확인')
      }
    }

    // 1. Missing clock record: weekday CAPS row with no leave
    //    No clock-in (whether or not clock-out exists) → 출근기록없음
    //    Clock-in present but no clock-out            → 퇴근기록없음
    if (dayType === 'WEEKDAY' && !leaveType) {
      if (!clockIn) verificationNote.push('출근기록없음')
      else if (!clockOut) verificationNote.push('퇴근기록없음')
    }

    // 2. 휴가 중 출근: approved 연차 but clock-in also exists
    if (leaveType === '연차' && clockIn !== null) {
      verificationNote.push('휴가 중 출근')
    }

    // 3. 연장 미신청: truncated OT > 0 AND no ERP OT applied AND not a leader
    //    Leaders (팀장, 본부장, …) are exempt from OT anomaly flagging.
    if (dayType === 'WEEKDAY' && clockIn && clockOut &&
        !employeeMap.get(compositeKey)?.isLeader) {
      const lunchMins       = toMinutes(policy.lunchEnd) - toMinutes(policy.lunchStart)
      const standardMinutes = policy.standardHours * 60 + lunchMins + policy.dinnerGraceMinutes
      const snapInMins      = Math.max(toMinutes(clockIn), toMinutes(policy.flexStart))
      const rawExtra        = toMinutes(clockOut) - snapInMins - standardMinutes
      const validOtMinutes  = Math.floor(Math.max(0, rawExtra) / policy.otUnitMinutes) * policy.otUnitMinutes
      if (validOtMinutes > 0 && !erpOtApplied) {
        verificationNote.push('연장 미신청')
      }
    }

    const newRecord: RawRecord = {
      employeeId:   compositeKey,   // canonical composite key — matches Employee.id
      date:         normDate,
      dayType,
      dayLabel,
      clockIn,
      clockOut,
      erpOtApplied,
      ...(erpApprovedOtHours > 0 && { erpApprovedOtHours }),
      leaveType,
      ...(erpLeaveAmount !== undefined && { erpLeaveAmount }),
      ...(isUnpaidLeave && { isUnpaidLeave }),
      ...(leaveEntry?.rawCode && { rawLeaveCode: leaveEntry.rawCode }),
      isHolidayWork,
      ...(employeeMap.get(compositeKey)?.isLeader && { isLeader: true }),
      ...(verificationNote.length > 0 && { verificationNote }),
    }

    // Rule 3: E26010101 dual-affiliation — merge per date instead of pushing directly
    if (compositeKey.startsWith(DUAL_AFFIL_PREFIX)) {
      const stageKey = `${compositeKey}|${normDate}`
      const prev = dualAffilStage.get(stageKey)
      if (!prev) {
        dualAffilStage.set(stageKey, newRecord)
      } else {
        const mergedClockIn  = mergeEarliest(prev.clockIn,  newRecord.clockIn)
        const mergedClockOut = mergeLatest(prev.clockOut, newRecord.clockOut)
        // Recompute missing-time notes for the merged result
        const otherNotes = [...new Set([
          ...(prev.verificationNote    ?? []),
          ...(newRecord.verificationNote ?? []),
        ])].filter(n => n !== '출근기록없음' && n !== '퇴근기록없음')
        if (dayType === 'WEEKDAY' && !leaveType) {
          if (!mergedClockIn) otherNotes.push('출근기록없음')
          else if (!mergedClockOut) otherNotes.push('퇴근기록없음')
        }
        dualAffilStage.set(stageKey, {
          ...prev,
          clockIn:  mergedClockIn,
          clockOut: mergedClockOut,
          erpOtApplied: prev.erpOtApplied || newRecord.erpOtApplied,
          ...(otherNotes.length && { verificationNote: otherNotes }),
        })
      }
    } else {
      rawRecords.push(newRecord)
    }
  }

  // Flush merged dual-affiliation records
  for (const record of dualAffilStage.values()) rawRecords.push(record)

  const erpOtMatchCount = rawRecords.filter(r => r.erpOtApplied).length

  if (typeof window !== 'undefined') {
    console.log(
      `[TAG] ERP 연장근로 매칭 결과: ${erpOtMatchCount}건 / 전체 ${rawRecords.length}건 (연장 맵 ${otMap.size}건)`,
    )
    if (erpOtMatchCount === 0 && otMap.size > 0) {
      console.warn('[TAG] ⚠ OT 맵에 항목은 있으나 CAPS 레코드와 날짜·사번이 매칭되지 않음 — 날짜 포맷 또는 사번 형식 확인 필요')
    }
  }

  return { employees, rawRecords, skippedCount, erpOtMatchCount }
}
