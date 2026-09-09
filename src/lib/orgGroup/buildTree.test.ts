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
