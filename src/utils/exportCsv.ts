import Papa from 'papaparse'
import * as XLSX from 'xlsx-js-style'
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'
import type { GridRow } from '@/components/admin/AttendanceResultTable'
import {
  computeWorkA, parseTimeToMins, computeDisplayBreakMins,
  computePayOtMins, computeLeaderPayOtMins, computeGasNightMins,
  isLeaderOnDate,
} from '@/utils/attendanceCalc'

// 3종 체계(지각/근무시간미달/미태깅) — EARLY_DEPARTURE/LATE_AND_EARLY_DEPARTURE는
// 재계산 전 캐시된 레코드 하위호환용 라벨(근태이상과 동일 취급).
const FLAG_LABEL: Record<string, string> = {
  LATE:                     '지각',
  NO_CLOCK_IN:              '출근 미태깅',
  NO_CLOCK_OUT:             '퇴근 미태깅',
  EARLY_DEPARTURE:          '근태이상',
  ATTENDANCE_ANOMALY:       '근태이상',
  LATE_AND_EARLY_DEPARTURE: '지각+근태이상',
  LATE_AND_ANOMALY:         '지각+근태이상',
}

function getOrgPath(emp: Employee): string {
  const parts = [emp.division, emp.team]
  if (emp.part) parts.push(emp.part)
  return parts.join(' / ')
}

function fmtH(h: number): string {
  return h === 0 ? '0' : h.toFixed(2)
}

function triggerDownload(csv: string, filename: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Per-record export (one row per employee × day). Used for table view. */
export function exportCsv(
  records: ProcessedRecord[],
  employees: Employee[],
  filename = '근태기록_export.csv',
) {
  const rows = records
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeId.localeCompare(b.employeeId))
    .map(r => {
      const emp = employees.find(e => e.id === r.employeeId)
      return {
        '조직경로': emp ? getOrgPath(emp) : r.employeeId,
        '사번': r.employeeId,
        '이름': emp?.name ?? r.employeeId,
        '근무일자': r.date,
        '근무일명칭': r.dayLabel ?? '',
        '출근': r.clockIn ?? '미태깅',
        '퇴근': r.clockOut ?? '미태깅',
        '기본(h)': fmtH(r.regularHours),
        '연장(h)': fmtH(r.overtimeHours),
        '야간(h)': fmtH(r.nightHours),
        '총합(h)': fmtH(r.regularHours + r.overtimeHours),
        '이상치': r.flag ? FLAG_LABEL[r.flag] : '',
      }
    })

  triggerDownload(Papa.unparse(rows, { header: true }), filename)
}

// ── Excel helpers ──────────────────────────────────────────────────────────

// ── Excel style helpers (xlsx-js-style) ───────────────────────────────────

const BORDER_THIN = {
  top:    { style: 'thin', color: { rgb: 'E0E0E0' } },
  bottom: { style: 'thin', color: { rgb: 'E0E0E0' } },
  left:   { style: 'thin', color: { rgb: 'E0E0E0' } },
  right:  { style: 'thin', color: { rgb: 'E0E0E0' } },
}

/** Set style on a cell, creating a blank cell if it doesn't exist yet. */
function cs(ws: XLSX.WorkSheet, r: number, c: number, s: object) {
  const ref = XLSX.utils.encode_cell({ r, c })
  if (!ws[ref]) ws[ref] = { v: null, t: 'z' }
  ws[ref].s = { border: BORDER_THIN, ...s }
}

/** Apply header-row style (row 0) across `cols` columns. */
function styleHeader(ws: XLSX.WorkSheet, cols: number, fillRgb: string) {
  for (let c = 0; c < cols; c++) {
    cs(ws, 0, c, {
      font:      { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: fillRgb } },
      alignment: { horizontal: 'center', vertical: 'center' },
    })
  }
}

/** Style a data/total block: alternating rows, optional per-cell overrides. */
function styleBlock(
  ws:       XLSX.WorkSheet,
  startRow: number,
  rowCount: number,
  cols:     number,
  getStyle: (r: number, c: number, val: unknown) => object,
) {
  for (let r = startRow; r < startRow + rowCount; r++) {
    for (let c = 0; c < cols; c++) {
      const ref = XLSX.utils.encode_cell({ r, c })
      const val = ws[ref]?.v ?? null
      if (!ws[ref]) ws[ref] = { v: null, t: 'z' }
      cs(ws, r, c, getStyle(r, c, val))
    }
  }
}

/**
 * Convert YYYY-MM-DD string → Excel 1900 date serial (integer).
 * Accounts for Excel's spurious Feb-29-1900 leap-day bug.
 */
function dateToExcelSerial(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const epoch = new Date(1899, 11, 31)   // Dec 31, 1899 local time
  const date  = new Date(y, m - 1, d)   // target date local time
  const dn    = Math.round((date.getTime() - epoch.getTime()) / 86400000)
  return dn > 60 ? dn + 1 : dn
}

