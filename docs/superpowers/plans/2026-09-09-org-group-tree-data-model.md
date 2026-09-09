# 조직도 트리 데이터 모델 + 초기 이관 (Plan 1/4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `OrgGroup`(자기참조 트리) + `OrgGroupMember`(직책/리더/승인권한 + 날짜이력) 신규
Prisma 모델을 추가하고, 기존 실데이터(Department 75건, EmployeeMaster 446건, 리더 예외규칙
75건)를 이 새 구조로 1회성 이관한다.

**Architecture:** 새 테이블은 순수 추가(additive)만 한다 — 기존 `Department`/
`EmployeeMaster.departmentId`는 이번 플랜에서 건드리지 않는다(`admin/employees` 등 기존
화면이 지금 이걸 읽고 있어서, 제거는 Plan 2~4가 새 테이블로 전환을 마친 뒤 별도 정리
플랜에서 진행). 순수 매핑/트리조립 로직은 단위 테스트로 검증한 뒤, 그 로직을 그대로 쓰는
이관 스크립트를 dry-run(쓰기 없이 리포트만) → 사람이 리포트 검토 → commit(실제 쓰기) 순서로
실행한다.

**Tech Stack:** Prisma(PostgreSQL/Supabase), TypeScript, `tsx`(스크립트 실행), Node.js 내장
테스트 러너(`node:test`/`node:assert`) — 이 저장소엔 vitest/jest 등 테스트 프레임워크가
없고 `scripts/*.cjs` 류의 1회성 검증 스크립트 관례만 있어서, 새 의존성 추가 없이 Node 내장
테스트 러너로 순수 함수만 테스트한다.

**Spec:** `docs/superpowers/specs/2026-09-08-org-chart-tree-design.md`

## Global Constraints

- 기존 `Department`/`EmployeeMaster.departmentId`/`ExceptionRule`(manager_exemption)는 이번
  플랜에서 **삭제하지 않는다** — 읽기만 하고 새 테이블에 이관만 한다.
- `OrgGroupMember.jobTitle`은 스펙에서 정한 enum: `CEO, CSO, CFO, DIVISION_PRESIDENT,
  DIVISION_HEAD, TEAM_LEAD, PART_LEAD, MEMBER, INTERN, CONTRACT, PART_TIMER, OTHER`.
- 직책자(OT 판정) = `jobTitle IN (DIVISION_HEAD, TEAM_LEAD, PART_LEAD)` — 이 플랜에서는
  데이터만 채우고, OT 엔진이 실제로 이 값을 읽도록 바꾸는 건 Plan 2 범위.
- 실DB(서브 배포 Supabase, `.env`의 `DATABASE_URL`)에 대고 작업한다 — 이관 스크립트는
  반드시 dry-run 리포트를 사람이 확인한 뒤에만 commit 모드로 실행한다.

---

## 파일 구조

```
prisma/schema.prisma                         (수정 — OrgGroup/OrgGroupMember/JobTitle 추가)
src/lib/orgGroup/mapping.ts                   (신규 — 순수 매핑 함수 3개)
src/lib/orgGroup/mapping.test.ts              (신규 — 위 함수 단위테스트)
src/lib/orgGroup/buildTree.ts                 (신규 — Department 행 → 트리 노드 목록 순수함수)
src/lib/orgGroup/buildTree.test.ts            (신규 — 위 함수 단위테스트)
scripts/migrate_org_group_tree.ts             (신규 — 실DB 이관 스크립트, dry-run/commit 겸용)
```

---

### Task 1: Prisma 스키마 추가 (OrgGroup / OrgGroupMember / JobTitle)

**Files:**
- Modify: `prisma/schema.prisma` (347번째 줄 `model EmployeeMaster` 근처, 406번째 줄
  `model OrgChartSnapshot` 뒤에 추가)

**Interfaces:**
- Produces: `OrgGroup { id, name, parentId, order }`, `OrgGroupMember { id, groupId,
  employeeRawId, jobTitle: JobTitle, isPrimary, hasApprovalAuthority, validFrom, validTo }`,
  `enum JobTitle`. 이후 모든 태스크가 이 타입을 그대로 씀.

- [ ] **Step 1: `prisma/schema.prisma` 맨 끝(`model OrgChartSnapshot` 블록 뒤)에 추가**

