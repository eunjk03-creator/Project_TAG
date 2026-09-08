# 조직도 그룹관리 (OrgGroup Tree) — 설계 스펙

> 작성일: 2026-09-08
> 브랜치: `feature/normalize-attendance-db`
> 목적: 향후 "권한별 조회(role-based access)" 기능의 전제조건으로, CAPS/ERP와 연동되는
> 트리형 조직도 + 리더/직책 관리 시스템을 새로 구축한다.

## 배경 / 왜 필요한가

- CAPS는 전체 인원이 division/team 텍스트로만 조회되고, 정확한 부서/팀/파트 구분과 조직
  계층(부문대표/본부장 등 리더 체계)이 시스템에 없다.
- 향후 "부문/본부별 조회 권한"(대표·본부장에게 자기 조직 스코프만 보이게)을 만들려면, 그 전에
  신뢰 가능한 조직 트리 + 리더 지정이 먼저 있어야 한다. 이 스펙은 그 전제조건만 다룬다 —
  로그인/권한 집행(누가 로그인해서 어떤 데이터를 볼 수 있는가) 자체는 범위 밖이다
  ([[project_tag_role_based_access_future]] 참고, 별도 트랙으로 이후 진행).
- 과거(2026-08) 구글시트/엑셀 기반 조직도 임포트(`src/lib/orgSheet/*`, `Department`/
  `EmployeeMaster` 초안)를 시도했으나 이번 브랜치에서는 그 방식을 쓰지 않기로 함 —
  `EmployeeMaster`는 현재 0건이라 실사용 데이터 손실 없이 새로 설계할 수 있다.
- 설계 도중 확인된 추가 요구사항: 이 조직도가 단순 권한용이 아니라, **OT(연장근로) 계산의
  "직책자 판정" 단일 소스**가 되어야 한다 — 현재 `EmployeeAttributeOverrides.isLeader` +
  `leaderFrom`/`leaderTo`(예외규칙 화면에서 수동 관리, CLAUDE.md §10)를 대체한다.

## 스코프

**포함:**
1. 임의 깊이 자기참조 트리(`OrgGroup`) + 소속/직책/리더 이력(`OrgGroupMember`) 데이터 모델
2. CAPS 원본 기준 초기 트리 자동 생성 + 기존 리더 예외규칙 이관 스크립트
3. OT 엔진의 "직책자 판정" 소스를 이 트리로 교체 (계산식 자체는 불변)
4. 드래그앤드롭 조직도 관리 UI (`admin/settings`의 기존 "조직도 동기화" 탭 대체)
5. 기존 division 단위 집계 화면(AllowanceTab/EmployeeCalendarGrid/overview)에 대한
   최소침습 연동 — 정확한 division명 소스만 이 트리로 교체

**제외 (다음 단계로 미룸):**
- 로그인/인증, 역할별 데이터 스코프 제어(권한별 조회 자체)
- 팀/파트 단위 조회 UI (division 단위보다 세밀한 필터링 화면)
- `hasApprovalAuthority`를 실제로 사용하는 승인 워크플로 (지금은 필드만 저장)
- `DIVISION_ORDER`(`data/orgChart.ts`) 하드코딩 상수 교체

## 데이터 모델

```prisma
enum JobTitle {
  CEO
  CSO
  CFO
  DIVISION_PRESIDENT   // 부문대표 — 근태 집계 대상 아님
  DIVISION_HEAD        // 본부장 — 직책자(OT 30분절삭 없음, ERP 승인 게이트 없음)
  TEAM_LEAD            // 팀장   — 직책자 (동일)
  PART_LEAD            // 파트장 — 직책자 (동일)
  MEMBER               // 팀원
  INTERN
  CONTRACT
  PART_TIMER
  OTHER
}

model OrgGroup {
  id        String   @id @default(uuid())
  name      String                       // "HMR사업본부", "HMR1팀", "A파트" 등
  parentId  String?  @map("parent_id")
  order     Int      @default(0)         // 형제 그룹 내 정렬 순서
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  parent    OrgGroup?        @relation("OrgGroupTree", fields: [parentId], references: [id])
  children  OrgGroup[]       @relation("OrgGroupTree")
  members   OrgGroupMember[]

  @@map("org_groups")
}

model OrgGroupMember {
  id                   String    @id @default(uuid())
  groupId              String    @map("group_id")
  employeeRawId        String    @map("employee_raw_id")   // EmployeeMaster.rawId
  jobTitle             JobTitle  @map("job_title")
  isPrimary            Boolean   @default(true)  @map("is_primary")   // 겸직 시 false
  hasApprovalAuthority Boolean   @default(false) @map("has_approval_authority")
  validFrom            DateTime @map("valid_from")
  validTo              DateTime? @map("valid_to")   // null = 현재 유효
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  group    OrgGroup       @relation(fields: [groupId], references: [id])
  employee EmployeeMaster @relation(fields: [employeeRawId], references: [rawId])

  @@index([employeeRawId, validFrom])
  @@index([groupId])
  @@map("org_group_members")
}
```

**설계 근거:**

