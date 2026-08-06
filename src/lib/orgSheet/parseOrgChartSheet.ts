/**
 * 조직도 Google Sheet(박스형 다이어그램) 파서.
 *
 * 시트는 표가 아니라 "본부별 컬럼블록(직책·성명·직무 3컬럼) + 팀/파트 헤더행 + 사람행"이
 * 섞인 시각적 다이어그램이다. merge 셀 메타데이터 없이도, "성명 칸이 비어있는가"만으로
 * 팀헤더 행과 사람 행을 구분할 수 있다는 걸 실제 시트 데이터로 확인했다:
 *   - 사람 행: 직책 칸에 실제 직책(TITLE_VOCAB), 성명 칸에 이름이 채워짐.
 *   - 팀헤더 행: 직책 칸에 팀/파트명, 성명 칸은 비어있고 직무 칸에 인원수 숫자.
 */

export interface SheetPersonRow {
  division: string
  team: string
  title: string
  name: string
  jobFunction: string | null
  /** 이름에 '*'(겸임 표시)가 붙어있던 경우 true — 이 사람이 이 행의 팀/직책을 겸임하고 있음을 뜻하고,
   *  다른 행에도 동일 인물이 본직으로 등장할 수 있다(헤드카운트 중복 집계 유의 신호). */
  isConcurrent: boolean
  tabName: string
}

export interface DeclaredCount {
  label: string
  count: number
}

export interface ParseResult {
  rows: SheetPersonRow[]
  /** 상단 집계 박스(구분/총인원) — sanity check 대조용. */
  sheetTotals: Record<string, number>
  /** 각 팀/파트/본부 헤더 행에 병기된 신고 인원수 — 상세 sanity check 보조용. */
  declaredCounts: DeclaredCount[]
  warnings: string[]
}

const TITLE_VOCAB = new Set([
  'CEO', 'CSO', 'CFO', 'CTO', 'CMO', '본부장', '부문대표', '팀장', '파트장', '팀원', '인턴',
])

function cell(grid: string[][], r: number, c: number): string {
  return (grid[r]?.[c] ?? '').toString().trim()
}

function isPureNumber(s: string): boolean {
  return /^\d+$/.test(s)
}

/** 헤더행("직책"+"성명"[+"직무"]) 위치를 전부 찾는다. 같은 컬럼에 섹션(상단/하단)별로 여러 번 나올 수 있다. */
function findHeaders(grid: string[][]): { row: number; col: number; width: 2 | 3 }[] {
  const headers: { row: number; col: number; width: 2 | 3 }[] = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (cell(grid, r, c) === '직책' && cell(grid, r, c + 1) === '성명') {
        const width: 2 | 3 = cell(grid, r, c + 2) === '직무' ? 3 : 2
        headers.push({ row: r, col: c, width })
      }
    }
  }
  return headers
}

/**
 * 헤더행 위쪽으로 스캔하며 "본부/사업부문 이름" 행을 찾는다.
 * 사이에 부문대표 같은 사람 행(직책+성명 둘 다 채워짐)이 끼어 있어도 계속 위로 올라가서
 * "성명 칸이 비어있는" 첫 행을 division 행으로 채택한다. 그 사이에 있던 사람 행(예:
 * "부문대표 이정복")은 이 본부 소속 사람으로 별도 수집해서 반환한다 — 그냥 지나치면
 * 헤드카운트에서 그 사람이 통째로 빠진다(실측: HMR/헬스케어 division에서 확인된 누락).
 */
function findDivisionAbove(
  grid: string[][],
  headerRow: number,
  col: number,
): { name: string; declaredCount: number | null; headPersons: { title: string; name: string }[] } | null {
  const MAX_UP = 10
  const headPersons: { title: string; name: string }[] = []
  for (let r = headerRow - 1, steps = 0; r >= 0 && steps < MAX_UP; r--, steps++) {
    const title = cell(grid, r, col)
    const name = cell(grid, r, col + 1)
    if (!title && !name) continue // 완전 빈 행 — 계속 위로
    if (title && !name) {
      const countStr = cell(grid, r, col + 2)
      return { name: title, declaredCount: isPureNumber(countStr) ? Number(countStr) : null, headPersons }
    }
    // title && name (예: 부문대표 이정복) — 사람 행. 본부 직속으로 수집하고 계속 위로 스캔.
    headPersons.push({ title, name })
  }
  return null
}

function parseSheetTotals(grid: string[][]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (cell(grid, r, c) === '구분' && cell(grid, r, c + 1) === '총인원(명)') {
        for (let rr = r + 1; rr < grid.length; rr++) {
          const label = cell(grid, rr, c)
          const countStr = cell(grid, rr, c + 1)
          if (!label && !countStr) break
          if (label && isPureNumber(countStr)) totals[label] = Number(countStr)
        }
      }
    }
  }
  return totals
}

export function parseOrgChartSheet(grid: string[][], tabName: string): ParseResult {
  const warnings: string[] = []
  const rows: SheetPersonRow[] = []
  const declaredCounts: DeclaredCount[] = []

  const headers = findHeaders(grid)

  for (const { row: headerRow, col, width } of headers) {
    const divisionInfo = findDivisionAbove(grid, headerRow, col)
    if (!divisionInfo) {
      warnings.push(`[${tabName}] col=${col} headerRow=${headerRow}: 본부명을 찾지 못함 — 스킵`)
      continue
    }
    const division = divisionInfo.name
    if (divisionInfo.declaredCount != null) {
      declaredCounts.push({ label: division, count: divisionInfo.declaredCount })
    }
    for (const hp of divisionInfo.headPersons) {
      const isConcurrent = hp.name.endsWith('*')
      rows.push({
        division,
        team: division,
        title: hp.title,
        name: isConcurrent ? hp.name.slice(0, -1).trim() : hp.name,
        jobFunction: null,
        isConcurrent,
        tabName,
      })
    }

    let currentTeam = division // 팀헤더 없이 바로 사람 행이 나오면 본부 직속(team = division)
    let blankRun = 0

    for (let r = headerRow + 1; r < grid.length; r++) {
      // 같은 컬럼에 다음 섹션의 헤더행이 다시 나오면 이 블록은 끝난 것으로 간주
      if (cell(grid, r, col) === '직책' && cell(grid, r, col + 1) === '성명') break

      const title = cell(grid, r, col)
      const name = cell(grid, r, col + 1)
      const third = width === 3 ? cell(grid, r, col + 2) : ''

      if (!title && !name) {
        blankRun++
        if (blankRun >= 2) break // 이 블록 섹션 종료
        continue
      }
      blankRun = 0

      if (!name) {
        // 팀/파트 헤더 행
        currentTeam = title
        if (isPureNumber(third)) declaredCounts.push({ label: `${division}/${title}`, count: Number(third) })
        continue
      }

      // 사람 행
      const isConcurrent = name.endsWith('*')
      const cleanName = isConcurrent ? name.slice(0, -1).trim() : name
      if (!TITLE_VOCAB.has(title)) {
        warnings.push(`[${tabName}] ${division}/${currentTeam} "${cleanName}": 알 수 없는 직책 표기 "${title}" — 계속 처리함`)
      }
      rows.push({
        division,
        team: currentTeam,
        title,
        name: cleanName,
        jobFunction: width === 3 ? (third || null) : null,
        isConcurrent,
        tabName,
      })
    }
  }

  return { rows, sheetTotals: parseSheetTotals(grid), declaredCounts, warnings }
}