```prisma
// ─── 조직도 그룹 트리 — 권한별조회 전제조건 + OT 직책자 판정 단일 소스.
// docs/superpowers/specs/2026-09-08-org-chart-tree-design.md 참고.
// 기존 Department(division/team 평면)와 병행 — 이 플랜에서는 Department를 건드리지 않는다.
enum JobTitle {
  CEO
  CSO
  CFO
  DIVISION_PRESIDENT   // 부문대표 — 근태 집계 대상 아님
  DIVISION_HEAD        // 본부장 — 직책자
  TEAM_LEAD            // 팀장   — 직책자
  PART_LEAD            // 파트장 — 직책자
  MEMBER               // 팀원
  INTERN
  CONTRACT
  PART_TIMER
  OTHER
}

model OrgGroup {
  id        String   @id @default(uuid())
  name      String
  parentId  String?  @map("parent_id")
  order     Int      @default(0)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  parent    OrgGroup?        @relation("OrgGroupTree", fields: [parentId], references: [id])
  children  OrgGroup[]       @relation("OrgGroupTree")
  members   OrgGroupMember[]

  @@index([parentId])
  @@map("org_groups")
}

model OrgGroupMember {
  id                   String    @id @default(uuid())
  groupId              String    @map("group_id")
  employeeRawId        String    @map("employee_raw_id")
  jobTitle             JobTitle  @map("job_title")
  isPrimary            Boolean   @default(true) @map("is_primary")
  hasApprovalAuthority Boolean   @default(false) @map("has_approval_authority")
  validFrom            DateTime  @map("valid_from")
  validTo              DateTime? @map("valid_to")
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @updatedAt @map("updated_at")

  group    OrgGroup       @relation(fields: [groupId], references: [id])
  employee EmployeeMaster @relation(fields: [employeeRawId], references: [rawId])

  @@index([employeeRawId, validFrom])
  @@index([groupId])
  @@map("org_group_members")
}
```

- [ ] **Step 2: `EmployeeMaster` 모델에 역방향 relation 필드 추가**

`prisma/schema.prisma`의 기존 `model EmployeeMaster { ... }` 블록에서 `capsLogs`,
`erpApplications` 옆에 한 줄 추가:

```prisma
  capsLogs           CapsDailyLog[]
  erpApplications    ErpApplication[]
  orgGroupMemberships OrgGroupMember[]
```

- [ ] **Step 3: 마이그레이션 생성 및 적용**

> **2026-09-09 수정:** 원래 여기 `npx prisma migrate dev --name add_org_group_tree`였으나,
> 실행 중 발견한 사실 때문에 `prisma db push`로 변경함 — `_prisma_migrations` 이력
> 테이블엔 `20260505071248_init` 딱 1건만 기록되어 있는데 반해, 실제 DB의 `exception_rules`
> 등 여러 테이블은 이미 현재 `schema.prisma`와 완전히 일치하는 상태였다(그동안
> `Department`/`EmployeeMaster`/`WorkSchedule`/`CapsDailyLog` 등은 전부 `db push`로
> 이 공유 DB에 반영되어 왔고, 로컬 마이그레이션 파일들은 이 DB엔 "적용됨"으로 기록된 적이
> 없음). 이 상태에서 `migrate dev`를 돌리면 drift 감지로 DB 리셋을 제안하는 흐름에 들어갈
> 위험이 있어, 이 프로젝트가 실제로 지금까지 써온 방식(`db push`)을 그대로 따르기로
> 사용자 승인 하에 변경. 마이그레이션 이력 부채 자체를 정리하는 건 이 플랜 범위 밖.

```bash
npx prisma db push
```

Expected: 콘솔에 "Your database is now in sync with your schema" 출력, 새 테이블
`org_groups`/`org_group_members` 생성. (마이그레이션 파일은 생성되지 않음 — `db push`는
마이그레이션 이력을 안 남기고 스키마만 직접 동기화하는 방식.)

- [ ] **Step 4: 클라이언트 재생성 확인**

```bash
npx prisma generate
npx tsc --noEmit -p tsconfig.json
```

Expected: 둘 다 에러 없이 종료(기존 코드가 새 모델을 아직 안 쓰므로 타입 에러 없어야 함).

- [ ] **Step 5: 빈 테이블 생성 확인**

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const g = await p.orgGroup.count();
  const m = await p.orgGroupMember.count();
  console.log(JSON.stringify({ orgGroup: g, orgGroupMember: m }));
  await p.\$disconnect();
})();
"
```

Expected: `{"orgGroup":0,"orgGroupMember":0}`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: OrgGroup/OrgGroupMember 조직도 트리 모델 추가"
```