// ── 요약 sheet: per-record category ────────────────────────────────────────

const SUM_CATS = [
  '정상', '지각', '근무시간 미달', '지각/근무시간 미달', '근태이상',
  '연차', '휴일근무',
  '휴가 미신청', '외근 (확인 필요)', '휴가 미신청 (확인 필요)',
] as const

type SumCat = typeof SUM_CATS[number]

function categorizeForSummary(r: ProcessedRecord): SumCat | null {
  if (r.finalStatus === '주말' || r.finalStatus === '공휴일') return null

  const flag  = r.flag ?? ''
  const notes = r.verificationNote ?? []
  const hasDup = notes.some(n => n.includes('동명이인'))

  // 3종 체계 — 조기퇴근은 근무시간미달로 통합 (EARLY_DEPARTURE는 캐시된 레코드 하위호환)
  if (flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') return '지각/근무시간 미달'
  if (flag === 'LATE')                                                     return '지각'
  if (flag === 'EARLY_DEPARTURE' || flag === 'ATTENDANCE_ANOMALY')        return '근무시간 미달'
  if (flag === 'NO_CLOCK_IN'     || flag === 'NO_CLOCK_OUT')              return '근태이상'

  if (r.finalStatus === '휴일근무') return '휴일근무'
  if (r.leaveType)                 return '연차'

  const hasMissingERP = notes.some(n => n.includes('ERP 미신청'))
  if (hasMissingERP) return hasDup ? '휴가 미신청 (확인 필요)' : '휴가 미신청'
  if (notes.some(n => n.includes('외근'))) return '외근 (확인 필요)'

  return '정상'
}

// ── Detail sheet column definitions ──────────────────────────────────────
//
// Each entry matches a columnVisibility key from AttendanceResultTable so that
// exportXlsx can filter headers and data to match exactly what the user sees.

interface DetailColDef { id: string; header: string; wch: number }

const DETAIL_COL_DEFS: DetailColDef[] = [
  { id: 'division',      header: '본부',             wch: 14 },
  { id: 'empId',         header: '사번',             wch: 12 },
  { id: 'name',          header: '이름',             wch: 10 },
  { id: 'date',          header: '근무일자',          wch: 14 },
  { id: 'clockIn',       header: '출근',             wch: 8  },
  { id: 'clockOut',      header: '퇴근',             wch: 8  },
  { id: 'leaveAmt',      header: '연차일수',          wch: 8  },
  { id: 'leaveType',     header: '연차코드',          wch: 10 },
  { id: 'leaveSource',   header: '연차정보',          wch: 8  },
  { id: 'breakH',        header: '휴게',             wch: 6  },
  { id: 'finalWorkH',       header: '최종근무(값)',    wch: 12 },
  { id: 'attendanceStatus', header: '근태상태',        wch: 8  },
  { id: 'normalTags',       header: '정상정보',        wch: 14 },
  { id: 'anomalyTags',      header: '비정상정보',      wch: 18 },
  { id: 'systemOtH',        header: '시스템 초과근로', wch: 14 },
  { id: 'payrollOtH',      header: '급여용 연장(최종)', wch: 16 },
  { id: 'payrollNightH',   header: '급여용 야간(최종)', wch: 16 },
  { id: 'payrollHolidayH', header: '급여용 휴일(최종)', wch: 16 },
  { id: 'erpOtApplied',    header: 'ERP 연장 신청',    wch: 12 },
]

function buildDetailRowData(
  r:     ProcessedRecord,
  emp:   Employee | undefined,
  attrs: EmployeeAttributeOverrides | undefined,
): Record<string, unknown> {
  const leaveAmt     = r.erpLeaveAmount ?? 0
  const leaveCode    = r.leaveType ?? null
  const isSlackInjected = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
  // 연차정보: ERP 미신청 여부를 기준으로 판단 (erpLeaveAmount는 Slack 주입 시 덮어써지므로 사용 불가)
  const leaveSource =
    isSlackInjected  ? 'Slack' :
    r.leaveType      ? 'ERP' :
    null
  const rawId = emp?.rawId ?? r.employeeId.split('_')[0]

  const workA         = computeWorkA(r.effectiveClockIn ?? r.clockIn, r.clockOut)
  const workAMins     = Math.round(workA * 60)
  const ciMins        = (r.effectiveClockIn ?? r.clockIn) ? parseTimeToMins((r.effectiveClockIn ?? r.clockIn)!) : null
  const coMins        = r.clockOut ? parseTimeToMins(r.clockOut) : null
  const isHoliday     = r.dayType !== 'WEEKDAY'
  const breakMins     = isHoliday ? r.breakMinutes : computeDisplayBreakMins(workAMins, ciMins, coMins, r.leaveType)
  const breakHours    = breakMins / 60
  const workBMins     = Math.max(0, workAMins - breakMins)
  const leaveCredit   = r.isUnpaidLeave ? 0 : leaveAmt * 8
  const finalWork     = isHoliday ? r.holidayHours : Math.max(0, workBMins / 60 + leaveCredit)

  // 테이블과 동일한 태그 로직
  const anomalyTags: string[] = []
  const flag = r.flag
  if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') anomalyTags.push('미태깅')
  if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('지각')
  if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') anomalyTags.push('근무시간 미달')

  const attendanceStatus = anomalyTags.length === 0 ? '정상' : '비정상'

  const normalTags: string[] = []
  if (r.finalStatus === '외근')     normalTags.push('외근')
  if (r.finalStatus === '휴일근무') normalTags.push('휴일근로')
  if (r.overtimeHours > 0)         normalTags.push('연장근로')
  const isLeaveDay = !!(r.leaveType && ['연차','오전반차','오후반차','오전반반차','오후반반차','출장','재택근무'].includes(r.leaveType))
  if (normalTags.length === 0 && !isLeaveDay && r.dayType === 'WEEKDAY') normalTags.push('일반')

  // r.isLeader(CAPS 자동감지, 날짜 무관 고정값)를 그대로 쓰면 발령일 이전 기록까지 전부
  // 직책자로 취급됨 — leaderFrom/leaderTo가 설정돼 있으면 그걸 우선하는 공유 판별함수를 씀.
  const isLeader           = isLeaderOnDate(attrs, emp, r.date)
  const effectiveIn        = r.effectiveClockIn ?? r.clockIn
  const isErpLeaveApproved = r.leaveType ? !isSlackInjected : true
  // 시스템 초과근로: 절삭없음 기준 (직책자=raw clockIn, 일반=effectiveIn — 반차 ERP승인 게이트는 공통 적용)
  const systemOtMins  = isLeader
    ? computeLeaderPayOtMins(r.clockIn, r.clockOut, r.leaveType, isErpLeaveApproved)
    : computeLeaderPayOtMins(effectiveIn, r.clockOut, r.leaveType, isErpLeaveApproved)
  const systemOtH   = systemOtMins / 60
  // 급여용 연장: 직책자=절삭없음+ERP무관(연장신청 자체는), 일반=30분절삭+ERP연장신청 필수
  // (단, 반차 자체의 ERP 승인 여부는 직책자도 동일하게 게이트)
  const gasPayOtMins = isLeader
    ? computeLeaderPayOtMins(r.clockIn, r.clockOut, r.leaveType, isErpLeaveApproved)
    : (r.erpOtApplied ? computePayOtMins(effectiveIn, r.clockOut, r.leaveType, isErpLeaveApproved) : 0)
  const payrollOtH  = gasPayOtMins / 60
  // 급여용 야간: 직책자=절삭없음, 일반=30분 절삭
  const payrollNightH = computeGasNightMins(r.clockOut, isLeader) / 60
  const erpOtLabel = r.erpOtApplied === true ? '신청' : r.erpOtApplied === false ? '미신청' : null

  return {
    division:      emp?.division ?? '',
    empId:         emp?.rawId ?? r.employeeId.split('_')[0],
    name:          emp?.name ?? r.employeeId,
    date:          dateToExcelSerial(r.date),
    clockIn:       r.effectiveClockIn ?? r.clockIn ?? '',
    clockOut:      r.clockOut ?? '',
    leaveAmt:      leaveAmt > 0 ? leaveAmt : null,
    leaveType:     leaveCode,
    leaveSource,
    breakH:           breakHours > 0 ? breakHours : null,
    finalWorkH:       finalWork  > 0 ? finalWork  : null,
    attendanceStatus,
    normalTags:       normalTags.length  > 0 ? normalTags.join(', ')  : null,
    anomalyTags:      anomalyTags.length > 0 ? anomalyTags.join(', ') : null,
    systemOtH:        systemOtH  > 0 ? systemOtH  : null,
    payrollOtH:    payrollOtH > 0 ? payrollOtH : null,
    payrollNightH: payrollNightH > 0 ? payrollNightH : null,
    erpOtApplied:  erpOtLabel,
  }
}

// ── Main two-sheet XLSX export ────────────────────────────────────────────

/**
 * Exports attendance data as an Excel workbook with two sheets:
 *  - 근태결과: per-employee per-day detail (matches uploaded template exactly)
 *  - 요약:     per-employee summary counts by status category
 *
 * visibleColIds — when provided, only columns whose ID is in this set are
 * included in the 근태결과 sheet (mirrors the user's "열 설정" toggle state).
 * When omitted, all 16 columns are exported.
 */
export function exportXlsx(
  records:       ProcessedRecord[],
  employees:     Employee[],
  filename =     '근태결과_export.xlsx',
  visibleColIds?: Set<string>,
  finalAttrMap?: Map<string, EmployeeAttributeOverrides>,
) {
  const empMap = new Map(employees.map(e => [e.id, e]))

  // Sort strictly by raw 사번 (rawId) ascending, then date ascending.
  // Using direct string comparison (not localeCompare) avoids locale-specific
  // ordering differences, and is safe because IDs are ASCII "E" + 8 digits
  // and dates are ISO YYYY-MM-DD — both sort lexicographically = numerically.
  const sorted = [...records].sort((a, b) => {
    const aId = empMap.get(a.employeeId)?.rawId ?? a.employeeId.split('_')[0]
    const bId = empMap.get(b.employeeId)?.rawId ?? b.employeeId.split('_')[0]
    if (aId < bId) return -1
    if (aId > bId) return  1
    if (a.date < b.date) return -1
    if (a.date > b.date) return  1
    return 0
  })

  // ── Sheet 1: 근태결과 ──────────────────────────────────────────────────

  const activeCols = visibleColIds
    ? DETAIL_COL_DEFS.filter(c => visibleColIds.has(c.id))
    : DETAIL_COL_DEFS

  const detailRows = sorted.map(r => {
    const emp     = empMap.get(r.employeeId)
    const attrs   = finalAttrMap?.get(r.employeeId)
    const rowData = buildDetailRowData(r, emp, attrs)
    return activeCols.map(c => rowData[c.id] ?? null)
  })

  const wsDetail = XLSX.utils.aoa_to_sheet([
    activeCols.map(c => c.header),
    ...detailRows,
  ])

  // Apply date format to the 근무일자 column
  const dateColIdx = activeCols.findIndex(c => c.id === 'date')
  if (dateColIdx >= 0) {
    const letter = String.fromCharCode(65 + dateColIdx)
    for (let i = 0; i < sorted.length; i++) {
      const ref = `${letter}${i + 2}`
      if (wsDetail[ref]) wsDetail[ref].z = 'yyyy-mm-dd'
    }
  }

  // Apply 0.00 number format to all numeric columns
  const NUMERIC_COL_IDS = new Set(['leaveAmt', 'breakH', 'finalWorkH', 'systemOtH', 'payrollOtH', 'payrollNightH', 'payrollHolidayH'])
  const numericColIndices = activeCols
    .map((c, i) => ({ id: c.id, idx: i }))
    .filter(({ id }) => NUMERIC_COL_IDS.has(id))

  for (let rowIdx = 0; rowIdx < sorted.length; rowIdx++) {
    for (const { idx } of numericColIndices) {
      const ref = XLSX.utils.encode_cell({ r: rowIdx + 1, c: idx })
      if (wsDetail[ref] && typeof wsDetail[ref].v === 'number') {
        wsDetail[ref].t = 'n'
        wsDetail[ref].z = '0.00'
      }
    }
  }

  wsDetail['!cols'] = activeCols.map(c => ({ wch: c.wch }))

  // 근태결과 헤더 스타일 (네이비)
  styleHeader(wsDetail, activeCols.length, '1F3864')
  // 데이터 행: 홀짝 줄무늬
  styleBlock(wsDetail, 1, sorted.length, activeCols.length, (r, _c, _v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: r % 2 === 0 ? 'F5F8FF' : 'FFFFFF' } },
    font:      { sz: 9, color: { rgb: '333333' } },
    alignment: { vertical: 'center' },
  }))

  // ── Sheet 2: 요약 ──────────────────────────────────────────────────────

  const SUM_HEADERS = [
    '사번', '이름', '본부',
    '정상', '지각', '근무시간 미달', '지각/근무시간 미달', '근태이상',
    '연차', '휴일근무',
    '휴가 미신청', '외근 (확인 필요)', '휴가 미신청 (확인 필요)',
    '총일수',
  ]

  // Group records by employee while preserving sorted order
  const empOrder: string[] = []
  const recsByEmp = new Map<string, ProcessedRecord[]>()
  for (const r of sorted) {
    if (!recsByEmp.has(r.employeeId)) {
      recsByEmp.set(r.employeeId, [])
      empOrder.push(r.employeeId)
    }
    recsByEmp.get(r.employeeId)!.push(r)
  }

  const summaryRows = empOrder.map(empId => {
    const emp       = empMap.get(empId)
    const recs      = recsByEmp.get(empId)!
    const cats: Partial<Record<SumCat, number>> = {}
    let totalDays   = 0

    for (const r of recs) {
      const cat = categorizeForSummary(r)
      if (cat === null) continue
      totalDays++
      cats[cat] = (cats[cat] ?? 0) + 1
    }

    const n = (key: SumCat) => (cats[key] ?? 0) > 0 ? cats[key]! : null

    return [
      emp?.rawId ?? empId.split('_')[0],  // 사번
      emp?.name ?? empId,                 // 이름
      emp?.division ?? '',                // 본부
      n('정상'),
      n('지각'),
      n('근무시간 미달'),
      n('지각/근무시간 미달'),
      n('근태이상'),
      n('연차'),
      n('휴일근무'),
      n('휴가 미신청'),
      n('외근 (확인 필요)'),
      n('휴가 미신청 (확인 필요)'),
      totalDays || null,
    ]
  })

  const wsSum = XLSX.utils.aoa_to_sheet([SUM_HEADERS, ...summaryRows])
  wsSum['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 14 },
    { wch: 6  }, { wch: 6  }, { wch: 8  }, { wch: 10 }, { wch: 8  },
    { wch: 6  }, { wch: 8  },
    { wch: 10 }, { wch: 14 }, { wch: 18 },
    { wch: 8  },
  ]

  // 요약 헤더 스타일 (다크그레이)
  styleHeader(wsSum, SUM_HEADERS.length, '404040')
  // 데이터 행
  styleBlock(wsSum, 1, summaryRows.length, SUM_HEADERS.length, (r, c, v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: r % 2 === 0 ? 'F7F7F7' : 'FFFFFF' } },
    font:      { sz: 9, color: { rgb: c >= 3 && v ? '1F3864' : '333333' } },
    alignment: { horizontal: c >= 3 ? 'center' : 'left', vertical: 'center' },
  }))

  // ── Sheet 3: 이상치 (개인별 이상치 유형 집계) ──────────────────────────

  const ANOMALY_HEADERS = [
    '사번', '이름', '본부',
    '지각', '근무시간 미달', '미태깅', '혼합', '총합계',
  ]

  type AnomalyKey = '지각' | '근무시간 미달' | '미태깅' | '혼합'

  // 3종 체계 — EARLY_DEPARTURE는 재계산 전 캐시된 레코드 하위호환용으로 근무시간미달에 포함
  function classifyAnomalyFlag(flag: string | null): AnomalyKey | null {
    switch (flag) {
      case 'LATE':                     return '지각'
      case 'ATTENDANCE_ANOMALY':
      case 'EARLY_DEPARTURE':          return '근무시간 미달'
      case 'NO_CLOCK_IN':
      case 'NO_CLOCK_OUT':             return '미태깅'
      case 'LATE_AND_EARLY_DEPARTURE':
      case 'LATE_AND_ANOMALY':         return '혼합'
      default:                         return null
    }
  }

  const anomalyDataRows: (string | number | null)[][] = []
  const anomalyTotals: Record<AnomalyKey, number> = {
    '지각': 0, '근무시간 미달': 0, '미태깅': 0, '혼합': 0,
  }

  for (const empId of empOrder) {
    const emp  = empMap.get(empId)
    const recs = recsByEmp.get(empId)!
    const counts: Record<AnomalyKey, number> = {
      '지각': 0, '근무시간 미달': 0, '미태깅': 0, '혼합': 0,
    }
    for (const r of recs) {
      if (r.dayType !== 'WEEKDAY') continue
      const cat = classifyAnomalyFlag(r.flag)
      if (cat) counts[cat]++
    }
    const total = Object.values(counts).reduce((s, v) => s + v, 0)
    if (total === 0) continue   // 이상치 없는 직원 제외

    for (const k of Object.keys(anomalyTotals) as AnomalyKey[]) {
      anomalyTotals[k] += counts[k]
    }

    anomalyDataRows.push([
      emp?.rawId ?? empId.split('_')[0],
      emp?.name  ?? empId,
      emp?.division ?? '',
      counts['지각']          || null,
      counts['근무시간 미달'] || null,
      counts['미태깅']        || null,
      counts['혼합']          || null,
      total,
    ])
  }

  // 합계 행
  const grandTotal = Object.values(anomalyTotals).reduce((s, v) => s + v, 0)
  const anomalyTotalRow: (string | number | null)[] = [
    null, '합계', null,
    anomalyTotals['지각']          || null,
    anomalyTotals['근무시간 미달'] || null,
    anomalyTotals['미태깅']        || null,
    anomalyTotals['혼합']          || null,
    grandTotal || null,
  ]

  const wsAnomaly = XLSX.utils.aoa_to_sheet([
    ANOMALY_HEADERS,
    ...anomalyDataRows,
    anomalyTotalRow,
  ])
  wsAnomaly['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 14 },
    { wch: 8  }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
  ]

  // 이상치 헤더 스타일 (레드)
  styleHeader(wsAnomaly, ANOMALY_HEADERS.length, 'C00000')
  // 데이터 행: 수치 컬럼 빨간색 강조
  styleBlock(wsAnomaly, 1, anomalyDataRows.length, ANOMALY_HEADERS.length, (r, c, v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: r % 2 === 0 ? 'FFF5F5' : 'FFFFFF' } },
    font:      { sz: 9, bold: c === 7 && !!v, color: { rgb: c >= 3 && v ? 'C00000' : '333333' } },
    alignment: { horizontal: c >= 3 ? 'center' : 'left', vertical: 'center' },
  }))
  // 합계 행
  const anomalyTotalRowIdx = anomalyDataRows.length + 1
  styleBlock(wsAnomaly, anomalyTotalRowIdx, 1, ANOMALY_HEADERS.length, (_r, c, v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: 'FFE0E0' } },
    font:      { sz: 9, bold: true, color: { rgb: c >= 3 && v ? 'C00000' : '333333' } },
    alignment: { horizontal: c >= 3 ? 'center' : 'left', vertical: 'center' },
  }))

  // ── Build and download workbook ───────────────────────────────────────

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, wsDetail,  '근태결과')
  XLSX.utils.book_append_sheet(wb, wsSum,     '요약')
  XLSX.utils.book_append_sheet(wb, wsAnomaly, '이상치')

  const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Exports attendance data as an Excel workbook using the exact values already
 * computed for on-screen display in AttendanceResultTable (respects the
 * 인정시간/실제값 + 크레딧 ON/OFF toggle state) — the 근태결과 detail sheet is a
 * direct passthrough of GridRow fields with NO recomputation, so it always
 * matches whatever the table currently shows. 요약/이상치 sheets are category
 * counts derived from the underlying ProcessedRecord (unaffected by the
 * toggle), so they reuse the same logic as exportXlsx.
 */
