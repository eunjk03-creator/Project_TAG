/**
 * 근로시간 활용 현황(인당) Excel 빌더 — 대표 보고용
 * 시트: 근로시간_활용현황 (개인별 총합 + 접이식 일자별 상세)
 *
 * 총 근로시간/연장 공식은 EmployeeCalendarGrid·SummaryTab과 동일한 "확정" 공식을 따른다
 * (직책자: netRecH(uncapped)+credit / 비직책자: 연장 있는 날 8+연장, 없는 날 min(netRecH,8)+credit).
 * deptReportExcel.ts의 recognizedHours()는 이 공식과 다른 구식 버전이라 재사용하지 않음.
 */
import * as XLSX from 'xlsx-js-style'
import type { ProcessedRecord, Employee, EmployeeAttributeOverrides } from '@/types/tag'
import {
  parseTimeToMins, compute4141BreakMins, computeEffInMins, computeLeaderPayOtMins,
  isLeaderOnDate,
} from '@/utils/attendanceCalc'
import { bd, S, hdr, titleS, sc, cellKey, periodLabel, ANOM_LABEL } from '@/utils/deptReportExcel'

// ── 일자별 근로시간/연장/크레딧 (그리드·SummaryTab §4 공식과 동일) ──────────────

function computeDaily(r: ProcessedRecord, isLeaderToday: boolean): { total: number; ot: number; night: number } {
  // 휴일근무는 평일과 다른 별도 휴게공식(processRecord.ts의 holidayHours, 30분절삭+4단계
  // 고정차감)을 쓰고 OT/연장 개념 자체가 없음(전체 인정시간이 그대로 휴일근로) — 아래
  // compute4141BreakMins 기반 평일 공식으로 재계산하면 안 됨. r.holidayHours를 그대로 사용.
  if (r.isHolidayWork || r.finalStatus === '휴일근무') {
    return { total: r.holidayHours ?? 0, ot: 0, night: r.nightHours ?? 0 }
  }

  const isSlackInj    = (r.verificationNote ?? []).some(n => n.includes('ERP 미신청'))
  const isErpApproved = r.leaveType ? !isSlackInj : true
  const credit         = (!r.isUnpaidLeave && !isSlackInj && r.erpLeaveAmount) ? r.erpLeaveAmount * 8 : 0

  const ciRaw = r.clockIn  ? parseTimeToMins(r.clockIn)  : null
  const co    = r.clockOut ? parseTimeToMins(r.clockOut) : null
  let netRecH = 0
  if (ciRaw !== null && co !== null) {
    const ciEff   = computeEffInMins(ciRaw, r.leaveType, isErpApproved)
    const elapsed = Math.max(0, co - ciEff)
    netRecH = Math.max(0, elapsed - compute4141BreakMins(elapsed)) / 60
  }

  const approvedOt = isLeaderToday
    ? computeLeaderPayOtMins(r.clockIn, r.clockOut, r.leaveType, isErpApproved) / 60
    : (r.erpOtApplied ? (r.overtimeHours ?? 0) : 0)

  const total = isLeaderToday
    ? netRecH + credit
    : (approvedOt > 0 ? (8 + approvedOt) : (Math.min(netRecH, 8) + credit))

  return { total, ot: approvedOt, night: r.nightHours ?? 0 }
}

// ── 시트 빌드 ────────────────────────────────────────────────────────────────

const HDRS = ['사번', '이름', '본부', '근무일수', '총 근로시간(h)', '총 연장근로(h)', '연장근로 비율(%)', '총 야간근로(h)', '총 휴일근로(h)', '일평균 근로시간(h)', '지각/이상 횟수']
const NCOL = HDRS.length - 1

