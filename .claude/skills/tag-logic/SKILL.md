---
name: tag-logic
description: T.A.G.(project_TAG) 근태 대시보드의 계산 로직/데이터 흐름을 정리한 구현 레퍼런스. "총근로 왜 이렇게 나와", "OT 계산", "연장/야간/휴일 집계", "이 숫자가 다른 화면이랑 달라요", "credit/backtrack", 대시보드 버그 조사·수정 시 참고. tag-attendance 코드 수정 전 반드시 확인.
---

# T.A.G. 근태 대시보드 로직 레퍼런스

> 정책 기준값(9~10절)은 루트 `CLAUDE.md` 참고. 이 문서 앞부분(§1~5)은 **지금 실제로 돌아가고
> 있고 확정된 로직**만 다룬다. 미수정 버그·구식/불일치 로직은 맨 아래 §6~7에 별도로 분리해뒀다 —
> 거기 있는 내용은 "확정값 아님", 참고만 하고 정답처럼 쓰지 말 것.
> 2026-07-08 세션에서 실데이터로 전수 검증하며 작성됨 — 이후 코드가 바뀌면 이 문서도 갱신할 것.

## 1. 데이터 흐름 (확정)

```
CAPS(출퇴근) + ERP(휴가/연장신청) + Slack(OOO)
        │  dataParser.ts / slackApi.ts
        ▼
   processRecord.ts  ← 유일한 "권위" 엔진. 레코드 1건(직원×날짜)의
        │              clockIn/clockOut/leaveType/erpLeaveAmount/erpOtApplied/
        │              overtimeHours/nightHours/holidayHours/effectiveClockIn/
        │              finalStatus/flag/verificationNote 를 확정
        ▼
   ProcessedRecord[] (AttendanceDataContext, serverProcessed)
        │
        ├─ EmployeeCalendarGrid.tsx  (그리드 "총 근로" 배지, 주52h 필터)  ← §4 공식
        ├─ SummaryTab.tsx            (부서별 52h 초과 리포트)            ← §4 공식
        └─ AllowanceTab.tsx          (연장/휴일 수당 — r.overtimeHours 그대로 사용)
```
그 외 소비처(AttendanceResultTable, CSV/Excel/PPT 내보내기 등)는 §6 참고 — 위 3개와 다른 공식을 쓴다.

**핵심 전제:** `processRecord.ts`가 확정해 내려주는 `r.overtimeHours`(급여용 연장, 30분 절삭,
ERP 가드 포함)는 **이미 반차 backtrack을 흡수한 값**이다. 이 값을 total에 넣을 때 반차 크레딧을
또 더하면 이중계상이 된다 (2026-07-08 B9로 발견·수정, §5).

## 2. OT(연장근로) 계산 — virtualIn/backtrack 공식 (확정)

`attendanceCalc.ts`:

```
effIn     = computeEffInMins(actual clockIn, leaveType, isErpApproved)   // std snap 적용
virtualIn = effIn - backtrack
  backtrack: 오전반차 ERP승인 → 300분(5h) / 오전반반차 ERP승인 → 120분(2h) / 그 외 0분
급여용 연장(computePayOtMins) = floor( max(0, clockOut - (virtualIn + 600분)) / 30분 ) × 30분
직책자(computeLeaderPayOtMins) = max(0, clockOut - (virtualIn + 600분))   ※ 30분 절삭 없음, ERP 가드 없음
```

전개하면 `OT = 경과시간(effIn~clockOut) - (600분 - backtrack)`. virtualIn은 "OT가 언제부터
시작인가"를 정하는 경계선 역할인데, 산식상 backtrack 분량이 실질적으로 OT 쪽 인정시간으로
환산된다는 점을 알고 있어야 한다 (→ credit과 겹치지 않게 다루는 게 §4의 핵심).

`compute4141BreakMins(elapsedMins) = min(max(0,elapsed-240),60) + min(max(0,elapsed-540),60)`
(4시간 초과분 60분 상한 + 9시간 초과분 60분 상한, 최대 120분) — 순근무(stdH) 계산 전용이며
OT 계산식에는 반영되지 않는 별개 산식.

