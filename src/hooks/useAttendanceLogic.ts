'use client'
import { useMemo } from 'react'
import type { PolicySettings, RawRecord, ProcessedRecord, AggregatedStats, SieveFlag, FinalStatus, EmployeeAttributeOverrides, ErpLeaveType } from '@/types/tag'
import { EMPLOYEES } from '@/data/orgChart'
import { normalizeLeaveType } from '@/utils/attendanceCalc'

function parseTime(hhmm: string): number {
  const isNext = hhmm.startsWith('+')
  const clean  = isNext ? hhmm.slice(1) : hhmm
  const parts  = clean.split(':')
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  // Seconds (parts[2]) are intentionally dropped — Rule 1: truncate, never round
  return h * 60 + m + (isNext ? 1440 : 0)
}

function fmtMins(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function processRecord(
  record: RawRecord,
  policy: PolicySettings,
  otExemptIds: Set<string> = new Set(),
  slackNoteMap: Map<string, { note: string; rawText: string }[]> = new Map(),
  attrOverrides?: EmployeeAttributeOverrides,
): ProcessedRecord {
  const { clockIn, erpOtApplied } = record
  // Resolve dayType: company holidays override CSV value; then DOW-guard for mistagged weekends
  const isCompanyHoliday = (policy.companyHolidays ?? []).some(h => h.date === record.date)
  const _actualDow = new Date(record.date + 'T12:00').getDay()
  const dayType = isCompanyHoliday ? 'HOLIDAY' as const :
    (record.dayType !== 'HOLIDAY' && (_actualDow === 0 || _actualDow === 6))
      ? 'WEEKEND' as const
      : record.dayType
  // Defense-in-depth: raw CAPS export sometimes omits '+' for next-day punch-outs.
  // If the parsed clock-out value is numerically less than clock-in, it must be past midnight.
  const clockOut: string | null = (() => {
    const raw = record.clockOut
    if (!raw || raw.startsWith('+') || !clockIn) return raw
    return parseTime(raw) < parseTime(clockIn) ? `+${raw}` : raw
  })()

  // ── Slack leave injection: when Slack says half-day and ERP has no leave ──
  // Computed before all arithmetic so thresholds and targets see the correct leave type.
  // ERP data always takes precedence; Slack is a fallback for ERP 미신청 cases only.
  const allSlackEntries = slackNoteMap.get(`${record.employeeId}_${record.date}`) ?? []
  // 반차/반반차 항목 중 첫 번째만 leave injection에 사용
  const slackEntry_ = (record.dayType === 'WEEKDAY' && !record.leaveType)
    ? allSlackEntries.find(e => {
        const norm = normalizeLeaveType(e.note, clockIn, clockOut)
        return norm && norm !== '연차'
      })
    : undefined
  // Normalise raw Slack text → canonical leave type; exclude 연차 (handled by applySlack)
  const _slackNorm     = slackEntry_
    ? normalizeLeaveType(slackEntry_.note, clockIn, clockOut)
    : null
  const slackHalfLeave = (_slackNorm && _slackNorm !== '연차') ? _slackNorm : null
  const effectiveLeaveType: ErpLeaveType | null | undefined = record.leaveType ?? slackHalfLeave ?? null
  const slackLeaveInjected = effectiveLeaveType != null && effectiveLeaveType !== (record.leaveType ?? null)
  const effectiveLeaveAmount: number = slackLeaveInjected
    ? (effectiveLeaveType === '오전반반차' || effectiveLeaveType === '오후반반차' ? 0.25 : 0.5)
    : (record.erpLeaveAmount ?? 0)

  // ── Per-employee attribute overrides ──────────────────────────────────────
  const isParentalLeave = (attrOverrides?.isParentalLeave ?? false) && (
    (!attrOverrides?.parentalLeaveFrom || record.date >= attrOverrides.parentalLeaveFrom) &&
    (!attrOverrides?.parentalLeaveTo   || record.date <= attrOverrides.parentalLeaveTo)
  )
  const isShortenedHours = (attrOverrides?.isShortenedHours ?? false) && (
    (!attrOverrides?.shortenedHoursFrom || record.date >= attrOverrides.shortenedHoursFrom) &&
    (!attrOverrides?.shortenedHoursTo   || record.date <= attrOverrides.shortenedHoursTo)
  )

  // 임신기 단축근로 날짜 범위 사전 체크 (effectiveStdH 계산에 필요)
  const _pregActive = (attrOverrides?.isPregnantReduced ?? false) && (
    (!attrOverrides?.pregnantReducedFrom || record.date >= attrOverrides.pregnantReducedFrom) &&
    (!attrOverrides?.pregnantReducedTo   || record.date <= attrOverrides.pregnantReducedTo)
  )

  const effectiveStdH = _pregActive ? 6 :
    isShortenedHours ? (attrOverrides?.shortenedHoursValue ?? 6) :
    policy.standardHours
  const isTenAMStarter     = attrOverrides?.isTenAMStarter     ?? false
  const isDispatchedWorker = (attrOverrides?.isDispatchedWorker ?? false) && (
    (!attrOverrides?.dispatchedWorkerFrom || record.date >= attrOverrides.dispatchedWorkerFrom) &&
    (!attrOverrides?.dispatchedWorkerTo   || record.date <= attrOverrides.dispatchedWorkerTo)
  )
  const isEasyLogis        = attrOverrides?.isEasyLogis        ?? false
  const isFixedScheduleA   = attrOverrides?.isFixedScheduleA   ?? false
  const isFixedScheduleB   = attrOverrides?.isFixedScheduleB   ?? false
  // 날짜 범위 체크: validFrom/validTo가 있으면 record.date가 범위 내일 때만 적용
  const _pregnantFlag = attrOverrides?.isPregnantReduced ?? false
  const _pFrom = attrOverrides?.pregnantReducedFrom
  const _pTo   = attrOverrides?.pregnantReducedTo
  const isPregnantReduced = _pregnantFlag && (
    (!_pFrom || record.date >= _pFrom) &&
    (!_pTo   || record.date <= _pTo)
  )
  const isGlobalExclusion  = attrOverrides?.isGlobalExclusion  ?? false
  // 퇴사자: resignedFrom(퇴사일) 이후 날짜부터 적용
  const isResigned = (attrOverrides?.isResigned ?? false) && (
    !attrOverrides?.resignedFrom || record.date >= attrOverrides.resignedFrom
  )

  const bypassAllAnomalies = isParentalLeave

  const policyFlexStartMins = parseTime(policy.flexStart)  // 08:00 — 클램핑 기준 (모든 직원 공통)
  const policyFlexEndMins   = parseTime(policy.flexEnd)    // 09:00 — 일반 지각 기준
  const flexStartMins       = policyFlexStartMins          // 10시 출근자도 클램핑은 08:00
  const flexEndMins         = isTenAMStarter ? 10 * 60 : policyFlexEndMins  // 지각 기준만 분리
  const lunchStartMins = parseTime(policy.lunchStart)
  const lunchEndMins   = parseTime(policy.lunchEnd)
  const nightStartMins = parseTime(policy.nightStart)
  const nightEndMins   = parseTime(policy.nightEnd) + 1440

  const base: ProcessedRecord = {
    ...record,
    dayType,   // propagate overridden dayType (company holiday / DOW correction)
    ...(slackLeaveInjected ? { leaveType: effectiveLeaveType, erpLeaveAmount: effectiveLeaveAmount } : {}),
    effectiveClockIn: null,
    regularHours:  0,
    overtimeHours: 0,
    nightHours:    0,
    holidayHours:  0,
    breakMinutes:  0,
    lunchDeducted: false,
    dinnerDeducted: false,
    flag:        null,
    finalStatus: '정상',
  }

  // ── Global exclusion / resigned — silently treat as 정상, no aggregation impact ───
  if (isGlobalExclusion || isResigned) {
    // 08:00 이전 출근은 전역 제외 직원도 08:00으로 클램핑
    const clampedIn = clockIn ? fmtMins(Math.max(parseTime(clockIn), flexStartMins)) : null
    return { ...base, effectiveClockIn: clampedIn, finalStatus: '정상', flag: null }
  }

  // ── New hire rule: override CAPS data on the hire day itself ──────────────
  // Employee ID format: E + YYMMDD + NN  →  hire date = 20YY-MM-DD
  // On the hire day (weekday only): credit a full standard day regardless of
  // what the CAPS export contains, and annotate with "입사당일".
  if (record.dayType === 'WEEKDAY') {
    const rawId = record.employeeId.split('_')[0]
    if (/^E\d{8}$/.test(rawId)) {
      const yymmdd   = rawId.slice(1, 7)   // e.g. "260105"
      const hireDate = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
      if (record.date === hireDate) {
        return {
          ...base,
          effectiveClockIn: '09:00',
          regularHours:    effectiveStdH,
          overtimeHours:   0,
          nightHours:      0,
          holidayHours:    0,
          breakMinutes:    60,
          lunchDeducted:   true,
          dinnerDeducted:  false,
          flag:            null,
          finalStatus:     '정상',
          verificationNote: ['입사당일'],
        }
      }
    }
  }

  function computeFinalStatus(r: ProcessedRecord): FinalStatus {
    if (r.dayType !== 'WEEKDAY') {
      if (r.dayType === 'HOLIDAY') return r.clockIn ? '휴일근무' : '공휴일'
      return r.clockIn ? '휴일근무' : '주말'
    }
    // Full-day leave with no clock-in → always 연차 (Rule 2)
    if (r.leaveType === '연차' && !r.clockIn) return '연차'
    // Non-work leave types bypass anomaly logic
    if (r.leaveType === '출장')     return '출장'
    if (r.leaveType === '재택근무') return '재택근무'
    // Anomaly flags take precedence over leave-type display (Rule 4)
    if (r.flag === 'NO_CLOCK_IN')              return '근태이상'
    if (r.flag === 'NO_CLOCK_OUT')             return '근태이상'
    if (r.flag === 'LATE_AND_ANOMALY')         return '근태이상'
    if (r.flag === 'ATTENDANCE_ANOMALY')       return '근태이상'
    if (r.flag === 'LATE_AND_EARLY_DEPARTURE') return '지각+조기퇴근'
    if (r.flag === 'LATE')                     return '지각'
    if (r.flag === 'EARLY_DEPARTURE')          return '조기퇴근'
    // No anomaly — show leave label for half-day leaves
    if (r.leaveType === '연차')     return '연차'       // full-day leave with clock-in, no issues
    if (r.leaveType === '오전반차') return '오전반차'
    if (r.leaveType === '오후반차') return '오후반차'
    // Quarter-day leaves with no flag → 정상
    if (r.overtimeHours > 0)        return '연장근로'
    return '정상'
  }

  function applySlack(r: ProcessedRecord): ProcessedRecord {
    const entries = allSlackEntries  // 위에서 이미 조회한 배열 재사용
    if (!entries.length) return { ...r, finalStatus: computeFinalStatus(r) }

    // ── 2-pass 처리 ────────────────────────────────────────────────────────
    // Pass 1: 휴일근무 / 연차 / 반차 항목 → leave 주입, 지각 플래그 조정
    // Pass 2: 외근 항목 → leaveType/leaveAmt 유지하면서 외근 상태만 덮어쓰기

    // 항목 분류
    const leaveEntries   = entries.filter(e => !isOffsiteNote(e.note))
    const offsiteEntries = entries.filter(e =>  isOffsiteNote(e.note))

    // Leave entries를 먼저 처리
    let result = r
    for (const entry of leaveEntries) {
      result = applySingleSlackEntry(result, entry)
    }

    // Offsite entries를 이어서 처리 (leaveType/leaveAmt 보존)
    for (const entry of offsiteEntries) {
      result = applyOffsiteEntry(result, entry)
    }

    // finalStatus가 base 기본값('정상')이면 computeFinalStatus 호출
    // 비평일 + 외근 항목만 있어서 applyOffsiteEntry가 스킵된 경우 대응
    if (result.finalStatus === '정상') {
      return { ...result, finalStatus: computeFinalStatus(result) }
    }
    return result
  }

  /** 외근 항목인지 판별 */
  function isOffsiteNote(note: string): boolean {
    return note === '외근·행사' || note === '출장' ||
      /외근|출장|직출|직퇴|미팅|행사|교육|참관|감리|공장|방문|외부|생산|현장|정기|audit/i.test(note)
  }

  /** 외근 항목 처리 — leaveType/leaveAmt 유지, 외근 상태만 적용 */
  function applyOffsiteEntry(r: ProcessedRecord, entry: { note: string; rawText: string }): ProcessedRecord {
    if (r.dayType !== 'WEEKDAY') return r

    const isDuplicate    = entry.note.includes('/ 동명이인 존재')
    const dupSuffix      = isDuplicate ? ' / 동명이인 존재 (확인 필요)' : ''
    const slackContext   = entry.rawText.replace(/^\d{1,2}\/\d{1,2}\s*(?:\([가-힣]\))?\s*/, '').trim()
    const memoCtx        = slackContext || entry.note
    const cleanedNotes   = (r.verificationNote ?? []).filter(n =>
      n !== '출근기록없음' && n !== '퇴근기록없음',
    )
    // 휴가 있는 날 외근: anomaly 플래그 유지 / 휴가 없는 날 외근: 기존처럼 플래그 클리어
    const hasLeaveContext = !!r.leaveType

    const actualOut = r.clockOut

    // 퇴근 기록 없으면 표준 근무일로 고정
    if (!actualOut) {
      const rawIn = r.effectiveClockIn ?? r.clockIn ?? '09:00'
      return {
        ...r,
        clockIn:          r.clockIn ?? '09:00',
        clockOut:         '18:00',
        effectiveClockIn: fmtMins(Math.max(parseTime(rawIn), flexStartMins)),
        regularHours:     effectiveStdH,
        overtimeHours:    0,
        nightHours:       0,
        breakMinutes:     60,
        lunchDeducted:    true,
        dinnerDeducted:   false,
        flag:             hasLeaveContext ? r.flag : null,
        finalStatus:      '외근',
        verificationNote: [...cleanedNotes, `✅ 슬랙 외근 공유 확인: ${memoCtx}${dupSuffix}`],
      }
    }

    // 퇴근 기록 있으면 실제 퇴근 시각 유지, 외근 상태만 적용 (08:00 이전 클램핑)
    const rawFrozenMins = r.effectiveClockIn ? parseTime(r.effectiveClockIn) : (r.clockIn ? parseTime(r.clockIn) : flexStartMins)
    const frozenInMins  = Math.max(rawFrozenMins, flexStartMins)
    const actualOutMins = parseTime(actualOut)
    const lunchDuration = lunchEndMins - lunchStartMins
    const stdOutMins    = frozenInMins + effectiveStdH * 60 + lunchDuration
    const dinnerEndMins_ = stdOutMins + policy.dinnerGraceMinutes
    const rawOtMins     = Math.max(0, actualOutMins - dinnerEndMins_)
    const otMins        = Math.floor(rawOtMins / policy.otUnitMinutes) * policy.otUnitMinutes
    const overtimeHours = otMins / 60
    const dinnerDeducted = actualOutMins > stdOutMins
    const nightWorkStart = Math.max(frozenInMins, nightStartMins)
    const nightWorkEnd   = Math.min(actualOutMins, nightEndMins)
    const nightHours     = Math.max(0, nightWorkEnd - nightWorkStart) / 60

    return {
      ...r,
      effectiveClockIn: fmtMins(frozenInMins),  // 08:00 클램핑 명시 적용
      flag:             hasLeaveContext ? r.flag : null,
      overtimeHours,
      ...(rawOtMins > 0 && { rawOvertimeMinutes: rawOtMins }),
      nightHours,
      dinnerDeducted,
      finalStatus:      '외근',
      verificationNote: [...cleanedNotes, `✅ 슬랙 외근 공유 확인: ${memoCtx}${dupSuffix}`],
    }
  }

  /** Leave/휴일근무 항목 처리 — 기존 applySlack 로직 그대로 */
  function applySingleSlackEntry(r: ProcessedRecord, entry: { note: string; rawText: string }): ProcessedRecord {
    if (!entry) return { ...r, finalStatus: computeFinalStatus(r) }

    const isDuplicate  = entry.note.includes('/ 동명이인 존재')
    const baseNote     = isDuplicate ? entry.note.replace(' / 동명이인 존재', '').trim() : entry.note
    const dupSuffix    = isDuplicate ? ' / 동명이인 존재 (확인 필요)' : ''
    // Strip "M/D(요일)" prefix from the raw Slack message for a clean memo context
    const slackContext = entry.rawText.replace(/^\d{1,2}\/\d{1,2}\s*(?:\([가-힣]\))?\s*/, '').trim()

    // ── Priority 1: Holiday work ────────────────────────────────────────
    // Applies regardless of current status (weekend records are not anomalies
    // yet still need to be resolved when someone posts 휴일근무 in Slack).
    if (baseNote === '휴일근무') {
      if (isDuplicate) {
        return {
          ...r,
          finalStatus: computeFinalStatus(r),
          verificationNote: [...(r.verificationNote ?? []), `슬랙 휴일근무 공유 확인${dupSuffix}`],
        }
      }
      return {
        ...r,
        flag:        null,
        holidayHours: r.holidayHours || effectiveStdH,
        finalStatus: '휴일근무',
        verificationNote: [...(r.verificationNote ?? []), '슬랙 휴일근무 공유 확인'],
      }
    }

    const currentStatus  = computeFinalStatus(r)
    const cleanedNotes   = (r.verificationNote ?? []).filter(n =>
      n !== '출근기록없음' && n !== '퇴근기록없음',
    )
    const normalizedNote = normalizeLeaveType(baseNote, r.clockIn, r.clockOut)
    const isHalfDayNote  = normalizedNote != null && normalizedNote !== '연차'

    // ── Priority 2: Leave ───────────────────────────────────────────────
    // Full-day leave (연차 / 공가): invincible rule — fires regardless of current flag.
    // Missing clock-in on a leave day is expected; clear ALL anomaly flags and force '연차'.
    if (baseNote === '연차' || baseNote === '공가') {
      if (record.leaveType) {
        // ERP already has the leave filed — Slack is a corroborating signal only.
        // Do NOT write 'ERP 미신청'; preserve existing flag/status.
        return {
          ...r,
          verificationNote: [...cleanedNotes, `슬랙+ERP 연차 일치 확인${dupSuffix}`],
          finalStatus: computeFinalStatus(r),
        }
      }
      return {
        ...r,
        leaveType:        '연차',
        flag:             null,
        finalStatus:      '연차',
        verificationNote: [...cleanedNotes, `슬랙 휴가 공유 확인 / ERP 미신청 / 연차${dupSuffix}`],
      }
    }

    // ── ERP priority guard: Slack says 반차/반반차 but ERP has no approved leave ──
    // Leave data was already injected into `r` before arithmetic ran (effectiveLeaveType).
    // Here we just annotate the record so HR knows to chase the ERP filing.
    if (isHalfDayNote && !record.leaveType) {
      return {
        ...r,
        verificationNote: [
          ...cleanedNotes,
          `슬랙 휴가 공유 확인 / ERP 미신청 (처리 요망) / ${normalizedNote}${dupSuffix}`,
        ],
        finalStatus: computeFinalStatus(r),
      }
    }

    // Partial / other leave types: only resolve if there is an active anomaly to clear.
    if (isHalfDayNote && currentStatus === '근태이상') {
      // Rule A: missing-clock anomalies CANNOT be cleared by partial leave.
      // Without both clock records we cannot verify total hours worked.
      if (r.flag === 'NO_CLOCK_IN' || r.flag === 'NO_CLOCK_OUT') {
        return {
          ...r,
          verificationNote: [
            ...cleanedNotes,
            `[출퇴근 태그 누락 — Slack "${baseNote}" 확인됨 / 근무시간 미검증 / 태그 보완 필요${dupSuffix}]`,
          ],
          finalStatus: computeFinalStatus(r),
        }
      }
      const leaveTypeFromNote = normalizedNote!
      if (record.leaveType) {
        return {
          ...r,
          verificationNote: [...cleanedNotes, `슬랙+ERP ${leaveTypeFromNote} 일치 확인${dupSuffix}`],
          finalStatus: computeFinalStatus(r),
        }
      }
      const slackMemo = `슬랙 휴가 공유 확인 / ERP 미신청 / ${leaveTypeFromNote}${dupSuffix}`
      const updated: ProcessedRecord = {
        ...r,
        leaveType:        leaveTypeFromNote,
        flag:             null,
        verificationNote: [...cleanedNotes, slackMemo],
      }
      return { ...updated, finalStatus: computeFinalStatus(updated) }
    }

    // ── Legacy: LATE clearance and minor-flag clearing ──────────────────
    // '외근·행사' removed — Priority 2 now handles all off-site cases before reaching here
    // AM leaves can clear a LATE flag (arrived late because morning was leave).
    const isMorningNote = isHalfDayNote && !normalizedNote!.includes('오후')
    const clearable     = new Set(['NO_CLOCK_IN', 'NO_CLOCK_OUT', 'EARLY_DEPARTURE', 'ATTENDANCE_ANOMALY'])
    let newFlag = r.flag

    if (isMorningNote) {
      if (r.flag === 'LATE')                          newFlag = null
      else if (r.flag === 'LATE_AND_EARLY_DEPARTURE') newFlag = 'EARLY_DEPARTURE'
      else if (r.flag === 'LATE_AND_ANOMALY')          newFlag = 'ATTENDANCE_ANOMALY'
    }
    if (r.flag !== null && clearable.has(r.flag)) newFlag = null

    const slackNote = (isMorningNote && (r.flag === 'LATE' || r.flag?.startsWith('LATE_AND'))
      ? `✅ 슬랙 확인: 지각 면제 (${baseNote})`
      : `✅ 슬랙 확인: ${baseNote}`) + dupSuffix

    const leaveTypeFromNote: '오전반차' | '오후반차' | undefined =
      normalizedNote === '오전반차' ? '오전반차' :
      normalizedNote === '오후반차' ? '오후반차' :
      undefined

    const updated: ProcessedRecord = {
      ...r,
      ...(leaveTypeFromNote !== undefined ? { leaveType: leaveTypeFromNote } : {}),
      flag: newFlag,
      verificationNote: [
        ...(r.verificationNote ?? []).filter(n =>
          n !== '연장 미신청' && n !== '출퇴근 누락' &&
          n !== '출근기록없음' && n !== '퇴근기록없음',
        ),
        slackNote,
      ],
    }
    return { ...updated, finalStatus: computeFinalStatus(updated) }
  }

  // ── Break time hierarchy (strict priority) ───────────────────────────────
  // 1) Stay > 12 h            → 120 min
  // 2) 오후반차 / 0.25 leaves  → 30 min
  // 3) 오전반차 (0.5 AM)       → clock-out based: <12:30 → 0, 12:30–13:30 → 30, >13:30 → 60
  // 4) Default                → 60 min
  function computeBreakMins(ci: number, co: number): number {
    if (co - ci > 12 * 60) return 120
    if (
      effectiveLeaveType === '오후반차'   ||
      effectiveLeaveType === '오전반반차' ||
      effectiveLeaveType === '오후반반차'
    ) return 30
    if (effectiveLeaveType === '오전반차') {
      if (co < parseTime('12:30')) return 0
      if (co <= parseTime('13:30')) return 30
      return 60
    }
    return 60
  }

  // ── Non-WEEKDAY ───────────────────────────────────────────────────────────
  // 휴일근무: 08:00 이전 출근은 08:00으로 클램핑. 지각 개념 없음.
  if (dayType !== 'WEEKDAY') {
    if (clockIn && clockOut) {
      const rawInMins = parseTime(clockIn)
      const inMins    = Math.max(rawInMins, flexStartMins)   // 08:00 이전 → 08:00
      const outMins   = parseTime(clockOut)
      const lunchDeducted = outMins > lunchEndMins && inMins < lunchStartMins
      const breakMins = lunchDeducted ? (lunchEndMins - lunchStartMins) : 0
      const elapsed   = Math.max(0, outMins - inMins - breakMins)
      return applySlack({
        ...base,
        effectiveClockIn: fmtMins(inMins),
        holidayHours:     elapsed / 60,
        lunchDeducted,
        breakMinutes:     breakMins,
      })
    }
    return applySlack(base)
  }

  // ── WEEKDAY: no clock-in ──────────────────────────────────────────────────
  if (!clockIn) {
    // Full annual leave with no clock-in is expected — no anomaly flag
    if (record.leaveType === '연차') return applySlack({ ...base, flag: null })
    const noClockFlag: SieveFlag = (bypassAllAnomalies || isDispatchedWorker) ? null : 'NO_CLOCK_IN'
    return applySlack({ ...base, flag: noClockFlag })
  }

  const actualInMins = parseTime(clockIn)

  // ── Fixed Schedule A: In 08:00, Out ≥ 16:00, Break 30 min ──────────────
  if (isFixedScheduleA && !bypassAllAnomalies) {
    const schedNote  = [...(base.verificationNote ?? []), '특수근무제']
    const schedIn    = parseTime('08:00')
    const schedBreak = 30
    const effectiveIn  = Math.max(actualInMins, schedIn)
    const isSchedLate  = actualInMins > schedIn

    if (!clockOut) {
      const clampedIn = clockIn ? fmtMins(Math.max(parseTime(clockIn), schedIn)) : null
      return applySlack({ ...base, effectiveClockIn: clampedIn, breakMinutes: schedBreak,
        flag: isSchedLate ? 'LATE' : 'NO_CLOCK_OUT', verificationNote: schedNote })
    }
    const co = parseTime(clockOut)
    const net = Math.max(0, co - effectiveIn - schedBreak)
    let schedFlag: SieveFlag =
      co <= parseTime('15:30')                              ? (isSchedLate ? 'LATE_AND_ANOMALY'         : 'ATTENDANCE_ANOMALY')  :
      co >= parseTime('15:31') && co <= parseTime('15:59') ? (isSchedLate ? 'LATE_AND_EARLY_DEPARTURE' : 'EARLY_DEPARTURE')     :
      isSchedLate                                          ? 'LATE'                                                              :
      null
    if (isEasyLogis) schedFlag = null
    return applySlack({ ...base, effectiveClockIn: fmtMins(effectiveIn),
      regularHours: net / 60, breakMinutes: schedBreak, flag: schedFlag, finalStatus: '정상',
      verificationNote: schedNote })
  }

  // ── Fixed Schedule B: In 08:30, Out ≥ 12:30, Break 0 min ──────────────
  if (isFixedScheduleB && !bypassAllAnomalies) {
    const schedNote  = [...(base.verificationNote ?? []), '특수근무제']
    const schedIn    = parseTime('08:30')
    const schedBreak = 0
    const effectiveIn  = Math.max(actualInMins, schedIn)
    const isSchedLate  = actualInMins > schedIn

    if (!clockOut) {
      const clampedIn = clockIn ? fmtMins(Math.max(parseTime(clockIn), schedIn)) : null
      return applySlack({ ...base, effectiveClockIn: clampedIn, breakMinutes: schedBreak,
        flag: isSchedLate ? 'LATE' : 'NO_CLOCK_OUT', verificationNote: schedNote })
    }
    const co = parseTime(clockOut)
    const net = Math.max(0, co - effectiveIn - schedBreak)
    let schedFlag: SieveFlag =
      co <= parseTime('12:00')                              ? (isSchedLate ? 'LATE_AND_ANOMALY'         : 'ATTENDANCE_ANOMALY')  :
      co >= parseTime('12:01') && co <= parseTime('12:29') ? (isSchedLate ? 'LATE_AND_EARLY_DEPARTURE' : 'EARLY_DEPARTURE')     :
      isSchedLate                                          ? 'LATE'                                                              :
      null
    if (isEasyLogis) schedFlag = null
    return applySlack({ ...base, effectiveClockIn: fmtMins(effectiveIn),
      regularHours: net / 60, breakMinutes: schedBreak, flag: schedFlag, finalStatus: '정상',
      verificationNote: schedNote })
  }

  // ── Standard flow ─────────────────────────────────────────────────────────
  const effectiveInMins = Math.max(actualInMins, flexStartMins)

  // Late thresholds per leave type (Rule 4)
  // 오전반반차 (0.25 AM): late > 11:00   오전반차 (0.5 AM): late > 14:00
  // 오후반반차 / 오후반차: standard flexEnd (09:00 or 10:00 for TenAMStarter)
  const effectiveLateThreshold =
    effectiveLeaveType === '오전반반차' ? parseTime('11:00') :
    effectiveLeaveType === '오전반차'   ? parseTime('14:00') :
    flexEndMins

  const isLate = !isEasyLogis && !bypassAllAnomalies &&
    actualInMins > effectiveLateThreshold

  if (!clockOut) {
    const noClockFlag: SieveFlag = (bypassAllAnomalies || isDispatchedWorker) ? null : 'NO_CLOCK_OUT'
    const clampedIn = clockIn ? fmtMins(Math.max(parseTime(clockIn), flexStartMins)) : null
    return applySlack({ ...base, effectiveClockIn: clampedIn, flag: noClockFlag })
  }

  const outMins         = parseTime(clockOut)
  const breakMins       = computeBreakMins(effectiveInMins, outMins)
  const lunchDeducted   = outMins > lunchEndMins && effectiveInMins < lunchStartMins
  const rawStayMins     = outMins - effectiveInMins  // 체류시간 (점심 공제 없음)
  let elapsed = rawStayMins
  if (lunchDeducted) elapsed -= (lunchEndMins - lunchStartMins)

  // ── Per-leave-type targets (Rule B) ──────────────────────────────────────
  // 반반차 (0.25) → 6 h   반차 (0.5) → 4.5 h   (기준: 최소 체류시간)
  const leaveMinRequired: number | null =
    effectiveLeaveType === '오전반반차' ? 6 * 60 :
    effectiveLeaveType === '오전반차'   ? 4.5 * 60 :
    effectiveLeaveType === '오후반반차' ? 6 * 60 :
    effectiveLeaveType === '오후반차'   ? 4.5 * 60 :
    null

  // For partial leave days, OT threshold and regularHours use the reduced target.
  // e.g. 오전반차 clock-in 13:00, clock-out 21:34 → standardOutMins=17:30, OT starts 18:30
  const effectiveTargetMins = leaveMinRequired ?? effectiveStdH * 60
  const standardOutMins     = effectiveInMins + effectiveTargetMins +
    (lunchDeducted ? lunchEndMins - lunchStartMins : 0)
  const dinnerEndMins       = standardOutMins + policy.dinnerGraceMinutes
  const dinnerDeducted      = outMins > standardOutMins

  const regularHours   = Math.min(Math.max(elapsed, 0), effectiveTargetMins) / 60
  const rawOtMins      = Math.max(0, outMins - dinnerEndMins)
  const otMins         = Math.floor(rawOtMins / policy.otUnitMinutes) * policy.otUnitMinutes
  const overtimeHours  = otMins / 60

  const nightWorkStart = Math.max(effectiveInMins, nightStartMins)
  const nightWorkEnd   = Math.min(outMins, nightEndMins)
  const nightHours     = Math.max(0, nightWorkEnd - nightWorkStart) / 60

  // 반차/반반차: 체류시간(rawStayMins) 기반 판정 — 점심 공제 없음
  // 일반: 기준퇴근시각(standardOutMins) 기반 판정
  const isEarlyDeparture = !bypassAllAnomalies && !isEasyLogis && (() => {
    if (leaveMinRequired !== null) return rawStayMins < leaveMinRequired - 30
    return outMins < standardOutMins - 30
  })()

  const isEarlyMild = !bypassAllAnomalies && !isEasyLogis && !isEarlyDeparture && (() => {
    if (leaveMinRequired !== null) return rawStayMins < leaveMinRequired
    return outMins < standardOutMins
  })()

  let flag: SieveFlag = null
  if (isLate && isEarlyDeparture)      flag = 'LATE_AND_ANOMALY'
  else if (isLate && isEarlyMild)      flag = 'LATE_AND_EARLY_DEPARTURE'
  else if (isLate)                     flag = 'LATE'
  else if (isEarlyDeparture)           flag = 'ATTENDANCE_ANOMALY'
  else if (isEarlyMild)                flag = 'EARLY_DEPARTURE'

  // ── Pregnant women: minimum 360 min effective work ─────────────────────────
  if (isPregnantReduced && !bypassAllAnomalies) {
    const leaveEquivMins =
      effectiveLeaveType === '오전반차' || effectiveLeaveType === '오후반차' ? 4 * 60 : 0
    const effectiveWork = Math.max(0, elapsed) + leaveEquivMins
    if (effectiveWork < 360) flag = 'ATTENDANCE_ANOMALY'
  }

  if (isEasyLogis || bypassAllAnomalies) flag = null

  return applySlack({
    ...base,
    effectiveClockIn: fmtMins(effectiveInMins),
    regularHours,
    overtimeHours,
    ...(rawOtMins > 0 && { rawOvertimeMinutes: rawOtMins }),
    nightHours,
    holidayHours: 0,
    breakMinutes: breakMins,
    lunchDeducted,
    dinnerDeducted,
    flag,
    finalStatus: '정상',
  })
}

function filterByDateRange(records: RawRecord[], fromDate: string, toDate: string): RawRecord[] {
  return records.filter(r => r.date >= fromDate && r.date <= toDate)
}

function aggregate(records: ProcessedRecord[], label: string, empCount: number): AggregatedStats {
  const regularHours = records.reduce((s, r) => s + r.regularHours, 0)
  const overtimeHours = records.reduce((s, r) => s + r.overtimeHours, 0)
  const nightHours = records.reduce((s, r) => s + r.nightHours, 0)
  const holidayHours = records.reduce((s, r) => s + r.holidayHours, 0)
  return { label, totalHours: regularHours + overtimeHours, regularHours, overtimeHours, nightHours, holidayHours, employeeCount: empCount }
}

export function useAttendanceLogic(
  rawRecords: RawRecord[],
  policy: PolicySettings,
  fromDate: string,
  toDate: string,
  otExemptIds: Set<string> = new Set(),
  slackNoteMap: Map<string, { note: string; rawText: string }[]> = new Map(),
  employeeAttrMap: Map<string, EmployeeAttributeOverrides> = new Map(),
) {
  return useMemo(() => {
    let mergedOtExemptIds = otExemptIds
    if (employeeAttrMap.size > 0) {
      mergedOtExemptIds = new Set(otExemptIds)
      for (const [empId, attrs] of employeeAttrMap) {
        if (attrs.isLeader || attrs.isEasyLogis) mergedOtExemptIds.add(empId)
      }
    }

    const filtered = filterByDateRange(rawRecords, fromDate, toDate)
    const processed = filtered.map(r =>
      processRecord(r, policy, mergedOtExemptIds, slackNoteMap, employeeAttrMap.get(r.employeeId)),
    )

    const byEmpId: Record<string, ProcessedRecord[]> = {}
    for (const r of processed) {
      if (!byEmpId[r.employeeId]) byEmpId[r.employeeId] = []
      byEmpId[r.employeeId].push(r)
    }

    const total = aggregate(processed, '전체', Object.keys(byEmpId).length)

    const divisions = [...new Set(EMPLOYEES.map(e => e.division))]
    const byDivision: AggregatedStats[] = divisions.map(div => {
      const ids = EMPLOYEES.filter(e => e.division === div).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, div, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const teamKeys = [...new Set(EMPLOYEES.map(e => `${e.division}||${e.team}`))]
    const byTeam: AggregatedStats[] = teamKeys.map(key => {
      const [div, team] = key.split('||')
      const ids = EMPLOYEES.filter(e => e.division === div && e.team === team).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, `${div} / ${team}`, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const partKeys = [...new Set(EMPLOYEES.filter(e => e.part).map(e => `${e.division}||${e.team}||${e.part}`))]
    const byPart: AggregatedStats[] = partKeys.map(key => {
      const [div, team, part] = key.split('||')
      const ids = EMPLOYEES.filter(e => e.division === div && e.team === team && e.part === part).map(e => e.id)
      const recs = processed.filter(r => ids.includes(r.employeeId))
      return aggregate(recs, `${team} / ${part}`, new Set(recs.map(r => r.employeeId)).size)
    }).filter(s => s.employeeCount > 0)

    const byIndividual: AggregatedStats[] = Object.entries(byEmpId).map(([id, recs]) => {
      const emp = EMPLOYEES.find(e => e.id === id)
      return aggregate(recs, emp ? `${emp.name} (${emp.division})` : id, 1)
    })

    const flagCounts = {
      LATE: processed.filter(r => r.flag === 'LATE').length,
      NO_CLOCK_IN: processed.filter(r => r.flag === 'NO_CLOCK_IN').length,
      NO_CLOCK_OUT: processed.filter(r => r.flag === 'NO_CLOCK_OUT').length,
      EARLY_DEPARTURE: processed.filter(r => r.flag === 'EARLY_DEPARTURE').length,
    }

    return { processed, total, byDivision, byTeam, byPart, byIndividual, flagCounts }
  }, [rawRecords, policy, fromDate, toDate, otExemptIds, slackNoteMap, employeeAttrMap])
}