(마이그레이션 파일이 없으므로 `prisma/migrations`는 커밋 대상에서 빠짐 — `db push`
방식이라 정상.)

---

### Task 2: 순수 매핑 함수 (jobTitle 변환 / 예외규칙 employeeId 파싱 / 직책 병합)

**Files:**
- Create: `src/lib/orgGroup/mapping.ts`
- Test: `src/lib/orgGroup/mapping.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수, 외부 의존 없음)
- Produces:
  - `mapEmployeeMasterJobTitle(raw: string): JobTitleValue`
  - `parseExceptionRuleEmployeeId(employeeId: string): { rawId: string; name: string } | null`
  - `resolveInitialJobTitle(employeeMasterJobTitle: string, hasLeaderExceptionRule: boolean): JobTitleValue`
  - `parseValidFrom(raw: string | null | undefined, fallbackIso: string): Date`
  - `type JobTitleValue = 'CEO'|'CSO'|'CFO'|'DIVISION_PRESIDENT'|'DIVISION_HEAD'|'TEAM_LEAD'|'PART_LEAD'|'MEMBER'|'INTERN'|'CONTRACT'|'PART_TIMER'|'OTHER'`
  - Task 4가 이 4개 함수를 그대로 import해서 씀.

실제 DB 조회 결과 `EmployeeMaster.jobTitle`의 distinct 값은 정확히 이 8개뿐이었다:
`['팀장','팀원','파트장','인턴','본부장','부문대표','','CFO']`. 예외규칙(manager_exemption)의
`employeeId`는 `"E25091505_박건우"`처럼 `rawId_이름` 합성키 형식이다(이름에 `_`가 들어가는
경우는 없음 — 한글 이름 기준).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/orgGroup/mapping.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapEmployeeMasterJobTitle,
  parseExceptionRuleEmployeeId,
  resolveInitialJobTitle,
  parseValidFrom,
} from './mapping'

test('mapEmployeeMasterJobTitle: 실DB에서 관찰된 8개 값 전부 매핑', () => {
  assert.equal(mapEmployeeMasterJobTitle('팀장'), 'TEAM_LEAD')
  assert.equal(mapEmployeeMasterJobTitle('팀원'), 'MEMBER')
  assert.equal(mapEmployeeMasterJobTitle('파트장'), 'PART_LEAD')
  assert.equal(mapEmployeeMasterJobTitle('인턴'), 'INTERN')
  assert.equal(mapEmployeeMasterJobTitle('본부장'), 'DIVISION_HEAD')
  assert.equal(mapEmployeeMasterJobTitle('부문대표'), 'DIVISION_PRESIDENT')
  assert.equal(mapEmployeeMasterJobTitle(''), 'MEMBER')
  assert.equal(mapEmployeeMasterJobTitle('CFO'), 'CFO')
})

test('mapEmployeeMasterJobTitle: 인식 못하는 값은 OTHER로', () => {
  assert.equal(mapEmployeeMasterJobTitle('알수없음'), 'OTHER')
})

test('parseExceptionRuleEmployeeId: rawId_이름 합성키 분리', () => {
  assert.deepEqual(parseExceptionRuleEmployeeId('E25091505_박건우'), {
    rawId: 'E25091505',
    name: '박건우',
  })
})

test('parseExceptionRuleEmployeeId: 언더스코어 없으면 null', () => {
  assert.equal(parseExceptionRuleEmployeeId('E25091505'), null)
})

test('resolveInitialJobTitle: EmployeeMaster에 이미 리더급 직책 있으면 그대로 사용', () => {
  assert.equal(resolveInitialJobTitle('본부장', true), 'DIVISION_HEAD')
  assert.equal(resolveInitialJobTitle('본부장', false), 'DIVISION_HEAD')
})

test('resolveInitialJobTitle: 직책 정보 없고 리더 예외규칙만 있으면 TEAM_LEAD로 이관', () => {
  assert.equal(resolveInitialJobTitle('', true), 'TEAM_LEAD')
  assert.equal(resolveInitialJobTitle('팀원', true), 'TEAM_LEAD')
})

test('resolveInitialJobTitle: 둘 다 없으면 매핑된 그대로(MEMBER)', () => {
  assert.equal(resolveInitialJobTitle('', false), 'MEMBER')
})

test('parseValidFrom: 빈 문자열/null이면 fallback 날짜', () => {
  assert.equal(parseValidFrom('', '2020-01-01').toISOString().slice(0, 10), '2020-01-01')
  assert.equal(parseValidFrom(null, '2020-01-01').toISOString().slice(0, 10), '2020-01-01')
  assert.equal(parseValidFrom(undefined, '2020-01-01').toISOString().slice(0, 10), '2020-01-01')
})

test('parseValidFrom: 유효한 날짜 문자열은 그대로 파싱', () => {
  assert.equal(parseValidFrom('2026-04-01', '2020-01-01').toISOString().slice(0, 10), '2026-04-01')
})
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

```bash
npx tsx --test src/lib/orgGroup/mapping.test.ts
```

Expected: FAIL — `mapping.ts` 파일이 없어서 모듈을 못 찾음(`Cannot find module './mapping'`).

- [ ] **Step 3: 최소 구현 작성**

`src/lib/orgGroup/mapping.ts`:

```ts
export type JobTitleValue =
  | 'CEO' | 'CSO' | 'CFO' | 'DIVISION_PRESIDENT' | 'DIVISION_HEAD'
  | 'TEAM_LEAD' | 'PART_LEAD' | 'MEMBER' | 'INTERN' | 'CONTRACT'
  | 'PART_TIMER' | 'OTHER'