- **자기참조 트리(parentId)** — 실제 조직은 (회사) → 사업부/본부 → 팀 → 파트의 3~4단이지만
  본부별로 리더 유무가 들쭉날쭉하고 향후 개편 가능성이 있어, 고정 깊이 컬럼 대신 임의 깊이
  트리로 설계. 규모(수백 명, 4단 이하)상 재귀조회 최적화(nested set 등) 불필요 — 전체
  로드 후 메모리에서 트리 조립으로 충분.
- **OrgGroupMember를 조인테이블로 분리** — 리더 여러 명 동시 지정 가능(레퍼런스와 동일),
  승인권한 플래그, 겸직(`isPrimary=false`)까지 한 구조로 커버.
- **날짜범위 이력(`validFrom`/`validTo`)** — 인사이동/승진이 과거 OT·급여 재계산에 정확히
  반영되어야 하므로(기존 `leaderFrom`/`leaderTo`와 동일 수준 요구사항), "인사이동 = 기존
  행 종료 + 새 행 추가"로 통일. 팀 이동과 직책 변경이 같은 연산이 됨.
- **직책자 판정** = `jobTitle IN (DIVISION_HEAD, TEAM_LEAD, PART_LEAD)`. 이 셋은 동일하게
  OT 30분절삭 없음 + ERP 연장근로 승인 게이트 없음(직책자는 연장수당을 별도 지급하므로
  ERP 승인 확인 자체가 불필요 — 기존 `computeLeaderPayOtMins` 동작 그대로).
- **CEO/CSO/CFO/DIVISION_PRESIDENT**는 근태·OT 계산 완전 배제(기존 "임원" 부서 제외 규칙과
  일치) — 조직도 트리에는 최상위 노드로만 존재, 이후 "전사 조회 권한" 부여 대상.
- `hasApprovalAuthority`는 지금 사용처 없음 — 미래 권한별조회용으로 필드만 선반영(과잉설계
  방지, 실제 승인 워크플로 생기기 전까지 저장만).
- 기존 `Department`(division/team 평면 2단) 모델은 제거하고 위 두 모델로 대체.
  `EmployeeMaster.departmentId`(단일 FK)도 제거 — 소속은 전부 `OrgGroupMember`로 표현.

## 초기 적재 & 기존 데이터 이관

1. **트리 자동 생성** — 최근 CAPS 업로드에서 distinct (division, team) 쌍을 추출해 2단
   트리 자동 생성 (division → team). 파트는 CAPS에 정보가 없어 미생성 — 관리화면에서
   팀 안에 수동으로 파트를 만들고 인원을 드래그.
2. **직원 배치** — CAPS에 등장한 모든 employeeId를 `EmployeeMaster`에 upsert(현재 0건이라
   사실상 신규 생성)하고, 각자의 CAPS division/team에 대응하는 그룹에 `OrgGroupMember`
   (`isPrimary=true`, `jobTitle=MEMBER`, `validFrom=적재일`)로 배치.
3. **기존 리더 이관** — `ExceptionRulesTab`에 등록된 `isLeader=true` 직원(및 `leaderFrom`/
   `leaderTo`)을 찾아 `OrgGroupMember` 행으로 변환:
   - `leaderFrom` 있으면 그 값을 `validFrom`, 없으면 이른 날짜(예: 입사일, 없으면
     2020-01-01)로 대체
   - `leaderTo` 있으면 `validTo`, 없으면 `validTo=null`
   - `jobTitle`은 일단 전부 `TEAM_LEAD`로 이관 — 기존 예외규칙엔 본부장/파트장 구분이
     없으므로, 이관 후 **관리자가 검수해서 수동으로 세분화**해야 하는 목록으로 별도 안내
   - 이관 스크립트는 1회성. 실행 후 이관 전/후 `isLeaderOnDate` 판정 결과가 동일한지
     스팟체크 필요
4. **전환기 UI 처리** — OT 엔진이 새 소스를 보게 되는 시점에 `ExceptionRulesTab`의
   `isLeader`/`leaderFrom`/`leaderTo` 입력 UI는 **즉시 제거**(마이그레이션 검증 끝나는 대로).
   리더 관리는 이후 전부 조직도 화면에서만 이뤄짐 — 두 곳에서 관리되면 기존 B3/B4류
   이중정의 버그와 같은 위험이 생기므로 병행 기간을 두지 않음.

## OT 엔진 연동 지점

계산식(formula)은 전혀 변경하지 않는다 — "이 사람이 특정 날짜에 직책자인가?"를 판정하는
**소스만** 교체한다.

- **`EmployeeExceptionsContext`의 `employeeAttrMap`** — 지금 `isLeader`/`leaderFrom`/
  `leaderTo`를 담아 내려주는 소스를 `OrgGroupMember` 조회 결과로 교체. 소비 측
  (`processRecord.ts`, `AllowanceTab.tsx`, `EmployeeCalendarGrid.tsx`)의 인터페이스는
  그대로 유지 — `isLeaderOnDate(date)` 내부 구현만 "날짜범위 필드 비교"에서 "OrgGroupMember
  조회"로 교체.
