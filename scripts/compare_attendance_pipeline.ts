/**
 * SQL 전환(Phase B/C) 검증 스크립트 — 기존 경로(getProcessedRecords, JSON blob 기반)와
 * 새 경로(DailyAttendance 테이블)가 완전히 같은 결과를 내는지 (employeeId, date) 키로
 * 필드별 deep-diff한다. Phase C(읽기 경로 전환) 진행 전 이 스크립트가 "완전 일치"를
 * 리포트할 때까지 반복 검증할 것 — 0건 불일치 확인 전엔 절대 다음 단계로 넘어가지 않는다.
 *
 * 사용법: npx tsx scripts/compare_attendance_pipeline.ts <from> <to>
 *   예: npx tsx scripts/compare_attendance_pipeline.ts 2026-01-01 2026-07-31
 *
 * 실행 전제: compute-attendance(전체 재계산)를 최소 한 번 돌려서 DailyAttendance가
 * 채워져 있어야 한다 — 비어있으면 전부 "OLD에만 존재"로 나온다.
 */
import type { DailyAttendance } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { getProcessedRecords } from '../src/lib/getProcessedRecords'
import { getDayInfo } from '../src/utils/dataParser'
import type { ProcessedRecord } from '../src/types/tag'

const EPSILON = 1e-6

interface AttendanceExtra {
  verificationNote?:   string[]
  leaveCodesDetail?:   string[]
  rawLeaveCode?:       string
  breakMinutes?:       number
  lunchDeducted?:      boolean
  dinnerDeducted?:     boolean
  rawOvertimeMinutes?: number
  erpApprovedOtHours?: number
  isHolidayWork?:      boolean
}

/** DailyAttendance row → ProcessedRecord 완전 복원. dayLabel은 저장 안 하므로 재계산. */
function reassemble(row: DailyAttendance): ProcessedRecord {
  const extra = (row.extra ?? {}) as AttendanceExtra
  const { dayLabel } = getDayInfo(row.workDate)
  return {
    employeeId: row.employeeId,
    date: row.workDate,
    dayType: row.dayType as ProcessedRecord['dayType'],
    dayLabel,
    clockIn: row.clockIn,
    clockOut: row.clockOut,
    erpOtApplied: row.erpOtApplied,
    leaveType: (row.leaveType ?? undefined) as ProcessedRecord['leaveType'],
    isHolidayWork: extra.isHolidayWork,
    isLeader: row.isLeader,
    verificationNote: extra.verificationNote,
    erpLeaveAmount: row.erpLeaveAmount ?? undefined,
    isUnpaidLeave: row.isUnpaidLeave,
    rawLeaveCode: extra.rawLeaveCode,
    leaveCodesDetail: extra.leaveCodesDetail as ProcessedRecord['leaveCodesDetail'],
    effectiveClockIn: row.effectiveClockIn,
    regularHours: row.regularHours,
    overtimeHours: row.overtimeHours,
    rawOvertimeMinutes: extra.rawOvertimeMinutes,
    nightHours: row.nightHours,
    holidayHours: row.holidayHours,
    breakMinutes: extra.breakMinutes ?? 0,
    lunchDeducted: extra.lunchDeducted ?? false,
    dinnerDeducted: extra.dinnerDeducted ?? false,
    flag: row.flag as ProcessedRecord['flag'],
    finalStatus: row.finalStatus as ProcessedRecord['finalStatus'],
  }
}

const NUMERIC_FIELDS = new Set([
  'regularHours', 'overtimeHours', 'nightHours', 'holidayHours',
  'breakMinutes', 'erpLeaveAmount', 'rawOvertimeMinutes', 'erpApprovedOtHours',
])
// RawRecord/ProcessedRecord에서 optional boolean(예: isLeader?: boolean)은 false일 때
// 필드 자체가 undefined로 생략되는 경우가 많다 — DailyAttendance 컬럼은 NOT NULL DEFAULT
// false라 저장 시 undefined→false로 채워진다. undefined와 false는 의미상 동일(둘 다
// "아니다")하므로 여기서 정규화하지 않으면 전부 가짜 불일치로 잡힌다.
const BOOLEAN_FIELDS = new Set(['erpOtApplied', 'isUnpaidLeave', 'isLeader'])
const COMPARE_FIELDS = [
  'dayType', 'clockIn', 'clockOut', 'effectiveClockIn', 'erpOtApplied', 'leaveType',
  'erpLeaveAmount', 'isUnpaidLeave', 'isLeader', 'finalStatus', 'flag',
  'regularHours', 'overtimeHours', 'nightHours', 'holidayHours', 'breakMinutes',
]

function fieldsEqual(a: ProcessedRecord, b: ProcessedRecord, field: string): boolean {
  const av = (a as unknown as Record<string, unknown>)[field]
  const bv = (b as unknown as Record<string, unknown>)[field]
  if (NUMERIC_FIELDS.has(field)) {
    return Math.abs((Number(av) || 0) - (Number(bv) || 0)) < EPSILON
  }
  if (BOOLEAN_FIELDS.has(field)) {
    return !!av === !!bv
  }
  return JSON.stringify(av ?? null) === JSON.stringify(bv ?? null)
}

async function main() {
  const [from, to] = process.argv.slice(2)
  if (!from || !to) {
    console.error('usage: npx tsx scripts/compare_attendance_pipeline.ts <from> <to>')
    process.exit(1)
  }
  console.log(`비교 범위: ${from} ~ ${to}`)

  const { records: oldRecords } = await getProcessedRecords({ from, to })
  const oldMap = new Map(oldRecords.map(r => [`${r.employeeId}_${r.date}`, r]))

  const newRows = await prisma.dailyAttendance.findMany({ where: { workDate: { gte: from, lte: to } } })
  const newMap = new Map(newRows.map(row => [`${row.employeeId}_${row.workDate}`, reassemble(row)]))

  const allKeys = new Set([...oldMap.keys(), ...newMap.keys()])
  let mismatchCount  = 0
  let missingInNew   = 0
  let missingInOld   = 0
  const MAX_LOG = 50 // 로그가 너무 길어지지 않게 상세 출력은 앞부분만

  for (const key of allKeys) {
    const oldR = oldMap.get(key)
    const newR = newMap.get(key)
    if (!oldR) { missingInOld++; if (missingInOld <= MAX_LOG) console.log(`[NEW에만 존재] ${key}`); continue }
    if (!newR) { missingInNew++; if (missingInNew <= MAX_LOG) console.log(`[OLD에만 존재] ${key}`); continue }

    const diffs = COMPARE_FIELDS.filter(f => !fieldsEqual(oldR, newR, f))
    if (diffs.length > 0) {
      mismatchCount++
      if (mismatchCount <= MAX_LOG) {
        console.log(`[불일치] ${key}`)
        for (const f of diffs) {
          console.log(`  ${f}: old=${JSON.stringify((oldR as unknown as Record<string, unknown>)[f])} new=${JSON.stringify((newR as unknown as Record<string, unknown>)[f])}`)
        }
      }
    }
  }

  console.log('---')
  console.log(`전체 비교 키: ${allKeys.size}`)
  console.log(`OLD엔 있는데 NEW 누락: ${missingInNew}`)
  console.log(`NEW엔 있는데 OLD 누락: ${missingInOld}`)
  console.log(`필드 불일치: ${mismatchCount}`)
  const ok = mismatchCount === 0 && missingInNew === 0 && missingInOld === 0
  console.log(ok ? '✅ 완전 일치 — Phase C 진행 가능' : '❌ 불일치 있음 — Phase C 진행 전 원인 파악 필요')

  await prisma.$disconnect()
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