const LEADER_TITLES: ReadonlySet<JobTitleValue> = new Set([
  'CEO', 'CSO', 'CFO', 'DIVISION_PRESIDENT', 'DIVISION_HEAD', 'TEAM_LEAD', 'PART_LEAD',
])

const RAW_JOB_TITLE_MAP: Record<string, JobTitleValue> = {
  '팀장': 'TEAM_LEAD',
  '팀원': 'MEMBER',
  '파트장': 'PART_LEAD',
  '인턴': 'INTERN',
  '본부장': 'DIVISION_HEAD',
  '부문대표': 'DIVISION_PRESIDENT',
  '': 'MEMBER',
  'CFO': 'CFO',
  'CEO': 'CEO',
  'CSO': 'CSO',
  '계약직': 'CONTRACT',
  '파트타이머': 'PART_TIMER',
}

/** EmployeeMaster.jobTitle(자유 텍스트) → JobTitle enum 값. 인식 못하면 OTHER. */
export function mapEmployeeMasterJobTitle(raw: string): JobTitleValue {
  return RAW_JOB_TITLE_MAP[raw.trim()] ?? 'OTHER'
}

/** ExceptionRule.employeeId("rawId_이름" 합성키)를 분리. 언더스코어 없으면 null. */
export function parseExceptionRuleEmployeeId(employeeId: string): { rawId: string; name: string } | null {
  const idx = employeeId.indexOf('_')
  if (idx < 0) return null
  return { rawId: employeeId.slice(0, idx), name: employeeId.slice(idx + 1) }
}

/**
 * 초기 이관 시 직책 결정 — EmployeeMaster.jobTitle이 이미 리더급이면 그걸 신뢰하고,
 * 아니면서 리더 예외규칙(manager_exemption)이 있으면 TEAM_LEAD로 이관(본부장/파트장 구분은
 * 예외규칙에 없으므로 관리자 수동 검수 필요 — 스펙 §초기적재 (c) 참고).
 */
export function resolveInitialJobTitle(
  employeeMasterJobTitle: string,
  hasLeaderExceptionRule: boolean,
): JobTitleValue {
  const mapped = mapEmployeeMasterJobTitle(employeeMasterJobTitle)
  if (LEADER_TITLES.has(mapped)) return mapped
  if (hasLeaderExceptionRule) return 'TEAM_LEAD'
  return mapped
}

