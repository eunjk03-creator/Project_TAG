import PptxGenJS from 'pptxgenjs'
import type { ProcessedRecord, Employee } from '@/types/tag'
import { DIVISION_ORDER } from '@/data/orgChart'
import { computeWorkA, computeDisplayBreakMins, parseTimeToMins } from '@/utils/attendanceCalc'

// ── Palette (hex without #) ──────────────────────────────────────────────────
const C = {
  white:    'FFFFFF',
  gray50:   'F9FAFB',
  gray100:  'F3F4F6',
  gray200:  'E5E7EB',
  gray300:  'D1D5DB',
  gray400:  '9CA3AF',
  gray500:  '6B7280',
  gray700:  '374151',
  gray800:  '1F2937',
  gray900:  '111827',
  amber:    'D97706',
  amberBg:  'FEF3C7',
  amberFg:  '92400E',
  orangeBg: 'FFEDD5',
  orangeFg: '9A3412',
  skyBg:    'E0F2FE',
  skyFg:    '0C4A6E',
  roseBg:   'FFF1F2',
  roseFg:   '881337',
  violetBg: 'EDE9FE',
  violetFg: '4C1D95',
  totalBg:  'E2E8F0',
  totalFg:  '0F172A',
  redBg:    'FEE2E2',
  redFg:    '991B1B',
}

// ── Cell helpers ─────────────────────────────────────────────────────────────

type CellOpts = Record<string, unknown>
type Cell     = { text: string; options?: CellOpts }

