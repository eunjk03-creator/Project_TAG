/**
 * 부문 근태 보고서 Excel 빌더
 * 시트: 이상치_요약 · 법정근로초과 · 지각 · 근무시간미달 · 미태깅 · 휴일근로
 */
import * as XLSX from 'xlsx-js-style'
import type { ProcessedRecord, Employee, SieveFlag } from '@/types/tag'
import { parseTimeToMins, compute4141BreakMins, computeEffInMins } from '@/utils/attendanceCalc'

// ── 인정시간 크레딧 ON 기준 근무시간 ─────────────────────────────────────────────
// 그리드 인정시간 크레딧 ON과 동일 계산: effectiveClockIn(반차보정) + 4/1/4/1 휴게 + 연차크레딧
function recognizedHours(r: ProcessedRecord): number {
  const isSlackInj    = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
  const isErpApproved = r.leaveType ? !isSlackInj : true
  const credit        = (isErpApproved && !r.isUnpaidLeave && r.erpLeaveAmount) ? r.erpLeaveAmount * 8 : 0

  const ciRaw = r.clockIn  ? parseTimeToMins(r.clockIn)  : null
  const co    = r.clockOut ? parseTimeToMins(r.clockOut) : null
  if (ciRaw === null || co === null) return credit

  const ciEff  = computeEffInMins(ciRaw, r.leaveType, isErpApproved)
  const elapsed = Math.max(0, co - ciEff)
  const net     = Math.max(0, elapsed - compute4141BreakMins(elapsed)) / 60
  return net + credit
}

// ── 타입 ─────────────────────────────────────────────────────────────────────

type AnomalyCategory = '지각' | '근무시간미달' | '미태깅'

interface EmpRow {
  sbn:      string
  name:     string
  division: string
}

// ── 플래그 분류 (혼합 플래그는 두 카테고리 모두에 개별 집계) ──────────────────────

// 3종 체계(지각/근무시간미달/미태깅) — EARLY_DEPARTURE는 재계산 전 캐시된 레코드에서만
// 남아있을 수 있음(하위호환), 근무시간미달로 통합.
// LATE_AND_ANOMALY/LATE_AND_EARLY_DEPARTURE는 지각+근무시간미달이 한 날에 겹친 혼합 케이스라
// 어느 한쪽으로만 분류하거나 제외하면 실제 발생 건수를 놓치게 됨 → 두 카테고리 모두에 +1.
function classifyFlags(flag: SieveFlag): AnomalyCategory[] {
  if (flag === 'LATE')                                    return ['지각']
  if (flag === 'ATTENDANCE_ANOMALY' || flag === 'EARLY_DEPARTURE') return ['근무시간미달']
  if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT')  return ['미태깅']
  if (flag === 'LATE_AND_ANOMALY' || flag === 'LATE_AND_EARLY_DEPARTURE') return ['지각', '근무시간미달']
  return []
}

export const ANOM_LABEL: Record<string, string> = {
  LATE:                     '지각',
  ATTENDANCE_ANOMALY:       '근무시간미달',
  EARLY_DEPARTURE:          '근무시간미달',
  NO_CLOCK_IN:              '미태깅',
  NO_CLOCK_OUT:             '미태깅',
  LATE_AND_ANOMALY:         '지각+근무시간미달',
  LATE_AND_EARLY_DEPARTURE: '지각+근무시간미달',
}

// ── 셀 / 스타일 헬퍼 ─────────────────────────────────────────────────────────

export const BDR = { style: 'thin', color: { rgb: 'D0D0D0' } } as const
export function bd() { return { top: BDR, bottom: BDR, left: BDR, right: BDR } }

export function S(fill: string, bold: boolean, color = '333333', align = 'center', sz = 10) {
  return {
    font:      { bold, color: { rgb: color }, sz },
    fill:      { fgColor: { rgb: fill } },
    alignment: { horizontal: align, vertical: 'center', wrapText: false },
    border:    bd(),
  }
}
export function hdr(fill = 'C00000') { return S(fill, true, 'FFFFFF', 'center', 10) }
export function titleS(fill = 'C00000') {
  return {
    font:      { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 },
    fill:      { fgColor: { rgb: fill } },
    alignment: { horizontal: 'center', vertical: 'center' },
  }
}