## 3. 공통 변수 (거의 모든 집계 코드에 반복되는 패턴, 확정)

```js
const isSlackInj     = verificationNote에 'ERP 미신청' 포함 여부
const isErpApproved  = leaveType ? !isSlackInj : true
const credit         = (!isUnpaidLeave && !isSlackInj) ? erpLeaveAmount * 8 : 0   // 0.25→2h, 0.5→4h, 1.0→8h
const netRecH        = max(0, (clockOut - effectiveClockIn) - compute4141BreakMins(elapsed)) / 60
const approvedOt     = erpOtApplied ? r.overtimeHours : 0
```
Slack 주입 반차(`verificationNote.includes('ERP 미신청')`)는 backtrack 없음 + credit 없음 —
`isErpApproved=false`라서 위 공식들이 자동으로 0 처리한다.

## 4. "총 근로시간" 확정 공식 — EmployeeCalendarGrid / SummaryTab (2026-07-08 수정 완료)

```js
if (직책자) {
  total = netRecH(uncapped) + credit
} else {
  total = approvedOt > 0
    ? (8 + approvedOt)              // 연장근로 발생일: credit 가산 없음 (backtrack이 이미 흡수)
    : (Math.min(netRecH, 8) + credit)  // 연장 없는 날(미신청 포함): 기존처럼 credit 가산
}
```
- **위치:** `EmployeeCalendarGrid.tsx` (empStats.roundedTotal / `hoursFilter==='over52'` 필터),
  `SummaryTab.tsx` (baseH) — 3곳 모두 동일 공식으로 통일됨 (커밋 4c921a6)
- **의미:** 그리드 상단 "총 근로" 배지, 그리드의 주52시간 초과 필터, 부서별 52시간 초과 리포트가
  이 공식으로 계산됨. 세 지표는 서로 100% 일치한다.
- **직책자는 원래부터 안전:** OT를 total에 더하지 않는 구조라 이중계상 버그 자체가 없었음.

## 4b. 지각/근무시간미달 혼합 플래그 분류 (2026-07-08 수정 완료)

`r.flag`가 `LATE_AND_ANOMALY`/`LATE_AND_EARLY_DEPARTURE`인 날은 **지각과 근무시간미달이 하루에
겹친 혼합 케이스**다. 이걸 어떻게 분류하는지가 파일마다 달랐다:

| 위치 | 혼합 플래그 처리 (수정 전) | 처리 (현재) |
|---|---|---|
| `AttendanceResultTable.tsx` (`anomalyTags`) | 지각 태그 + 근무시간미달 태그 **둘 다 push** | 그대로 (원래부터 맞음) |
| `AllowanceTab.tsx` (`lateByMonth`) | 지각으로만 카운트 (근무시간미달 카운트 자체가 없음) | 그대로 (원래부터 맞음, 대응되는 근무시간미달 집계가 없어서 문제 없음) |
| `deptReportExcel.ts` (`classifyFlag`) | **혼합 → null 반환, 지각/근무시간미달/미태깅 시트 전부에서 통째로 누락** | ✅ **수정됨** `classifyFlags`로 변경, 지각·근무시간미달 두 카테고리 모두에 +1 집계 (커밋 7c07eeb) |
| `EmployeeCalendarGrid.tsx` (empStats.anomalies, 상단 "이상" 배지) | `finalStatus` 기준 1건으로만 카운트 (지각/근무시간미달 구분 없이 "이상 있는 날" 총합) | 변경 안 함 — 이건 "카테고리별 집계"가 아니라 "이상 있는 날 수" 개념이라 혼합이어도 1건이 맞다고 판단 |
| `EmployeeCalendarGrid.tsx` (출근 행의 "지각" InfoTag, `flag.includes('LATE')`) | 혼합 포함 지각으로 표시 | 그대로 (원래부터 맞음) |

