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
 *  • COMPOSITE EMPLOYEE KEY: "${maskedEmpId}_${normalizeName(name)}"
 *    → masked IDs (e.g. "E250**1501") are NOT unique; name is required as the 2nd factor
 *    → Employee.id == compositeKey; Employee.rawId == original masked empId for display
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
 * Valid employee ID format: 'E' followed by ≥ 8 digits or masking asterisks.
 * Rejects pure-numeric IDs, very short IDs, and non-E-prefixed entries
 * (e.g. visitor codes, contractor numbers) that occasionally appear in CAPS.
 * Masked IDs like "E250**1501" pass because they match E + 8+ [digit|*] chars.
 */
function isValidEmpId(rawId: string): boolean {
  return /^E[\d*]{8,}$/.test(rawId)
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

// ── Name-only fallback index ──────────────────────────────────────────────

/**
 * Builds a normalizedName → employeeId map for resolving ERP rows whose
 * 사원번호 format differs from CAPS (e.g., CAPS masks digits as *, ERP uses
 * the full unmasked ID).  Entries for non-unique names (동명이인) are
 * deliberately removed so they cannot cause a wrong-employee assignment.
 */
function buildNameOnlyFallback(employeeMap: Map<string, Employee>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [empId, emp] of employeeMap) {
    const n = normalizeName(emp.name)
    if (m.has(n)) m.delete(n)   // duplicate name — never safe to use as a fallback
    else          m.set(n, empId)
  }
  return m
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
  const nameOnlyFallback = buildNameOnlyFallback(employeeMap)

  // 이름 → 모든 compositeKey 목록 (마스킹 불일치 대응)
  // 같은 이름이 다른 사번으로 두 CAPS 파일에 나타날 때 모든 키에 leave 저장
  const nameToAllKeys = new Map<string, string[]>()
  for (const [empId, emp] of employeeMap) {
    const n = normalizeName(emp.name)
    if (!nameToAllKeys.has(n)) nameToAllKeys.set(n, [])
    nameToAllKeys.get(n)!.push(empId)
  }

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

    let compositeKey = `${rawId}_${erpName}`
    if (!employeeMap.has(compositeKey)) {
      const fallbackId = nameOnlyFallback.get(erpName)
      if (fallbackId) {
        compositeKey = fallbackId
      } else {
        console.warn(`[TAG] ⚠ ERP 휴가 미매칭: 사원번호="${rawId}" 성명="${erpName}" → 직원 목록에 없음 (동명이인 또는 미등록). 스킵.`)
        continue
      }
    }

    const status = String(r['승인상태'] ?? '').trim()
    if (!isAcceptedStatus(status)) continue

    const code = String(r['근태코드'] ?? '').trim()
    if (OT_CODE_SET.has(code)) continue

    const category = String(r['근태구분'] ?? '').trim()
    if (category === '시간') continue

    const startDate = normalizeDate(r['시작일'])
    if (!startDate) continue
    const endDate = normalizeDate(r['종료일'] ?? '') || startDate

    // 🔍 임시 디버그 — ERP 휴가 매핑 확인
    if (typeof window !== 'undefined' && (r['성명'] ?? '').includes('배영언')) {
      console.log(`[DEBUG ERP 배영언] compositeKey="${compositeKey}" code="${code}" start="${startDate}" end="${endDate}"`)
    }

    const dk       = `${compositeKey}||${code}||${startDate}||${endDate}`
    const existing = dedupMap.get(dk)
    if (!existing || leavePriority(status) > leavePriority(String(existing.row['승인상태'] ?? '').trim())) {
      dedupMap.set(dk, { compositeKey, row: r })
    }
  }

  // ── Pass 2: accumulation with type inference ──────────────────────────
  for (const { compositeKey, row: r } of dedupMap.values()) {
    const code = String(r['근태코드'] ?? '').trim()

    const leaveType = ERP_LEAVE_TYPE_MAP[code]
    if (!leaveType) continue  // code not in leave whitelist — silently skip

    const startDate = normalizeDate(r['시작일'])
    if (!startDate) continue
    const endDate = normalizeDate(r['종료일'] ?? '') || startDate

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

    // ── Diagnostic: log every processed ERP leave row (dev only) ─────────
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
      console.log(
        `[TAG] ERP leave row: 성명="${r['성명'] ?? ''}" 코드="${code}" 시작="${startDate}" 종료="${endDate}"`,
        `일수key="${iljuKey}" 일수_raw="${iljuStr}" 일수_parsed=${iljuRaw}`,
        `effectiveType="${effectiveType}" perDayAmount=${perDayAmount} → compositeKey="${compositeKey}"`,
      )
    }

    // 마스킹 불일치 대응: 같은 이름의 모든 compositeKey에 저장
    const rowName2 = normalizeName(String(r['성명'] ?? '').trim())
    const allKeysForName = nameToAllKeys.get(rowName2) ?? [compositeKey]

    let cur = startDate
    while (cur <= endDate) {
      const { dayType: curDayType } = getDayInfo(cur, companyHolsMap)
      if (curDayType === 'WEEKDAY') {
        for (const cKey of allKeysForName) {
          const k          = key(cKey, cur)
          const existing   = accumMap.get(k)
          const prevAmount = existing?.amount ?? 0
          const newAmount  = Math.min(1.0, prevAmount + perDayAmount)
          const newType: ErpLeaveType = newAmount >= 1.0 ? '연차' : effectiveType
          accumMap.set(k, { amount: newAmount, type: newType, isUnpaid: (existing?.isUnpaid ?? false) || isUnpaid, rawCode: code })
        }
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

  const nameOnlyFallback = buildNameOnlyFallback(employeeMap)

  for (const row of rows) {
    const r = row as unknown as Record<string, string>

    const rawId   = normalizeId(r['사원번호'])
    const erpName = normalizeName(r['성명'])
    if (!rawId || !erpName) continue

    let compositeKey = `${rawId}_${erpName}`
    if (!employeeMap.has(compositeKey)) {
      const fallbackId = nameOnlyFallback.get(erpName)
      if (fallbackId) {
        compositeKey = fallbackId
      } else {
        console.warn(`[TAG] ⚠ ERP 연장근로 미매칭: 사원번호="${rawId}" 성명="${erpName}" → 직원 목록에 없음 (동명이인 또는 미등록). 스킵.`)
        continue
      }
    }

    const status = String(r['승인상태'] ?? '').trim()
    if (!isAcceptedStatus(status)) continue

    const code  = String(r['근태코드'] ?? '').trim()
    const hours = parseInjeongTime(r['인정시간'])

    // Include as OT if code matches OR if non-zero approved hours exist
    const isOT = OT_CODE_SET.has(code) || hours > 0
    if (!isOT) continue

    const startDate = normalizeDate(r['시작일'])
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
    const name  = String(r['이름'] ?? r['성명'] ?? '').trim()
    if (!rawId || !name) continue

    // Rule: invalid IDs and excluded departments are silently dropped at parse time
    const dept = String(r['부서'] ?? '').trim()
    if (!isValidEmpId(rawId) || EXCLUDED_DEPTS.has(dept)) continue

    // Composite primary key: masked IDs are NOT unique on their own.
    // "E250**1501_김희" and "E250**1501_이수" are two distinct people.
    const compositeKey = `${rawId}_${normalizeName(name)}`

    if (seen.has(compositeKey)) continue  // same person appearing in multiple rows — skip

    const { division, team } = getOrganization(dept)

    const jobTitle = String(r['직급'] ?? r['직책'] ?? '').trim()
    const isLeader = LEADER_TITLES.some(t => jobTitle.includes(t)) || undefined

    seen.set(compositeKey, {
      id:    compositeKey,  // canonical unique key used for ALL downstream lookups
      rawId,               // original masked 사원번호 — display only
      name,
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
  employees:    Employee[]
  rawRecords:   RawRecord[]
  skippedCount: number
}

export function parseAttendanceData(
  capsData: CapsRow[],
  erpData:  ErpUnifiedRow[],   // single unified ERP array — leave + OT rows mixed
  policy:   PolicySettings = DEFAULT_POLICY,
): ParseResult {
  const employees   = extractEmployees(capsData)
  const employeeMap = new Map(employees.map(e => [e.id, e]))

  // 사번 마스킹 불일치 대응: 이름 기반 fallback (동명이인은 제외)
  const capsFallbackMap = buildNameOnlyFallback(employeeMap)

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

  // 🔍 임시: leaveMap에서 배영언 키 확인
  if (typeof window !== 'undefined') {
    const byKeys = [...leaveMap.keys()].filter(k => k.includes('배영언'))
    console.log(`[DEBUG leaveMap 배영언] ${byKeys.length}건:`, byKeys)
  }

  // ── Debug: confirm map sizes in browser console ──────────────────────────
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(
      '[TAG] leaveMap', leaveMap.size, 'keys |',
      'otMap', otMap.size, 'keys |',
      'employees', employees.length, '|',
      'caps rows', capsData.length,
    )
    // Sample a few keys from each map for visual confirmation
    const lSample = [...leaveMap.keys()].slice(0, 3)
    const oSample = [...otMap.keys()].slice(0, 3)
    if (lSample.length) console.log('[TAG] leaveMap sample keys:', lSample)
    if (oSample.length) console.log('[TAG] otMap sample keys:', oSample)
  }

  for (const row of capsData) {
    const r = row as unknown as Record<string, string>

    // ── Build composite key — the only key used for ALL lookups ────────────
    const rawId   = String(r['사원번호'] ?? '').trim()
    const rowName = normalizeName(r['이름'] ?? r['성명'])
    if (!rawId || !rowName) { skippedCount++; continue }

    // Silent skip for excluded depts / invalid IDs — these were never added to employeeMap,
    // so we drop them here without a console warning to keep logs clean.
    const rowDept = String(r['부서'] ?? '').trim()
    if (!isValidEmpId(rawId) || EXCLUDED_DEPTS.has(rowDept)) { skippedCount++; continue }

    // Composite key = masked empId + normalized name.
    let compositeKey = `${rawId}_${rowName}`

    // 두 CAPS 파일의 사번 마스킹 불일치 대응:
    // 직접 매칭 실패 시 이름 기반 fallback (동명이인 제외)
    if (!employeeMap.has(compositeKey)) {
      const fallbackId = capsFallbackMap.get(rowName)
      if (fallbackId) {
        compositeKey = fallbackId
      } else {
        console.warn(`[TAG] ⚠ CAPS 미등록 직원: 사원번호="${rawId}" 이름="${rowName}" → 직원 목록에 없음. 스킵.`)
        skippedCount++
        continue
      }
    }

    // CAPS dates: "2026/05/01" → replace "/" → "2026-05-01"
    const normDate = normalizeDate(r['근무일자'])
    if (!normDate) { skippedCount++; continue }

    const lookupKey = key(compositeKey, normDate)

    // 🔍 임시 디버그 — 배영언 lookupKey vs leaveMap
    if (typeof window !== 'undefined' && rowName.includes('배영언') && normDate === '2026-05-26') {
      const found = leaveMap.get(lookupKey)
      console.log(`[DEBUG LOOKUP 배영언] rawId="${rawId}" compositeKey="${compositeKey}" lookupKey="${lookupKey}" → leaveEntry=${found ? JSON.stringify(found) : 'undefined'}`)
      console.log(`[DEBUG LOOKUP 배영언] leaveMap 전체 키 중 배영언 포함:`, [...leaveMap.keys()].filter(k => k.includes('배영언')))
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
    const clockIn     = normalizeTime(r['출근'] || null)
    const rawClockOut = normalizeTime(r['퇴근'] || null)
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
    if (
      (leaveType === '오전반차' || leaveType === '오후반차') &&
      leaveEntry?.rawCode &&
      !leaveEntry.rawCode.includes('오전') &&
      !leaveEntry.rawCode.includes('오후')
    ) {
      const inferred = normalizeLeaveType(leaveEntry.rawCode, clockIn, clockOut)
      if (inferred === '오전반차' || inferred === '오후반차') leaveType = inferred
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

  return { employees, rawRecords, skippedCount }
}
