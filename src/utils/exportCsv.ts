import Papa from 'papaparse'
import type { ProcessedRecord, Employee } from '@/types/tag'

const FLAG_LABEL: Record<string, string> = {
  LATE: '지각',
  NO_CLOCK_OUT: '퇴근 미태깅',
  UNAPPROVED_OT: 'OT 미신청',
  EARLY_DEPARTURE: '조기퇴근',
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

/** Grid-format export (one row per employee, one column per day). Used for calendar-grid view. */
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