/** ExceptionRule.validFrom(빈 문자열 가능) → Date. 빈 값이면 fallbackIso 사용. */
export function parseValidFrom(raw: string | null | undefined, fallbackIso: string): Date {
  const trimmed = (raw ?? '').trim()
  return new Date(trimmed.length > 0 ? trimmed : fallbackIso)
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx tsx --test src/lib/orgGroup/mapping.test.ts
```

Expected: 모든 테스트 PASS (9개).

- [ ] **Step 5: Commit**

```bash
git add src/lib/orgGroup/mapping.ts src/lib/orgGroup/mapping.test.ts
git commit -m "feat: 조직도 이관용 직책 매핑 순수함수 추가"
```

---

### Task 3: Department 행 → 트리 노드 목록 변환 (순수 함수)

**Files:**
- Create: `src/lib/orgGroup/buildTree.ts`
- Test: `src/lib/orgGroup/buildTree.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `buildGroupNodesFromDepartments(rows: DeptRow[]): GroupNode[]`,
  `interface DeptRow { division: string; team: string | null; order: number }`,
  `interface GroupNode { key: string; name: string; parentKey: string | null; order: number }`
  — Task 4가 이 함수와 타입을 그대로 씀. `key`는 division 노드면 division 문자열 그대로,
  team 노드면 `` `${division}::${team}` `` 형식.

`Department`는 `@@unique([division, team])` 제약이 있어 (division, team=null) 조합은
division당 최대 1건뿐이다 — 이 "team=null" 행이 division 레벨 자체를 나타낸다. team=null
행이 아예 없는 division이 있을 수도 있으므로(방어적으로), distinct division 값마다 무조건
정확히 1개의 division 노드를 만들고, team!=null 행마다 그 division을 부모로 하는 team
노드를 만든다 — 같은 (division, team) 조합이 중복 입력되어도 결과는 dedup된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/orgGroup/buildTree.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGroupNodesFromDepartments, type DeptRow } from './buildTree'

test('division 전용 행(team=null)은 최상위 노드가 된다', () => {
  const rows: DeptRow[] = [{ division: '경영기획본부', team: null, order: 0 }]
  const nodes = buildGroupNodesFromDepartments(rows)
  assert.equal(nodes.length, 1)
  assert.deepEqual(nodes[0], { key: '경영기획본부', name: '경영기획본부', parentKey: null, order: 0 })
})

test('team 행은 같은 division 노드의 자식이 된다', () => {
  const rows: DeptRow[] = [
    { division: 'HQ', team: null, order: 0 },
    { division: 'HQ', team: '총무팀', order: 1 },
    { division: 'HQ', team: 'CX팀', order: 2 },
  ]
  const nodes = buildGroupNodesFromDepartments(rows)
  assert.equal(nodes.length, 3)
  const hq = nodes.find(n => n.key === 'HQ')
  assert.deepEqual(hq, { key: 'HQ', name: 'HQ', parentKey: null, order: 0 })
  const team = nodes.find(n => n.key === 'HQ::총무팀')
  assert.deepEqual(team, { key: 'HQ::총무팀', name: '총무팀', parentKey: 'HQ', order: 1 })
})

test('team=null 행이 없는 division도 division 노드가 합성된다', () => {
  const rows: DeptRow[] = [{ division: '피플본부', team: '인재전략팀', order: 1 }]
  const nodes = buildGroupNodesFromDepartments(rows)
  const division = nodes.find(n => n.key === '피플본부')
  assert.ok(division, 'division 노드가 합성되어야 함')
  assert.equal(division!.parentKey, null)
})

test('같은 division이 여러 team 행에 걸쳐 나와도 division 노드는 1개만', () => {
  const rows: DeptRow[] = [
    { division: 'SCM본부', team: 'S&OP팀', order: 1 },
    { division: 'SCM본부', team: '구매팀', order: 2 },
  ]
  const nodes = buildGroupNodesFromDepartments(rows)
  const divisionNodes = nodes.filter(n => n.key === 'SCM본부')
  assert.equal(divisionNodes.length, 1)
  assert.equal(nodes.length, 3) // division 1 + team 2
})
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

```bash
npx tsx --test src/lib/orgGroup/buildTree.test.ts
```

Expected: FAIL — `Cannot find module './buildTree'`

- [ ] **Step 3: 최소 구현 작성**

`src/lib/orgGroup/buildTree.ts`:

```ts
export interface DeptRow {
  division: string
  team: string | null
  order: number
}

export interface GroupNode {
  key: string
  name: string
  parentKey: string | null
  order: number
}

/** Department 행 목록 → OrgGroup 트리 노드 목록. division당 정확히 1개 노드 + team마다 1개. */
export function buildGroupNodesFromDepartments(rows: DeptRow[]): GroupNode[] {
  const divisionOrder = new Map<string, number>()
  const teamRows: DeptRow[] = []

  for (const row of rows) {
    if (row.team === null) {
      if (!divisionOrder.has(row.division)) divisionOrder.set(row.division, row.order)
    } else {
      teamRows.push(row)
      if (!divisionOrder.has(row.division)) divisionOrder.set(row.division, row.order)
    }
  }

  const nodes: GroupNode[] = []
  for (const [division, order] of divisionOrder) {
    nodes.push({ key: division, name: division, parentKey: null, order })
  }
  for (const row of teamRows) {
    const key = `${row.division}::${row.team}`
    nodes.push({ key, name: row.team!, parentKey: row.division, order: row.order })
  }
  return nodes
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx tsx --test src/lib/orgGroup/buildTree.test.ts
```

