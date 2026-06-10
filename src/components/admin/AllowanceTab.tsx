'use client'
import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx-js-style'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useEmployeeExceptions } from '@/context/EmployeeExceptionsContext'
import { DIVISION_ORDER } from '@/data/orgChart'
import type { Employee, ProcessedRecord } from '@/types/tag'

// ── Format helpers (UI only) ──────────────────────────────────────────────

function floorTo30(h: number): number { return Math.floor(h * 2) / 2 }
function round2(n: number) { return Math.round(n * 100) / 100 }

function fmtH(h: number): string {
  if (h === 0) return '—'
  return round2(h).toFixed(2)
}

function fmtW(amount: number): string {
  if (amount === 0) return '—'
  return `₩ ${Math.round(amount).toLocaleString('ko-KR')}`
}

function colLetter(c: number): string {
  if (c < 26) return String.fromCharCode(65 + c)
  return String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26))
}

// ── Excel export (xlsx-js-style) ─────────────────────────────────────────
// Column layout (0-indexed):
//  0:이름  1:부서  2:통상시급
//  3:연장+휴일수당(=E+M)  4:연장수당(=F*C)  5:연장총시간  6-11:월별연장(6)
//  12:휴일수당(=N*C)  13:휴일총시간  14-19:월별휴일(6)
//  20:지각총횟수  21-26:월별지각(6)

// ── Style constants ──────────────────────────────────────────────────────
const BDR = (rgb = 'CBD5E1') => ({ style: 'thin' as const, color: { rgb } })
const BORDER = { top: BDR(), bottom: BDR(), left: BDR(), right: BDR() }
const BORDER_R_MED = { ...BORDER, right: BDR('94A3B8') }

function fill(rgb: string) { return { patternType: 'solid' as const, fgColor: { rgb } } }
function font(rgb: string, bold = false, sz = 9) { return { color: { rgb }, bold, sz, name: '맑은 고딕' } }
const CENTER = { horizontal: 'center' as const, vertical: 'center' as const, wrapText: true }
const RIGHT  = { horizontal: 'right'  as const, vertical: 'center' as const }
const LEFT   = { horizontal: 'left'   as const, vertical: 'center' as const }

// Header style builders
const hBase   = (bg: string, fg: string, bold = true) => ({ fill: fill(bg), font: font(fg, bold), alignment: CENTER, border: BORDER })
const hBaseR  = (bg: string, fg: string) => ({ fill: fill(bg), font: font(fg, true), alignment: CENTER, border: BORDER_R_MED })

// Preset header styles
const H = {
  name:     hBaseR('D9E1F2', '1E293B'),   // 이름/부서/통상시급: gray-blue
  summary:  hBaseR('94A3B8', 'FFFFFF'),   // 연장+휴일 합산: slate (강조)
  otPay:    hBase ('BDD7EE', '1F3864'),   // 연장수당: blue-200
  otGroup:  hBase ('DDEBF7', '1F3864'),   // 연장근로시간 (그룹)
  otSub:    hBase ('EEF4FB', '1D4ED8'),   // 연장 서브헤더
  holPay:   hBase ('FCE4D6', '7C2D12'),   // 휴일수당: amber
  holGroup: hBase ('FCE4D6', '7C2D12'),   // 휴일근로시간 (그룹)
  holSub:   hBase ('FDF2EC', 'B45309'),   // 휴일 서브헤더
  lateGroup:hBase ('FECACA', '7F1D1D'),   // 지각 (그룹)
  lateSub:  hBase ('FFF0F0', 'B91C1C'),   // 지각 서브헤더
}

// Data cell style builders
function dataStyle(fg: string, bg?: string, bold = false, align: 'L'|'C'|'R' = 'R') {
  return {
    font: font(fg, bold),
    ...(bg ? { fill: fill(bg) } : {}),
    alignment: align === 'L' ? LEFT : align === 'C' ? { horizontal: 'center' as const, vertical: 'center' as const } : RIGHT,
    border: BORDER,
  }
}

const D = {
  name:      dataStyle('1E293B', undefined, true,  'L'),
  dept:      dataStyle('475569', undefined, false, 'L'),
  empId:     dataStyle('64748B', undefined, false, 'C'),
  rate:      dataStyle('1E293B', 'FAFAFA',  false, 'R'),
  totalPay:  dataStyle('1E293B', 'F1F5F9',  true,  'R'),
  otPay:     dataStyle('1D4ED8', 'EFF6FF',  true,  'R'),
  holPay:    dataStyle('92400E', 'FFFBEB',  true,  'R'),
  otHTot:    dataStyle('1D4ED8', 'EFF6FF',  true,  'C'),
  otHMon:    dataStyle('2563EB', undefined, false, 'C'),
  holHTot:   dataStyle('92400E', 'FFFBEB',  true,  'C'),
  holHMon:   dataStyle('D97706', undefined, false, 'C'),
  lateTot:   dataStyle('991B1B', 'FFF5F5',  true,  'C'),
  lateMon:   dataStyle('DC2626', undefined, false, 'C'),
  empty:     { font: font('1E293B'), border: BORDER, alignment: RIGHT },
}

