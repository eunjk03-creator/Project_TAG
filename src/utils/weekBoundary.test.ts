import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekStart, weekOfMonth, weekMonthNumber } from './weekBoundary'

// 2026-01-01은 목요일 → 1/4(일)이 1월 첫 일요일. 2월 1일도 일요일(2026-02-01),
// 2월은 28일(2026은 평년)이라 3/1도 일요일, 3월은 31일이라 3/29도 일요일.
// 아래 날짜들은 전부 이 사실에서 손으로 계산해 검증한 값이다.

test('weekStart: 일요일 자기 자신은 그대로', () => {
  assert.equal(weekStart('2026-02-01'), '2026-02-01')
})

test('weekStart: 수요일은 그 주의 일요일로', () => {
  assert.equal(weekStart('2026-01-07'), '2026-01-04') // 1/7(수) → 1/4(일)
})

test('weekStart: 월 마지막 주 토요일도 그 주의 일요일로', () => {
  assert.equal(weekStart('2026-01-31'), '2026-01-25') // 1/31(토) → 1/25(일)
})

test('weekOfMonth/weekMonthNumber: 그 주 일요일이 속한 달의 몇 번째 일요일인지', () => {
  assert.equal(weekOfMonth('2026-02-01'), 1)      // 2/1(일) 자체가 2월 첫 일요일
  assert.equal(weekMonthNumber('2026-02-01'), 2)
})

test('weekOfMonth: 월 첫 일요일 이전 날짜는 전달 마지막 주로 귀속', () => {
  // 2026-04-01(수)이 속한 주의 일요일은 2026-03-29(3월) — 4월 1주차가 아니라 3월 5주차.
  assert.equal(weekStart('2026-04-01'), '2026-03-29')
  assert.equal(weekOfMonth('2026-04-01'), 5)
  assert.equal(weekMonthNumber('2026-04-01'), 3)
})

test('weekOfMonth: 그 달의 진짜 1주차는 그 달의 첫 일요일부터', () => {
  assert.equal(weekOfMonth('2026-04-05'), 1)   // 4/5(일) = 4월 첫 일요일
  assert.equal(weekMonthNumber('2026-04-05'), 4)
})