**주의:** 그리드 상단 "이상" 배지는 지각 전용 카운트가 아니라 지각+근무시간미달+미태깅을 합친
"이상 있는 날짜 수"다. 이 숫자를 AllowanceTab의 "지각" 총 횟수와 1:1로 비교하면 애초에 다른
지표를 비교하는 것이라 안 맞는 게 정상 — 지각만 비교하려면 그리드 출근행의 지각 태그를 세거나
`deptReportExcel.ts`의 "지각" 시트를 봐야 한다.

## 5. 체크리스트 — 새 집계 코드 작성 시

1. `r.overtimeHours`(또는 `computePayOtMins`/`computeLeaderPayOtMins` 재계산값)를 쓴다면, 그 값이
   이미 backtrack을 흡수했는지 확인하고 **동시에 credit을 또 더치지 않는지** 확인.
2. ERP 미승인 레코드는 backtrack=0, credit=0으로 자동 처리되므로 별도 분기 불필요.
3. 직책자 분기는 손대지 않아도 안전 (netRecH uncapped + credit, OT는 별도 스탯으로만 집계).

---

## 6. ⚠️ 예전 코드 / 확정값과 다른 공식을 쓰는 곳 (미정리 — 확정값 아님)

아래는 §4와 **의도적으로 통일한 게 아니라 각자 따로 구현된** 코드다. 같은 사람·같은 날짜라도
그리드(§4)와 다른 숫자가 나올 수 있다. "왜 여기랑 숫자가 다르냐"는 질문이 오면 이 표부터 확인.

| 위치 | 용도 | 실제 쓰는 공식 |
|---|---|---|
| `AttendanceResultTable.tsx` (`finalWorkH`) | 일자별 상세 테이블 "최종근무" 컬럼 | `netWork(uncapped) + credit` — OT를 아예 안 더함(연장은 옆에 별도 컬럼으로만 표시) |
| `exportCsv.ts` (`finalWork`) | CSV 내보내기 "최종근무" | 위와 동일 |
| `deptReportExcel.ts` (`recognizedHours`) | 법정근로초과 Excel 시트 | 위와 동일 |
| `PeopleAnalyticsTab.tsx` (`computeFinalWorkH`) | 주간 분석 | 위와 동일 |
| `statusSlidePptx.ts` (52h 슬라이드) | PPT 리포트 | 위와 동일 |

이 5곳은 "이중계상 버그"는 없지만(애초에 OT를 더하지 않으니까), §4와 근본적으로 다른 지표를
보여준다 — 그리드는 `8+연장(절삭)`, 이쪽은 `실제순근무(uncapped)+credit`. 오전반반차+연장 겹친
날 기준 최대 backtrack만큼(오전반차 5h/오전반반차 2h) 차이 날 수 있음. 어느 쪽으로 통일할지는
아직 결정된 바 없음 — 임의로 통일하지 말고 확인 후 진행.

## 7. ⚠️ 알려진 버그 (미수정 — 확정값 아님, 상세는 메모리 `project_tag_bugs.md` / 루트 CLAUDE.md §13)

