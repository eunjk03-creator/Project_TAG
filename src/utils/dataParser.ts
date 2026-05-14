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
import type {
  Employee, RawRecord, CapsRow, ErpRow, ErpOtRow, ErpLeaveType, DayType, PolicySettings,
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
 * Accepted ERP 승인상태 values — both approved ('승인') and pending ('신청').
 * Explicitly rejected: '승인취소', '반려'.
 * Using substring logic so '신청중' etc. are also covered.
 */
function isAcceptedStatus(status: string): boolean {
  if (status.includes('취소') || status.includes('반려')) return false
  return status.includes('승인') || status.includes('신청')
}

/** 근태코드 values that represent overtime (not leave). */
const OT_CODE_SET = new Set(['연장근로', '시간외', '시간외근무', '연장근무', '휴일근로'])

/**
 * Job titles / roles that are exempt from 미신청OT flagging.
 * Leaders are assumed to manage their own schedules.
 */
const LEADER_TITLES = ['CEO', 'CSO', 'CFO', '본부장', '팀장', '부문장', '실장', '센터장']

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
  return String(raw ?? '').trim().replace(/\s+/g, '')
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

function getDayInfo(dateStr: string): { dayType: DayType; dayLabel: string } {
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

// ── Leave map ─────────────────────────────────────────────────────────────

/**
 * Builds a flat Map<"empId_date", ErpLeaveType> from BOTH ERP files.
 *
 * Why both files?  The ERP overtime file sometimes carries leave-type entries
 * (e.g. an employee files 반차 + OT on the same day as two separate rows).
 *
 * Leave file (ErpRow) has 종료일  → expand multi-day ranges.
 * OT file (ErpOtRow) has no 종료일 → single-date entry only.
 *
 * Rows are only included when:
 *   승인상태 is '승인' or '신청' (not '승인취소'/'반려')  AND  근태코드 is NOT an OT-type code
 */
function buildLeaveMap(
  leaveRows:   ErpRow[],
  otRows:      ErpOtRow[],
  employeeMap: Map<string, Employee>,
): Map<string, ErpLeaveType> {
  const map = new Map<string, ErpLeaveType>()

  // ── From leave file (with range expansion) ──────────────────────────────
  for (const row of leaveRows) {
    const r = row as unknown as Record<string, string>

    const rawId   = normalizeId(r['사원번호'])
    const erpName = normalizeName(r['성명'])
    if (!rawId || !erpName) continue

    // Composite lookup — implicitly enforces ID AND name match in one step.
    // If the name in ERP doesn't match any CAPS entry for this masked ID,
    // no composite key will exist → row is skipped, no data corruption.
    const compositeKey = `${rawId}_${erpName}`
    if (!employeeMap.has(compositeKey)) {
      console.warn(`[TAG] ⚠ ERP 휴가 미매칭: 사원번호="${rawId}" 성명="${erpName}" (키="${compositeKey}") → 직원 목록에 없음. 스킵.`)
      continue
    }

    const status = String(r['승인상태'] ?? '').trim()
    if (!isAcceptedStatus(status)) continue

    const code = String(r['근태코드'] ?? '').trim()
    if (OT_CODE_SET.has(code)) continue

    const leaveType = ERP_LEAVE_TYPE_MAP[code]
    if (!leaveType) continue

    const startDate = normalizeDate(r['시작일'])
    if (!startDate) continue

    const endDate = normalizeDate(r['종료일']) || startDate

    let cur = startDate
    while (cur <= endDate) {
      map.set(key(compositeKey, cur), leaveType)
      if (cur === endDate) break
      cur = addOneDayUTC(cur)
    }
  }

  // ── From OT file (single-date, no 종료일) ────────────────────────────────
  for (const row of otRows) {
    const r = row as unknown as Record<string, string>

    const rawId   = normalizeId(r['사원번호'])
    const erpName = normalizeName(r['성명'])
    if (!rawId || !erpName) continue

    const compositeKey = `${rawId}_${erpName}`
    if (!employeeMap.has(compositeKey)) {
      console.warn(`[TAG] ⚠ ERP OT(휴가출처) 미매칭: 사원번호="${rawId}" 성명="${erpName}" → 직원 목록에 없음. 스킵.`)
      continue
    }

    const status = String(r['승인상태'] ?? '').trim()
    if (!isAcceptedStatus(status)) continue

    const code = String(r['근태코드'] ?? '').trim()
    if (OT_CODE_SET.has(code)) continue

    const leaveType = ERP_LEAVE_TYPE_MAP[code]
    if (!leaveType) continue

    const startDate = normalizeDate(r['시작일'])
    if (!startDate) continue

    const k = key(compositeKey, startDate)
    if (!map.has(k)) map.set(k, leaveType)
  }

  return map
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
  otRows:      ErpOtRow[],
  employeeMap: Map<string, Employee>,
): Map<string, { hours: number; code: string }> {
  const map = new Map<string, { hours: number; code: string }>()

  for (const row of otRows) {
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

    // Composite primary key: masked IDs are NOT unique on their own.
    // "E250**1501_김희" and "E250**1501_이수" are two distinct people.
    const compositeKey = `${rawId}_${normalizeName(name)}`

    if (seen.has(compositeKey)) continue  // same person appearing in multiple rows — skip

    const dept = String(r['부서'] ?? '').trim()
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
  capsData:     CapsRow[],
  erpLeaveData: ErpRow[],
  erpOtData:    ErpOtRow[],
  policy:       PolicySettings = DEFAULT_POLICY,
): ParseResult {
  const employees   = extractEmployees(capsData)
  const employeeMap = new Map(employees.map(e => [e.id, e]))
  // Pass employeeMap so ERP rows are cross-validated against CAPS names (strict AND match)
  const leaveMap    = buildLeaveMap(erpLeaveData, erpOtData, employeeMap)
  const otMap       = buildOtMap(erpOtData, employeeMap)

  const rawRecords: RawRecord[] = []
  let   skippedCount = 0

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

    // Composite key = masked empId + normalized name.
    // Two people sharing the same masked ID (e.g. "E250**1501") produce
    // different composite keys and are treated as distinct employees.
    const compositeKey = `${rawId}_${rowName}`

    // If this composite key is not in employeeMap, the row is orphaned
    // (no CAPS employee entry for this exact ID+name combination).
    if (!employeeMap.has(compositeKey)) {
      console.warn(`[TAG] ⚠ CAPS 미등록 직원: 사원번호="${rawId}" 이름="${rowName}" → 직원 목록에 없음. 스킵.`)
      skippedCount++
      continue
    }

    // CAPS dates: "2026/05/01" → replace "/" → "2026-05-01"
    const normDate = normalizeDate(r['근무일자'])
    if (!normDate) { skippedCount++; continue }

    const lookupKey = key(compositeKey, normDate)

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

    const { dayType, dayLabel } = getDayInfo(normDate)
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
    const leaveType: ErpLeaveType | null = leaveMap.get(lookupKey) ?? null

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

    // 0. ERP OT/holiday approved → add memo so the table column M shows it
    if (erpOtApplied && erpOtCode) {
      if (erpOtCode === '휴일근로') {
        verificationNote.push('ERP 휴일근로 승인')
      } else if (OT_CODE_SET.has(erpOtCode)) {
        verificationNote.push('ERP 연장근로 승인')
      }
    }

    // 1. 출퇴근 누락: weekday CAPS row with no times and no leave
    if (dayType === 'WEEKDAY' && !clockIn && !clockOut && !leaveType) {
      verificationNote.push('출퇴근 누락')
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

    rawRecords.push({
      employeeId:   compositeKey,   // canonical composite key — matches Employee.id
      date:         normDate,
      dayType,
      dayLabel,
      clockIn,
      clockOut,
      erpOtApplied,
      ...(erpApprovedOtHours > 0 && { erpApprovedOtHours }),
      leaveType,
      isHolidayWork,
      ...(employeeMap.get(compositeKey)?.isLeader && { isLeader: true }),
      ...(verificationNote.length > 0 && { verificationNote }),
    })
  }

  return { employees, rawRecords, skippedCount }
}