export function exportTableXlsx(
  rows:          GridRow[],
  employees:     Employee[],
  filename =     '근태결과_export.xlsx',
  visibleColIds?: Set<string>,
) {
  const empMap = new Map(employees.map(e => [e.id, e]))

  // Same rawId → date ordering as exportXlsx, applied across all three sheets.
  const sortedRows = [...rows].sort((a, b) => {
    if (a.empId < b.empId) return -1
    if (a.empId > b.empId) return  1
    if (a.date < b.date) return -1
    if (a.date > b.date) return  1
    return 0
  })

  // ── Sheet 1: 근태결과 — GridRow 값 그대로 사용 (재계산 없음) ─────────────

  const activeCols = visibleColIds
    ? DETAIL_COL_DEFS.filter(c => visibleColIds.has(c.id))
    : DETAIL_COL_DEFS

  const detailRows = sortedRows.map(row => {
    const rowData: Record<string, unknown> = {
      division:         row.division,
      empId:            row.empId,
      name:             row.name,
      date:             dateToExcelSerial(row.date),
      clockIn:          row.clockIn ?? '',
      clockOut:         row.clockOut ?? '',
      leaveAmt:         row.leaveAmt > 0 ? row.leaveAmt : null,
      leaveType:        row.leaveType,
      leaveSource:      row.leaveSource || null,
      breakH:           row.breakH > 0 ? row.breakH : null,
      finalWorkH:       row.finalWorkH > 0 ? row.finalWorkH : null,
      attendanceStatus: row.attendanceStatus,
      normalTags:       row.normalTags.length  > 0 ? row.normalTags.join(', ')  : null,
      anomalyTags:      row.anomalyTags.length > 0 ? row.anomalyTags.join(', ') : null,
      systemOtH:        row.systemOtH  > 0 ? row.systemOtH  : null,
      payrollOtH:       row.payrollOtH > 0 ? row.payrollOtH : null,
      payrollNightH:    row.payrollNightH > 0 ? row.payrollNightH : null,
      payrollHolidayH:  row.payrollHolidayH > 0 ? row.payrollHolidayH : null,
      erpOtApplied:     row.erpOtStatus === '—' ? null : row.erpOtStatus,
    }
    return activeCols.map(c => rowData[c.id] ?? null)
  })

  const wsDetail = XLSX.utils.aoa_to_sheet([
    activeCols.map(c => c.header),
    ...detailRows,
  ])

  const dateColIdx = activeCols.findIndex(c => c.id === 'date')
  if (dateColIdx >= 0) {
    const letter = String.fromCharCode(65 + dateColIdx)
    for (let i = 0; i < sortedRows.length; i++) {
      const ref = `${letter}${i + 2}`
      if (wsDetail[ref]) wsDetail[ref].z = 'yyyy-mm-dd'
    }
  }

  const NUMERIC_COL_IDS = new Set(['leaveAmt', 'breakH', 'finalWorkH', 'systemOtH', 'payrollOtH', 'payrollNightH', 'payrollHolidayH'])
  const numericColIndices = activeCols
    .map((c, i) => ({ id: c.id, idx: i }))
    .filter(({ id }) => NUMERIC_COL_IDS.has(id))

  for (let rowIdx = 0; rowIdx < sortedRows.length; rowIdx++) {
    for (const { idx } of numericColIndices) {
      const ref = XLSX.utils.encode_cell({ r: rowIdx + 1, c: idx })
      if (wsDetail[ref] && typeof wsDetail[ref].v === 'number') {
        wsDetail[ref].t = 'n'
        wsDetail[ref].z = '0.00'
      }
    }
  }

  wsDetail['!cols'] = activeCols.map(c => ({ wch: c.wch }))
  styleHeader(wsDetail, activeCols.length, '1F3864')
  styleBlock(wsDetail, 1, sortedRows.length, activeCols.length, (r, _c, _v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: r % 2 === 0 ? 'F5F8FF' : 'FFFFFF' } },
    font:      { sz: 9, color: { rgb: '333333' } },
    alignment: { vertical: 'center' },
  }))

  // ── Sheet 2: 요약 (exportXlsx와 동일 로직 — ProcessedRecord 기준 카테고리 집계) ──

  const SUM_HEADERS = [
    '사번', '이름', '본부',
    '정상', '지각', '근무시간 미달', '지각/근무시간 미달', '근태이상',
    '연차', '휴일근무',
    '휴가 미신청', '외근 (확인 필요)', '휴가 미신청 (확인 필요)',
    '총일수',
  ]

  const empOrder: string[] = []
  const recsByEmp = new Map<string, ProcessedRecord[]>()
  for (const row of sortedRows) {
    const r = row.record
    if (!recsByEmp.has(r.employeeId)) {
      recsByEmp.set(r.employeeId, [])
      empOrder.push(r.employeeId)
    }
    recsByEmp.get(r.employeeId)!.push(r)
  }

  const summaryRows = empOrder.map(empId => {
    const emp       = empMap.get(empId)
    const recs      = recsByEmp.get(empId)!
    const cats: Partial<Record<SumCat, number>> = {}
    let totalDays   = 0

    for (const r of recs) {
      const cat = categorizeForSummary(r)
      if (cat === null) continue
      totalDays++
      cats[cat] = (cats[cat] ?? 0) + 1
    }

    const n = (key: SumCat) => (cats[key] ?? 0) > 0 ? cats[key]! : null

    return [
      emp?.rawId ?? empId.split('_')[0],
      emp?.name ?? empId,
      emp?.division ?? '',
      n('정상'),
      n('지각'),
      n('근무시간 미달'),
      n('지각/근무시간 미달'),
      n('근태이상'),
      n('연차'),
      n('휴일근무'),
      n('휴가 미신청'),
      n('외근 (확인 필요)'),
      n('휴가 미신청 (확인 필요)'),
      totalDays || null,
    ]
  })

  const wsSum = XLSX.utils.aoa_to_sheet([SUM_HEADERS, ...summaryRows])
  wsSum['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 14 },
    { wch: 6  }, { wch: 6  }, { wch: 8  }, { wch: 10 }, { wch: 8  },
    { wch: 6  }, { wch: 8  },
    { wch: 10 }, { wch: 14 }, { wch: 18 },
    { wch: 8  },
  ]

  styleHeader(wsSum, SUM_HEADERS.length, '404040')
  styleBlock(wsSum, 1, summaryRows.length, SUM_HEADERS.length, (r, c, v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: r % 2 === 0 ? 'F7F7F7' : 'FFFFFF' } },
    font:      { sz: 9, color: { rgb: c >= 3 && v ? '1F3864' : '333333' } },
    alignment: { horizontal: c >= 3 ? 'center' : 'left', vertical: 'center' },
  }))

  // ── Sheet 3: 이상치 (개인별 이상치 유형 집계, exportXlsx와 동일 로직) ────────

  const ANOMALY_HEADERS = [
    '사번', '이름', '본부',
    '지각', '근무시간 미달', '미태깅', '혼합', '총합계',
  ]

  type AnomalyKey = '지각' | '근무시간 미달' | '미태깅' | '혼합'

  function classifyAnomalyFlag(flag: string | null): AnomalyKey | null {
    switch (flag) {
      case 'LATE':                     return '지각'
      case 'ATTENDANCE_ANOMALY':
      case 'EARLY_DEPARTURE':          return '근무시간 미달'
      case 'NO_CLOCK_IN':
      case 'NO_CLOCK_OUT':             return '미태깅'
      case 'LATE_AND_EARLY_DEPARTURE':
      case 'LATE_AND_ANOMALY':         return '혼합'
      default:                         return null
    }
  }

  const anomalyDataRows: (string | number | null)[][] = []
  const anomalyTotals: Record<AnomalyKey, number> = {
    '지각': 0, '근무시간 미달': 0, '미태깅': 0, '혼합': 0,
  }

  for (const empId of empOrder) {
    const emp  = empMap.get(empId)
    const recs = recsByEmp.get(empId)!
    const counts: Record<AnomalyKey, number> = {
      '지각': 0, '근무시간 미달': 0, '미태깅': 0, '혼합': 0,
    }
    for (const r of recs) {
      if (r.dayType !== 'WEEKDAY') continue
      const cat = classifyAnomalyFlag(r.flag)
      if (cat) counts[cat]++
    }
    const total = Object.values(counts).reduce((s, v) => s + v, 0)
    if (total === 0) continue   // 이상치 없는 직원 제외

    for (const k of Object.keys(anomalyTotals) as AnomalyKey[]) {
      anomalyTotals[k] += counts[k]
    }

    anomalyDataRows.push([
      emp?.rawId ?? empId.split('_')[0],
      emp?.name  ?? empId,
      emp?.division ?? '',
      counts['지각']          || null,
      counts['근무시간 미달'] || null,
      counts['미태깅']        || null,
      counts['혼합']          || null,
      total,
    ])
  }

  const grandTotal = Object.values(anomalyTotals).reduce((s, v) => s + v, 0)
  const anomalyTotalRow: (string | number | null)[] = [
    null, '합계', null,
    anomalyTotals['지각']          || null,
    anomalyTotals['근무시간 미달'] || null,
    anomalyTotals['미태깅']        || null,
    anomalyTotals['혼합']          || null,
    grandTotal || null,
  ]

  const wsAnomaly = XLSX.utils.aoa_to_sheet([
    ANOMALY_HEADERS,
    ...anomalyDataRows,
    anomalyTotalRow,
  ])
  wsAnomaly['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 14 },
    { wch: 8  }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
  ]

  styleHeader(wsAnomaly, ANOMALY_HEADERS.length, 'C00000')
  styleBlock(wsAnomaly, 1, anomalyDataRows.length, ANOMALY_HEADERS.length, (r, c, v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: r % 2 === 0 ? 'FFF5F5' : 'FFFFFF' } },
    font:      { sz: 9, bold: c === 7 && !!v, color: { rgb: c >= 3 && v ? 'C00000' : '333333' } },
    alignment: { horizontal: c >= 3 ? 'center' : 'left', vertical: 'center' },
  }))
  const anomalyTotalRowIdx = anomalyDataRows.length + 1
  styleBlock(wsAnomaly, anomalyTotalRowIdx, 1, ANOMALY_HEADERS.length, (_r, c, v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: 'FFE0E0' } },
    font:      { sz: 9, bold: true, color: { rgb: c >= 3 && v ? 'C00000' : '333333' } },
    alignment: { horizontal: c >= 3 ? 'center' : 'left', vertical: 'center' },
  }))

  // ── Build and download workbook ───────────────────────────────────────

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, wsDetail,  '근태결과')
  XLSX.utils.book_append_sheet(wb, wsSum,     '요약')
  XLSX.utils.book_append_sheet(wb, wsAnomaly, '이상치')

  const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Grid-format export (one row per employee, one column per day). */
