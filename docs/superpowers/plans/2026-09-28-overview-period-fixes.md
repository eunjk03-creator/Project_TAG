# 경영진 현황 기간 기준 수정 (일요일 주 단위 + 다이제스트 버그 3건) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/overview` 대시보드의 "주" 정의를 월요일 시작에서 일요일 시작으로 바꾸고, 복수
기간 선택 시 다이제스트 기준일자가 갱신 안 되는 버그를 고치고, 일 단위 복수선택 카드를
날짜별 나열 대신 합산 카운트로 단순화한다.

**Architecture:** 주 경계(월요일→일요일) 계산 로직이 이 저장소 8개 파일에 각자 복제돼 있어서,
먼저 순수 함수 모듈(`src/utils/weekBoundary.ts`)을 신설해 `node:test`로 검증한 뒤(Task 1),
그 8개 파일을 전부 이 모듈을 참조하도록 마이그레이션한다(Task 2). 이후 다이제스트 기준일자
버그(Task 3)와 일 단위 카드 단순화(Task 4)는 Task 1/2와 독립적으로 진행 가능하지만, 최종
검증(Task 5)은 Task 1/2가 끝난 뒤에 해야 "주" 개념이 실제로 일요일 기준인지 확인할 수 있다.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19. 이 저장소엔 vitest/jest가 없고
Node.js 내장 테스트 러너(`node:test`/`node:assert`)를 `npx tsx --test`로 돌리는 관례만 있다
(`src/lib/orgGroup/*.test.ts` 참고) — 새 순수 함수(Task 1)는 이 방식으로 테스트하고, 나머지
UI 통합 변경은 `npx tsc --noEmit` 전체 타입체크 + `npm run dev` 수동 스모크로 검증한다.

**Spec:** 별도 스펙 문서 없음 — 2026-09-28 대화에서 사용자가 직접 준 4개 요구사항을 그대로
반영한다(아래 Global Constraints의 "새 주 시작일 규칙" 참고).

## Global Constraints

- **범위: Next.js 대시보드(`tag-attendance/src`)만.** `gas/` 폴더(급여 정산 엔진)는 이번
  변경에서 완전히 제외한다 — 급여 실지급액에 영향을 줄 수 있어 사용자가 명시적으로 제외를
  확정함(2026-09-28).
- **월 단위 "4주 평균 52시간 초과자" 신규 기능은 이번 라운드에서 보류.** (사용자 확정) 이
  플랜은 그 기능을 만들지 않는다.
- `overviewAggregations.ts`의 `buildWeeklyAnomalySeries`(월간 "N주차 이상치 추이" 차트)가
  쓰는 로컬 `weekOfMonth`/`mondayBasedDow`는 **이번 변경 대상에서 제외**한다 — 이건 실제
  7일 단위 주가 아니라 "월 달력 그리드에서 몇 번째 줄인가"를 구하는 별개 알고리즘이라(모든
  날짜가 빠짐없이 어떤 주차엔가는 배정돼야 함), 일요일 기준으로 바꾸면 월초 며칠이 전달
  주차로 빠지는 시각적 변화가 생긴다 — 사용자가 요청한 4개 항목에 없으므로 손대지 않는다.
- `src/components/admin/WeeklySwitcher.tsx`는 어디서도 import되지 않는 죽은 코드로
  확인됨(`grep`) — 이번 마이그레이션 대상에서 제외한다(고칠 필요도, 고쳐서 얻을 것도 없음).
- **새 주 시작일 규칙(모든 Task가 이 규칙을 따른다):** 일요일이 그 주의 시작이다. 그 주는
  "시작일(일요일)이 속한 달"의 몇 번째 일요일인지로 주차 라벨을 매긴다 — 예: 10/3이
  일요일이면 그 주(10/3~10/9)는 "10월 1주차". 그 달의 첫 일요일 이전 날짜(예: 10/1~10/2)는
  전달 마지막 주에 속한다.

---

## 파일 구조

