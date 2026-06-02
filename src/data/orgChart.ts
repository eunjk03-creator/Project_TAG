import type { Employee } from '@/types/tag'

// ── Canonical division taxonomy ────────────────────────────────────────────
// 사업부문/신사업본부: CAPS exports only the division name (no sub-team column).
// 본부/HQ: CAPS exports "본부명 팀명" or just the team name — teams listed below.

export const DIVISIONS = [
  '임원',
  '경영기획본부',
  '피플본부',
  'GTM본부',
  'HQ',
  'SCM본부',
  'HMR사업부문',
  '음료사업부문',
  '뷰티사업부문',
  '헬스케어사업부문',
  '신사업본부',
] as const

/** UI 표시용 부서 정렬 순서 (사업부서 → 지원부서) */
export const DIVISION_ORDER: string[] = [
  'HMR사업부문', '음료사업부문', '헬스케어사업부문', '뷰티사업부문', '신사업본부',
  '경영기획본부', '피플본부', 'SCM본부', 'GTM본부', 'HQ',
]

export function sortByDivisionOrder(divisions: string[]): string[] {
  return [...divisions].sort((a, b) => {
    const ai = DIVISION_ORDER.indexOf(a)
    const bi = DIVISION_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b, 'ko')
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

export type DivisionName = (typeof DIVISIONS)[number]

// Known teams per division. Used for Strategy 4 (team-only lookup) and filter dropdowns.
// 사업부문 / 신사업본부: no sub-team in CAPS — employees resolve directly to the division.
// 본부장 etc. who appear with only the 본부 name also fall through to team = division name.
export const DIVISION_TEAMS: Record<DivisionName, readonly string[]> = {
  '임원':             ['CEO', 'CSO', 'CFO'],
  '경영기획본부':     ['경영관리팀', '리스크매니지먼트팀', '재무회계팀', '연결회계팀'],
  '피플본부':         ['인사기획팀', '조직문화팀'],
  'GTM본부':          ['GTM팀', '영업기획팀'],
  'HQ':               ['총무팀', 'CX팀', '촬영팀', '인프라개발팀', '품질관리팀', '수출팀', '기타'],
  'SCM본부':          ['S&OP팀', '물류운영팀', '물류기획팀'],
  'HMR사업부문':      [],
  '음료사업부문':     [],
  '뷰티사업부문':     [],
  '헬스케어사업부문': [],
  '신사업본부':       [],
}

// ── Parser helpers ─────────────────────────────────────────────────────────

/**
 * Aliases for 본부/부문 suffix inconsistency in CAPS exports.
 * CAPS sometimes exports "헬스케어사업본부" while the canonical name is "헬스케어사업부문".
 * Checked as a prefix so "헬스케어사업본부 브랜드1팀" also resolves correctly.
 */
const DIVISION_ALIASES: Record<string, DivisionName> = {
  '헬스케어사업본부': '헬스케어사업부문',
  '음료사업본부':     '음료사업부문',
  'HMR사업본부':      'HMR사업부문',
  '뷰티사업본부':     '뷰티사업부문',
  '신사업부문':       '신사업본부',   // 구 CAPS export 대응
}

// Divisions sorted longest-first so "HMR사업부문" is tried before "사업부문"
// (the old grouping key that no longer appears, but guards against partial hits).
const DIVISIONS_BY_LENGTH = [...DIVISIONS].sort((a, b) => b.length - a.length)

function isDivision(s: string): s is DivisionName {
  return (DIVISIONS as readonly string[]).includes(s)
}

/**
 * Resolves a raw 부서 string from CAPS into { division, team }.
 *
 * Strategy 1 — Slash separator: "경영기획본부 / 경영관리팀"
 *   Split on /, left side is division, right side is team.
 *   If left is not a known division, try right; otherwise keep left as division.
 *
 * Strategy 2 — Division prefix (longest first): "HMR사업부문 상품기획팀"
 *   If the string starts with a canonical division name, the remainder is team.
 *   Empty remainder means the whole string IS the division (use as team too).
 *
 * Strategy 3 — Exact division name: "피플본부"
 *   The raw string exactly equals a canonical division → { division, team: division }.
 *
 * Strategy 4 — Exact team lookup: "경영관리팀"
 *   Find which division owns this team in DIVISION_TEAMS.
 *
 * Strategy 5 — 기타 fallback:
 *   Preserve the raw string as team so it's still displayable.
 */
export function getOrganization(deptName: string): { division: string; team: string } {
  const name = deptName.trim()
  if (!name) return { division: '신사업본부', team: name }

  // Strategy 1: slash separator
  const slashIdx = name.indexOf('/')
  if (slashIdx !== -1) {
    const left  = name.slice(0, slashIdx).trim()
    const right = name.slice(slashIdx + 1).trim()
    if (isDivision(left))  return { division: left,  team: right || left }
    if (isDivision(right)) return { division: right, team: left  || right }
    // Fallback: prefix-check the left side
    const divFromLeft = DIVISIONS_BY_LENGTH.find(d => left.startsWith(d))
    return { division: divFromLeft ?? left, team: right || left }
  }

  // Strategy 1.5 — alias: resolves 본부↔부문 suffix inconsistency in CAPS exports
  for (const [alias, canonical] of Object.entries(DIVISION_ALIASES)) {
    if (name.startsWith(alias)) {
      const rest = name.slice(alias.length).trim()
      return { division: canonical, team: rest || canonical }
    }
  }

  // Strategy 2: division name as prefix (longest match first)
  for (const div of DIVISIONS_BY_LENGTH) {
    if (name.startsWith(div)) {
      const rest = name.slice(div.length).trim()
      return { division: div, team: rest || div }
    }
  }

  // Strategy 3: exact division name
  if (isDivision(name)) return { division: name, team: name }

  // Strategy 4: exact team lookup inside DIVISION_TEAMS
  for (const [division, teams] of Object.entries(DIVISION_TEAMS)) {
    if ((teams as readonly string[]).includes(name)) {
      return { division, team: name }
    }
  }

  // Strategy 5: unrecognised dept — use raw string as division to prevent silent mis-classification
  return { division: name, team: name }
}

// ── Mock employees (dev / demo only) ──────────────────────────────────────

export const EMPLOYEES: Employee[] = [
  { id: 'E1111111', name: '강악어',   division: '피플본부',       team: '인사기획팀',    part: 'Biz파트',            jobTitle: '매니저' },
  { id: 'E1111112', name: '박인사',   division: '피플본부',       team: '인사기획팀',    part: 'Biz파트',            jobTitle: '선임'   },
  { id: 'E1111113', name: '최코어',   division: '피플본부',       team: '인사기획팀',    part: 'Core파트',           jobTitle: '책임'   },
  { id: 'E1111114', name: '이조직',   division: '피플본부',       team: '조직문화팀',                                jobTitle: '매니저' },
  { id: 'E2222221', name: '김경영',   division: '경영기획본부',   team: '경영관리팀',                                jobTitle: '팀장'   },
  { id: 'E2222222', name: '정재무',   division: '경영기획본부',   team: '재무회계팀',                                jobTitle: '매니저' },
  { id: 'E2222223', name: '한리스크', division: '경영기획본부',   team: '리스크매니지먼트팀',                        jobTitle: '선임'   },
  { id: 'E3333331', name: '오에스오피', division: 'SCM본부',      team: 'S&OP팀',                                    jobTitle: '책임'   },
  { id: 'E3333332', name: '류물류',   division: 'SCM본부',        team: '물류운영팀',                                jobTitle: '매니저' },
  { id: 'E4444441', name: '신씨브이에스', division: 'GTM본부',    team: 'GTM팀',         part: 'CVS&Catering파트',   jobTitle: '선임'   },
  { id: 'E4444442', name: '임하이퍼', division: 'GTM본부',        team: 'GTM팀',         part: 'HYPER&B2B파트',      jobTitle: '매니저' },
  { id: 'E5555551', name: '윤에이치엠알', division: 'HMR사업부문', team: '상품기획팀',                               jobTitle: '책임'   },
  { id: 'E5555552', name: '조디자인', division: 'HMR사업부문',    team: '디자인팀',                                  jobTitle: '선임'   },
  { id: 'E6666661', name: '서마케팅', division: '음료사업부문',   team: '마케팅1팀',                                 jobTitle: '매니저' },
  { id: 'E6666662', name: '문프로덕트', division: '음료사업부문', team: '프로덕트팀',    part: '브랜드디자인파트',   jobTitle: '선임'   },
  { id: 'E7777771', name: '권헬스',   division: '헬스케어사업부문', team: '브랜드1팀',                               jobTitle: '팀장'   },
  { id: 'E7777772', name: '황온라인', division: '헬스케어사업부문', team: '온라인MD팀',                              jobTitle: '매니저' },
  { id: 'E8888881', name: '김그로스', division: '뷰티사업부문',   team: '브레이마케팅팀', part: '그로스파트',        jobTitle: '책임'   },
  { id: 'E8888882', name: '안콘텐츠', division: '뷰티사업부문',   team: '브레이마케팅팀', part: '콘텐츠파트',        jobTitle: '선임'   },
  { id: 'E9999991', name: '백신사업', division: '신사업본부',     team: '신사업본부',    part: '마케팅파트',         jobTitle: '책임'   },
  { id: 'E9999992', name: '하해외',   division: '신사업본부',     team: '신사업본부',    part: '해외파트',           jobTitle: '매니저' },
  { id: 'E0000001', name: '전전략',   division: 'HQ',             team: '전략기획팀',                                jobTitle: '팀장'   },
  { id: 'E0000002', name: '송큐에이', division: 'HQ',             team: '품질관리팀',    part: 'QA파트',             jobTitle: '선임'   },
]

export function getDivisions(): string[] {
  return [...DIVISIONS]
}