export function exportGridCsv(
  employees: Employee[],
  records: ProcessedRecord[],
  dates: string[],
  filename = '근태그리드_export.csv',
) {
  const lookup: Record<string, Record<string, ProcessedRecord>> = {}
  for (const r of records) {
    if (!lookup[r.employeeId]) lookup[r.employeeId] = {}
    lookup[r.employeeId][r.date] = r
  }

  const rows = employees.map(emp => {
    const empRecs = lookup[emp.id] ?? {}
    let totalH = 0
    let otH = 0
    let anomalies = 0

    const row: Record<string, string> = {
      '이름': emp.name,
      '조직경로': getOrgPath(emp),
    }

    for (const date of dates) {
      const rec = empRecs[date]
      const dow = new Date(date + 'T12:00').getDay()
      const dayNum = new Date(date + 'T12:00').getDate()
      const col = `${dayNum}일`

      if (!rec) {
        row[col] = dow === 0 || dow === 6 ? '' : '—'
      } else if (rec.dayType !== 'WEEKDAY') {
        row[col] = 'H'
      } else if (rec.flag === 'LATE') {
        row[col] = 'L'
        anomalies++
      } else if (rec.flag !== null) {
        row[col] = 'A'
        anomalies++
      } else if (rec.overtimeHours > 0) {
        row[col] = 'OT'
      } else {
        row[col] = 'N'
      }

      if (rec) {
        totalH += rec.regularHours + rec.overtimeHours
        otH += rec.overtimeHours
      }
    }

    row['총근로(h)'] = fmtH(totalH)
    row['연장(h)'] = fmtH(otH)
    row['이상치(건)'] = String(anomalies)

    return row
  })

  triggerDownload(Papa.unparse(rows, { header: true }), filename)
}