Expected: 모든 테스트 PASS (4개).

- [ ] **Step 5: Commit**

```bash
git add src/lib/orgGroup/buildTree.ts src/lib/orgGroup/buildTree.test.ts
git commit -m "feat: Department 행을 조직도 트리 노드로 변환하는 순수함수 추가"
```

---

### Task 4: 이관 스크립트 — dry-run 모드

**Files:**
- Create: `scripts/migrate_org_group_tree.ts`

**Interfaces:**
- Consumes: `buildGroupNodesFromDepartments`(Task 3), `resolveInitialJobTitle`,
  `parseExceptionRuleEmployeeId`, `parseValidFrom`(Task 2)
- Produces: CLI 스크립트. 인자 없이 실행하면 dry-run(리포트만 출력, DB 쓰기 없음), `--commit`
  플래그를 주면 실제로 씀(Task 5에서 사용).

- [ ] **Step 1: 스크립트 작성 (dry-run 로직까지)**

`scripts/migrate_org_group_tree.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import {
  buildGroupNodesFromDepartments, type DeptRow,
} from '../src/lib/orgGroup/buildTree'
import {
  resolveInitialJobTitle, parseExceptionRuleEmployeeId, parseValidFrom,
} from '../src/lib/orgGroup/mapping'

const FALLBACK_VALID_FROM = '2020-01-01'
const prisma = new PrismaClient()

async function buildPlan() {
  const departments = await prisma.department.findMany({
    select: { division: true, team: true, order: true },
  })
  const groupNodes = buildGroupNodesFromDepartments(departments as DeptRow[])

  const employees = await prisma.employeeMaster.findMany({
    select: { rawId: true, jobTitle: true, departmentId: true, hireDate: true },
  })
  const departmentsById = await prisma.department.findMany()
  const deptById = new Map(departmentsById.map(d => [d.id, d]))

  const leaderRules = await prisma.exceptionRule.findMany({
    where: { ruleType: 'manager_exemption' },
    select: { employeeId: true, validFrom: true },
  })
  const leaderRawIds = new Set<string>()
  const unparsedLeaderRuleIds: string[] = []
  for (const rule of leaderRules) {
    const parsed = parseExceptionRuleEmployeeId(rule.employeeId)
    if (parsed) leaderRawIds.add(parsed.rawId)
    else unparsedLeaderRuleIds.push(rule.employeeId)
  }

  const membersToCreate: {
    rawId: string
    groupKey: string
    jobTitle: string
    validFrom: Date
  }[] = []
  const unassigned: string[] = []
  const employeeRawIds = new Set(employees.map(e => e.rawId))

  for (const emp of employees) {
    if (!emp.departmentId) { unassigned.push(emp.rawId); continue }
    const dept = deptById.get(emp.departmentId)
    if (!dept) { unassigned.push(emp.rawId); continue }
    const groupKey = dept.team ? `${dept.division}::${dept.team}` : dept.division
    const jobTitle = resolveInitialJobTitle(emp.jobTitle, leaderRawIds.has(emp.rawId))
    const validFrom = parseValidFrom(emp.hireDate, FALLBACK_VALID_FROM)
    membersToCreate.push({ rawId: emp.rawId, groupKey, jobTitle, validFrom })
  }

  const leaderRawIdsNotInEmployeeMaster = [...leaderRawIds].filter(id => !employeeRawIds.has(id))

  return {
    groupNodes,
    membersToCreate,
    unassigned,
    unparsedLeaderRuleIds,
    leaderRawIdsNotInEmployeeMaster,
  }
}

async function main() {
  const commit = process.argv.includes('--commit')
  const plan = await buildPlan()

  console.log('=== 조직도 트리 이관 계획 ===')
  console.log(`생성할 OrgGroup 노드: ${plan.groupNodes.length}개`)
  console.log(`  - division 노드: ${plan.groupNodes.filter(n => n.parentKey === null).length}개`)
  console.log(`  - team 노드: ${plan.groupNodes.filter(n => n.parentKey !== null).length}개`)
  console.log(`생성할 OrgGroupMember: ${plan.membersToCreate.length}건`)
  console.log(`부서 미배정(스킵): ${plan.unassigned.length}명`)
  if (plan.unparsedLeaderRuleIds.length > 0) {
    console.log(`⚠️ employeeId 파싱 실패한 리더 예외규칙: ${plan.unparsedLeaderRuleIds.length}건`)
    console.log('  ', plan.unparsedLeaderRuleIds.join(', '))
  }
  if (plan.leaderRawIdsNotInEmployeeMaster.length > 0) {
    console.log(`⚠️ EmployeeMaster에 없는 리더 예외규칙 rawId: ${plan.leaderRawIdsNotInEmployeeMaster.length}건`)
    console.log('  ', plan.leaderRawIdsNotInEmployeeMaster.join(', '))
  }
  const jobTitleCounts = new Map<string, number>()
  for (const m of plan.membersToCreate) {
    jobTitleCounts.set(m.jobTitle, (jobTitleCounts.get(m.jobTitle) ?? 0) + 1)
  }
  console.log('직책 분포:', Object.fromEntries(jobTitleCounts))

  if (!commit) {
    console.log('\n(dry-run — 실제 DB 쓰기는 안 함. --commit 플래그로 실행하면 반영됩니다)')
    await prisma.$disconnect()
    return
  }

  console.log('\n=== commit 모드 — 실제로 씁니다 ===')
  // 2026-09-09 수정: 그룹75+멤버277 = 약 352건을 순차 await로 처리하면 Prisma 인터랙티브
  // 트랜잭션 기본 타임아웃(5000ms)을 원격 Supabase 상대로 넘길 수 있음(Task 4 리뷰에서 발견) —
  // 타임아웃을 넉넉히 늘림. 로직은 그대로, 옵션만 추가.
  await prisma.$transaction(async tx => {
    const idByKey = new Map<string, string>()
    const divisionNodes = plan.groupNodes.filter(n => n.parentKey === null)
    const teamNodes = plan.groupNodes.filter(n => n.parentKey !== null)

    for (const node of divisionNodes) {
      const created = await tx.orgGroup.create({
        data: { name: node.name, parentId: null, order: node.order },
      })
      idByKey.set(node.key, created.id)
    }
    for (const node of teamNodes) {
      const parentId = idByKey.get(node.parentKey!)
      if (!parentId) throw new Error(`부모 그룹을 못 찾음: ${node.parentKey}`)
      const created = await tx.orgGroup.create({
        data: { name: node.name, parentId, order: node.order },
      })
      idByKey.set(node.key, created.id)
    }

    for (const member of plan.membersToCreate) {
      const groupId = idByKey.get(member.groupKey)
      if (!groupId) throw new Error(`그룹을 못 찾음: ${member.groupKey}`)
      await tx.orgGroupMember.create({
        data: {
          groupId,
          employeeRawId: member.rawId,
          jobTitle: member.jobTitle as never,
          isPrimary: true,
          hasApprovalAuthority: false,
          validFrom: member.validFrom,
          validTo: null,
        },
      })
    }
  }, { timeout: 120_000 })
  console.log('완료.')
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: dry-run 실행**

```bash
npx tsx scripts/migrate_org_group_tree.ts
```

Expected: 종료코드 0, "생성할 OrgGroup 노드: 75개 이하"(division dedup으로 75보다 작을 수
있음), "생성할 OrgGroupMember: 277건 안팎"(departmentId 있는 EmployeeMaster 수, 446-169=277
예상), "부서 미배정(스킵): 169명" — DB 실측치와 다르면(1번 항목 실행 시점 Department가
75건, EmployeeMaster가 446건, 그중 departmentId null이 169건이었음 — 값이 바뀌었으면 그
사이 실데이터가 바뀐 것이므로 새 값 기준으로 판단) 원인을 먼저 파악하고 진행.

- [ ] **Step 3: 출력된 리포트를 사람이 검토**

이 단계는 자동화하지 않는다 — dry-run 출력(특히 "⚠️" 두 항목, 직책 분포)을 실행한 사람이
직접 읽고 이상한 값(예: 리더 예외규칙 rawId가 EmployeeMaster에 없는 경우, employeeId 파싱
실패)이 없는지 확인한 뒤에만 Task 5로 진행한다.

- [ ] **Step 4: Commit (dry-run 스크립트만)**

```bash
git add scripts/migrate_org_group_tree.ts
git commit -m "feat: 조직도 트리 이관 스크립트 추가 (dry-run)"
```

---

### Task 5: 이관 스크립트 — 실제 커밋 실행 및 검증

**Files:**
- (스크립트 변경 없음 — Task 4 산출물을 `--commit`으로 실행)

**Interfaces:**
- Consumes: Task 4의 `scripts/migrate_org_group_tree.ts`
- Produces: 실DB의 `org_groups`/`org_group_members` 테이블 데이터

- [ ] **Step 1: Task 4의 dry-run 리포트가 이미 검토·승인된 상태인지 확인**

Task 4 Step 3에서 사람이 리포트를 확인하고 이상 없다고 판단한 경우에만 이 태스크를 진행한다.
이상이 있었다면(예: 파싱 실패 rawId 존재) 먼저 Task 2/3 로직이나 원본 데이터를 고치고
Task 4 dry-run을 다시 돌려서 리포트가 깨끗해진 뒤에 진행한다.

- [ ] **Step 2: 실제 커밋 실행**

```bash
npx tsx scripts/migrate_org_group_tree.ts --commit
```

Expected: "완료." 출력, 종료코드 0.

- [ ] **Step 3: 결과 검증**

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const groups = await p.orgGroup.count();
  const members = await p.orgGroupMember.count();
  const byTitle = await p.orgGroupMember.groupBy({ by: ['jobTitle'], _count: true });
  console.log(JSON.stringify({ groups, members, byTitle }, null, 1));
  await p.\$disconnect();
})();
"
```

