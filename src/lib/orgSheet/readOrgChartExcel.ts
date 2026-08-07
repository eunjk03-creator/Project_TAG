import * as XLSX from 'xlsx'

export interface OrgChartTab {
  tabName: string
  values: string[][]
}

/**
 * 조직도 엑셀 파일(HR이 넘겨준 파일 — 지금 Google Sheet와 동일한 박스형 다이어그램)의
 * 모든 시트를 읽어 grid로 변환한다. CAPS/ERP 업로드(CsvUploader.tsx)와 동일하게
 * 브라우저에서 클라이언트 사이드로 파싱 — 서버에 원본 파일을 보내지 않는다.
 *
 * header:1로 읽으면 병합 셀의 "가려진" 칸은 빈 값으로 온다 — parseOrgChartSheet.ts가
 * 원래 Google Sheets values.get() 응답도 이 형태(병합 정보 없이 성명 칸이 비어있는 것)로
 * 가정하고 짜여 있어서 그대로 재사용된다.
 */
export function readOrgChartWorkbook(buffer: ArrayBuffer): OrgChartTab[] {
  const wb = XLSX.read(buffer, { type: 'array' })
  return wb.SheetNames.map(tabName => {
    const ws = wb.Sheets[tabName]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
    const values = rows.map(row => row.map(cell => String(cell ?? '')))
    return { tabName, values }
  })
}
