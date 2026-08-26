import Papa from 'papaparse'
import * as XLSX from 'xlsx-js-style'
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'
import type { GridRow } from '@/components/admin/AttendanceResultTable'
import { computeRealHoursOtForRecord, isLeaderOnDate } from '@/utils/attendanceCalc'

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
  { id: 'stayH',            header: '순체류',          wch: 8  },
  { id: 'realWorkH',        header: '실근무',          wch: 8  },
  { id: 'approvedWorkRawH', header: '승인근무(원본)',   wch: 12 },
  { id: 'approvedWorkPayH', header: '승인근무(급여용)', wch: 12 },
  { id: 'paidRecognizedH',  header: '유급인정시간',     wch: 12 },
  { id: 'attendanceStatus', header: '근태상태',        wch: 8  },
  { id: 'normalTags',       header: '정상정보',        wch: 14 },
  { id: 'anomalyTags',      header: '비정상정보',      wch: 18 },
  { id: 'otherH',      header: '소정외',          wch: 10 },
  { id: 'otH',         header: '법정연장',        wch: 10 },
  { id: 'nightH',      header: '야간',            wch: 10 },
  { id: 'payOtherH',   header: '소정외',          wch: 14 },
  { id: 'payOtH',      header: '법정연장',        wch: 14 },
  { id: 'payNightH',   header: '야간',            wch: 14 },
  { id: 'erpOtApplied', header: '연장신청',       wch: 12 },
]

// 화면 테이블(AttendanceResultTable.tsx)의 급여용/실계산 2단 그룹 헤더와 동일한 구분을
// 엑셀에도 반영하기 위한 그룹 정의.
const PAY_GROUP_IDS = new Set(['payOtherH', 'payOtH', 'payNightH'])
const RAW_GROUP_IDS = new Set(['otherH', 'otH', 'nightH'])

interface ColSpan { start: number; end: number }

function findGroupSpan(activeCols: DetailColDef[], ids: Set<string>): ColSpan | null {
  const idxs: number[] = []
  activeCols.forEach((c, i) => { if (ids.has(c.id)) idxs.push(i) })
  return idxs.length ? { start: idxs[0], end: idxs[idxs.length - 1] } : null
}