Expected: `groups`/`members` 수가 Task 4 dry-run에서 예고한 수와 정확히 일치. `byTitle`
분포도 dry-run의 "직책 분포"와 일치.

- [ ] **Step 4: 스팟체크 — 기존 리더 판정과 어긋나지 않는지 확인**

기존 리더 예외규칙(75건) 중 하나를 골라, 그 사람의 새 `OrgGroupMember.jobTitle`이 직책자
집합(`DIVISION_HEAD`/`TEAM_LEAD`/`PART_LEAD`) 중 하나인지 수동 확인:

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rule = await p.exceptionRule.findFirst({ where: { ruleType: 'manager_exemption' } });
  const rawId = rule.employeeId.split('_')[0];
  const member = await p.orgGroupMember.findFirst({ where: { employeeRawId: rawId } });
  console.log(JSON.stringify({ rule, member }, null, 1));
  await p.\$disconnect();
})();
"
```

Expected: `member.jobTitle`이 `DIVISION_HEAD`/`TEAM_LEAD`/`PART_LEAD` 중 하나.

- [ ] **Step 5: Commit**

이관 스크립트 자체는 Task 4에서 이미 커밋됨 — 이 태스크는 실DB 상태 변경만 있고 코드 변경이
없으므로 별도 커밋 없음. (원하면 실행 로그를 `docs/superpowers/plans/` 옆에 결과 요약을
남기는 것도 가능하지만 필수 아님.)

---

## Self-Review 메모 (계획 작성자용, 실행 시 참고)

- **스펙 커버리지:** 스펙의 "데이터 모델" 섹션 → Task 1. "초기 적재 (a)(b)(c)" → Task 3/4.
  "초기 적재 (d) 전환기 처리"(ExceptionRulesTab UI 제거)는 Plan 2 범위(OT 엔진이 실제로
  새 소스를 읽기 시작한 뒤에만 안전하게 제거 가능하므로 이 플랜엔 포함 안 함).
- **겹치는 validTo=null 행 방지**(스펙 리스크 항목)는 이 플랜에서는 이슈가 안 됨 — 초기
  이관은 인당 정확히 1개 행만 만들기 때문. 이 리스크는 Plan 3(관리 UI에서 이동/승진 처리
  시 기존 행을 확실히 닫고 새 행을 여는 로직)에서 다뤄야 함.
- **CEO/CSO/부문대표**는 실DB에 아직 그런 jobTitle이 없었지만(관찰된 8개 값에 CEO/CSO/
  계약직/파트타이머 없음) 매핑 테이블엔 방어적으로 포함해뒀다 — 향후 데이터에 나타나도
  깨지지 않음.