function buildProductivitySheet(
  records:      ProcessedRecord[],
  employees:    Employee[],
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
  period:       string,
) {
  const empMap = new Map(employees.map(e => [e.id, e]))

  type PersonAgg = {
    emp: Employee
    days: number
    totalH: number
    otH: number
    nightH: number
    holidayH: number
    anomalyCnt: number
    rows: Array<{ r: ProcessedRecord; total: number; ot: number; night: number }>
  }
  const agg = new Map<string, PersonAgg>()

  records
    .filter(r => r.dayType === 'WEEKDAY' || r.isHolidayWork || r.finalStatus === '휴일근무')
    .forEach(r => {
      const emp = empMap.get(r.employeeId)
      if (!emp) return
      const attrs = finalAttrMap.get(r.employeeId)
      if (attrs?.isGlobalExclusion) return
      // 퇴사자: 퇴사일(마지막 출근일, 포함) 다음날부터만 제외(processRecord.ts와 동일 규칙) —
      // 퇴사일 미설정 시 기존처럼 전체 제외. 퇴사일까지의 실적은 그대로 집계에 남아야 함.
      if (attrs?.isResigned && (!attrs.resignedFrom || r.date > attrs.resignedFrom)) return

      const isLeaderToday = isLeaderOnDate(attrs, emp, r.date)
      const { total, ot, night } = computeDaily(r, isLeaderToday)
      const isHoliday = r.isHolidayWork || r.finalStatus === '휴일근무'

      if (!agg.has(r.employeeId)) {
        agg.set(r.employeeId, { emp, days: 0, totalH: 0, otH: 0, nightH: 0, holidayH: 0, anomalyCnt: 0, rows: [] })
      }
      const p = agg.get(r.employeeId)!
      if (r.clockIn) p.days++
      p.totalH += total
      p.otH    += ot
      p.nightH += night
      if (isHoliday) p.holidayH += total
      if (r.flag) p.anomalyCnt++
      p.rows.push({ r, total, ot, night })
    })

  const persons = Array.from(agg.values()).sort((a, b) => a.emp.name.localeCompare(b.emp.name, 'ko'))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const merges: XLSX.Range[] = []
  const rowHpt: object[] = []
  let R = 0

  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NCOL } })
  sc(ws, 0, R, `${period} 근로시간 활용 현황 (개인별)`, titleS('1F4E79'))
  rowHpt.push({ hpt: 24 }); R++

  HDRS.forEach((h, c) => sc(ws, c, R, h, hdr('1F4E79')))
  rowHpt.push({ hpt: 20 }); R++

  persons.forEach(p => {
    const avgH   = p.days > 0 ? p.totalH / p.days : 0
    const otRate = p.totalH > 0 ? (p.otH / p.totalH) * 100 : 0

    ;[p.emp.rawId ?? p.emp.id, p.emp.name, p.emp.division, p.days,
      +p.totalH.toFixed(2), +p.otH.toFixed(2), +otRate.toFixed(1),
      +p.nightH.toFixed(2), +p.holidayH.toFixed(2), +avgH.toFixed(2), p.anomalyCnt].forEach((v, ci) => {
      const s = ci < 3
        ? S('F5F5F5', true, '333333', ci === 2 ? 'left' : 'center')
        : { font: { bold: ci === 4, color: { rgb: ci === 6 && otRate > 20 ? 'C00000' : '333333' }, sz: 10 },
            fill: { fgColor: { rgb: 'F5F5F5' } },
            alignment: { horizontal: 'center', vertical: 'center' },
            border: bd() }
      sc(ws, ci, R, v as string | number, s)
    })
    rowHpt.push({ hpt: 18, collapsed: 1 }); R++

    // 상세행 (접힘)
    const dayRows = p.rows.sort((a, b) => a.r.date.localeCompare(b.r.date))
    ;['', '근무일자', '출근', '퇴근', '근무시간(h)', '연장(h)', '야간(h)', '연차일수', '연차코드', '비고'].forEach((h, ci) =>
      sc(ws, ci, R, h, h ? S('E8E8E8', true, '555555', 'center', 9) : S('E8E8E8', false, 'AAAAAA', 'center', 9))
    )
    rowHpt.push({ hpt: 15, level: 1, hidden: 1 }); R++

    dayRows.forEach(({ r, total, ot, night }) => {
      // 출근/퇴근 미기록이 '연차라서 원래 안 찍힘'인지 '진짜 미태깅(이상치)'인지 구분
      const isFlaggedNoTag = r.flag === 'NO_CLOCK_IN' || r.flag === 'NO_CLOCK_OUT'
      const inLabel  = r.clockIn  ?? (isFlaggedNoTag ? '미태깅' : (r.leaveType ? '-' : '미태깅'))
      const outLabel = r.clockOut ?? (isFlaggedNoTag ? '미태깅' : (r.leaveType ? '-' : '미태깅'))
      const note = (r.flag ? ANOM_LABEL[r.flag] : '') || (r.isHolidayWork || r.finalStatus === '휴일근무' ? '휴일근무' : '')
      ;['', r.date, inLabel, outLabel,
        +total.toFixed(2), +ot.toFixed(2), +night.toFixed(2),
        r.erpLeaveAmount ?? '', r.leaveType ?? '', note].forEach((v, ci) => {
        const color = ci === 9 && v ? 'C00000' : '555555'
        sc(ws, ci, R, v as string | number, S('FFFFFF', false, color, 'center', 9))
      })
      rowHpt.push({ hpt: 16, level: 1, hidden: 1 }); R++
    })
  })

  ws['!ref']    = 'A1:' + cellKey(NCOL, R)
  ws['!merges'] = merges
  ws['!cols']   = [10, 8, 16, 8, 12, 12, 12, 12, 12, 14, 10].map(w => ({ wch: w }))
  ws['!rows']   = rowHpt
  return ws
}

// ── 메인 빌더 ────────────────────────────────────────────────────────────────

export function buildProductivityReportBuffer(
  records:      ProcessedRecord[],
  employees:    Employee[],
  finalAttrMap: Map<string, EmployeeAttributeOverrides>,
): Buffer {
  const period = periodLabel(records)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, buildProductivitySheet(records, employees, finalAttrMap, period), '근로시간_활용현황')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