function hCell(text: string, bg = C.gray100, fg = C.gray800, extra?: CellOpts): Cell {
  return { text, options: { bold: true, fill: { color: bg }, color: fg, align: 'center', valign: 'middle', ...extra } }
}
function hCellL(text: string, bg = C.gray100, fg = C.gray800, extra?: CellOpts): Cell {
  return { text, options: { bold: true, fill: { color: bg }, color: fg, align: 'left', valign: 'middle', ...extra } }
}
function dCell(text: string, extra?: CellOpts): Cell {
  return { text, options: { align: 'center', valign: 'middle', color: C.gray700, ...extra } }
}
function dCellL(text: string, extra?: CellOpts): Cell {
  return { text, options: { align: 'left', valign: 'middle', color: C.gray700, ...extra } }
}
function dimCell(extra?: CellOpts): Cell {
  return { text: '—', options: { align: 'center', valign: 'middle', color: C.gray300, ...extra } }
}
function totalCell(text: string, extra?: CellOpts): Cell {
  return { text, options: { bold: true, fill: { color: C.totalBg }, color: C.totalFg, align: 'center', valign: 'middle', ...extra } }
}
function totalCellL(text: string, extra?: CellOpts): Cell {
  return { text, options: { bold: true, fill: { color: C.totalBg }, color: C.totalFg, align: 'left', valign: 'middle', ...extra } }
}
// blank cell for template (writable input appearance)
function blankCell(wide = false): Cell {
  return { text: '', options: { align: wide ? 'left' : 'center', valign: 'middle', fill: { color: C.white } } }
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function shortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function weekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function fmtH(h: number): string {
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(2)}h`
}
function divSort<T extends { division: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    const ai = DIVISION_ORDER.indexOf(a.division)
    const bi = DIVISION_ORDER.indexOf(b.division)
    if (ai === -1 && bi === -1) return a.division.localeCompare(b.division, 'ko')
    return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
  })
}

type AnomalyCounts = { late: number; shortage: number; notag: number; total: number }

// 3종 체계(지각/근무시간미달/미태깅) — EARLY_DEPARTURE/LATE_AND_EARLY_DEPARTURE는
// 재계산 전 캐시된 레코드 하위호환용, 근무시간미달로 통합.
function applyFlag(row: Omit<AnomalyCounts, 'total'>, flag: string): void {
  if (flag === 'LATE' || flag === 'LATE_AND_EARLY_DEPARTURE' || flag === 'LATE_AND_ANOMALY') row.late++
  if (flag === 'ATTENDANCE_ANOMALY' || flag === 'LATE_AND_ANOMALY' || flag === 'EARLY_DEPARTURE' || flag === 'LATE_AND_EARLY_DEPARTURE') row.shortage++
  if (flag === 'NO_CLOCK_IN' || flag === 'NO_CLOCK_OUT') row.notag++
}

const ANOMALY_COLS = [
  { key: 'late'     as const, label: '지각',          bg: C.amberBg,  fg: C.amberFg  },
  { key: 'shortage' as const, label: '근무시간 미달', bg: C.skyBg,    fg: C.skyFg    },
  { key: 'notag'    as const, label: '미태깅',        bg: C.roseBg,   fg: C.roseFg   },
  { key: 'total'    as const, label: '총합계',        bg: C.totalBg,  fg: C.totalFg  },
]

// ── Layout constants ─────────────────────────────────────────────────────────
const LEFT    = 0.4
const W       = 12.53
const TABLE_Y = 0.85
const ROW_H   = 0.265
const SEP     = 0.42    // gap between auto-table and template below it
const TMPL_ROWS = 5     // blank rows in each template

// ── Main export ──────────────────────────────────────────────────────────────

export async function buildStatusSlidePptxBuffer(
  records:   ProcessedRecord[],
  employees: Employee[],
  from:      string,
  to:        string,
  dept?:     string,
): Promise<Buffer> {
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'  // 13.33" × 7.5"

  const empMap      = new Map(employees.map(e => [e.id, e]))
  const deptLabel   = dept ?? '전체'
  const periodLabel = `${shortDate(from)} ~ ${shortDate(to)}`

  const borderOpts = { pt: 0.5, color: C.gray200 }
  const tableBase = {
    x: LEFT,
    w: W,
    border: borderOpts,
    fontFace: 'Malgun Gothic',
    fontSize: 10,
    rowH: ROW_H,
    valign: 'middle' as const,
  }

  // ── Helper: add a titled slide ────────────────────────────────────────────
  function newSlide(title: string, note?: string) {
    const s = pres.addSlide()
    s.background = { color: C.white }
    s.addShape('rect' as Parameters<typeof s.addShape>[0], {
      x: 0, y: 0, w: '100%', h: 0.06,
      fill: { color: C.gray900 },
      line: { color: C.gray900, pt: 0 },
    })
    s.addText(title, {
      x: LEFT, y: 0.12, w: 8, h: 0.48,
      fontSize: 17, bold: true, color: C.gray900, fontFace: 'Malgun Gothic',
    })
    s.addText(`${deptLabel} · ${periodLabel}`, {
      x: LEFT, y: 0.62, w: W, h: 0.18,
      fontSize: 9, color: C.gray400, fontFace: 'Malgun Gothic',
    })
    if (note) {
      s.addText(note, {
        x: LEFT, y: 0.62, w: W, h: 0.18,
        fontSize: 8.5, color: C.gray400, fontFace: 'Malgun Gothic', align: 'right',
      })
    }
    return s
  }

  // ── Helper: add a sub-section label inside a slide ────────────────────────
  function addSectionLabel(
    s: ReturnType<typeof pres.addSlide>,
    text: string,
    y: number,
    accentColor = C.gray700,
  ) {
    // colored left bar
    s.addShape('rect' as Parameters<typeof s.addShape>[0], {
      x: LEFT, y: y + 0.04, w: 0.04, h: 0.15,
      fill: { color: accentColor },
      line: { color: accentColor, pt: 0 },
    })
    s.addText(text, {
      x: LEFT + 0.1, y, w: 6, h: 0.23,
      fontSize: 10, bold: true, color: C.gray800, fontFace: 'Malgun Gothic',
    })
  }

  // ── Slide 1: Cover ────────────────────────────────────────────────────────
  const cover = pres.addSlide()
  cover.background = { color: C.gray900 }
  cover.addText('근태 현황 보고', {
    x: 1, y: 2.4, w: 11.33, h: 1.1,
    fontSize: 38, bold: true, color: C.white,
    align: 'center', fontFace: 'Malgun Gothic',
  })
  cover.addText(`${deptLabel}  ·  ${periodLabel}`, {
    x: 1, y: 3.7, w: 11.33, h: 0.5,
    fontSize: 16, color: C.gray400,
    align: 'center', fontFace: 'Malgun Gothic',
  })

  // ── Slide 2: 휴일근무 현황 ────────────────────────────────────────────────
  {
    const holidayRecs = records.filter(r => r.finalStatus === '휴일근무')
    const dates = [...new Set(holidayRecs.map(r => r.date))].sort()

    type DivRow = { division: string; empIds: Set<string>; dateCounts: Record<string, number>; totalHours: number }
    const divMap = new Map<string, DivRow>()
    for (const r of holidayRecs) {
      const div = empMap.get(r.employeeId)?.division ?? '—'
      if (!divMap.has(div)) divMap.set(div, { division: div, empIds: new Set(), dateCounts: {}, totalHours: 0 })
      const row = divMap.get(div)!
      row.empIds.add(r.employeeId)
      row.dateCounts[r.date] = (row.dateCounts[r.date] ?? 0) + 1
      row.totalHours += r.holidayHours ?? 0
    }
    const rows = divSort([...divMap.values()]).map(row => ({
      ...row,
      names: [...row.empIds].map(id => empMap.get(id)?.name ?? id).sort((a, b) => a.localeCompare(b, 'ko')),
    }))
    const totalEmpIds = new Set(holidayRecs.map(r => r.employeeId))
    const totalHours  = holidayRecs.reduce((s, r) => s + (r.holidayHours ?? 0), 0)
    const totalPerDate: Record<string, number> = {}
    for (const d of dates) totalPerDate[d] = holidayRecs.filter(r => r.date === d).length

    const s = newSlide('휴일근무 현황')

    // ── 메인 테이블 ─────────────────────────────────────────────────────────
    let mainTableEndY = TABLE_Y + ROW_H  // minimum: just header

    if (rows.length === 0) {
      s.addText('휴일근무 기록이 없습니다', {
        x: LEFT, y: TABLE_Y, w: W, h: 0.9,
        fontSize: 11, color: C.gray400, align: 'center', fontFace: 'Malgun Gothic',
      })
      mainTableEndY = TABLE_Y + 0.9
    } else {
      const divW  = 1.6
      const cntW  = 0.55
      const sumW  = 0.78
      const dateW = Math.max(0.38, Math.min(0.6, (W - divW - cntW - sumW - 2.2) / Math.max(dates.length, 1)))
      const nameW = Math.max(1.5, W - divW - cntW - sumW - dateW * dates.length)
      const colW  = [divW, cntW, ...dates.map(() => dateW), sumW, nameW]

      const header: Cell[] = [
        hCellL('부서'),
        hCell('인원'),
        ...dates.map(d => hCell(shortDate(d), C.amberBg, C.amberFg)),
        hCell('근무합', C.amberBg, C.amberFg),
        hCellL('대상자'),
      ]
      const dataRows: Cell[][] = rows.map((row, i) => [
        dCellL(row.division, { bold: true, color: C.gray800, fill: { color: i % 2 ? C.gray50 : C.white } }),
        dCell(`${row.empIds.size}명`, { fill: { color: i % 2 ? C.gray50 : C.white } }),
        ...dates.map(d => {
          const cnt = row.dateCounts[d] ?? 0
          return cnt
            ? dCell(String(cnt), { bold: true, color: C.gray800, fill: { color: i % 2 ? C.gray50 : C.white } })
            : { text: '—', options: { align: 'center', color: C.gray300, fill: { color: i % 2 ? C.gray50 : C.white } } }
        }),
        dCell(fmtH(row.totalHours), { bold: true, color: C.amber, fill: { color: i % 2 ? C.gray50 : C.white } }),
        dCellL(row.names.join(', '), { color: C.gray500, fontSize: 8, fill: { color: i % 2 ? C.gray50 : C.white } }),
      ])
      const totalRow: Cell[] = [
        totalCellL('합계'),
        totalCell(`${totalEmpIds.size}명`),
        ...dates.map(d => totalCell(String(totalPerDate[d] ?? 0))),
        totalCell(fmtH(totalHours), { color: C.amber }),
        totalCellL(''),
      ]

      const tableRows = [header, ...dataRows, totalRow]
      s.addTable(tableRows as unknown as Parameters<typeof s.addTable>[0], {
        ...tableBase, y: TABLE_Y, colW,
      })
      mainTableEndY = TABLE_Y + tableRows.length * ROW_H
    }

    // ── 휴일근무 사유 템플릿 (수기 작성) ────────────────────────────────────
    const reasonsY = mainTableEndY + SEP
    addSectionLabel(s, '휴일근무 사유', reasonsY, C.amber)

    const reasonColW = [2.2, W - 2.2]
    const reasonHeader: Cell[] = [
      hCellL('부서'),
      hCellL('휴일근무 사유'),
    ]
    const reasonRows: Cell[][] = Array.from({ length: TMPL_ROWS }, () => [
      blankCell(false),
      blankCell(true),
    ])

    s.addTable([reasonHeader, ...reasonRows] as unknown as Parameters<typeof s.addTable>[0], {
      ...tableBase,
      y: reasonsY + 0.27,
      colW: reasonColW,
    })
  }

  // ── Slide 3: 부서별 이상치 현황 ──────────────────────────────────────────
  {
    type DivRow = AnomalyCounts & { division: string }
    const divMap = new Map<string, DivRow>()
    for (const r of records) {
      if (!r.flag) continue
      const div = empMap.get(r.employeeId)?.division ?? '—'
      if (!divMap.has(div)) divMap.set(div, { division: div, late: 0, shortage: 0, notag: 0, total: 0 })
      const row = divMap.get(div)!
      applyFlag(row, r.flag)
      row.total++
    }
    const divRows = divSort([...divMap.values()]).filter(r => r.total >= 10)
    const totals  = divRows.reduce<AnomalyCounts>(
      (s, r) => ({ late: s.late+r.late, shortage: s.shortage+r.shortage, notag: s.notag+r.notag, total: s.total+r.total }),
      { late: 0, shortage: 0, notag: 0, total: 0 },
    )

    const s = newSlide('부서별 이상치 현황', '이상치 합계 10건 이상 부서만 표시')

    // ── 메인 이상치 테이블 ─────────────────────────────────────────────────
    let mainTableEndY = TABLE_Y + ROW_H

    if (divRows.length === 0) {
      s.addText('이상치 10건 이상 부서가 없습니다', {
        x: LEFT, y: TABLE_Y, w: W, h: 0.9,
        fontSize: 11, color: C.gray400, align: 'center', fontFace: 'Malgun Gothic',
      })
      mainTableEndY = TABLE_Y + 0.9
    } else {
      const divW  = 2.1
      const anomW = (W - divW) / ANOMALY_COLS.length
      const colW  = [divW, ...ANOMALY_COLS.map(() => anomW)]

      const header: Cell[] = [
        hCellL('부서'),
        ...ANOMALY_COLS.map(c => hCell(c.label, c.bg, c.fg)),
      ]
      const dataRows: Cell[][] = divRows.map((row, i) => [
        dCellL(row.division, { bold: true, color: C.gray800, fill: { color: i % 2 ? C.gray50 : C.white } }),
        ...ANOMALY_COLS.map(({ key }) => {
          const v = row[key]
          return v
            ? dCell(String(v), { bold: true, fill: { color: i % 2 ? C.gray50 : C.white } })
            : { ...dimCell(), options: { ...dimCell().options, fill: { color: i % 2 ? C.gray50 : C.white } } }
        }),
      ])
      const totalRow: Cell[] = [
        totalCellL('합계'),
        ...ANOMALY_COLS.map(({ key }) => totalCell(totals[key] ? String(totals[key]) : '—')),
      ]

      const tableRows = [header, ...dataRows, totalRow]
      s.addTable(tableRows as unknown as Parameters<typeof s.addTable>[0], {
        ...tableBase, y: TABLE_Y, colW,
      })
      mainTableEndY = TABLE_Y + tableRows.length * ROW_H
    }

    // ── 주 52시간 초과자 (실데이터) ─────────────────────────────────────────
    const over52Y = mainTableEndY + SEP
    addSectionLabel(s, '주 52시간 초과자', over52Y, C.redFg)

    // 직원별·주별 weekday 근무시간 + 휴일근무시간 집계
    type WeekAgg = { baseH: number; holidayH: number }
    const empWeekAgg = new Map<string, Map<string, WeekAgg>>()
    for (const r of records) {
      const wk = weekMonday(r.date)
      if (!empWeekAgg.has(r.employeeId)) empWeekAgg.set(r.employeeId, new Map())
      const wmap = empWeekAgg.get(r.employeeId)!
      if (!wmap.has(wk)) wmap.set(wk, { baseH: 0, holidayH: 0 })
      const agg = wmap.get(wk)!
      if (r.dayType === 'WEEKDAY') {
        const effIn  = r.effectiveClockIn ?? r.clockIn
        const wAMins = Math.round(computeWorkA(effIn, r.clockOut) * 60)
        const ci     = effIn      ? parseTimeToMins(effIn)      : null
        const co     = r.clockOut ? parseTimeToMins(r.clockOut) : null
        const brk    = computeDisplayBreakMins(wAMins, ci, co, r.leaveType)
        const credit = r.isUnpaidLeave ? 0 : (r.erpLeaveAmount ?? 0) * 8
        agg.baseH += Math.max(0, (wAMins - brk) / 60 + credit)
      } else if (r.finalStatus === '휴일근무') {
        agg.holidayH += r.holidayHours ?? 0
      }
    }

    // 어느 주든 52h 초과하면 포함 (미포함: 평일만으로 초과 / 포함: 휴일 포함 시 초과)
    type ViolType = 'no' | 'with'
    const violators = new Map<string, ViolType>()
    for (const [empId, wmap] of empWeekAgg) {
      for (const [, agg] of wmap) {
        if (agg.baseH > 52) { violators.set(empId, 'no'); break }
        if (agg.baseH + agg.holidayH > 52 && violators.get(empId) !== 'no')
          violators.set(empId, 'with')
      }
    }

    type Div52Row = { division: string; noNames: string[]; withNames: string[] }
    const div52Map = new Map<string, Div52Row>()
    for (const [empId, type] of violators) {
      const div  = empMap.get(empId)?.division ?? '—'
      const name = empMap.get(empId)?.name ?? empId
      if (!div52Map.has(div)) div52Map.set(div, { division: div, noNames: [], withNames: [] })
      const row = div52Map.get(div)!
      if (type === 'no') row.noNames.push(name)
      else               row.withNames.push(name)
    }
    const div52Rows = [...div52Map.values()].sort((a, b) => {
      const ai = DIVISION_ORDER.indexOf(a.division), bi = DIVISION_ORDER.indexOf(b.division)
      if (ai === -1 && bi === -1) return a.division.localeCompare(b.division, 'ko')
      return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi
    })

    // 5열: 부서 | 미포함(인원) | 포함(인원) | 미포함(대상자) | 포함(대상자)
    const col52Div  = 2.0
    const col52Cnt  = 0.92
    const col52Name = (W - col52Div - col52Cnt * 2) / 2
    const colW52    = [col52Div, col52Cnt, col52Cnt, col52Name, col52Name]

    const header52_0: Cell[] = [
      hCellL('구분'),
      hCell('휴일근로 포함 여부', C.orangeBg, C.orangeFg, { colspan: 2 }),
      hCell('대상자', C.skyBg, C.skyFg, { colspan: 2 }),
    ]
    const header52_1: Cell[] = [
      hCellL('부서'),
      hCell('미포함', C.orangeBg, C.orangeFg),
      hCell('포함',   C.orangeBg, C.orangeFg),
      hCell('미포함', C.skyBg,   C.skyFg),
      hCell('포함',   C.skyBg,   C.skyFg),
    ]

    let totalNo = 0, totalWith = 0
    const data52Rows: Cell[][] = div52Rows.map((row, i) => {
      const bg = { fill: { color: i % 2 ? C.gray50 : C.white } }
      totalNo   += row.noNames.length
      totalWith += row.withNames.length
      return [
        dCellL(row.division, { bold: true, color: C.gray800, ...bg }),
        row.noNames.length   ? dCell(String(row.noNames.length),   { bold: true, color: C.orangeFg, ...bg }) : { ...dimCell(), options: { ...dimCell().options, ...bg } },
        row.withNames.length ? dCell(String(row.withNames.length), { bold: true, color: C.redFg,    ...bg }) : { ...dimCell(), options: { ...dimCell().options, ...bg } },
        dCellL(row.noNames.join(', '),   { color: C.gray500, fontSize: 8, ...bg }),
        dCellL(row.withNames.join(', '), { color: C.gray500, fontSize: 8, ...bg }),
      ]
    })

    const totalRow52: Cell[] = [
      totalCellL('합계'),
      totalCell(totalNo   ? String(totalNo)   : '—'),
      totalCell(totalWith ? String(totalWith) : '—'),
      totalCellL(''), totalCellL(''),
    ]

    if (div52Rows.length === 0) {
      s.addText('주 52시간 초과자가 없습니다', {
        x: LEFT, y: over52Y + 0.3, w: W, h: 0.4,
        fontSize: 9, color: C.gray400, align: 'center', fontFace: 'Malgun Gothic',
      })
    } else {
      s.addTable(
        [header52_0, header52_1, ...data52Rows, totalRow52] as unknown as Parameters<typeof s.addTable>[0],
        { ...tableBase, y: over52Y + 0.27, colW: colW52 },
      )
    }
  }

  // ── Slide 4+: 개인별 근태이상 (20명씩 분할) ──────────────────────────────
  {
    type EmpRow = AnomalyCounts & { division: string; name: string }
    const empMap2 = new Map<string, EmpRow>()
    for (const r of records) {
      if (!r.flag) continue
      const emp  = empMap.get(r.employeeId)
      const div  = emp?.division ?? '—'
      const name = emp?.name ?? r.employeeId
      if (!empMap2.has(r.employeeId)) empMap2.set(r.employeeId, { division: div, name, late: 0, shortage: 0, notag: 0, total: 0 })
      const row = empMap2.get(r.employeeId)!
      applyFlag(row, r.flag)
      row.total++
    }
    const empRows = [...empMap2.values()]
      .filter(r => r.total >= 3)
      .sort((a, b) => {
        const di = DIVISION_ORDER.indexOf(a.division) - DIVISION_ORDER.indexOf(b.division)
        return di !== 0 ? di : a.name.localeCompare(b.name, 'ko')
      })

    const totals = empRows.reduce<AnomalyCounts>(
      (s, r) => ({ late: s.late+r.late, shortage: s.shortage+r.shortage, notag: s.notag+r.notag, total: s.total+r.total }),
      { late: 0, shortage: 0, notag: 0, total: 0 },
    )

    const PER_SLIDE = 20
    const numSlides = Math.max(1, Math.ceil(empRows.length / PER_SLIDE))

    const divW  = 1.6
    const nameW = 1.1
    const anomW = (W - divW - nameW) / ANOMALY_COLS.length
    const colW  = [divW, nameW, ...ANOMALY_COLS.map(() => anomW)]

    const header: Cell[] = [
      hCellL('부서'),
      hCellL('이름'),
      ...ANOMALY_COLS.map(c => hCell(c.label, c.bg, c.fg)),
    ]

    for (let si = 0; si < numSlides; si++) {
      const chunk      = empRows.slice(si * PER_SLIDE, (si + 1) * PER_SLIDE)
      const slideTitle = numSlides > 1
        ? `개인별 근태이상 (${si + 1}/${numSlides})`
        : '개인별 근태이상'
      const s = newSlide(slideTitle, '이상치 합계 3건 이상 대상자만 표시')

      if (empRows.length === 0) {
        s.addText('이상치 3건 이상 대상자가 없습니다', {
          x: LEFT, y: TABLE_Y, w: W, h: 0.9,
          fontSize: 11, color: C.gray400, align: 'center', fontFace: 'Malgun Gothic',
        })
        continue
      }

      const dataRows: Cell[][] = chunk.map((row, i) => [
        dCellL(row.division, { color: C.gray500, fill: { color: i % 2 ? C.gray50 : C.white } }),
        dCellL(row.name,     { bold: true, color: C.gray800, fill: { color: i % 2 ? C.gray50 : C.white } }),
        ...ANOMALY_COLS.map(({ key }) => {
          const v = row[key]
          return v
            ? dCell(String(v), { bold: true, fill: { color: i % 2 ? C.gray50 : C.white } })
            : { ...dimCell(), options: { ...dimCell().options, fill: { color: i % 2 ? C.gray50 : C.white } } }
        }),
      ])

      const tableRows: Cell[][] = [header, ...dataRows]
      if (si === numSlides - 1) {
        tableRows.push([
          totalCellL('합계'),
          totalCellL(''),
          ...ANOMALY_COLS.map(({ key }) => totalCell(totals[key] ? String(totals[key]) : '—')),
        ])
      }

      s.addTable(tableRows as unknown as Parameters<typeof s.addTable>[0], {
        ...tableBase, y: TABLE_Y, colW, rowH: 0.25,
      })
    }
  }

  const raw = await pres.write({ outputType: 'nodebuffer' })
  return Buffer.from(raw as Uint8Array)
}
