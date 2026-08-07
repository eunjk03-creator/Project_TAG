import { normalizeName } from '@/utils/dataParser'
import { getOrganization } from '@/data/orgChart'
import type { SheetPersonRow } from './parseOrgChartSheet'

/** 매칭 대상 CAPS 직원 — AttendanceSourceContext의 Employee[]에서 필요한 필드만. */
export interface CapsEmployeeLite {
  rawId: string
  name: string
  rawDept?: string
  division: string
  team: string
}

export interface KnownResolution {
  matchKey: string
  resolvedRawId: string
}

export interface MatchCandidate {
  rawId: string
  name: string
  division: string
  team: string
}

export interface SheetAmbiguousMatch {
  matchKey: string
  sheetName: string
  sheetDept: string
  candidates: MatchCandidate[]
  autoPickId: string | null
  isConfirmed: boolean
  resolvedId: string | null
}

export interface MatchedRow {
  sheetRow: SheetPersonRow
  rawId: string
  confidence: 'confirmed' | 'auto-unique' | 'auto-dept'
}

export interface MatchResult {
  matched: MatchedRow[]
  ambiguous: SheetAmbiguousMatch[]
  newHires: SheetPersonRow[]
}

function buildMatchKey(name: string, team: string): string {
  return `${normalizeName(name)}::${team}`
}

/** 시트의 division/team 텍스트가 CAPS 직원의 부서와 관련 있는지 — orgChart.ts의 표준
 *  division 표기로 정규화해서 비교(문자열 단순 포함비교보다 오탐이 적다). */
function deptMatches(sheetDivision: string, sheetTeam: string, emp: CapsEmployeeLite): boolean {
  const empOrg = getOrganization(emp.rawDept ?? emp.team ?? emp.division)
  return empOrg.division === sheetDivision || empOrg.team === sheetTeam || emp.division === sheetDivision
}

export function matchEmployees(
  sheetRows: SheetPersonRow[],
  capsEmployees: CapsEmployeeLite[],
  knownResolutions: KnownResolution[] = [],
): MatchResult {
  const resolutionByKey = new Map(knownResolutions.map(r => [r.matchKey, r.resolvedRawId]))
  const byNormName = new Map<string, CapsEmployeeLite[]>()
  for (const emp of capsEmployees) {
    const key = normalizeName(emp.name)
    const list = byNormName.get(key) ?? []
    list.push(emp)
    byNormName.set(key, list)
  }

  const matched: MatchedRow[] = []
  const ambiguous: SheetAmbiguousMatch[] = []
  const newHires: SheetPersonRow[] = []

  for (const sheetRow of sheetRows) {
    const matchKey = buildMatchKey(sheetRow.name, sheetRow.team)
    const sheetDept = `${sheetRow.division} / ${sheetRow.team}`

    // Tier 0: 관리자가 이미 확정한 매칭
    const confirmedRawId = resolutionByKey.get(matchKey)
    if (confirmedRawId) {
      matched.push({ sheetRow, rawId: confirmedRawId, confidence: 'confirmed' })
      continue
    }

    const candidates = byNormName.get(normalizeName(sheetRow.name)) ?? []

    if (candidates.length === 0) {
      newHires.push(sheetRow)
      continue
    }

    if (candidates.length === 1) {
      matched.push({ sheetRow, rawId: candidates[0].rawId, confidence: 'auto-unique' })
      continue
    }

    // 동명이인 — 부서 텍스트로 좁힌다.
    const deptFiltered = candidates.filter(c => deptMatches(sheetRow.division, sheetRow.team, c))
    const autoPickId = deptFiltered.length === 1 ? deptFiltered[0].rawId : null

    // 부서로 1명으로 좁혀져도 ambiguousMatches에 넣어 관리자 검토 대상으로 유지한다
    // (Slack 동명이인 처리와 동일한 신중함 원칙 — 부서 필터링이 틀렸을 가능성 존재).
    ambiguous.push({
      matchKey,
      sheetName: sheetRow.name,
      sheetDept,
      candidates: candidates.map(c => ({ rawId: c.rawId, name: c.name, division: c.division, team: c.team })),
      autoPickId,
      isConfirmed: false,
      resolvedId: autoPickId,
    })
    if (autoPickId) {
      matched.push({ sheetRow, rawId: autoPickId, confidence: 'auto-dept' })
    }
  }

  return { matched, ambiguous, newHires }
}

export interface ResignedCandidate {
  rawId: string
  name: string
  lastSeenSheetAt: Date | null
}

/** ACTIVE 마스터 중 이번 시트 매칭 결과에 없는 사람 — 퇴사 후보(자동 전환은 안 함). */
export function findPossiblyResigned(
  activeMasterRows: { rawId: string; name: string; lastSeenSheetAt: Date | null }[],
  matched: MatchedRow[],
): ResignedCandidate[] {
  const matchedIds = new Set(matched.map(m => m.rawId))
  return activeMasterRows
    .filter(m => !matchedIds.has(m.rawId))
    .map(m => ({ rawId: m.rawId, name: m.name, lastSeenSheetAt: m.lastSeenSheetAt }))
}