// ── Cell builders ─────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XCell = Record<string, any>

function sc(v: string, s: object): XCell      { return { v, t: 's', s } }
function nc(v: number, s: object, z?: string): XCell {
  return z ? { v, t: 'n', s, z } : { v, t: 'n', s }
}
function fc(formula: string, s: object, z = '#,##0'): XCell {
  return { f: formula, v: 0, t: 'n', s, z }
}

function exportAllowanceExcel(
  rows: EmpRow[],
  half: 'H1' | 'H2',
  months: string[],
  hourlyRates: Record<string, string>,
) {
  const halfLabel = half === 'H1' ? '상반기' : '하반기'
  const ML: Record<string, string> = {
    '01':'1월','02':'2월','03':'3월','04':'4월','05':'5월','06':'6월',
    '07':'7월','08':'8월','09':'9월','10':'10월','11':'11월','12':'12월',
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}

  // ── Column layout (0-indexed) ──
  // A(0):소속  B(1):사번  C(2):이름  D(3):통상시급
  // E(4):연장+휴일수당(=F+N)  F(5):연장수당(=G*D)  G(6):연장총시간  H-M(7-12):월별연장
  // N(13):휴일수당(=O*D)  O(14):휴일총시간  P-U(15-20):월별휴일
  // V(21):지각총횟수  W-AB(22-27):월별지각

  // ── Header row 1 ──
  ws['A1'] = sc('소속',                         H.name)
  ws['B1'] = sc('사번',                         H.name)
  ws['C1'] = sc('이름',                         H.name)
  ws['D1'] = sc('통상시급',                     H.name)
  ws['E1'] = sc(`${halfLabel}\n연장+휴일수당`,  H.summary)
  ws['F1'] = sc(`${halfLabel}\n연장근무수당`,   H.otPay)
  ws['G1'] = sc(`${halfLabel} 연장근로시간`,    H.otGroup)
  ws['N1'] = sc(`${halfLabel}\n휴일근무수당`,   H.holPay)
  ws['O1'] = sc(`${halfLabel} 휴일근로시간`,    H.holGroup)
  ws['V1'] = sc(`${halfLabel} 지각`,            H.lateGroup)

  // ── Header row 2 ──
  ws['G2'] = sc('총 시간', H.otSub)
  months.forEach((mm, i) => { ws[`${colLetter(7 + i)}2`] = sc(ML[mm], H.otSub) })
  ws['O2'] = sc('총 시간', H.holSub)
  months.forEach((mm, i) => { ws[`${colLetter(15 + i)}2`] = sc(ML[mm], H.holSub) })
  ws['V2'] = sc('총 횟수', H.lateSub)
  months.forEach((mm, i) => { ws[`${colLetter(22 + i)}2`] = sc(ML[mm], H.lateSub) })

  // ── Merges (0-indexed r/c) ──
  ws['!merges'] = [
    { s: { r:0, c:0  }, e: { r:1, c:0  } }, // 소속
    { s: { r:0, c:1  }, e: { r:1, c:1  } }, // 사번
    { s: { r:0, c:2  }, e: { r:1, c:2  } }, // 이름
    { s: { r:0, c:3  }, e: { r:1, c:3  } }, // 통상시급
    { s: { r:0, c:4  }, e: { r:1, c:4  } }, // 연장+휴일수당
    { s: { r:0, c:5  }, e: { r:1, c:5  } }, // 연장수당
    { s: { r:0, c:6  }, e: { r:0, c:12 } }, // 연장근로시간 (총+6months)
    { s: { r:0, c:13 }, e: { r:1, c:13 } }, // 휴일수당
    { s: { r:0, c:14 }, e: { r:0, c:20 } }, // 휴일근로시간 (총+6months)
    { s: { r:0, c:21 }, e: { r:0, c:27 } }, // 지각 (총+6months)
  ]

  // ── Row heights ──
  ws['!rows'] = [{ hpt: 30 }, { hpt: 18 }]

  // ── Data rows (Excel row 3 onward) ──
  rows.forEach((row, idx) => {
    const R = idx + 3
    const { emp, otByMonth, holidayByMonth, lateByMonth, totalOt, totalHoliday, totalLate } = row
    const rate   = parseFloat(hourlyRates[emp.id] ?? '0') || 0
    const rowBg  = idx % 2 === 1 ? 'F8FAFC' : undefined
    const altDep = rowBg ? { ...D.dept,  fill: fill(rowBg) } : D.dept
    const altNam = rowBg ? { ...D.name,  fill: fill(rowBg) } : D.name
    const altId  = rowBg ? { ...D.empId, fill: fill(rowBg) } : D.empId

    const divStr = emp.division + (emp.team !== emp.division ? ` / ${emp.team}` : '')

    ws[`A${R}`] = sc(divStr,          altDep)
    ws[`B${R}`] = sc(emp.rawId ?? '', altId)
    ws[`C${R}`] = sc(emp.name,        altNam)
    ws[`D${R}`] = rate > 0
      ? nc(rate, rowBg ? { ...D.rate, fill: fill(rowBg) } : D.rate, '#,##0')
      : sc('',   rowBg ? { ...D.empty, fill: fill(rowBg) } : D.empty)

    ws[`E${R}`] = fc(`F${R}+N${R}`, D.totalPay)
    ws[`F${R}`] = fc(`G${R}*D${R}`, D.otPay)
    ws[`G${R}`] = nc(round2(totalOt),      D.otHTot,  '0.00')
    months.forEach((mm, i) => {
      ws[`${colLetter(7 + i)}${R}`] = nc(round2(otByMonth[mm] ?? 0), D.otHMon, '0.00')
    })

    ws[`N${R}`] = fc(`O${R}*D${R}`, D.holPay)
    ws[`O${R}`] = nc(round2(totalHoliday), D.holHTot, '0.00')
    months.forEach((mm, i) => {
      ws[`${colLetter(15 + i)}${R}`] = nc(round2(holidayByMonth[mm] ?? 0), D.holHMon, '0.00')
    })

    ws[`V${R}`] = nc(totalLate, D.lateTot)
    months.forEach((mm, i) => {
      ws[`${colLetter(22 + i)}${R}`] = nc(lateByMonth[mm] ?? 0, D.lateMon)
    })
  })

  ws['!ref'] = `A1:${colLetter(27)}${rows.length + 2}`

  ws['!cols'] = [
    { wch: 16 }, // 소속
    { wch: 10 }, // 사번
    { wch: 8  }, // 이름
    { wch: 10 }, // 통상시급
    { wch: 14 }, // 연장+휴일수당
    { wch: 12 }, // 연장수당
    { wch: 8  }, // 연장총시간
    ...months.map(() => ({ wch: 6 })),
    { wch: 12 }, // 휴일수당
    { wch: 8  }, // 휴일총시간
    ...months.map(() => ({ wch: 6 })),
    { wch: 7  }, // 지각총횟수
    ...months.map(() => ({ wch: 5 })),
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, `${halfLabel}수당집계`)
  XLSX.writeFile(wb, `수당집계_${halfLabel}.xlsx`)
}

