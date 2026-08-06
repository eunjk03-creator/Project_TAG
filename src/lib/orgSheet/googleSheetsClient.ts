import { google } from 'googleapis'

/**
 * 조직도 시트는 앱 전체가 공유하는 단일 소스라 사용자별 OAuth가 아니라 서비스 계정
 * 고정 인프라로 인증한다(Slack 연동처럼 클라이언트가 토큰을 넘기는 방식과 다름 — 이유는
 * PROGRESS 설계문서 D절 참고). 읽기 전용 스코프만 요청 — 이 앱은 시트를 절대 쓰지 않는다.
 *
 * 사전조건: HR이 GOOGLE_SERVICE_ACCOUNT_EMAIL 계정을 대상 시트에 뷰어로 공유해야 동작한다.
 */
function isConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
    process.env.ORG_CHART_SHEET_ID,
  )
}

function getSheetsClient() {
  if (!isConfigured()) {
    throw new Error(
      '[orgSheet] Google Sheets 서비스계정이 설정되지 않았습니다. ' +
      'GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / ORG_CHART_SHEET_ID ' +
      'env를 설정하고, 해당 서비스계정 이메일을 조직도 시트에 뷰어로 공유해야 합니다.',
    )
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  return google.sheets({ version: 'v4', auth })
}

export interface OrgChartTab {
  tabName: string
  values: string[][]
}

/** 탭 이름을 "M/D" 형식으로 가정하고 최신(가장 늦은 날짜) 탭을 고른다.
 *  탭 월이 현재월보다 6개월 이상 미래면 작년으로 간주해 연말/연초 경계를 처리한다. */
function pickLatestTab(tabNames: string[], now: Date): string {
  let best: { name: string; ts: number } | null = null
  for (const name of tabNames) {
    const m = name.match(/^(\d{1,2})\/(\d{1,2})$/)
    if (!m) continue
    const month = Number(m[1])
    let year = now.getFullYear()
    if (month - (now.getMonth() + 1) > 6) year -= 1
    const ts = new Date(year, month - 1, Number(m[2])).getTime()
    if (!best || ts > best.ts) best = { name, ts }
  }
  if (!best) throw new Error(`[orgSheet] "M/D" 형식 탭을 찾지 못함: ${tabNames.join(', ')}`)
  return best.name
}

export async function fetchLatestOrgChartTab(now: Date = new Date()): Promise<OrgChartTab> {
  const sheets = getSheetsClient()
  const spreadsheetId = process.env.ORG_CHART_SHEET_ID as string

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '').filter(Boolean)
  const latestTab = pickLatestTab(tabNames, now)

  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${latestTab}'!A1:AA300`,
  })
  return { tabName: latestTab, values: (valuesRes.data.values ?? []) as string[][] }
}

export async function listOrgChartTabNames(): Promise<string[]> {
  const sheets = getSheetsClient()
  const spreadsheetId = process.env.ORG_CHART_SHEET_ID as string
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' })
  return (meta.data.sheets ?? []).map(s => s.properties?.title ?? '').filter(Boolean)
}
