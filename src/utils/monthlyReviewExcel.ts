/**
 * 월간 이상치 · 주 52시간 초과자 검토용 Excel — 경영진 현황 월 탭의 다이제스트
 * "다운로드" 버튼 전용. 부서 구분 없이 전 부서를 한 파일에 담는다(부서별 파일을 따로
 * 안 만드는 이유: 받는 쪽에서 Excel 자체 필터로 부서별 조회를 하기 때문 — 그래서 이
 * 파일은 선택된 부서와 무관하게 항상 전체 부서 기준으로 만든다).
 *
 * 시트 2개:
 *  - 이상치: 지각/근무시간미달/미태깅/혼합(하루에 지각+미달이 겹친 날) 4종 상호배타 집계,
 *    총합계(이상치 건수) 내림차순.
 *  - 52시간초과: 그 달의 주(일~토)별 인정근무시간 + N주 평균, 평균초과자는 행 전체를
 *    강조색으로 구분(사용자 요청 "조건부 서식"에 해당 — xlsx-js-style은 진짜 Excel
 *    조건부 서식 규칙을 못 써서 이미 계산된 결과를 정적 스타일로 미리 칠한다). 4주 평균
 *    내림차순.
 */
import * as XLSX from 'xlsx-js-style'
import { S, hdr, sc, bd, cellKey } from '@/utils/deptReportExcel'
import type { MonthlyAnomalyBreakdownRow, WeeklyCapRow, MonthWeek } from '@/utils/overviewAggregations'

function band(row: number): string {
  return row % 2 === 0 ? 'FFFFFF' : 'FFF5F5'
}

/** "3h30m" / "3h" / 데이터 없는 주는 "-" */
function fmtWeekHours(h: number | null): string {
  if (h === null) return '-'
  const totalMin = Math.round(h * 60)
  const hh = Math.floor(totalMin / 60)
  const mm = totalMin % 60
  return mm > 0 ? `${hh}h${String(mm).padStart(2, '0')}m` : `${hh}h`
}

// ── 이상치 시트 ──────────────────────────────────────────────────────────────

function buildAnomalySheet(rows: MonthlyAnomalyBreakdownRow[]) {
  const sorted = [...rows].sort((a, b) => b.total - a.total)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const NCOL = 7 // A~H, 0-based 마지막 열 인덱스
  let R = 0

  const HEADERS = ['사번', '이름', '본부', '지각', '근무시간 미달', '미태깅', '혼합', '총합계']
  HEADERS.forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
  R++

  sorted.forEach(row => {
    const fill = band(R)
    sc(ws, 0, R, row.rawId, S(fill, false, '333333', 'left'))
    sc(ws, 1, R, row.name,       S(fill, false, '333333', 'left'))
    sc(ws, 2, R, row.division,   S(fill, false, '333333', 'left'))
    const numStyle = (v: number, bold: boolean) => ({
      font: { bold, color: { rgb: 'C00000' }, sz: 9 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: 'center' as const, vertical: 'center' as const },
      border: bd(),
    })
    // 0건은 빈 칸으로 둔다(레퍼런스 양식과 동일 — 값 자체를 안 씀)
    if (row.late)     sc(ws, 3, R, row.late,     numStyle(row.late, false))
    else ws[cellKey(3, R)] = { v: '', t: 's', s: S(fill, false, '333333', 'center') }
    if (row.shortage) sc(ws, 4, R, row.shortage, numStyle(row.shortage, false))
    else ws[cellKey(4, R)] = { v: '', t: 's', s: S(fill, false, '333333', 'center') }
    if (row.notag)    sc(ws, 5, R, row.notag,    numStyle(row.notag, false))
    else ws[cellKey(5, R)] = { v: '', t: 's', s: S(fill, false, '333333', 'center') }
    if (row.mixed)    sc(ws, 6, R, row.mixed,    numStyle(row.mixed, false))
    else ws[cellKey(6, R)] = { v: '', t: 's', s: S(fill, false, '333333', 'center') }
    sc(ws, 7, R, row.total, numStyle(row.total, true))
    R++
  })

  ws['!ref']        = 'A1:' + cellKey(NCOL, Math.max(R - 1, 1))
  ws['!cols']       = [13, 11, 15, 9, 15, 9, 9, 10].map(w => ({ wch: w }))
  ws['!autofilter'] = { ref: `A1:${cellKey(NCOL, R - 1)}` }
  return ws
}

// ── 52시간초과 시트 ──────────────────────────────────────────────────────────

function buildWeeklyCapSheet(rows: WeeklyCapRow[], weeks: MonthWeek[]) {
  const sorted = [...rows].sort((a, b) => b.avgHours - a.avgHours)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {}
  const weekCols = weeks.length
  const AVG_COL  = 3 + weekCols       // 사번,이름,본부 + N주 다음 칸
  const TYPE_COL = AVG_COL + 1
  const NCOL     = TYPE_COL
  let R = 0

  const headers = ['사번', '이름', '본부', ...weeks.map(w => w.label), `${weekCols}주 평균`, '구분']
  headers.forEach((h, c) => sc(ws, c, R, h, hdr('C00000')))
  R++

  sorted.forEach(row => {
    const highlight = row.isAvgOver
    const fill = highlight ? 'FFCCCC' : band(R)
    const textStyle = (align: 'left' | 'center' = 'left') =>
      S(fill, highlight, highlight ? 'C00000' : '333333', align, 9)

    sc(ws, 0, R, row.rawId, textStyle())
    sc(ws, 1, R, row.name,       textStyle())
    sc(ws, 2, R, row.division,   textStyle())
    row.weekHours.forEach((h, i) => {
      sc(ws, 3 + i, R, fmtWeekHours(h), {
        font: { bold: h !== null && h > 52, color: { rgb: h !== null && h > 52 ? 'C00000' : (highlight ? 'C00000' : '333333') }, sz: 9 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: bd(),
      })
    })
    sc(ws, AVG_COL, R, fmtWeekHours(row.avgHours), {
      font: { bold: true, color: { rgb: 'C00000' }, sz: 9 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: bd(),
    })
    sc(ws, TYPE_COL, R, row.isAvgOver ? '평균 초과' : `${row.overCount}회`, {
      font: { bold: true, color: { rgb: 'C00000' }, sz: 9 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: bd(),
    })
    R++
  })

  ws['!ref']        = 'A1:' + cellKey(NCOL, Math.max(R - 1, 1))
  ws['!cols']       = [13, 11, 15, ...weeks.map(() => 9), 11, 10].map(w => ({ wch: w }))
  ws['!autofilter'] = { ref: `A1:${cellKey(NCOL, R - 1)}` }
  return ws
}

// ── 메인 빌더 ────────────────────────────────────────────────────────────────

export function buildMonthlyReviewBuffer(
  anomalyRows: MonthlyAnomalyBreakdownRow[],
  weeklyCapRows: WeeklyCapRow[],
  weeks: MonthWeek[],
): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, buildAnomalySheet(anomalyRows), '이상치')
  XLSX.utils.book_append_sheet(wb, buildWeeklyCapSheet(weeklyCapRows, weeks), '52시간초과')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