/** row1(서브헤더) 스타일 — 기존 단일행 헤더와 동일한 네이비. */
function styleDetailSubHeader(ws: XLSX.WorkSheet, r: number, c: number) {
  cs(ws, r, c, {
    font:      { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 },
    fill:      { patternType: 'solid', fgColor: { rgb: '1F3864' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  })
}

/**
 * "근태결과" 시트를 2행 헤더로 빌드한다 — row0: 급여용/실계산(원본) 그룹 라벨(가로 병합),
 * 그 외 컬럼은 row0:row1 세로 병합으로 기존처럼 한 줄 헤더로 보이게 함. row1: 그룹 내
 * 개별 컬럼명. exportXlsx/exportTableXlsx가 rowData 구성만 다르게 하고 공유한다.
 */
function buildDetailSheet(
  activeCols: DetailColDef[],
  detailRows: unknown[][],
  /** ERP 미신청 야간/연장 감사 대상 행 표시 — 소정외/법정연장/야간(실계산 원본) 컬럼만 옅은 red로 하이라이트.
   *  경영진 KPI에는 올리지 않기로 한 지표라 상세 시트에서만 눈에 띄게 한다. */
  auditFlags?: boolean[],
): XLSX.WorkSheet {
  const paySpan = findGroupSpan(activeCols, PAY_GROUP_IDS)
  const rawSpan = findGroupSpan(activeCols, RAW_GROUP_IDS)
  const inSpan  = (i: number, span: ColSpan | null) => span != null && i >= span.start && i <= span.end
  const inGroup = (i: number) => inSpan(i, paySpan) || inSpan(i, rawSpan)

  const groupRow: (string | null)[] = activeCols.map((c, i) => {
    if (paySpan && i === paySpan.start) return '급여용'
    if (rawSpan && i === rawSpan.start) return '실계산 (원본)'
    return inGroup(i) ? null : c.header
  })
  const subRow: (string | null)[] = activeCols.map((c, i) => inGroup(i) ? c.header : null)

  const wsDetail = XLSX.utils.aoa_to_sheet([groupRow, subRow, ...detailRows])

  const merges: XLSX.Range[] = []
  if (paySpan && paySpan.start !== paySpan.end) merges.push({ s: { r: 0, c: paySpan.start }, e: { r: 0, c: paySpan.end } })
  if (rawSpan && rawSpan.start !== rawSpan.end) merges.push({ s: { r: 0, c: rawSpan.start }, e: { r: 0, c: rawSpan.end } })
  activeCols.forEach((_c, i) => {
    if (!inGroup(i)) merges.push({ s: { r: 0, c: i }, e: { r: 1, c: i } })
  })
  wsDetail['!merges'] = merges

  // 날짜 포맷 (근무일자 컬럼) — 헤더가 2행이라 데이터는 row index 2부터 시작
  const dateColIdx = activeCols.findIndex(c => c.id === 'date')
  if (dateColIdx >= 0) {
    for (let i = 0; i < detailRows.length; i++) {
      const ref = XLSX.utils.encode_cell({ r: i + 2, c: dateColIdx })
      if (wsDetail[ref]) wsDetail[ref].z = 'yyyy-mm-dd'
    }
  }

  // 숫자 포맷 (0.00)
  const NUMERIC_COL_IDS = new Set(['leaveAmt', 'stayH', 'realWorkH', 'approvedWorkRawH', 'approvedWorkPayH', 'paidRecognizedH', 'payOtherH', 'payOtH', 'payNightH', 'otherH', 'otH', 'nightH'])
  const numericColIndices = activeCols
    .map((c, i) => ({ id: c.id, idx: i }))
    .filter(({ id }) => NUMERIC_COL_IDS.has(id))

  for (let rowIdx = 0; rowIdx < detailRows.length; rowIdx++) {
    for (const { idx } of numericColIndices) {
      const ref = XLSX.utils.encode_cell({ r: rowIdx + 2, c: idx })
      if (wsDetail[ref] && typeof wsDetail[ref].v === 'number') {
        wsDetail[ref].t = 'n'
        wsDetail[ref].z = '0.00'
      }
    }
  }

  wsDetail['!cols'] = activeCols.map(c => ({ wch: c.wch }))

  // 헤더 스타일 — 그룹 라벨(급여용=amber, 실계산=gray) / 그 외 네이비
  activeCols.forEach((_c, i) => {
    if (paySpan && i === paySpan.start) {
      cs(wsDetail, 0, i, {
        font:      { bold: true, color: { rgb: '7A4A00' }, sz: 10 },
        fill:      { patternType: 'solid', fgColor: { rgb: 'FDECC8' } },
        alignment: { horizontal: 'center', vertical: 'center' },
      })
    } else if (rawSpan && i === rawSpan.start) {
      cs(wsDetail, 0, i, {
        font:      { bold: true, color: { rgb: '404040' }, sz: 10 },
        fill:      { patternType: 'solid', fgColor: { rgb: 'E5E5E5' } },
        alignment: { horizontal: 'center', vertical: 'center' },
      })
    } else if (!inGroup(i)) {
      styleDetailSubHeader(wsDetail, 0, i)
    }
    if (inGroup(i)) styleDetailSubHeader(wsDetail, 1, i)
  })

  // 데이터 행: 홀짝 줄무늬 (헤더 2행만큼 시작 행 보정, 줄무늬 패턴 자체는 기존과 동일)
  styleBlock(wsDetail, 2, detailRows.length, activeCols.length, (r, _c, _v) => ({
    fill:      { patternType: 'solid', fgColor: { rgb: (r - 2) % 2 === 0 ? 'FFFFFF' : 'F5F8FF' } },
    font:      { sz: 9, color: { rgb: '333333' } },
    alignment: { vertical: 'center' },
  }))

  // ERP 미신청 감사 대상 — 실계산(원본) 소정외/법정연장/야간 칸만 옅은 red로 덮어써서 눈에 띄게 한다.
  if (auditFlags && rawSpan) {
    for (let i = 0; i < detailRows.length; i++) {
      if (!auditFlags[i]) continue
      for (let c = rawSpan.start; c <= rawSpan.end; c++) {
        cs(wsDetail, i + 2, c, {
          fill:      { patternType: 'solid', fgColor: { rgb: 'FDE2E1' } },
          font:      { sz: 9, color: { rgb: '333333' } },
          alignment: { vertical: 'center' },
        })
      }
    }
  }

  return wsDetail
}

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
  const isHoliday = r.dayType !== 'WEEKDAY'
  // 직책자는 연장신청 절차 자체가 면제(재량근로)되므로 ERP 게이트를 걸지 않는다 — 발령/해임일
  // 범위 밖(직책자 아닌 기간)은 일반 직원과 동일하게 게이트를 확인해야 함 (isLeaderOnDate).
  const isLeader = isLeaderOnDate(attrs, emp, r.date)

  // 테이블과 동일한 태그 로직
  const anomalyTags: string[] = []
  const flag = r.flag
  if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') anomalyTags.push('미태깅')
  if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') anomalyTags.push('지각')
  if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') anomalyTags.push('근무시간 미달')

  const attendanceStatus = anomalyTags.length === 0 ? '정상' : '비정상'

  // 실근무시간 기준 순체류/실근무/소정외(1.0x)/법정연장(1.5x)/야간 — 테이블(AttendanceResultTable)/
  // 그리드(EmployeeCalendarGrid)와 동일한 공용 함수(computeRealHoursOtForRecord) 재사용. 휴일근무는
  // ERP 연장신청과 무관하게(구글폼으로 별도 확인) 소정외=0, 법정연장 슬롯에 기존 r.holidayHours.
  const realHoursOt = computeRealHoursOtForRecord(r, isLeader)
  const {
    stayMins, realWorkMins, nightMins, otherMins, otMins, payOtherH, payOtH, payNightH,
    approvedWorkRawH, approvedWorkPayH, paidRecognizedH,
  } = realHoursOt
  const otherH = otherMins / 60
  const otH    = otMins / 60
  const nightH = nightMins / 60

  // 휴일근로는 연장신청(ERP) 체계 밖 — 구글폼으로 수기 확인하는 별도 프로세스라
  // "연장근로" 태그·ERP상태 게이트를 안 걸고 "휴일근로" 하나만 표시한다.
  const normalTags: string[] = []
  if (r.finalStatus === '외근')     normalTags.push('외근')
  if (isHoliday) {
    if (r.finalStatus === '휴일근무') normalTags.push('휴일근로')
  } else {
    if (otherH > 0 || otH > 0) normalTags.push('연장근로')
  }
  const isLeaveDay = !!(r.leaveType && ['연차','오전반차','오후반차','오전반반차','오후반반차','출장','재택근무'].includes(r.leaveType))
  if (normalTags.length === 0 && !isLeaveDay && r.dayType === 'WEEKDAY') normalTags.push('일반')

  // AttendanceResultTable.tsx의 auditFlag와 동일 기준 — 급여용 값이 있는데 ERP 미신청인
  // 감사 대상. DETAIL_COL_DEFS에는 없는 필드라 시트 컬럼으로는 안 나가고, exportXlsx가
  // 행별 하이라이트 판단에만 별도로 뽑아 쓴다.
  const auditFlag = !isHoliday && !isLeader && (otherH > 0 || otH > 0 || nightH > 0) && r.erpOtApplied !== true

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
    stayH:      stayMins / 60 > 0 ? stayMins / 60 : null,
    realWorkH:  realWorkMins / 60 > 0 ? realWorkMins / 60 : null,
    approvedWorkRawH: approvedWorkRawH > 0 ? approvedWorkRawH : null,
    approvedWorkPayH: approvedWorkPayH > 0 ? approvedWorkPayH : null,
    paidRecognizedH:  paidRecognizedH  > 0 ? paidRecognizedH  : null,
    attendanceStatus,
    normalTags:       normalTags.length  > 0 ? normalTags.join(', ')  : null,
    anomalyTags:      anomalyTags.length > 0 ? anomalyTags.join(', ') : null,
    payOtherH: payOtherH > 0 ? payOtherH : null,
    payOtH:    payOtH    > 0 ? payOtH    : null,
    payNightH: payNightH > 0 ? payNightH : null,
    otherH: otherH > 0 ? otherH : null,
    otH:    otH    > 0 ? otH    : null,
    nightH: nightH > 0 ? nightH : null,
    erpOtApplied:
      isHoliday      ? '—' :
      isLeader       ? '—' :
      r.erpOtApplied ? '신청' :
      otH > 0        ? '미신청' :
      '—',
    auditFlag,
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

  const auditFlags: boolean[] = []
  const detailRows = sorted.map(r => {
    const emp     = empMap.get(r.employeeId)
    const attrs   = finalAttrMap?.get(r.employeeId)
    const rowData = buildDetailRowData(r, emp, attrs)
    auditFlags.push(rowData.auditFlag === true)
    return activeCols.map(c => rowData[c.id] ?? null)
  })

  const wsDetail = buildDetailSheet(activeCols, detailRows, auditFlags)

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
      stayH:            row.stayH > 0 ? row.stayH : null,
      realWorkH:        row.realWorkH > 0 ? row.realWorkH : null,
      approvedWorkRawH: row.approvedWorkRawH > 0 ? row.approvedWorkRawH : null,
      approvedWorkPayH: row.approvedWorkPayH > 0 ? row.approvedWorkPayH : null,
      paidRecognizedH:  row.paidRecognizedH  > 0 ? row.paidRecognizedH  : null,
      attendanceStatus: row.attendanceStatus,
      normalTags:       row.normalTags.length  > 0 ? row.normalTags.join(', ')  : null,
      anomalyTags:      row.anomalyTags.length > 0 ? row.anomalyTags.join(', ') : null,
      payOtherH:        row.payOtherH > 0 ? row.payOtherH : null,
      payOtH:           row.payOtH    > 0 ? row.payOtH    : null,
      payNightH:        row.payNightH > 0 ? row.payNightH : null,
      otherH:           row.otherH > 0 ? row.otherH : null,
      otH:              row.otH    > 0 ? row.otH    : null,
      nightH:           row.nightH > 0 ? row.nightH : null,
      erpOtApplied:     row.erpOtStatus,
    }
    return activeCols.map(c => rowData[c.id] ?? null)
  })
  const auditFlags = sortedRows.map(row => row.auditFlag === true)

  const wsDetail = buildDetailSheet(activeCols, detailRows, auditFlags)

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
