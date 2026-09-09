import { PrismaClient, type JobTitle } from '@prisma/client'
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
    select: { employeeId: true, validFrom: true, validTo: true },
  })
  const leaderRawIds = new Set<string>()
  // rawId -> 해당 manager_exemption 규칙의 원본 validFrom/validTo (둘 다 빈 문자열일 수 있음).
  // 확인됨: 직원당 manager_exemption 규칙은 최대 1건이라 dedup 불필요 (1:1 매핑).
  const leaderRuleDatesByRawId = new Map<string, { validFrom: string; validTo: string }>()
  const unparsedLeaderRuleIds: string[] = []
  for (const rule of leaderRules) {
    const parsed = parseExceptionRuleEmployeeId(rule.employeeId)
    if (parsed) {
      leaderRawIds.add(parsed.rawId)
      leaderRuleDatesByRawId.set(parsed.rawId, { validFrom: rule.validFrom, validTo: rule.validTo })
    } else {
      unparsedLeaderRuleIds.push(rule.employeeId)
    }
  }

  const membersToCreate: {
    rawId: string
    groupKey: string
    jobTitle: string
    validFrom: Date
    validTo: Date | null
  }[] = []
  const unassigned: string[] = []
  const employeeRawIds = new Set(employees.map(e => e.rawId))

  for (const emp of employees) {
    if (!emp.departmentId) { unassigned.push(emp.rawId); continue }
    const dept = deptById.get(emp.departmentId)
    if (!dept) { unassigned.push(emp.rawId); continue }
    const groupKey = dept.team ? `${dept.division}::${dept.team}` : dept.division
    const jobTitle = resolveInitialJobTitle(emp.jobTitle, leaderRawIds.has(emp.rawId))

    const leaderRuleDates = leaderRuleDatesByRawId.get(emp.rawId)
    let validFrom: Date
    let validTo: Date | null
    if (leaderRuleDates) {
      // 매칭되는 manager_exemption 리더 규칙의 발령/해임일을 그대로 승계 (빈 문자열은 "지정 없음"으로 취급).
      validFrom = parseValidFrom(leaderRuleDates.validFrom, FALLBACK_VALID_FROM)
      const trimmedValidTo = leaderRuleDates.validTo.trim()
      validTo = trimmedValidTo.length > 0 ? new Date(trimmedValidTo) : null
    } else {
      validFrom = parseValidFrom(emp.hireDate, FALLBACK_VALID_FROM)
      validTo = null
    }
    membersToCreate.push({ rawId: emp.rawId, groupKey, jobTitle, validFrom, validTo })
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
  const [existingGroupCount, existingMemberCount] = await Promise.all([
    prisma.orgGroup.count(),
    prisma.orgGroupMember.count(),
  ])
  if (existingGroupCount > 0 || existingMemberCount > 0) {
    throw new Error(
      `이 스크립트는 1회성 이관 스크립트입니다. 이미 OrgGroup ${existingGroupCount}건, `
      + `OrgGroupMember ${existingMemberCount}건이 존재합니다. 재실행이 정말 필요하면 `
      + '먼저 두 테이블(org_groups, org_group_members)을 모두 비운 뒤 다시 실행하세요.',
    )
  }

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
          jobTitle: member.jobTitle as JobTitle,
          isPrimary: true,
          hasApprovalAuthority: false,
          validFrom: member.validFrom,
          validTo: member.validTo,
        },
      })
    }
  }, { timeout: 120_000 })
  console.log('완료.')
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