// ── Types ──────────────────────────────────────────────────────────────────

type SectionKey = 'ot' | 'holiday' | 'late'
type SortKey    = 'default' | 'ot_desc' | 'ot_asc' | 'holiday_desc' | 'holiday_asc'

interface EmpRow {
  emp:            Employee
  otByMonth:      Record<string, number>
  holidayByMonth: Record<string, number>
  lateByMonth:    Record<string, number>
  totalOt:        number
  totalHoliday:   number
  totalLate:      number
  isLeader:       boolean
}

const PAGE_SIZE = 50

// ── Component ──────────────────────────────────────────────────────────────

export function AllowanceTab() {
  const { processedRecords: serverProcessed, employees } = useAttendanceSource()
  const { employeeAttrMap } = useEmployeeExceptions()

  const [half,         setHalf]        = useState<'H1' | 'H2'>(() =>
    new Date().getMonth() + 1 >= 7 ? 'H2' : 'H1',
  )
  const [expanded,     setExpanded]    = useState<Set<SectionKey>>(new Set())
  const [hourlyRates,  setHourlyRates] = useState<Record<string, string>>({})
  const [search,       setSearch]      = useState('')
  const [leaderOnly,   setLeaderOnly]  = useState(false)
  const [divFilter,    setDivFilter]   = useState('')
  const [sortKey,      setSortKey]     = useState<SortKey>('default')
  const [page,         setPage]        = useState(0)
  const [selectedIds,  setSelectedIds] = useState<Set<string>>(new Set())
  const [viewSelected, setViewSelected]= useState(false)
  const [showDivAvg,   setShowDivAvg]  = useState(false)

  const months: string[] = half === 'H1'
    ? ['01', '02', '03', '04', '05', '06']
    : ['07', '08', '09', '10', '11', '12']

  const monthLabels: Record<string, string> = {
    '01': '1월', '02': '2월', '03': '3월', '04': '4월', '05': '5월', '06': '6월',
    '07': '7월', '08': '8월', '09': '9월', '10': '10월', '11': '11월', '12': '12월',
  }

  function toggleSection(key: SectionKey) {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  function toggleSort(col: 'ot' | 'holiday') {
    setSortKey(prev => prev === `${col}_desc` ? `${col}_asc` as SortKey : `${col}_desc` as SortKey)
  }

  function sortIcon(col: 'ot' | 'holiday') {
    if (sortKey === `${col}_desc`) return '↓'
    if (sortKey === `${col}_asc`)  return '↑'
    return '↕'
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  // ── Base aggregated rows ──────────────────────────────────────────────────
  const baseRows = useMemo<EmpRow[]>(() => {
    const records  = serverProcessed ?? []
    const monthSet = new Set(months)

    const recsByEmp = new Map<string, ProcessedRecord[]>()
    for (const r of records) {
      if (!monthSet.has(r.date.slice(5, 7))) continue
      const b = recsByEmp.get(r.employeeId)
      if (b) { b.push(r) } else { recsByEmp.set(r.employeeId, [r]) }
    }

    const result: EmpRow[] = []
    for (const emp of employees) {
      const attrs = employeeAttrMap.get(emp.id)
      if (attrs?.isGlobalExclusion || attrs?.isResigned) continue

      const isLeader   = attrs?.isLeader === true
      const empRecords = recsByEmp.get(emp.id) ?? []

      const otByMonth:      Record<string, number> = {}
      const holidayByMonth: Record<string, number> = {}
      const lateByMonth:    Record<string, number> = {}
      for (const mm of months) { otByMonth[mm] = 0; holidayByMonth[mm] = 0; lateByMonth[mm] = 0 }

      for (const r of empRecords) {
        const mm = r.date.slice(5, 7)
        if (r.dayType === 'WEEKDAY') {
          if (isLeader)          otByMonth[mm] += (r.rawOvertimeMinutes ?? 0) / 60  // 직책자: ERP 무관
          else if (r.erpOtApplied) otByMonth[mm] += r.overtimeHours                // 비직책자: ERP 상신자만
        }
        if (r.dayType !== 'WEEKDAY') {
          holidayByMonth[mm] += isLeader ? r.holidayHours : floorTo30(r.holidayHours)
        }
        if (r.flag === 'LATE' || r.flag === 'LATE_AND_EARLY_DEPARTURE' || r.flag === 'LATE_AND_ANOMALY') {
          lateByMonth[mm] += 1
        }
      }

      const totalOt      = months.reduce((s, mm) => s + otByMonth[mm],      0)
      const totalHoliday = months.reduce((s, mm) => s + holidayByMonth[mm], 0)
      const totalLate    = months.reduce((s, mm) => s + lateByMonth[mm],    0)

      result.push({ emp, otByMonth, holidayByMonth, lateByMonth, totalOt, totalHoliday, totalLate, isLeader })
    }

    result.sort((a, b) => {
      const ai = DIVISION_ORDER.indexOf(a.emp.division), bi = DIVISION_ORDER.indexOf(b.emp.division)
      const dc = ai === -1 && bi === -1 ? a.emp.division.localeCompare(b.emp.division, 'ko')
               : ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
      return dc !== 0 ? dc : a.emp.name.localeCompare(b.emp.name, 'ko')
    })
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverProcessed, employees, employeeAttrMap, half])

  const divisions = useMemo(() => {
    const divSet = new Set(baseRows.map(r => r.emp.division))
    return [...divSet].sort((a, b) => {
      const ai = DIVISION_ORDER.indexOf(a), bi = DIVISION_ORDER.indexOf(b)
      return ai === -1 && bi === -1 ? a.localeCompare(b, 'ko') : ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
    })
  }, [baseRows])

  // ── Filtered + sorted rows ────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    let rows = baseRows
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(r =>
        r.emp.name.toLowerCase().includes(q) ||
        r.emp.division.toLowerCase().includes(q) ||
        r.emp.team.toLowerCase().includes(q),
      )
    }
    if (leaderOnly) rows = rows.filter(r => r.isLeader)
    if (divFilter)  rows = rows.filter(r => r.emp.division === divFilter)
    if (sortKey === 'ot_desc')          rows = [...rows].sort((a, b) => b.totalOt      - a.totalOt)
    else if (sortKey === 'ot_asc')      rows = [...rows].sort((a, b) => a.totalOt      - b.totalOt)
    else if (sortKey === 'holiday_desc') rows = [...rows].sort((a, b) => b.totalHoliday - a.totalHoliday)
    else if (sortKey === 'holiday_asc') rows = [...rows].sort((a, b) => a.totalHoliday - b.totalHoliday)
    return rows
  }, [baseRows, search, leaderOnly, divFilter, sortKey])

  // ── Division averages (for summary panel) ────────────────────────────────
  const divAvgRows = useMemo(() => {
    const byDiv = new Map<string, { ot: number; holiday: number; late: number; count: number }>()
    for (const row of filteredRows) {
      const d = row.emp.division
      const b = byDiv.get(d) ?? { ot: 0, holiday: 0, late: 0, count: 0 }
      b.ot      += row.totalOt
      b.holiday += row.totalHoliday
      b.late    += row.totalLate
      b.count   += 1
      byDiv.set(d, b)
    }
    return [...byDiv.entries()]
      .sort((a, b) => {
        const ai = DIVISION_ORDER.indexOf(a[0]), bi = DIVISION_ORDER.indexOf(b[0])
        return ai === -1 && bi === -1 ? a[0].localeCompare(b[0], 'ko') : ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
      })
      .map(([div, v]) => ({
        div,
        count:   v.count,
        avgOt:   v.ot      / v.count,
        avgHol:  v.holiday / v.count,
        avgLate: v.late    / v.count,
      }))
  }, [filteredRows])

  // viewSelected: bypass all filters and show only selected rows
  const displayRows = useMemo(() =>
    viewSelected ? baseRows.filter(r => selectedIds.has(r.emp.id)) : filteredRows,
  [viewSelected, selectedIds, baseRows, filteredRows])

  useEffect(() => { setPage(0) }, [search, leaderOnly, divFilter, sortKey, half, viewSelected])

  const totalPages = Math.ceil(displayRows.length / PAGE_SIZE)
  const pagedRows  = displayRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // ── Select-all state (operates on filteredRows) ───────────────────────────
  const allSelected  = filteredRows.length > 0 && filteredRows.every(r => selectedIds.has(r.emp.id))
  const someSelected = !allSelected && filteredRows.some(r => selectedIds.has(r.emp.id))

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(prev => {
        const n = new Set(prev); filteredRows.forEach(r => n.delete(r.emp.id)); return n
      })
    } else {
      setSelectedIds(prev => {
        const n = new Set(prev); filteredRows.forEach(r => n.add(r.emp.id)); return n
      })
    }
  }

  // ── ColSpan ───────────────────────────────────────────────────────────────
  const otColSpan      = expanded.has('ot')      ? months.length + 1 : 1
  const holidayColSpan = expanded.has('holiday')  ? months.length + 1 : 1
  const lateColSpan    = expanded.has('late')     ? months.length + 1 : 1
  const totalCols      = 1 + 4 + 1 + 1 + 1 + otColSpan + 1 + holidayColSpan + lateColSpan // checkbox + 소속+사번+이름+시급

  const halfLabel    = half === 'H1' ? '상반기' : '하반기'
  const BADGE_LEADER = 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200'

  // Export target: selected rows if any selected, else all filteredRows
  function handleExport() {
    const target = selectedIds.size > 0
      ? baseRows.filter(r => selectedIds.has(r.emp.id))
      : filteredRows
    exportAllowanceExcel(target, half, months, hourlyRates)
  }

  let lastDivision = ''

  return (
    <div className="flex flex-col gap-3">

      {/* ── Header bar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-gray-900">수당 집계</h2>
          <p className="text-xs text-gray-400">반기별 연장근로·휴일근로·지각 집계 및 수당 산출</p>
        </div>

        {/* Half selector */}
        <div className="ml-auto flex items-center bg-gray-100 rounded-lg p-0.5 text-xs font-medium shrink-0">
          {(['H1', 'H2'] as const).map(h => (
            <button key={h} onClick={() => setHalf(h)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                half === h ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
              }`}>
              {h === 'H1' ? '상반기 (1–6월)' : '하반기 (7–12월)'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* 이름·부서 검색 */}
        <div className="relative">
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="이름·부서 검색"
            className="pl-7 pr-6 py-1.5 text-xs border border-gray-200 rounded-lg w-40 focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder-gray-300"
          />
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 text-xs">✕</button>}
        </div>

        {/* 부서 필터 */}
        <select value={divFilter} onChange={e => setDivFilter(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
          <option value="">전체 부서</option>
          {divisions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        {/* 직책자 필터 */}
        <button onClick={() => setLeaderOnly(v => !v)}
          className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
            leaderOnly ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400 hover:text-blue-600'
          }`}>
          직책자만
        </button>

        {/* 선택 인원 보기 — 선택된 사람 있을 때만 */}
        {selectedIds.size > 0 && (
          <button onClick={() => setViewSelected(v => !v)}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
              viewSelected
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-violet-50 text-violet-700 border-violet-300 hover:bg-violet-100'
            }`}>
            선택 {selectedIds.size}명만 보기
          </button>
        )}
        {selectedIds.size > 0 && (
          <button onClick={() => { setSelectedIds(new Set()); setViewSelected(false) }}
            className="text-[11px] text-gray-400 hover:text-gray-600 px-1">선택 해제</button>
        )}

        {/* 정렬 */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[11px] text-gray-400">정렬</span>
          <button onClick={() => toggleSort('ot')}
            className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              sortKey.startsWith('ot_')
                ? 'bg-blue-50 text-blue-700 border-blue-300'
                : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300'
            }`}>
            연장 {sortIcon('ot')}
          </button>
          <button onClick={() => toggleSort('holiday')}
            className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              sortKey.startsWith('holiday_')
                ? 'bg-amber-50 text-amber-700 border-amber-300'
                : 'bg-white text-gray-500 border-gray-200 hover:border-amber-300'
            }`}>
            휴일 {sortIcon('holiday')}
          </button>
          {sortKey !== 'default' && (
            <button onClick={() => setSortKey('default')} className="text-[11px] text-gray-400 hover:text-gray-600 px-1">초기화</button>
          )}

          {/* 부문 평균 토글 */}
          <button onClick={() => setShowDivAvg(v => !v)}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
              showDivAvg
                ? 'bg-teal-600 text-white border-teal-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-teal-400 hover:text-teal-600'
            }`}>
            부문 평균
          </button>

          {/* 엑셀 다운로드 */}
          <button onClick={handleExport}
            className="ml-1 flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M12 15V3m0 12-4-4m4 4 4-4M2 17l.621 2.485A2 2 0 0 0 4.561 21h14.878a2 2 0 0 0 1.94-1.515L22 17" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {selectedIds.size > 0 ? `선택 ${selectedIds.size}명 Excel` : 'Excel'}
          </button>
        </div>
      </div>

      {/* ── 부문별 평균 패널 ── */}
      {showDivAvg && (
        <div className="rounded-xl border border-teal-200 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-teal-100 bg-teal-50/60 flex items-center gap-2">
            <span className="text-xs font-semibold text-teal-800">부문별 평균</span>
            <span className="text-[10px] text-teal-600">현재 필터 기준 · {filteredRows.length}명</span>
          </div>
          <table className="text-xs w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-4 py-2 text-gray-600 font-medium">부문</th>
                <th className="text-center px-3 py-2 text-gray-600 font-medium">인원</th>
                <th className="text-center px-3 py-2 font-medium text-blue-700 bg-blue-50/40">연장 평균 (h)</th>
                <th className="text-center px-3 py-2 font-medium text-amber-700 bg-amber-50/40">휴일 평균 (h)</th>
                <th className="text-center px-3 py-2 font-medium text-red-700 bg-red-50/40">지각 평균 (회)</th>
              </tr>
            </thead>
            <tbody>
              {divAvgRows.map(row => (
                <tr key={row.div} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2 font-medium text-gray-800">{row.div}</td>
                  <td className="px-3 py-2 text-center text-gray-500 tabular-nums">{row.count}명</td>
                  <td className="px-3 py-2 text-center text-blue-700 font-medium tabular-nums bg-blue-50/10">{fmtH(row.avgOt)}</td>
                  <td className="px-3 py-2 text-center text-amber-700 font-medium tabular-nums bg-amber-50/10">{fmtH(row.avgHol)}</td>
                  <td className="px-3 py-2 text-center text-red-700 font-medium tabular-nums bg-red-50/10">
                    {row.avgLate > 0 ? round2(row.avgLate).toFixed(1) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Table ── */}
      <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
        <table className="text-xs w-full border-collapse">
          <thead>
            {/* Row 1 */}
            <tr className="bg-gray-50 border-b border-gray-200">
              {/* 체크박스 */}
              <th rowSpan={2} className="sticky left-0 z-10 bg-gray-50 px-2 py-2.5 border-r border-gray-200 w-8 text-center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected }}
                  onChange={toggleSelectAll}
                  className="w-3.5 h-3.5 cursor-pointer"
                />
              </th>
              <th rowSpan={2} className="sticky left-8 z-10 bg-gray-50 text-left px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap w-24">소속</th>
              <th rowSpan={2} className="sticky left-[128px] z-10 bg-gray-50 text-left px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap w-[80px]">사번</th>
              <th rowSpan={2} className="sticky left-[208px] z-10 bg-gray-50 text-left px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap min-w-[80px]">이름</th>
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-gray-700 border-r border-gray-200 whitespace-nowrap min-w-[110px]">
                통상시급<br /><span className="text-[10px] font-normal text-gray-400">(선택)</span>
              </th>
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-gray-900 bg-gray-100 border-r border-gray-300 whitespace-nowrap min-w-[120px]">
                {halfLabel}<br />연장+휴일수당
              </th>
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-gray-700 bg-blue-50 border-r border-blue-200 whitespace-nowrap min-w-[110px]">
                {halfLabel}<br />연장근무수당
              </th>
              <th colSpan={otColSpan} onClick={() => toggleSection('ot')}
                className="cursor-pointer px-3 py-2.5 font-semibold text-gray-700 bg-blue-50/60 border-r border-blue-200 text-center whitespace-nowrap select-none hover:bg-blue-100 transition-colors">
                {halfLabel} 연장근로시간 {expanded.has('ot') ? '▼' : '▶'}
              </th>
              <th rowSpan={2} className="text-right px-3 py-2.5 font-semibold text-gray-700 bg-amber-50 border-r border-amber-200 whitespace-nowrap min-w-[110px]">
                {halfLabel}<br />휴일근무수당
              </th>
              <th colSpan={holidayColSpan} onClick={() => toggleSection('holiday')}
                className="cursor-pointer px-3 py-2.5 font-semibold text-gray-700 bg-amber-50/60 border-r border-amber-200 text-center whitespace-nowrap select-none hover:bg-amber-100 transition-colors">
                {halfLabel} 휴일근로시간 {expanded.has('holiday') ? '▼' : '▶'}
              </th>
              <th colSpan={lateColSpan} onClick={() => toggleSection('late')}
                className="cursor-pointer px-3 py-2.5 font-semibold text-gray-700 bg-red-50/60 text-center whitespace-nowrap select-none hover:bg-red-100 transition-colors">
                {halfLabel} 지각 {expanded.has('late') ? '▼' : '▶'}
              </th>
            </tr>

            {/* Row 2 */}
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-2 font-medium text-gray-600 bg-blue-50/60 border-r border-blue-100 text-center whitespace-nowrap min-w-[70px]">총시간</th>
              {expanded.has('ot') && months.map(mm => (
                <th key={`ot-${mm}`} className="px-2 py-2 font-medium text-gray-500 bg-blue-50/40 border-r border-blue-100 text-center whitespace-nowrap min-w-[56px]">{monthLabels[mm]}</th>
              ))}
              <th className="px-3 py-2 font-medium text-gray-600 bg-amber-50/60 border-r border-amber-100 text-center whitespace-nowrap min-w-[70px]">총시간</th>
              {expanded.has('holiday') && months.map(mm => (
                <th key={`hol-${mm}`} className="px-2 py-2 font-medium text-gray-500 bg-amber-50/40 border-r border-amber-100 text-center whitespace-nowrap min-w-[56px]">{monthLabels[mm]}</th>
              ))}
              <th className="px-3 py-2 font-medium text-gray-600 bg-red-50/60 border-r border-red-100 text-center whitespace-nowrap min-w-[56px]">총횟수</th>
              {expanded.has('late') && months.map(mm => (
                <th key={`late-${mm}`} className="px-2 py-2 font-medium text-gray-500 bg-red-50/40 border-r border-red-100 text-center whitespace-nowrap min-w-[48px]">{monthLabels[mm]}</th>
              ))}
            </tr>
          </thead>

          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={totalCols} className="px-6 py-10 text-center text-gray-400">
                  {displayRows.length === 0 && baseRows.length > 0 ? '검색 결과가 없습니다.' : '데이터가 없습니다. CSV를 업로드하면 집계됩니다.'}
                </td>
              </tr>
            ) : pagedRows.map(row => {
              const { emp, otByMonth, holidayByMonth, lateByMonth, totalOt, totalHoliday, totalLate, isLeader } = row
              const rate             = parseFloat(hourlyRates[emp.id] ?? '0') || 0
              const otAllowance      = rate > 0 ? totalOt      * rate : 0
              const holidayAllowance = rate > 0 ? totalHoliday * rate : 0
              const totalAllowance   = otAllowance + holidayAllowance
              const isSelected       = selectedIds.has(emp.id)

              const isDivisionStart = sortKey === 'default' && !viewSelected && emp.division !== lastDivision
              lastDivision = emp.division

              return (
                <tr key={emp.id}
                  className={`border-b border-gray-100 transition-colors ${
                    isSelected ? 'bg-violet-50/60' : 'hover:bg-gray-50'
                  } ${isDivisionStart ? 'border-t-2 border-t-gray-200' : ''}`}
                >
                  {/* 체크박스 */}
                  <td className="sticky left-0 z-10 px-2 py-2 border-r border-gray-100 text-center bg-inherit w-8">
                    <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(emp.id)}
                      className="w-3.5 h-3.5 cursor-pointer" />
                  </td>

                  {/* 소속 */}
                  <td className="sticky left-8 z-10 bg-inherit px-3 py-2 border-r border-gray-100 whitespace-nowrap w-24">
                    <div className="leading-tight">
                      <div className="text-gray-700">{emp.division}</div>
                      {emp.team !== emp.division && <div className="text-[10px] text-gray-400">{emp.team}</div>}
                    </div>
                  </td>

                  {/* 사번 */}
                  <td className="sticky left-[128px] z-10 bg-inherit px-3 py-2 border-r border-gray-100 whitespace-nowrap w-[80px] text-gray-500 tabular-nums">
                    {emp.rawId ?? '—'}
                  </td>

                  {/* 이름 + 직책 뱃지 */}
                  <td className="sticky left-[208px] z-10 bg-inherit px-3 py-2 border-r border-gray-100 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{emp.name}</span>
                      {isLeader && <span className={BADGE_LEADER}>직책</span>}
                    </div>
                  </td>

                  {/* 통상시급 */}
                  <td className="px-2 py-1.5 border-r border-gray-100">
                    <input type="number" min={0} step={100}
                      value={hourlyRates[emp.id] ?? ''}
                      onChange={e => setHourlyRates(prev => ({ ...prev, [emp.id]: e.target.value }))}
                      placeholder="시급 입력"
                      className="w-24 text-right text-xs px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder-gray-300"
                    />
                  </td>

                  {/* 연장+휴일 합산 */}
                  <td className="px-3 py-2 border-r border-gray-300 text-right font-bold text-gray-900 bg-gray-50 tabular-nums whitespace-nowrap">{fmtW(totalAllowance)}</td>

                  {/* 연장수당 */}
                  <td className="px-3 py-2 border-r border-blue-200 text-right font-semibold text-gray-800 bg-blue-50/40 tabular-nums whitespace-nowrap">{fmtW(otAllowance)}</td>

                  {/* 연장 총시간 — 총시간 열만 파란색 유지 */}
                  <td className="px-3 py-2 border-r border-blue-100 text-center text-blue-700 font-medium tabular-nums bg-blue-50/20 whitespace-nowrap">{fmtH(totalOt)}</td>
                  {expanded.has('ot') && months.map(mm => (
                    <td key={`ot-${mm}`} className="px-2 py-2 border-r border-blue-100 text-center text-gray-700 tabular-nums bg-blue-50/10 whitespace-nowrap">{fmtH(otByMonth[mm] ?? 0)}</td>
                  ))}

                  {/* 휴일수당 */}
                  <td className="px-3 py-2 border-r border-amber-200 text-right font-semibold text-gray-800 bg-amber-50/40 tabular-nums whitespace-nowrap">{fmtW(holidayAllowance)}</td>

                  {/* 휴일 총시간 — 총시간 열만 주황색 유지 */}
                  <td className="px-3 py-2 border-r border-amber-100 text-center text-amber-700 font-medium tabular-nums bg-amber-50/20 whitespace-nowrap">{fmtH(totalHoliday)}</td>
                  {expanded.has('holiday') && months.map(mm => (
                    <td key={`hol-${mm}`} className="px-2 py-2 border-r border-amber-100 text-center text-gray-700 tabular-nums bg-amber-50/10 whitespace-nowrap">{fmtH(holidayByMonth[mm] ?? 0)}</td>
                  ))}

                  {/* 지각 총횟수 — 총횟수 열만 빨간색 유지 */}
                  <td className="px-3 py-2 border-r border-red-100 text-center text-red-700 font-medium tabular-nums bg-red-50/20 whitespace-nowrap">
                    {totalLate > 0 ? totalLate : '—'}
                  </td>
                  {expanded.has('late') && months.map(mm => (
                    <td key={`late-${mm}`} className="px-2 py-2 border-r border-red-100 text-center text-gray-700 tabular-nums bg-red-50/10 whitespace-nowrap">
                      {(lateByMonth[mm] ?? 0) > 0 ? lateByMonth[mm] : '—'}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, displayRows.length)} / {displayRows.length}명</span>
          <div className="flex items-center gap-1 ml-auto">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
              className="px-2.5 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">← 이전</button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button key={i} onClick={() => setPage(i)}
                className={`w-7 h-7 rounded text-center transition-colors ${page === i ? 'bg-gray-900 text-white' : 'hover:bg-gray-100 text-gray-600'}`}>
                {i + 1}
              </button>
            ))}
            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
              className="px-2.5 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">다음 →</button>
          </div>
        </div>
      )}

      {/* ── Footnote ── */}
      <p className="text-[11px] text-gray-400">
        * 통상시급은 페이지 새로고침 시 초기화됩니다.
        수당 = 시간 × 통상시급. Excel 다운로드 시 수당 열에 <code>=시간*통상시급</code> 수식이 포함됩니다.
        직책자(직책 뱃지)는 rawOvertimeMinutes 기준(절사 없음)으로 연장근로 집계.
      </p>
    </div>
  )
}