export function cellKey(c: number, r: number): string {
  let col = ''
  let cc  = c
  while (cc >= 0) { col = String.fromCharCode(65 + (cc % 26)) + col; cc = Math.floor(cc / 26) - 1 }
  return col + (r + 1)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sc(ws: Record<string, any>, c: number, r: number, v: string | number, s: object) {
  ws[cellKey(c, r)] = { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s }
}

// ── 기간 라벨 ────────────────────────────────────────────────────────────────

export function periodLabel(records: ProcessedRecord[]): string {
  const dates = records.map(r => r.date).sort()
  if (!dates.length) return ''
  const fmt = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`
  return `${fmt(dates[0])}~${fmt(dates[dates.length - 1])}`
}

// ── 주간 시작일 (월요일) ──────────────────────────────────────────────────────

function weekStart(dateStr: string): string {
  const d   = new Date(dateStr + 'T00:00:00Z')
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}

// ── 이상치_요약 ───────────────────────────────────────────────────────────────

function buildAnomSheet(
  records:  ProcessedRecord[],
  empMap:   Map<string, Employee>,
  period:   string,
) {
  // 사번별 이상치 집계
  const anomRecords = records.filter(r => classifyFlags(r.flag).length > 0)

  const empSbn: Record<string, EmpRow> = {}
  const counts:  Record<string, Record<AnomalyCategory, number>> = {}
  const details: Record<string, ProcessedRecord[]> = {}

  anomRecords.forEach(r => {
    const cats = classifyFlags(r.flag)
    const emp = empMap.get(r.employeeId)
    if (!emp) return
    const key = r.employeeId
    if (!empSbn[key])  empSbn[key]  = { sbn: emp.rawId ?? r.employeeId, name: emp.name, division: emp.division }
    if (!counts[key])  counts[key]  = { 지각: 0, 근무시간미달: 0, 미태깅: 0 }
    if (!details[key]) details[key] = []
    cats.forEach(cat => { counts[key][cat]++ })
    details[key].push(r)
  })

  // 이름순 정렬
  const persons = Object.keys(empSbn).sort((a, b) =>
    empSbn[a].name.localeCompare(empSbn[b].name, 'ko')
  )

  // 합계
  const totals: Record<AnomalyCategory, number> = { 지각: 0, 근무시간미달: 0, 미태깅: 0 }
  persons.forEach(k => {
    const c = counts[k]
    totals.지각        += c.지각
    totals.근무시간미달 += c.근무시간미달
    totals.미태깅      += c.미태깅
  })

  const NCOL = 6
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const merges: XLSX.Range[] = []
  const rowHpt: object[] = []
  let R = 0

  // 타이틀
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOL } })
  sc(ws, 0, R, `${period} 이상치 현황 (개인별)`, titleS('C00000'))
  rowHpt.push({ hpt: 24 }); R++

  // 헤더
  ;['사번', '이름', '본부', '지각', '근무시간 미달', '미태깅', '총합계'].forEach((h, c) =>
    sc(ws, c, R, h, hdr('C00000'))
  )
  rowHpt.push({ hpt: 20 }); R++

  // 개인별
  persons.forEach(key => {
    const { sbn, name, division } = empSbn[key]
    const c = counts[key]
    const total = c.지각 + c.근무시간미달 + c.미태깅

    ;[sbn, name, division, c.지각, c.근무시간미달, c.미태깅, total].forEach((v, ci) => {
      const s = ci < 3
        ? S('F5F5F5', true, '333333', ci === 2 ? 'left' : 'center')
        : { font: { bold: ci === 6, color: { rgb: (v as number) > 0 ? 'C00000' : 'AAAAAA' }, sz: 10 },
            fill: { fgColor: { rgb: 'F5F5F5' } },
            alignment: { horizontal: 'center', vertical: 'center' },
            border: bd() }
      sc(ws, ci, R, v as string | number, s)
    })
    rowHpt.push({ hpt: 18, collapsed: 1 }); R++

    // 상세행 (접힘)
    const recs = details[key]?.sort((a, b) => a.date.localeCompare(b.date)) ?? []
    if (recs.length > 0) {
      // 소제목
      ;['', '근무일자', '출근', '퇴근', '연차일수', '연차코드', '최종근무(h)', '비정상정보'].forEach((h, ci) =>
        sc(ws, ci, R, h, h ? S('E8E8E8', true, '555555', 'center', 9) : S('E8E8E8', false, 'AAAAAA', 'center', 9))
      )
      rowHpt.push({ hpt: 15, level: 1, hidden: 1 }); R++

      recs.forEach(r => {
        const workH = +recognizedHours(r).toFixed(2)
        ;['', r.date, r.clockIn ?? '미태깅', r.clockOut ?? '미태깅',
          r.erpLeaveAmount ?? '', r.leaveType ?? '',
          workH, ANOM_LABEL[r.flag!] ?? ''].forEach((v, ci) => {
          const color = ci === 7 && v ? 'C00000' : '555555'
          sc(ws, ci, R, v as string | number, S('FFFFFF', false, color, 'center', 9))
        })
        rowHpt.push({ hpt: 16, level: 1, hidden: 1 }); R++
      })
    }
  })

  // 합계행
  const grandTotal = totals.지각 + totals.근무시간미달 + totals.미태깅
  ;['', '합계', '', totals.지각, totals.근무시간미달, totals.미태깅, grandTotal].forEach((v, ci) => {
    sc(ws, ci, R, v as string | number, {
      font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 },
      fill: { fgColor: { rgb: 'C00000' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: bd(),
    })
  })
  rowHpt.push({ hpt: 18 }); R++

  ws['!ref']    = 'A1:' + cellKey(NCOL, R)
  ws['!merges'] = merges
  ws['!cols']   = [10, 10, 18, 7, 13, 7, 9].map(w => ({ wch: w }))
  ws['!rows']   = rowHpt
  return ws
}

// ── 법정근로초과 ──────────────────────────────────────────────────────────────

function buildOvertimeSheet(records: ProcessedRecord[], empMap: Map<string, Employee>, period: string) {
  // 월별·주별 모두 인정시간(크레딧 ON) 기준 — 연차/반차/반반차 포함해서도 초과인 사람 추출
  const monthly: Map<string, Map<string, number>> = new Map()
  const weekly:  Map<string, Map<string, number>> = new Map()

  records.forEach(r => {
    const h = recognizedHours(r)
    if (h <= 0) return
    const emp = empMap.get(r.employeeId)
    if (!emp) return

    const month = r.date.slice(0, 7)
    if (!monthly.has(month)) monthly.set(month, new Map())
    monthly.get(month)!.set(r.employeeId, (monthly.get(month)!.get(r.employeeId) ?? 0) + h)

    const wk = weekStart(r.date)
    if (!weekly.has(wk)) weekly.set(wk, new Map())
    weekly.get(wk)!.set(r.employeeId, (weekly.get(wk)!.get(r.employeeId) ?? 0) + h)
  })

  // 초과자 추출
  type OverEntry = { name: string; h: number; over: number }

  const monthOver: Array<{ label: string; items: OverEntry[] }> = []
  Array.from(monthly.entries()).sort().forEach(([month, map]) => {
    const items: OverEntry[] = []
    map.forEach((h, empId) => {
      if (h > 209) {
        const emp = empMap.get(empId)
        if (emp) items.push({ name: emp.name, h: +h.toFixed(2), over: +(h - 209).toFixed(2) })
      }
    })
    if (items.length > 0) {
      items.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      const [y, m] = month.split('-')
      monthOver.push({ label: `${y}년 ${+m}월 소정근로 209시간 초과`, items })
    }
  })

  const weekOver: Array<{ label: string; items: OverEntry[] }> = []
  Array.from(weekly.entries()).sort().forEach(([wk, map]) => {
    const items: OverEntry[] = []
    map.forEach((h, empId) => {
      if (h >= 52) {
        const emp = empMap.get(empId)
        if (emp) items.push({ name: emp.name, h: +h.toFixed(2), over: +(h - 52).toFixed(2) })
      }
    })
    if (items.length > 0) {
      items.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      const sun = new Date(wk + 'T00:00:00Z')
      sun.setUTCDate(sun.getUTCDate() + 6)
      const end = sun.toISOString().slice(0, 10)
      weekOver.push({ label: `주 52시간 초과 (${wk}~${end})`, items })
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const merges: XLSX.Range[] = []
  const rowHpt: object[] = []
  let R = 0

  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 3 } })
  sc(ws, 0, R, `${period} 법정 근로시간 초과 현황`, titleS('8B0000'))
  rowHpt.push({ hpt: 26 }); R++

  function section(label: string, items: OverEntry[], colLabel: string) {
    merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 3 } })
    sc(ws, 0, R, `${label} (${items.length}명)`, hdr('8B0000'))
    rowHpt.push({ hpt: 20 }); R++

    ;[colLabel, '총 근무시간(h)', '초과시간(h)', ''].forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
    rowHpt.push({ hpt: 18 }); R++

    if (items.length === 0) {
      merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 3 } })
      sc(ws, 0, R, '해당 없음', S('FFFFFF', false, '999999'))
      rowHpt.push({ hpt: 17 }); R++
    } else {
      items.forEach(({ name, h, over }) => {
        sc(ws, 0, R, name, S('FFFFFF', false, '333333'))
        sc(ws, 1, R, h,    S('FFFFFF', false, '333333'))
        sc(ws, 2, R, over, { font: { bold: true, color: { rgb: 'C00000' }, sz: 10 }, fill: { fgColor: { rgb: 'FFF0F0' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: bd() })
        sc(ws, 3, R, '',   S('FFFFFF', false, 'FFFFFF'))
        rowHpt.push({ hpt: 17 }); R++
      })
    }
    rowHpt.push({ hpt: 8 }); R++ // 빈 줄
  }

  if (monthOver.length === 0) {
    section('월 소정근로 209시간 초과', [], '이름')
  } else {
    monthOver.forEach(({ label, items }) => section(label, items, '이름'))
  }

  if (weekOver.length === 0) {
    section('주 52시간 초과', [], '이름')
  } else {
    weekOver.forEach(({ label, items }) => section(label, items, '이름'))
  }

  ws['!ref']    = 'A1:' + cellKey(3, R)
  ws['!merges'] = merges
  ws['!cols']   = [14, 16, 12, 4].map(w => ({ wch: w }))
  ws['!rows']   = rowHpt
  return ws
}

// ── 유형별 상세 시트 ──────────────────────────────────────────────────────────

const DETAIL_HDRS = ['본부', '사번', '이름', '근무일자', '출근', '퇴근', '연차일수', '연차코드', '최종근무(h)', '근태상태', '비정상정보']
const DETAIL_COLS = [16, 10, 8, 10, 7, 7, 8, 10, 10, 8, 14].map(w => ({ wch: w }))

function buildTypeSheet(
  records:   ProcessedRecord[],
  empMap:    Map<string, Employee>,
  flagTypes: SieveFlag[],
  titleText: string,
  period:    string,
) {
  const flagSet = new Set(flagTypes)
  const filtered = records
    .filter(r => r.flag !== null && flagSet.has(r.flag))
    .sort((a, b) => {
      const na = empMap.get(a.employeeId)?.name ?? ''
      const nb = empMap.get(b.employeeId)?.name ?? ''
      return na.localeCompare(nb, 'ko') || a.date.localeCompare(b.date)
    })

  // 개인별 횟수 (이름순)
  const countMap: Record<string, { name: string; cnt: number }> = {}
  filtered.forEach(r => {
    const emp = empMap.get(r.employeeId)
    if (!emp) return
    if (!countMap[r.employeeId]) countMap[r.employeeId] = { name: emp.name, cnt: 0 }
    countMap[r.employeeId].cnt++
  })
  const sorted = Object.values(countMap).sort((a, b) => a.name.localeCompare(b.name, 'ko'))

  const NCOLS = DETAIL_HDRS.length - 1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const merges: XLSX.Range[] = []
  const rowHpt: object[] = []
  let R = 0

  // 타이틀
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOLS } })
  sc(ws, 0, R, `${period} ${titleText}`, titleS('C00000'))
  rowHpt.push({ hpt: 24 }); R++

  // 개인별 횟수 요약
  const sumCols = sorted.length  // 이름 수
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: Math.max(sumCols, 1) } })
  sc(ws, 0, R, '개인별 횟수', hdr('8B0000'))
  rowHpt.push({ hpt: 18 }); R++

  ;['이름', ...sorted.map(v => v.name)].forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
  rowHpt.push({ hpt: 18 }); R++

  ;['횟수', ...sorted.map(v => v.cnt)].forEach((v, c) => {
    const s = c === 0
      ? S('F5F5F5', true, '333333')
      : { font: { bold: true, color: { rgb: 'C00000' }, sz: 10 }, fill: { fgColor: { rgb: 'FFFFFF' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: bd() }
    sc(ws, c, R, v as string | number, s)
  })
  rowHpt.push({ hpt: 18 }); R++

  rowHpt.push({ hpt: 8 }); R++ // 빈 줄

  // 상세 내역
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOLS } })
  sc(ws, 0, R, '상세 내역', hdr('8B0000'))
  rowHpt.push({ hpt: 18 }); R++

  DETAIL_HDRS.forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
  rowHpt.push({ hpt: 18 }); R++

  filtered.forEach(r => {
    const emp  = empMap.get(r.employeeId)
    const workH = +recognizedHours(r).toFixed(2)
    ;[emp?.division ?? '', emp?.rawId ?? r.employeeId, emp?.name ?? r.employeeId,
      r.date, r.clockIn ?? '미태깅', r.clockOut ?? '미태깅',
      r.erpLeaveAmount ?? '', r.leaveType ?? '',
      workH, r.finalStatus, ANOM_LABEL[r.flag!] ?? ''].forEach((v, ci) => {
      const color = ci === 10 && v ? 'C00000' : '333333'
      sc(ws, ci, R, v as string | number, S('FFFFFF', false, color, 'center'))
    })
    rowHpt.push({ hpt: 17 }); R++
  })

  ws['!ref']    = 'A1:' + cellKey(Math.max(NCOLS, sumCols), R)
  ws['!merges'] = merges
  ws['!cols']   = DETAIL_COLS
  ws['!rows']   = rowHpt
  return ws
}

// ── 휴일근로 ──────────────────────────────────────────────────────────────────

function buildHolidaySheet(records: ProcessedRecord[], empMap: Map<string, Employee>, period: string) {
  const holRecords = records
    .filter(r => r.finalStatus === '휴일근무' || r.isHolidayWork)
    .sort((a, b) => {
      const na = empMap.get(a.employeeId)?.name ?? ''
      const nb = empMap.get(b.employeeId)?.name ?? ''
      return na.localeCompare(nb, 'ko') || a.date.localeCompare(b.date)
    })

  // 개인별 집계
  const personMap: Map<string, { name: string; cnt: number; totalH: number; rows: ProcessedRecord[] }> = new Map()
  holRecords.forEach(r => {
    const emp = empMap.get(r.employeeId)
    if (!emp) return
    if (!personMap.has(r.employeeId)) personMap.set(r.employeeId, { name: emp.name, cnt: 0, totalH: 0, rows: [] })
    const p = personMap.get(r.employeeId)!
    p.cnt++
    p.totalH += recognizedHours(r)
    p.rows.push(r)
  })
  const persons = Array.from(personMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'ko'))

  // 날짜별 집계
  const dateMap: Map<string, string[]> = new Map()
  holRecords.forEach(r => {
    const emp = empMap.get(r.employeeId)
    if (!emp) return
    if (!dateMap.has(r.date)) dateMap.set(r.date, [])
    dateMap.get(r.date)!.push(emp.name)
  })
  const dateSummary = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, names]) => ({ date, names: names.join(', '), cnt: names.length }))

  const NCOL = 4
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const merges: XLSX.Range[] = []
  const rowHpt: object[] = []
  let R = 0

  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOL } })
  sc(ws, 0, R, `${period} 휴일근로 현황`, titleS('8B0000'))
  rowHpt.push({ hpt: 24 }); R++

  // 개인별 요약 소제목
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOL } })
  sc(ws, 0, R, '개인별 휴일근로 요약', hdr('8B0000'))
  rowHpt.push({ hpt: 18 }); R++

  ;['이름', '출근 횟수', '총 근로시간(h)', '', ''].forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
  rowHpt.push({ hpt: 18 }); R++

  // 개인별 요약행 + 접히는 상세행
  persons.forEach(({ name, cnt, totalH, rows }) => {
    sc(ws, 0, R, name,              S('F5F5F5', true,  '333333'))
    sc(ws, 1, R, cnt,               { font: { bold: true, color: { rgb: 'C00000' }, sz: 10 }, fill: { fgColor: { rgb: 'F5F5F5' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: bd() })
    sc(ws, 2, R, +totalH.toFixed(2), { font: { bold: true, color: { rgb: 'C00000' }, sz: 10 }, fill: { fgColor: { rgb: 'F5F5F5' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: bd() })
    sc(ws, 3, R, '',                S('F5F5F5', false, 'AAAAAA'))
    sc(ws, 4, R, '',                S('F5F5F5', false, 'AAAAAA'))
    rowHpt.push({ hpt: 18, collapsed: 1 }); R++

    // 소제목행
    ;['', '근무일자', '출근', '퇴근', '최종근무(h)'].forEach((h, ci) =>
      sc(ws, ci, R, h, h ? S('E8E8E8', true, '555555', 'center', 9) : S('E8E8E8', false, 'AAAAAA', 'center', 9))
    )
    rowHpt.push({ hpt: 15, level: 1, hidden: 1 }); R++

    rows.forEach(r => {
      sc(ws, 0, R, '',                            S('FFFFFF', false, 'AAAAAA', 'center', 9))
      sc(ws, 1, R, r.date,                        S('FFFFFF', false, '555555', 'center', 9))
      sc(ws, 2, R, r.clockIn  ?? '미태깅',         S('FFFFFF', false, '555555', 'center', 9))
      sc(ws, 3, R, r.clockOut ?? '미태깅',         S('FFFFFF', false, '555555', 'center', 9))
      sc(ws, 4, R, +recognizedHours(r).toFixed(2), S('FFFFFF', false, '555555', 'center', 9))
      rowHpt.push({ hpt: 16, level: 1, hidden: 1 }); R++
    })
  })

  rowHpt.push({ hpt: 10 }); R++

  // 날짜별 출근자
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOL } })
  sc(ws, 0, R, '날짜별 출근자 현황', hdr('8B0000'))
  rowHpt.push({ hpt: 18 }); R++

  ;['날짜', '출근자', '인원수', '', ''].forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
  rowHpt.push({ hpt: 18 }); R++

  dateSummary.forEach(({ date, names, cnt }) => {
    sc(ws, 0, R, date,  S('FFFFFF', false, '333333'))
    sc(ws, 1, R, names, S('FFFFFF', false, '333333', 'left'))
    sc(ws, 2, R, cnt,   { font: { bold: true, color: { rgb: 'C00000' }, sz: 10 }, fill: { fgColor: { rgb: 'FFFFFF' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: bd() })
    sc(ws, 3, R, '',    S('FFFFFF', false, 'AAAAAA'))
    sc(ws, 4, R, '',    S('FFFFFF', false, 'AAAAAA'))
    rowHpt.push({ hpt: 17 }); R++
  })

  ws['!ref']    = 'A1:' + cellKey(NCOL, R)
  ws['!merges'] = merges
  ws['!cols']   = [14, 10, 12, 40, 4].map(w => ({ wch: w }))
  ws['!rows']   = rowHpt
  return ws
}

// ── 메인 빌더 ────────────────────────────────────────────────────────────────

export function buildDeptReportBuffer(
  records:   ProcessedRecord[],
  employees: Employee[],
): Buffer {
  const empMap = new Map(employees.map(e => [e.id, e]))
  const period = periodLabel(records)

  const wb = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(wb, buildAnomSheet(records, empMap, period),   '이상치_요약')
  XLSX.utils.book_append_sheet(wb, buildOvertimeSheet(records, empMap, period), '법정근로초과')
  // LATE_AND_ANOMALY/LATE_AND_EARLY_DEPARTURE(지각+근무미달 혼합)는 두 시트 모두에 포함
  XLSX.utils.book_append_sheet(wb, buildTypeSheet(records, empMap, ['LATE', 'LATE_AND_ANOMALY', 'LATE_AND_EARLY_DEPARTURE'], '지각 현황', period), '지각')
  // 조기퇴근은 근무시간미달로 통합 — EARLY_DEPARTURE는 재계산 전 캐시된 레코드 하위호환용으로 같이 포함
  XLSX.utils.book_append_sheet(wb, buildTypeSheet(records, empMap, ['ATTENDANCE_ANOMALY', 'EARLY_DEPARTURE', 'LATE_AND_ANOMALY', 'LATE_AND_EARLY_DEPARTURE'], '근무시간 미달 현황', period), '근무시간미달')
  XLSX.utils.book_append_sheet(wb, buildTypeSheet(records, empMap, ['NO_CLOCK_IN', 'NO_CLOCK_OUT'],   '미태깅 현황',       period), '미태깅')
  XLSX.utils.book_append_sheet(wb, buildHolidaySheet(records, empMap, period), '휴일근로')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