| # | 상태 | 내용 |
|---|---|---|
| B1 | 🔴 미수정 | Slack 반차 주입 시 leaveAmount=0.25 고정 (반차는 0.5여야 함) |
| B2 | 🔴 미수정 | Break 계산 로직 processRecord/attendanceCalc/GAS 3곳 상이 |
| B3 | 🟡 미수정 | 10시 출근자 하드코딩 3곳 이중정의 |
| B4 | 🟡 미수정 | 상태 판정 로직 2곳 (computeStatusN vs flag 로직) |
| B5 | 🟡 미수정 | Dinner Grace 60분 GAS 미반영 |
| B6 | 🟠 확인필요 | 임산부 단축기준 360분 근거 불명 |
| B7 | 🟠 확인필요 | AllowanceTab 비직책자 clockIn/clockOut override 시 overtimeHours stale 가능성 |
| B8 | 🟡 미수정 | EmployeeCalendarGrid per-day OT 셀 합계 ≠ empStats.ot |
| B9 | ✅ 수정됨(2026-07-08, 커밋 4c921a6) | 연장근로 발생일 credit 이중계상 — 수정 내용은 §4로 이미 반영 |
| B10 | ✅ 수정됨(2026-07-08, 커밋 7c07eeb) | deptReportExcel 지각+근무시간미달 혼합 플래그 누락 — 수정 내용은 §4b로 이미 반영 |
| B11 | ✅ 수정됨(2026-07-09, 커밋 7eda511) | 휴일근무 부분태깅(clockIn/clockOut 중 하나만 있음) 시 '휴일근무' 뱃지는 뜨는데 holidayHours=0으로 집계 → 휴일/총근로 과소산정. 하나만 있으면 '출퇴근누락'(신규 사용, flag도 NO_CLOCK_IN/OUT)으로 분류하도록 수정. Slack 확인된 휴일근무는 뱃지만 유지하고 `holidayHours` 임의 대체(`|| effectiveStdH`) 로직 제거 — 시간은 크로스체크로만 씀 |
| B12 | ✅ 수정됨(2026-07-09, 커밋 607b241) | `admin/fast/page.tsx`의 override 재처리(overriddenRawRecords/allProcessed)가 erpLeaveType을 누락해서, 일별 상세탭에서 연차/휴가 수정해도 effectiveClockIn/OT 등 파생값이 재계산 안 됨. `admin/page.tsx`는 원래 처리하고 있었으나 인라인 중복 정의라 두 페이지가 어긋나 있었음 — `erpLeaveTypeToAmount`를 `attendanceCalc.ts`로 이동해 단일 정의로 공유 |
| B13 | ✅ 수정됨(2026-07-09, 커밋 d2b5b21) | `processRecord.ts`의 근무시간 미달(`isInsufficientHours`) 판정이 `insufficientBaselineMins`를 일반근무일 기준 `9*60`(표준 8h+점심 1h)으로 하드코딩 — 단축근로(`isShortenedHours`)/임신기 단축(`isPregnantReduced`) 예외규칙으로 `effectiveStdH`를 낮춰도 미달 기준선은 그대로 8h 기준이라 정상 단축근무자가 미달로 잘못 잡힘. `effectiveStdH*60+60`으로 수정 — 표준 8h 근무자는 영향 없음(8*60+60=9h로 동일) |
| B15 | ✅ 수정됨(2026-07-10, 커밋 c5e8cfa) | `DailyDetailModal.tsx`의 "ERP 연차·휴가" 패널이 `record.leaveType`(ERP 원본과 Slack 주입 값이 한 필드에 섞여 있음)를 구분 없이 표시 — Slack에만 남긴 연차(ERP 미신청)도 초록 상태점+실선 뱃지로 ERP 승인건처럼 보였음. `verificationNote`의 'ERP 미신청' 마커로 분기해서 점선+반투명+경고문구로 표시하도록 수정. 프론트엔드 표시 전용이라 캐시 재생성 불필요, 배포 즉시 반영 |
| B14 | 🔴 미수정(발견 2026-07-10) | **"전체 재계산" 버튼(`/api/compute-attendance`)이 49,075건 처리 도중 서버리스 타임아웃/500으로 조용히 실패** — UI에 에러 표시가 없어서 실패를 알기 어려움. 그 결과 `processed_data` 캐시가 안 갱신되고, `processRecord.ts` 레벨 수정이 전부 그리드에 반영 안 됨. 임시 우회: `scripts/recompute_processed_data.ts`로 로컬(타임아웃 없음)에서 직접 캐시 갱신. **processRecord.ts를 고칠 때마다 이 스크립트로 캐시 갱신 필요** — 버튼 클릭만으론 반영 안 됨 |
| — | 🟠 확인필요 | ERP 연장 **미신청**이면 실제 심야근무(야간수당 포함)를 해도 총근로/연장/야간에서 전부 0 처리됨 — 법정 야간수당은 신청 여부 무관하게 발생하는 게 원칙이라 정책 재확인 필요 |