```
src/utils/weekBoundary.ts                        (신규 — weekStart/weekOfMonth/weekMonthNumber 순수 함수, 전역 단일 소스)
src/utils/weekBoundary.test.ts                    (신규 — node:test)
src/hooks/usePeriodRange.ts                       (수정 — 로컬 weekStart 삭제, import로 교체)
src/hooks/useManagementMetrics.ts                 (수정 — getWeekMonday 삭제, import로 교체)
src/components/admin/DateRangePicker.tsx          (수정 — weekMonday/weekOfMonth 로컬 정의 삭제, import로 교체)
src/components/admin/overview/PeriodMultiPicker.tsx (수정 — 동일)
src/components/admin/EmployeeCalendarGrid.tsx     (수정 — weekKey 로컬 정의 삭제, import로 교체)
src/utils/deptReportExcel.ts                      (수정 — UTC weekStart 로컬 정의 삭제, import로 교체)
src/utils/statusSlidePptx.ts                      (수정 — weekMonday 로컬 정의 삭제, import로 교체)
src/components/admin/AttendanceResultTable.tsx    (수정 — weekStartUTC 로컬 정의 삭제, import로 교체)
src/utils/buildAttendanceDigestMarkdown.ts        (수정 — DailyDigestInput.date → dateLabel, dowLabel 제거)
src/app/admin/overview/page.tsx                   (수정 — 다이제스트 라벨 계산, buildDayCard 단순화, weekStart import 경로 변경)
```

---

## Task 1: `weekBoundary.ts` 공용 유틸 신설 (일요일 시작)

**Files:**
- Create: `src/utils/weekBoundary.ts`
- Test: `src/utils/weekBoundary.test.ts`

**Interfaces:**
- Produces: `weekStart(dateStr: string): string` — dateStr(YYYY-MM-DD)이 속한 주의 시작일(일요일)을 YYYY-MM-DD로 반환.
- Produces: `weekOfMonth(dateStr: string): number` — 그 주(일요일 시작)가 시작일 기준 그 달의 몇 번째 일요일인지(1-based).
- Produces: `weekMonthNumber(dateStr: string): number` — 그 주가 속한 달(1-12, 시작일=일요일 기준).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/utils/weekBoundary.test.ts`:

```ts
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
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npx tsx --test src/utils/weekBoundary.test.ts`
Expected: FAIL (모듈이 아직 없어서 import 에러)

- [ ] **Step 3: 구현**

`src/utils/weekBoundary.ts`:

```ts
/**
 * 주(Week) 경계 계산 — 일요일 시작. 대시보드 전역에서 "이번 주" 개념을 쓰는 모든 곳
 * (기간 선택기, 다중선택 캘린더, 52시간 위험군 집계, 엑셀/PPT 리포트, 직원 캘린더 그리드)이
 * 공유하는 단일 소스 — 과거엔 이 로직이 8곳에 각자 복제되어 있었다(2026-09-28 통합).
 * 여기 말고 로컬로 주 경계를 다시 계산하지 말 것.
 */

/** dateStr(YYYY-MM-DD)이 속한 주의 시작일(일요일)을 YYYY-MM-DD로 반환. */
export function weekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - d.getDay()) // getDay(): 0 = Sun, 그대로 빼면 그 주의 일요일
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 그 주(일요일 시작)가 시작일 기준으로 그 달의 몇 번째 일요일인지(1-based).
 *  예: 10/3이 일요일이면 그 주는 "10월 1주차". 월 첫 일요일 이전 날짜는 전달 마지막 주에 속함. */
export function weekOfMonth(dateStr: string): number {
  const sunday = weekStart(dateStr)
  const day = Number(sunday.slice(8, 10))
  return Math.ceil(day / 7)
}

