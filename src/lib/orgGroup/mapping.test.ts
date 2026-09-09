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
