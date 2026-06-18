import type {
  PolicySettings,
  RawRecord,
  ProcessedRecord,
  SieveFlag,
  FinalStatus,
  EmployeeAttributeOverrides,
  ErpLeaveType,
} from '@/types/tag'
import { normalizeLeaveType, computeDisplayBreakMins } from '@/utils/attendanceCalc'

export function parseTime(hhmm: string): number {
  const isNext = hhmm.startsWith('+')
  const clean  = isNext ? hhmm.slice(1) : hhmm
  const parts  = clean.split(':')
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  return h * 60 + m + (isNext ? 1440 : 0)
}

export function fmtMins(mins: number): string {
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
  void erpOtApplied
  void otExemptIds
  const isCompanyHoliday = (policy.companyHolidays ?? []).some(h => h.date === record.date)
  const _actualDow = new Date(record.date + 'T12:00').getDay()
  const dayType = isCompanyHoliday ? 'HOLIDAY' as const :
    (record.dayType !== 'HOLIDAY' && (_actualDow === 0 || _actualDow === 6))
      ? 'WEEKEND' as const
      : record.dayType
  const clockOut: string | null = (() => {
    const raw = record.clockOut
    if (!raw || raw.startsWith('+') || !clockIn) return raw
    return parseTime(raw) < parseTime(clockIn) ? `+${raw}` : raw
  })()

  const allSlackEntries = slackNoteMap.get(`${record.employeeId}_${record.date}`) ?? []
  const slackEntry_ = (record.dayType === 'WEEKDAY' && !record.leaveType)
    ? allSlackEntries.find(e => {
        const norm = normalizeLeaveType(e.note, clockIn, clockOut)
        return norm && norm !== '연차'
      })
    : undefined
  const _slackNorm     = slackEntry_
    ? normalizeLeaveType(slackEntry_.note, clockIn, clockOut)
    : null
  const slackHalfLeave = (_slackNorm && _slackNorm !== '연차') ? _slackNorm : null
  const effectiveLeaveType: ErpLeaveType | null | undefined = record.leaveType ?? slackHalfLeave ?? null
  const slackLeaveInjected = effectiveLeaveType != null && effectiveLeaveType !== (record.leaveType ?? null)
  const effectiveLeaveAmount: number = slackLeaveInjected
    ? (effectiveLeaveType === '오전반반차' || effectiveLeaveType === '오후반반차' ? 0.25 : 0.5)
    : (record.erpLeaveAmount ?? 0)

  const isParentalLeave = (attrOverrides?.isParentalLeave ?? false) && (
    (!attrOverrides?.parentalLeaveFrom || record.date >= attrOverrides.parentalLeaveFrom) &&
    (!attrOverrides?.parentalLeaveTo   || record.date <= attrOverrides.parentalLeaveTo)
  )
  const isShortenedHours = (attrOverrides?.isShortenedHours ?? false) && (
    (!attrOverrides?.shortenedHoursFrom || record.date >= attrOverrides.shortenedHoursFrom) &&
    (!attrOverrides?.shortenedHoursTo   || record.date <= attrOverrides.shortenedHoursTo)
  )

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
  const _pregnantFlag = attrOverrides?.isPregnantReduced ?? false
  const _pFrom = attrOverrides?.pregnantReducedFrom
  const _pTo   = attrOverrides?.pregnantReducedTo
  const isPregnantReduced = _pregnantFlag && (
    (!_pFrom || record.date >= _pFrom) &&
    (!_pTo   || record.date <= _pTo)
  )
  const isGlobalExclusion  = attrOverrides?.isGlobalExclusion  ?? false
  const isResigned = (attrOverrides?.isResigned ?? false) && (
    !attrOverrides?.resignedFrom || record.date >= attrOverrides.resignedFrom
  )

  const bypassAllAnomalies = isParentalLeave

  const policyFlexStartMins = parseTime(policy.flexStart)
  const policyFlexEndMins   = parseTime(policy.flexEnd)
  const flexStartMins       = policyFlexStartMins
  const flexEndMins         = isTenAMStarter ? 10 * 60 : policyFlexEndMins
  const lunchStartMins = parseTime(policy.lunchStart)
  const lunchEndMins   = parseTime(policy.lunchEnd)
  const nightStartMins = parseTime(policy.nightStart)
  const nightEndMins   = parseTime(policy.nightEnd) + 1440

  const base: ProcessedRecord = {
    ...record,
    dayType,
    ...(slackLeaveInjected ? { leaveType: effectiveLeaveType, erpLeaveAmount: effectiveLeaveAmount } : {}),
    // 임신기단축근로는 ERP 기간신청 데이터 — leaveType/erpLeaveAmount를 일별 근태에 반영하지 않음
    ...(_pregActive ? { leaveType: undefined, erpLeaveAmount: undefined } : {}),
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

  if (isGlobalExclusion || isResigned) {
    const clampedIn = clockIn ? fmtMins(Math.max(parseTime(clockIn), flexStartMins)) : null
    return { ...base, effectiveClockIn: clampedIn, finalStatus: '정상', flag: null }
  }

  if (record.dayType === 'WEEKDAY') {
    const rawId = record.employeeId.split('_')[0]
    if (/^E\d{8}$/.test(rawId)) {
      const yymmdd   = rawId.slice(1, 7)
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
    // Full-day absence: 연차 or combo leave (erpLeaveAmount >= 1.0)
    if (!r.clockIn && (r.leaveType === '연차' || (r.erpLeaveAmount ?? 0) >= 1.0)) return '연차'
    if (r.flag === 'NO_CLOCK_IN')              return '근태이상'
    if (r.flag === 'NO_CLOCK_OUT')             return '근태이상'
    if (r.flag === 'LATE_AND_ANOMALY')         return '근태이상'
    if (r.flag === 'ATTENDANCE_ANOMALY')       return '근태이상'
    if (r.flag === 'LATE_AND_EARLY_DEPARTURE') return '지각+조기퇴근'
    if (r.flag === 'LATE')                     return '지각'
    if (r.flag === 'EARLY_DEPARTURE')          return '조기퇴근'
    if (r.leaveType === '오전반차') return '오전반차'
    if (r.leaveType === '오후반차') return '오후반차'
    if (r.overtimeHours > 0)        return '연장근로'
    return '정상'
  }

  function applySlack(r: ProcessedRecord): ProcessedRecord {
    const entries = allSlackEntries
    if (!entries.length) return { ...r, finalStatus: computeFinalStatus(r) }

    const leaveEntries   = entries.filter(e => !isOffsiteNote(e.note))
    const offsiteEntries = entries.filter(e =>  isOffsiteNote(e.note))

    let result = r
    for (const entry of leaveEntries) {
      result = applySingleSlackEntry(result, entry)
    }
    for (const entry of offsiteEntries) {
      result = applyOffsiteEntry(result, entry)
    }

    if (result.finalStatus === '정상') {
      return { ...result, finalStatus: computeFinalStatus(result) }
    }
    return result
  }

  function isOffsiteNote(note: string): boolean {
    return note === '외근·행사' || note === '출장' ||
      /외근|출장|직출|직퇴|미팅|행사|교육|참관|감리|공장|방문|외부|생산|현장|정기|audit/i.test(note)
  }

  function applyOffsiteEntry(r: ProcessedRecord, entry: { note: string; rawText: string }): ProcessedRecord {
    if (r.dayType !== 'WEEKDAY') return r

    const isDuplicate    = entry.note.includes('/ 동명이인 존재')
    const dupSuffix      = isDuplicate ? ' / 동명이인 존재 (확인 필요)' : ''
    const slackContext   = entry.rawText.replace(/^\d{1,2}\/\d{1,2}\s*(?:\([가-힣]\))?\s*/, '').trim()
    const memoCtx        = slackContext || entry.note
    const cleanedNotes   = (r.verificationNote ?? []).filter(n =>
      n !== '출근기록없음' && n !== '퇴근기록없음',
    )
    // AM/PM 반차 여부 — 외근 보정 범위를 제한하는 데 사용
    const isAMLeave = effectiveLeaveType === '오전반차' || effectiveLeaveType === '오전반반차'
    const isPMLeave = effectiveLeaveType === '오후반차' || effectiveLeaveType === '오후반반차'

    // AM 반차 기준 출근 시각: 반반차 → 11:00, 반차 → 14:00
    const amLeaveThresholdMins =
      effectiveLeaveType === '오전반반차' ? parseTime('11:00') :
      effectiveLeaveType === '오전반차'   ? parseTime('14:00') :
      flexEndMins

    // 출근 시각 결정
    // AM 반차: CAPS가 기준시 이전이면 실 기록 사용, 이후(지각)이면 기준시로 클램핑
    // AM 반차 미태깅: 기준시(11:00 또는 14:00)를 출근으로 인정 (기존 09:00 대신)
    const rawInRaw  = r.effectiveClockIn ?? r.clockIn ?? null
    const effInMins = rawInRaw
      ? isAMLeave
        ? Math.min(Math.max(parseTime(rawInRaw), flexStartMins), amLeaveThresholdMins)
        : Math.min(Math.max(parseTime(rawInRaw), flexStartMins), flexEndMins)
      : isAMLeave ? amLeaveThresholdMins : flexEndMins

    // 퇴근 시각: 외근이면 18:00까지 근무한 것으로 간주
    // PM 반차: 실 퇴근 그대로 사용 (18:00 floor 제거)
    //   미태깅이면 반차 기준 퇴근 시각을 추정하고 verificationNote에 명시
    const stdEndMins    = parseTime('18:00')
    const actualOutMins = r.clockOut ? parseTime(r.clockOut) : null
    const effOutMins: number = (() => {
      if (actualOutMins !== null) {
        return isPMLeave ? actualOutMins : (actualOutMins > stdEndMins ? actualOutMins : stdEndMins)
      }
      if (isPMLeave) {
        // 미태깅 + PM 반차: 반차 기준 퇴근 예상 시각 (실근무 필요시간 + 휴게)
        // 점심 구간(12:30~13:30)이 근무 범위에 걸리는 만큼만 휴게로 추가
        // 오후반차(4h): naiveOut=13:00 ≤ lunchEnd(13:30) → +30분 → 13:30
        // 오후반반차(6h): naiveOut=15:00 > lunchEnd → +60분 → 16:00
        const workMinsReq = Math.round((1 - effectiveLeaveAmount) * 8 * 60)
        const naiveOut    = effInMins + workMinsReq
        const lunchInSpan = effInMins < lunchStartMins
        const breakEst    = !lunchInSpan                  ? 0
          : naiveOut <= lunchEndMins                      ? 30
          : lunchEndMins - lunchStartMins
        return naiveOut + breakEst
      }
      return stdEndMins
    })()
    const effOutStr = fmtMins(effOutMins)

    const rawStay  = effOutMins - effInMins
    const brk      = computeDisplayBreakMins(rawStay, effInMins, effOutMins, effectiveLeaveType)
    const net      = Math.max(0, rawStay - brk)
    const lunchDed = effOutMins > lunchEndMins && effInMins < lunchStartMins

    // 외근 Slack 확인 시 모든 이상 플래그 해제
    // effectiveClockIn/Out이 이미 보정됐으므로 태그 누락·지각은 외근으로 증빙됨
    // (LATE, NO_CLOCK_IN, NO_CLOCK_OUT, ATTENDANCE_ANOMALY, EARLY_DEPARTURE 전부 해제)
    const newFlag: SieveFlag = null

    const lunchDuration = lunchEndMins - lunchStartMins
    // 반차 있을 때 외근 기준 소정시간 = 실근무 필요시간 (leaveAmount 반영)
    // 없으면 정책 소정시간 그대로
    const offsiteEffStdH = effectiveLeaveAmount > 0
      ? (1 - effectiveLeaveAmount) * effectiveStdH
      : effectiveStdH
    const offsiteStdOut  = effInMins + offsiteEffStdH * 60 + (lunchDed ? lunchDuration : 0)
    const dinnerEndMins_ = offsiteStdOut + policy.dinnerGraceMinutes
    const rawOtMins      = Math.max(0, effOutMins - dinnerEndMins_)
    const otMins         = Math.floor(rawOtMins / policy.otUnitMinutes) * policy.otUnitMinutes
    const overtimeHours  = otMins / 60
    const dinnerDeducted = effOutMins > offsiteStdOut
    const nightWorkStart = Math.max(effInMins, nightStartMins)
    const nightWorkEnd   = Math.min(effOutMins, nightEndMins)
    const nightHours     = Math.max(0, nightWorkEnd - nightWorkStart) / 60

    // PM 반차 + 미태깅인 경우 추정 퇴근 시각을 note에 명시
    const pmEstimateNote = (isPMLeave && actualOutMins === null)
      ? ` / ${effectiveLeaveType} 기준 퇴근 추정: ${effOutStr} (태그 보완 필요)`
      : ''

    return {
      ...r,
      clockOut:         effOutStr,
      effectiveClockIn: fmtMins(effInMins),
      regularHours:     Math.min(net, offsiteEffStdH * 60) / 60,
      overtimeHours,
      ...(rawOtMins > 0 && { rawOvertimeMinutes: rawOtMins }),
      nightHours,
      breakMinutes:     brk,
      lunchDeducted:    lunchDed,
      dinnerDeducted,
      flag:             newFlag,
      finalStatus:      '외근',
      verificationNote: [...cleanedNotes, `✅ 슬랙 외근 공유 확인: ${memoCtx}${dupSuffix}${pmEstimateNote}`],
    }
  }

  function applySingleSlackEntry(r: ProcessedRecord, entry: { note: string; rawText: string }): ProcessedRecord {
    if (!entry) return { ...r, finalStatus: computeFinalStatus(r) }

    const isDuplicate  = entry.note.includes('/ 동명이인 존재')
    const baseNote     = isDuplicate ? entry.note.replace(' / 동명이인 존재', '').trim() : entry.note
    const dupSuffix    = isDuplicate ? ' / 동명이인 존재 (확인 필요)' : ''
    const slackContext = entry.rawText.replace(/^\d{1,2}\/\d{1,2}\s*(?:\([가-힣]\))?\s*/, '').trim()

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

    if (baseNote === '연차' || baseNote === '공가') {
      if (record.leaveType) {
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

    if (isHalfDayNote && currentStatus === '근태이상') {
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

    // 반차 Slack 확인됐지만 체류시간 부족으로 조기퇴근 플래그가 붙은 경우 — flag 유지
    if (isHalfDayNote && currentStatus === '조기퇴근') {
      const leaveTypeFromNote = normalizedNote!
      if (record.leaveType) {
        if (record.leaveType === leaveTypeFromNote) {
          // ERP와 Slack leaveType 일치
          return {
            ...r,
            verificationNote: [...cleanedNotes, `슬랙+ERP ${leaveTypeFromNote} 일치 확인 (조기퇴근)${dupSuffix}`],
            finalStatus: computeFinalStatus(r),
          }
        } else {
          // ERP와 Slack leaveType 불일치 → Slack 기준으로 정정
          const updated: ProcessedRecord = {
            ...r,
            leaveType: leaveTypeFromNote as typeof r.leaveType,
            verificationNote: [
              ...cleanedNotes,
              `슬랙 ${leaveTypeFromNote} 확인 / ERP 방향 불일치(${record.leaveType}) → 슬랙 기준 정정 (조기퇴근)${dupSuffix}`,
            ],
          }
          return { ...updated, finalStatus: computeFinalStatus(updated) }
        }
      }
      const slackMemo = `슬랙 휴가 공유 확인 / ERP 미신청 / ${leaveTypeFromNote}${dupSuffix}`
      const updated: ProcessedRecord = {
        ...r,
        leaveType:        leaveTypeFromNote,
        verificationNote: [...cleanedNotes, slackMemo],
      }
      return { ...updated, finalStatus: computeFinalStatus(updated) }
    }

    void slackContext
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


  if (dayType !== 'WEEKDAY') {
    if (clockIn && clockOut) {
      const rawInMins = parseTime(clockIn)
      const inMins    = Math.max(rawInMins, flexStartMins)
      const outMins   = parseTime(clockOut)
      const rawElapsed    = outMins - inMins
      const lunchDeducted = outMins > lunchEndMins && inMins < lunchStartMins
      const breakMins     = rawElapsed >= 10 * 60 ? 120
        : rawElapsed >= 8 * 60 ? 60
        : rawElapsed >= 4 * 60 ? 30
        : 0
      const elapsed       = Math.max(0, rawElapsed - breakMins)
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

  if (!clockIn) {
    // Full-day leave (연차 or combo leave totalling ≥ 1.0 day) → 정상, no attendance required
    const isFullDay = record.leaveType === '연차' || effectiveLeaveAmount >= 1.0
    if (isFullDay) return applySlack({ ...base, flag: null })
    const noClockFlag: SieveFlag = (bypassAllAnomalies || isDispatchedWorker) ? null : 'NO_CLOCK_IN'
    return applySlack({ ...base, flag: noClockFlag })
  }

  const actualInMins = parseTime(clockIn)

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

  const effectiveInMins = Math.max(actualInMins, flexStartMins)

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
  const rawStayMins     = outMins - effectiveInMins
  const breakMins       = computeDisplayBreakMins(rawStayMins, effectiveInMins, outMins, effectiveLeaveType)
  const lunchDeducted   = outMins > lunchEndMins && effectiveInMins < lunchStartMins
  const elapsed         = Math.max(0, rawStayMins - breakMins)

  const leaveMinRequired: number | null =
    effectiveLeaveType === '오전반반차' ? 6 * 60 :
    effectiveLeaveType === '오전반차'   ? 4.5 * 60 :
    effectiveLeaveType === '오후반반차' ? 6 * 60 :
    effectiveLeaveType === '오후반차'   ? 4.5 * 60 :
    null

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