/** 그 주(일요일 시작)가 속한 달(1-12) — weekOfMonth와 짝을 이뤄 "10월1주" 라벨을 만들 때 씀. */
export function weekMonthNumber(dateStr: string): number {
  return Number(weekStart(dateStr).slice(5, 7))
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npx tsx --test src/utils/weekBoundary.test.ts`
Expected: PASS (5개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add src/utils/weekBoundary.ts src/utils/weekBoundary.test.ts
git commit -m "feat: add shared Sunday-start week boundary util"
```

---

## Task 2: 8개 파일을 공용 유틸로 마이그레이션 (월요일 → 일요일)

**Files:**
- Modify: `src/hooks/usePeriodRange.ts:32-39`
- Modify: `src/hooks/useManagementMetrics.ts:72-83,166-167`
- Modify: `src/components/admin/DateRangePicker.tsx:18-26,32,34,40`
- Modify: `src/components/admin/overview/PeriodMultiPicker.tsx:18-26,32,34,40`
- Modify: `src/components/admin/EmployeeCalendarGrid.tsx:367-373,382`
- Modify: `src/utils/deptReportExcel.ts:107-113,249`
- Modify: `src/utils/statusSlidePptx.ts:73-78,367`
- Modify: `src/components/admin/AttendanceResultTable.tsx:128-135`
- Modify: `src/app/admin/overview/page.tsx:14` (weekStart import 출처 변경)

**Interfaces:**
- Consumes: Task 1의 `weekStart(dateStr: string): string`, `weekOfMonth(dateStr: string): number` from `@/utils/weekBoundary`.

이 8개 파일은 전부 같은 패턴(로컬 `weekMonday`/`getWeekMonday`/`weekStart` 함수가 "월요일까지
며칠 되돌아갈지"를 계산 → 공용 유틸 import로 교체)이라 하나의 태스크로 묶는다. 각 파일의
로컬 필드명(`monday`, `sunday` 등)은 이번에 리네이밍하지 않는다 — 실제 버그는 "어느 요일을
기준으로 삼는가"이지 변수 이름이 아니고, `WeekInfo.monday`/JSX의 `data-monday` 등을 전부
바꾸면 이번 변경과 무관한 디프가 커진다.

- [ ] **Step 1: `usePeriodRange.ts` — 로컬 weekStart 삭제**

Before (`src/hooks/usePeriodRange.ts:32-39`):
```ts
/** Monday of the week containing dateStr. */
export function weekStart(dateStr: string): string {
  const d   = toDate(dateStr)
  const dow = d.getDay() // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1
  d.setDate(d.getDate() - back)
  return fromDate(d)
}
```

After: 이 함수 전체를 삭제하고, 파일 상단 import에 `import { weekStart } from '@/utils/weekBoundary'`
를 추가한다. 파일 내부 사용처(`const mon = weekStart(refDate)`, line 82)는 그대로 동작한다.
이 함수는 더 이상 `export`되지 않으므로, 이 훅을 import하는 곳(`page.tsx`)에서 `weekStart`를
더 이상 가져올 수 없다 — Step 9에서 그 import를 `@/utils/weekBoundary`로 옮긴다.

- [ ] **Step 2: `useManagementMetrics.ts` — getWeekMonday 삭제**

Before (`src/hooks/useManagementMetrics.ts:72-83`):
```ts
/** Returns the ISO date string for the Monday of the week containing `dateStr`. */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  const dow  = d.getDay()                  // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1     // days back to Monday
  d.setDate(d.getDate() - back)
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  )
}
```

After: 함수 삭제, 파일 상단에 `import { weekStart } from '@/utils/weekBoundary'` 추가.

Before (`src/hooks/useManagementMetrics.ts:166-167`):
```ts
    // Weekly hours: Mon of toDate's week → toDate, inclusive
    const weekMonday = getWeekMonday(toDate)
```

After:
```ts
    // Weekly hours: Sun of toDate's week → toDate, inclusive
    const weekMonday = weekStart(toDate)
```

(변수명 `weekMonday`는 아래 `weeklyHoursMap` 루프에서 여러 번 참조되므로 이름은 그대로 두고
값의 의미만 바뀐다 — 변수명까지 정리하려면 아래 두 줄도 함께 바뀌어야 하니 원하면 이 스텝에서
`weekStartDate`로 리네이밍해도 되지만 필수는 아니다.)

- [ ] **Step 3: `DateRangePicker.tsx` — 로컬 weekMonday/weekOfMonth 삭제**

Before (`src/components/admin/DateRangePicker.tsx:18-26`):
```ts
function weekMonday(s: string): string {
  const d = new Date(s + 'T12:00:00')
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return toDS(d)
}
function weekOfMonth(monday: string): number {
  return Math.ceil(new Date(monday + 'T12:00:00').getDate() / 7)
}
```

After: 두 함수 삭제, 상단에
`import { weekStart as weekMonday, weekOfMonth, weekMonthNumber } from '@/utils/weekBoundary'`
추가(`as weekMonday` 별칭은 파일 내부 나머지 호출부 3곳 — line 32, 34, 40 — 을 안 바꾸고
그대로 쓰기 위함). `toDS`/`addDays` 등 다른 헬퍼는 그대로 둔다.

추가로 `buildWeeks` 안의 아래 줄(line 39)도 같이 바꾼다 — `weekMonthNumber`를 새로 만들어놓고
아무도 안 쓰면 리뷰에서 "안 쓰는 export" 지적을 받을 것이므로, 이미 있던 인라인 month 계산을
그걸로 교체해 하나로 합친다:

Before:
```ts
      month:  new Date(mon + 'T12:00:00').getMonth() + 1,
```
After:
```ts
      month:  weekMonthNumber(mon),
```

- [ ] **Step 4: `PeriodMultiPicker.tsx` — 동일 패턴**

Before (`src/components/admin/overview/PeriodMultiPicker.tsx:18-26`): DateRangePicker.tsx와
완전히 동일한 코드.

After: 동일하게
`import { weekStart as weekMonday, weekOfMonth, weekMonthNumber } from '@/utils/weekBoundary'`로
교체. `buildWeeks`(line 39, DateRangePicker.tsx와 동일한 위치)의
`month: new Date(mon + 'T12:00:00').getMonth() + 1,`도 Step 3과 동일하게
`month: weekMonthNumber(mon),`로 바꾼다.

- [ ] **Step 5: `EmployeeCalendarGrid.tsx` — weekKey 교체**

Before (`src/components/admin/EmployeeCalendarGrid.tsx:367-373`):
```ts
    function weekKey(dateStr: string): string {
      const d = new Date(dateStr + 'T12:00')
      const dow  = d.getDay()
      const back = dow === 0 ? 6 : dow - 1
      d.setDate(d.getDate() - back)
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    }
```

After: 이 로컬 함수를 삭제하고 파일 상단에 `import { weekStart } from '@/utils/weekBoundary'`를
추가한 뒤, 아래 호출부(line 382)를 `const wk = weekStart(r.date)`로 바꾼다. 이 파일은
"52시간 이상 주가 있는 직원만 필터"하는 그리드 화면 로직이라(line 385 `weekTotals[...] >= 52`),
개요 페이지의 주간 위험군 집계와 같은 "주" 정의를 쓰게 되어 두 화면이 이제 일치한다.

- [ ] **Step 6: `deptReportExcel.ts` — UTC weekStart 교체**

Before (`src/utils/deptReportExcel.ts:107-113`):
```ts
// ── 주간 시작일 (월요일) ──────────────────────────────────────────────────────

function weekStart(dateStr: string): string {
  const d   = new Date(dateStr + 'T00:00:00Z')
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}
```

After: 함수 삭제, 상단에 `import { weekStart } from '@/utils/weekBoundary'` 추가. 한국은
DST가 없어 UTC 자정 앵커와 로컬 정오 앵커가 날짜 계산 결과에 차이를 만들지 않으므로 안전한
교체다. 섹션 주석은 `// ── 주간 시작일 (일요일) ──` 로 갱신한다.

- [ ] **Step 7: `statusSlidePptx.ts` — weekMonday 교체**

Before (`src/utils/statusSlidePptx.ts:73-78`):
```ts
function weekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00')
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
```

After: 함수 삭제, `import { weekStart as weekMonday } from '@/utils/weekBoundary'` 추가(호출부
line 367 `const wk = weekMonday(r.date)`는 그대로 유지).

- [ ] **Step 8: `AttendanceResultTable.tsx` — weekStartUTC 교체**

Before (`src/components/admin/AttendanceResultTable.tsx:128-135`):
```ts
function weekStartUTC(dateStr: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dt  = new Date(Date.UTC(y, mo - 1, d))
  const mon = new Date(dt.getTime() + (dt.getUTCDay() === 0 ? -6 : 1 - dt.getUTCDay()) * 86_400_000)
  return mon.getUTCFullYear() + '-' +
    String(mon.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(mon.getUTCDate()).padStart(2, '0')
}
```

After: 함수 삭제, `import { weekStart as weekStartUTC } from '@/utils/weekBoundary'` 추가
(호출부 이름은 유지, 값의 의미만 일요일 기준으로 바뀜).

- [ ] **Step 9: `page.tsx` — weekStart import 출처 변경**

Before (`src/app/admin/overview/page.tsx:14`):
```ts
import { usePeriodRange, weekStart, monthStart } from '@/hooks/usePeriodRange'
```

After:
```ts
import { usePeriodRange, monthStart } from '@/hooks/usePeriodRange'
import { weekStart } from '@/utils/weekBoundary'
```

(`monthStart`는 이번 변경과 무관하므로 `usePeriodRange.ts`에 그대로 둔다. `weekStart` 사용처
— line 445 `repeatWindowFrom = ... weekStart(period.from) ...` — 는 import만 바뀌고 동작은
자동으로 일요일 기준이 된다.)

- [ ] **Step 10: 전체 타입체크**

Run: `npx tsc --noEmit -p .`
Expected: 에러 없음(0 output)

- [ ] **Step 11: 수동 스모크 테스트**

Run: `npm run dev`, `/admin/overview` 접속 → 주 단위 탭에서 기간 선택기를 눌러 이번 주 범위가
일요일~토요일로 표시되는지, `PeriodMultiPicker`의 "주별" 목록 버튼 라벨(`N월M주`)이 일요일
기준으로 바뀌었는지 확인. `/admin` 그리드 화면에서 `DateRangePicker`도 동일하게 확인.

- [ ] **Step 12: 커밋**

```bash
git add src/hooks/usePeriodRange.ts src/hooks/useManagementMetrics.ts \
  src/components/admin/DateRangePicker.tsx src/components/admin/overview/PeriodMultiPicker.tsx \
  src/components/admin/EmployeeCalendarGrid.tsx src/utils/deptReportExcel.ts \
  src/utils/statusSlidePptx.ts src/components/admin/AttendanceResultTable.tsx \
  src/app/admin/overview/page.tsx
git commit -m "refactor: migrate week-start calculations to Sunday via shared util"
```

---

## Task 3: 복수 기간 선택 시 다이제스트 기준일자 버그 수정

**Files:**
- Modify: `src/utils/buildAttendanceDigestMarkdown.ts:45-68` (`DailyDigestInput.date` → `dateLabel`)
- Modify: `src/app/admin/overview/page.tsx:~985-1034` (라벨 계산 추가, 호출부 필드명 변경)

**Interfaces:**
- Consumes: `DateRange` type from `@/types/tag`(이미 page.tsx가 import), `activeBlocks: DateRange[]`(page.tsx에 이미 존재, line 188).
- Produces: `DailyDigestInput.dateLabel: string`(기존 `date: string` 필드 대체) — 다른 digest input 타입은 안 바뀜.

**버그 원인:** `buildDailyDigestMarkdown`은 `date: period.from`만 받는데, `period.from`은
"기준 날짜 1개"(`usePeriodRange` 훅의 refDate)이지 `PeriodMultiPicker`로 고른 여러 블록
(`activeBlocks`)을 반영하지 않는다 — 그래서 날짜를 여러 개 골라도 제목엔 항상 첫 기준일만
찍힌다. 복수 선택 기능 자체(`activeBlocks`, `PeriodMultiPicker`)는 그대로 유지하고, 표시
라벨만 `activeBlocks` 기준으로 고친다.

- [ ] **Step 1: `DailyDigestInput.date` → `dateLabel`로 교체**

Before (`src/utils/buildAttendanceDigestMarkdown.ts:45-68`):
```ts
export interface DailyDigestInput {
  scopeDivision: string | null
  date: string          // YYYY-MM-DD
  attendancePct: number
  vsTargetPct: number
  vsPrevPct: number | null
  normalCount: number
  anomalyTotal: number
  anomalyLate: number
  anomalyShortage: number
  anomalyNotag: number
  leaveCount: number
  offsiteCount: number
  /** scopeDivision === null일 때만 사용 — 부문 비교 TOP3 */
  topDivisions: { label: string; value: number; unit: string }[]
  /** scopeDivision이 있을 때만 사용 — 그 부문의 이상치 있는 개인 전원(캡 없음) */
  anomalyPeople: AnomalyPersonDetail[]
  repeatOffenders: { name: string; division: string; late: number; shortage: number; notag: number }[]
}

export function buildDailyDigestMarkdown(d: DailyDigestInput): string {
  const title = d.scopeDivision
    ? `*📊 일일 근태 요약 — ${d.scopeDivision} (${d.date} ${dowLabel(d.date)})*`
    : `*📊 일일 근태 요약 (${d.date} ${dowLabel(d.date)})*`
```

After:
```ts
export interface DailyDigestInput {
  scopeDivision: string | null
  /** 이미 포맷된 기준일자 라벨 — 단일 선택이면 "9월 16일 (화)", 복수 선택이면
   *  호출부(overview 페이지)가 activeBlocks 기준으로 만들어서 넘긴다. */
  dateLabel: string
  attendancePct: number
  vsTargetPct: number
  vsPrevPct: number | null
  normalCount: number
  anomalyTotal: number
  anomalyLate: number
  anomalyShortage: number
  anomalyNotag: number
  leaveCount: number
  offsiteCount: number
  /** scopeDivision === null일 때만 사용 — 부문 비교 TOP3 */
  topDivisions: { label: string; value: number; unit: string }[]
  /** scopeDivision이 있을 때만 사용 — 그 부문의 이상치 있는 개인 전원(캡 없음) */
  anomalyPeople: AnomalyPersonDetail[]
  repeatOffenders: { name: string; division: string; late: number; shortage: number; notag: number }[]
}

export function buildDailyDigestMarkdown(d: DailyDigestInput): string {
  const title = d.scopeDivision
    ? `*📊 일일 근태 요약 — ${d.scopeDivision} (${d.dateLabel})*`
    : `*📊 일일 근태 요약 (${d.dateLabel})*`
```

이제 `dowLabel`/`DOW_KR`(파일 상단 lines 11-15)이 이 파일 안에서 더 이상 안 쓰이므로 같이
삭제한다.

- [ ] **Step 2: page.tsx — 라벨 계산 함수 추가 + 호출부 수정**

`page.tsx`의 `digestMarkdown` useMemo 바로 위(현재 `const digestTitle = ...` 근처)에 헬퍼
2개를 추가한다:

```ts
const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']
function fmtDigestDate(ds: string): string {
  const d = new Date(ds + 'T12:00:00')
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`
}
/** 일 단위 다이제스트 제목용 — 단일 선택이면 그 날짜, 복수 선택이면 첫 날짜 + 개수. */
function formatDigestDateLabel(blocks: DateRange[]): string {
  const sorted = [...blocks].sort((a, b) => a.from.localeCompare(b.from))
  return sorted.length === 1
    ? fmtDigestDate(sorted[0].from)
    : `${fmtDigestDate(sorted[0].from)} 외 ${sorted.length - 1}일`
}
/** 주 단위 다이제스트 제목용 — 단일 선택이면 그 주 범위, 복수 선택이면 범위 + 개수. */
function formatDigestPeriodLabel(blocks: DateRange[]): string {
  const sorted = [...blocks].sort((a, b) => a.from.localeCompare(b.from))
  return sorted.length === 1
    ? `${sorted[0].from} ~ ${sorted[0].to}`
    : `${sorted[0].from} ~ ${sorted[sorted.length - 1].to} (${sorted.length}개 구간)`
}
```

Before (`src/app/admin/overview/page.tsx` — 일간 다이제스트 호출부):
```ts
      return buildDailyDigestMarkdown({
        scopeDivision: selectedDivision,
        date: period.from,
        attendancePct: normalRate.pct,
```

After:
```ts
      return buildDailyDigestMarkdown({
        scopeDivision: selectedDivision,
        dateLabel: formatDigestDateLabel(activeBlocks),
        attendancePct: normalRate.pct,
```

Before (주간 다이제스트 호출부):
```ts
      return buildWeeklyDigestMarkdown({
        scopeDivision: selectedDivision,
        periodLabel: period.label,
```

After:
```ts
      return buildWeeklyDigestMarkdown({
        scopeDivision: selectedDivision,
        periodLabel: formatDigestPeriodLabel(activeBlocks),
```

(`WeeklyDigestInput.periodLabel`은 타입이 이미 `string`이라 인터페이스 변경 없이 호출부만
바뀐다.)

- [ ] **Step 3: 타입체크**

Run: `npx tsc --noEmit -p .`
Expected: 에러 없음

- [ ] **Step 4: 수동 스모크 테스트**

`/admin/overview`에서 일 단위로 날짜 2개를 복수 선택 → 다이제스트 미리보기 제목이
"9월16일 외 1일" 식으로 바뀌는지 확인. 주 단위에서 주 2개를 복수 선택 → 제목이
"YYYY-MM-DD ~ YYYY-MM-DD (2개 구간)" 식으로 바뀌는지 확인. 단일 선택으로 되돌리면 기존과
동일한 표시(날짜 1개/주 1개 범위)로 돌아오는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add src/utils/buildAttendanceDigestMarkdown.ts src/app/admin/overview/page.tsx
git commit -m "fix: digest date label reflect multi-block period selection"
```

---

## Task 4: 일 단위 복수 선택 시 이상치 카드를 합산 카운트로 단순화

**Files:**
- Modify: `src/app/admin/overview/page.tsx:701-751` (`buildDayCard` 함수), 상단 import(`flagToAnomalyCategories`)

**Interfaces:**
- Consumes: 기존 `empAnomaly`(`buildEmployeeAnomalyRollup` 결과, 이미 page.tsx에 있음), `anomaly.total`.
- Produces: 변경 없음 — `DeptCardVM.rows`의 내용만 달라짐(날짜별 행 → 인원별 합산 행).

2026-09-08에 "여러 날짜 합쳐 볼 때 어느 날 발생했는지 구분이 안 된다"는 피드백으로 날짜별
행 분해 로직이 추가됐는데, 이번엔 반대로 "그냥 합산 건수만 보이면 된다"는 요청이라 그 분기를
제거하고 원래(단일 선택과 동일한) 합산 로직 하나로 통일한다.

- [ ] **Step 1: `buildDayCard`의 분기 제거**

Before (`src/app/admin/overview/page.tsx:701-734`, 함수 앞부분은 그대로 두고 rows 계산부만):
```ts
    // 여러 날짜를 합쳐서 볼 땐(activeBlocks 2개 이상) 인원별 합산 집계 대신 "언제 발생했는지"를
    // 알 수 있게 발생 건별(직원+날짜) 행으로 풀어서 보여준다 — 합산 카운트만 있으면 여러 날짜
    // 중 어느 날 일어난 건지 구분이 안 된다는 피드백(2026-09-08). 1개만 선택된 기존 상태는
    // 하루뿐이라 애초에 구분할 필요가 없어 그대로 유지(동일 결과, 회귀 없음).
    const rows: DeptCardPersonRow[] = []
    if (activeBlocks.length > 1) {
      const divOccurrences = scopedRecords.filter(r => r.flag && empMap.get(r.employeeId)?.division === m.division)
      for (const r of divOccurrences) {
        const emp  = empMap.get(r.employeeId)
        const cats = new Set(flagToAnomalyCategories(r.flag!))
        rows.push({
          key: `${r.employeeId}_${r.date}`, name: emp?.name ?? r.employeeId, date: r.date,
          cols: [cats.has('late') ? '●' : '—', cats.has('shortage') ? '●' : '—', cats.has('notag') ? '●' : '—'],
        })
      }
      rows.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    } else {
      const people = empAnomaly.filter(r => r.division === m.division)
      let budget = anomaly.total
      for (const p of people) {
        if (budget <= 0) break
        rows.push({ key: p.key, name: p.label, cols: [p.late || '—', p.shortage || '—', p.notag || '—'] })
        budget -= p.total
      }
    }
```

After:
```ts
    // 복수 날짜를 합쳐서 볼 때도(activeBlocks 2개 이상) 날짜별로 풀지 않고 인원별 합산
    // 카운트만 보여준다 — 2026-09-08엔 날짜별로 풀어달라는 요청이었으나, 2026-09-28에
    // "선택 기간 총 발생 횟수만 보이면 된다"는 반대 요청으로 되돌림. empAnomaly가 이미
    // scopedRecords(activeBlocks로 필터된 전체)를 인원별로 합산해두므로 단일/복수 선택
    // 구분 없이 이 로직 하나로 충분하다.
    const rows: DeptCardPersonRow[] = []
    const people = empAnomaly.filter(r => r.division === m.division)
    let budget = anomaly.total
    for (const p of people) {
      if (budget <= 0) break
      rows.push({ key: p.key, name: p.label, cols: [p.late || '—', p.shortage || '—', p.notag || '—'] })
      budget -= p.total
    }
```

- [ ] **Step 2: 이제 안 쓰는 import 제거**

Before (`src/app/admin/overview/page.tsx:16`):
```ts
import { flagToAnomalyCategories } from '@/utils/attendanceCalc'
```

After: 이 줄 삭제(`flagToAnomalyCategories`가 page.tsx 안에서 더 이상 쓰이지 않음 — 삭제
전에 `grep -n "flagToAnomalyCategories" src/app/admin/overview/page.tsx`로 다른 사용처가
없는지 한 번 더 확인할 것).

- [ ] **Step 3: 타입체크**

Run: `npx tsc --noEmit -p .`
Expected: 에러 없음

- [ ] **Step 4: 수동 스모크 테스트**

`/admin/overview` 일 단위에서 날짜 2~3개 복수 선택 → 부서 카드 목록에 사람당 한 줄씩,
지각/미달/미태깅 합산 건수로 뜨는지(날짜별로 여러 줄 안 뜨는지) 확인. 단일 날짜 선택으로
되돌리면 기존과 동일하게 보이는지(회귀 없음) 확인.

- [ ] **Step 5: 커밋**

```bash
git add src/app/admin/overview/page.tsx
git commit -m "simplify: day-view multi-select anomaly rows back to per-person totals"
```

---

## Task 5: 주 단위 52시간(인정근무시간) 노출 검증 + 캡션 보강

**Files:**
- Modify: `src/app/admin/overview/page.tsx:772-773` (`buildWeekOvertimeCard` 캡션 텍스트만)

**이미 구현되어 있음 — 코드 로직 변경 없음.** `computeWeeklyRiskBuckets`
(`src/utils/overviewAggregations.ts:435-468`)가 이미 `computeDailyRecognizedHours`(인정근무
시간, credit/backtrack 반영)로 45h/50h/52h 밴드를 계산하고 있고, Task 1/2가 끝나면 그 집계에
들어가는 "주" 자체가 일요일 기준으로 자동 교정된다. 이 태스크는 재계산 로직을 새로 만드는 게
아니라 (a) 그 사실을 확인하고 (b) 화면 카피에 "인정근무시간 기준"임을 명시해 눈으로도 바로
확인되게 하는 것만 한다.

- [ ] **Step 1: 계산 근거 재확인**

`grep -n "computeDailyRecognizedHours" src/utils/overviewAggregations.ts`로
`computeWeeklyRiskBuckets`가 여전히 이 함수(원시 clockIn/clockOut이 아니라 인정근무시간)를
쓰고 있는지 확인. (Task 1/2에서 이 함수는 건드리지 않으므로 통과할 것으로 예상 — 만약 이
grep이 비어 있거나 다른 함수를 쓰고 있다면 이 태스크를 멈추고 원인을 먼저 파악할 것.)

- [ ] **Step 2: 캡션에 "인정근무시간" 명시**

Before (`src/app/admin/overview/page.tsx:772-773`):
```ts
      progressPct: (weeklyOtAvg / 20) * 100, progressMarkerPct: (policy.weeklyOtActionH / 20) * 100,
      captionLeft: `주당 평균 ${fmtH(weeklyOtAvg)}`, captionRight: `기준 ${policy.weeklyOtActionH}h`,
```

After:
```ts
      progressPct: (weeklyOtAvg / 20) * 100, progressMarkerPct: (policy.weeklyOtActionH / 20) * 100,
      captionLeft: `주당 평균 ${fmtH(weeklyOtAvg)}`, captionRight: `기준 ${policy.weeklyOtActionH}h(인정근무시간)`,
```

- [ ] **Step 3: 타입체크 + 스모크**

Run: `npx tsc --noEmit -p .` → 에러 없음. `/admin/overview` 주 단위 탭에서 부서 카드
캡션 우측에 "기준 12h(인정근무시간)"처럼 표기되는지 확인.

- [ ] **Step 4: 커밋**

```bash
git add src/app/admin/overview/page.tsx
git commit -m "docs: clarify weekly OT card uses recognized hours"
```

---

## Self-Review 요약

- **Spec coverage:** 사용자 4개 항목(일요일 주 시작 / 다이제스트 기준일자 버그 / 주 단위
  52h 인정근무시간 노출 / 일 단위 복수선택 단순화) → 각각 Task 1+2, Task 3, Task 5, Task 4로
  매핑됨. 보류하기로 한 "월 4주 평균" 항목은 이 플랜에 없음(의도적).
- **Placeholder scan:** 없음 — 모든 스텝에 실제 코드/명령어 포함.
- **Type consistency:** `DailyDigestInput.dateLabel`(Task 3)이 `page.tsx` 호출부와 일치,
  `weekBoundary.ts`의 세 함수 시그니처가 Task 2의 모든 import 문과 일치함을 확인함.
