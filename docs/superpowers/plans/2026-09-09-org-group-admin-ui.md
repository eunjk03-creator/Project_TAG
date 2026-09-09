# 조직도 관리 화면 (Plan 3 MVP) Implementation Plan

**Goal:** admin/settings에 "조직도 관리" 탭을 추가해 Plan 1이 이관한 실데이터(75그룹/277명)를
화면에서 보고, 하위그룹 추가/이름수정/삭제, 구성원 소속이동(드롭다운)까지 할 수 있게 한다.

**Architecture:** 신규 API 4개(`OrgGroup` CRUD + 소속이동) + 신규 탭 컴포넌트 1개. 기존
"조직도 동기화" 탭은 그대로 둔다(제거는 별도 결정). 소속이동은 Plan 1과 동일한 "기존 행
종료 + 새 행 생성" 패턴. 드래그앤드롭 없이 드롭다운으로 대체(오늘 범위 밖). 그룹 위치
재조정(parentId 변경)은 미지원 — 레퍼런스 도구도 "한번 등록하면 위치 변경 불가" 규칙.

**Spec:** `docs/superpowers/specs/2026-09-08-org-chart-tree-design.md` §4 (관리 UI) 축소판.

## Global Constraints
- Department/EmployeeMaster/ExceptionRule 안 건드림 — OrgGroup/OrgGroupMember만 다룸.
- 그룹 삭제는 자식그룹·활성 구성원이 있으면 차단.
- OT 엔진은 아직 이 데이터를 안 읽으므로(Plan 2 범위) recompute 트리거 불필요.

## 파일 구조
```
src/app/api/org-groups/route.ts             (GET 트리, POST 그룹생성)
src/app/api/org-groups/[id]/route.ts        (PATCH 이름수정, DELETE)
src/app/api/org-group-members/move/route.ts (POST 소속이동)
src/components/admin/OrgGroupManageTab.tsx  (신규 탭 UI)
src/app/admin/settings/page.tsx             (수정 — 탭 등록)
```

## Task 1: API — 트리 조회 + 그룹 생성/수정/삭제

`src/app/api/org-groups/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const groups = await prisma.orgGroup.findMany({ orderBy: [{ order: 'asc' }] })
  const members = await prisma.orgGroupMember.findMany({
    where: { validTo: null },
    include: { employee: { select: { name: true } } },
  })
  const membersByGroup = new Map<string, typeof members>()
  for (const m of members) {
    const list = membersByGroup.get(m.groupId) ?? []
    list.push(m)
    membersByGroup.set(m.groupId, list)
  }
  const result = groups.map(g => ({
    id: g.id, name: g.name, parentId: g.parentId, order: g.order,
    members: (membersByGroup.get(g.id) ?? []).map(m => ({
      id: m.id, employeeRawId: m.employeeRawId, name: m.employee.name,
      jobTitle: m.jobTitle, hasApprovalAuthority: m.hasApprovalAuthority,
    })),
  }))
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name?.trim()) return NextResponse.json({ error: '그룹명이 필요합니다.' }, { status: 400 })
  const created = await prisma.orgGroup.create({
    data: { name: body.name.trim(), parentId: body.parentId ?? null, order: body.order ?? 0 },
  })
  return NextResponse.json(created, { status: 201 })
}
```

`src/app/api/org-groups/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  if (!body.name?.trim()) return NextResponse.json({ error: '그룹명이 필요합니다.' }, { status: 400 })
  const updated = await prisma.orgGroup.update({ where: { id }, data: { name: body.name.trim() } })
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const childCount = await prisma.orgGroup.count({ where: { parentId: id } })
  if (childCount > 0) {
    return NextResponse.json({ error: `하위 그룹이 ${childCount}개 있어 삭제할 수 없습니다.` }, { status: 400 })
  }
  const memberCount = await prisma.orgGroupMember.count({ where: { groupId: id, validTo: null } })
  if (memberCount > 0) {
    return NextResponse.json({ error: `소속 인원이 ${memberCount}명 있어 삭제할 수 없습니다.` }, { status: 400 })
  }
  await prisma.orgGroup.delete({ where: { id } })
  return new NextResponse(null, { status: 204 })
}
```

## Task 2: API — 소속이동

`src/app/api/org-group-members/move/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const { employeeRawId, newGroupId } = await req.json() as { employeeRawId: string; newGroupId: string }
  if (!employeeRawId || !newGroupId) {
    return NextResponse.json({ error: 'employeeRawId, newGroupId가 필요합니다.' }, { status: 400 })
  }
  const current = await prisma.orgGroupMember.findFirst({
    where: { employeeRawId, validTo: null, isPrimary: true },
  })
  if (!current) return NextResponse.json({ error: '현재 소속 정보를 찾을 수 없습니다.' }, { status: 404 })
  if (current.groupId === newGroupId) return NextResponse.json(current)

  const now = new Date()
  const [, created] = await prisma.$transaction([
    prisma.orgGroupMember.update({ where: { id: current.id }, data: { validTo: now } }),
    prisma.orgGroupMember.create({
      data: {
        groupId: newGroupId, employeeRawId, jobTitle: current.jobTitle,
        isPrimary: true, hasApprovalAuthority: current.hasApprovalAuthority,
        validFrom: now, validTo: null,
      },
    }),
  ])
  return NextResponse.json(created)
}
```

## Task 3: UI — OrgGroupManageTab

`src/components/admin/OrgGroupManageTab.tsx` — 컬럼형 트리 대신(오늘 범위상 단순화) 들여쓰기
목록 + 클릭 시 우측에 구성원 패널. 각 그룹 행에 [+ 하위그룹][이름수정][삭제], 각 구성원 행에
직책 배지(⭐ TEAM_LEAD/PART_LEAD/DIVISION_HEAD)와 소속이동 `<select>`.

## Task 4: 탭 등록

`src/app/admin/settings/page.tsx`에 `OrgGroupManageTab` import, 사이드바에
`{ id: 'org-groups', label: '조직도 관리' }` 추가(순서: `org-sync` 다음), 렌더 분기 추가.

## 검증
- `npx tsc --noEmit` 클린
- 브라우저에서 admin/settings → 조직도 관리 탭 열어서 실데이터(75그룹/277명) 렌더 확인
- 하위그룹 추가 → 삭제 → 구성원 소속이동 한 번씩 실제로 눌러서 확인