- **신규 헬퍼**: `getJobTitleOnDate(employeeRawId, date): JobTitle` — 조직도 데이터를 한 번에
  로드해 메모리 맵으로 특정 날짜의 유효 직책을 조회(직원 규모상 매 레코드 쿼리 불필요).
  `isLeaderOnDate`는 이 결과가 `{DIVISION_HEAD, TEAM_LEAD, PART_LEAD}`에 속하는지로 재정의.
- **CEO/CSO/CFO/부문대표**는 CAPS 원본에도 없거나 있어도 `isGlobalExclusion` 대상이라 OT
  엔진 입장에서 추가로 손댈 부분 없음 — 조직도 트리에만 노드로 존재.
- **영향 파일**: `processRecord.ts`, `attendanceCalc.ts`(computeLeaderPayOtMins 분기),
  `AllowanceTab.tsx`, `EmployeeCalendarGrid.tsx` — 이 4곳이 `employeeAttrMap.isLeader`류
  필드 대신 새 조회 함수를 쓰도록 교체.

## 관리자 UI (트리 + 드래그앤드롭 + 직책/리더 지정)

레퍼런스(그룹 관리 SaaS 화면)와 동일한 레이아웃:

- **가로 depth 컬럼 뷰**: 최상위 / 1depth / 2depth / ... 컬럼이 옆으로 나열, 각 컬럼에 그
  깊이의 그룹 카드들이 나열.
- **그룹 카드 액션 메뉴**: `+ 하위 그룹 추가`, `구성원 보기`, `그룹명 수정`, `이동`, `삭제`.
- **구성원 패널**: 소속 인원 리스트 — 이름 옆 `jobTitle` 배지, 직책자(TEAM_LEAD/PART_LEAD/
  DIVISION_HEAD)면 별 아이콘(승인권한 있으면 노란별, 없으면 검은별 — `hasApprovalAuthority`
  로 색 결정).
- **드래그앤드롭 소속변경**: 구성원 카드를 다른 그룹 카드 위로 드래그 → 드랍 시 현재
  `OrgGroupMember` 행을 `validTo=오늘`로 닫고 새 그룹에 새 행 생성(`validFrom=오늘`, 직책은
  기존 값 유지 — 팀 이동만으로 직책이 바뀌진 않음).
- **직책 변경**: 별도 폼(구성원 카드 → "직책 변경") — jobTitle 드롭다운 + 발효일(validFrom)
  입력 → 저장 시 기존 행 종료 + 새 행 생성. 발효일을 과거로 소급 입력 가능(예: "지난달부터
  팀장이었는데 이제 등록").
- **라이브러리**: `@dnd-kit` (React 19 호환, 활발히 유지보수) — 컬럼 간 드래그, 카드 위
  드랍존 처리.
- **위치**: `admin/settings`의 기존 "조직도 동기화"(엑셀 기반) 탭을 이걸로 교체, 탭 이름은
  "조직도 관리"로 변경.

## 기존 화면 연동 (division 집계)

- **최소침습 원칙** — `AllowanceTab`/`EmployeeCalendarGrid`/`overview` 등은 지금처럼 division
  텍스트 기준 그룹핑을 유지. `EmployeeMaster.rawId → OrgGroupMember(isPrimary) → 부모 체인을
  최상위(사업부/본부)까지 순회` 하는 헬퍼 `getTopDivisionName(rawId, date)` 하나만 추가해서,
  CAPS 원본 텍스트 대신 이 헬퍼가 반환하는 이름을 쓰도록 교체하는 정도로 그친다.
- **팀/파트 단위 조회는 이번 스펙에 미포함** — 권한별 조회 단계에서 본격 사용.
- `DIVISION_ORDER`(`data/orgChart.ts`)는 이번엔 변경하지 않음 — 초기 적재 후 트리 최상위
  노드명이 이 상수와 실제로 일치하는지는 검증 포인트로만 남긴다(불일치 시 별도 보고).

## 리스크 / 확인 필요 사항

- 리더 이관 시 `jobTitle`을 전부 `TEAM_LEAD`로 뭉뚱그리는 부분 — 관리자 수동 검수 필요
  (본부장/파트장 구분 누락 위험).
- CAPS division/team 텍스트가 표기 흔들림(오탈자, 공백차이 등)이 있으면 트리 자동생성 시
  같은 조직이 다른 노드로 중복 생성될 수 있음 — 초기 적재 후 목록 검수 필요.
- `OrgGroupMember` 이력이 쌓이면서 특정 날짜 조회 시 겹치는 행이 생기지 않도록(겸직
  `isPrimary=false` 제외) 애플리케이션 레벨에서 "같은 그룹, 같은 시점에 validTo=null 행은
  하나"를 보장하는 로직이 필요(DB 제약으로 강제하기 어려움 — 저장 시 검증).

## 다음 단계 (이 스펙 이후)

- 팀/파트 단위 조회 UI
- 로그인/인증 + 역할별 데이터 스코프 제어("권한별 조회" 본편, [[project_tag_role_based_access_future]])
- `hasApprovalAuthority`를 실제로 쓰는 승인 워크플로 설계
