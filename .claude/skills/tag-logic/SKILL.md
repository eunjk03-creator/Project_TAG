---
name: tag-logic
description: T.A.G.(project_TAG) 근태 대시보드의 계산 로직/데이터 흐름/집계 지점별 공식 차이/알려진 버그를 정리한 구현 레퍼런스. "총근로 왜 이렇게 나와", "OT 계산", "연장/야간/휴일 집계", "이 숫자가 다른 화면이랑 달라요", "credit/backtrack", 대시보드 버그 조사·수정 시 참고. tag-attendance 코드 수정 전 반드시 확인.
---

# T.A.G. 근태 대시보드 로직 레퍼런스

> 정책 기준값(9~10절)은 루트 `CLAUDE.md` 참고. 이 문서는 **구현이 실제로 어떻게 동작하는지**, 특히
> "총 근로시간"류 지표를 계산하는 지점이 여러 곳에 흩어져 있고 서로 다른 공식을 쓴다는 점에 집중한다.
> 2026-07-08 세션에서 실데이터로 전수 검증하며 작성됨 — 이후 코드가 바뀌면 이 문서도 갱신할 것.

## 1. 데이터 흐름

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
        ├─ EmployeeCalendarGrid.tsx  (그리드 "총 근로" 배지, 주52h 필터)
        ├─ SummaryTab.tsx            (부서별 52h 초과 리포트)
        ├─ AttendanceResultTable.tsx (일자별 상세 테이블 "최종근무" 컬럼)
        ├─ AllowanceTab.tsx          (연장/휴일 수당 집계 — 원장 r.overtimeHours 그대로 사용)
        ├─ PeopleAnalyticsTab.tsx    (주간 분석)
        ├─ exportCsv.ts / deptReportExcel.ts / statusSlidePptx.ts (내보내기)
        └─ EmployeeDrawer.tsx / SectionComparisonChart.tsx / ExecutiveBoard.tsx
```

**중요한 전제:** `processRecord.ts`가 `r.overtimeHours`(급여용 연장, 30분 절삭, ERP 가드 포함)를
한 번 확정해서 내려주는데, **그 값 자체가 이미 반차 backtrack을 흡수한 값**이다. 그런데 위 소비처들이
각자 "총 근로시간"을 다시 조립하면서 이 사실을 모르고 반차 크레딧을 또 더하는 경우가 있었다 (§4 참고).

## 2. OT(연장근로) 계산 — virtualIn/backtrack 공식

`attendanceCalc.ts`:

```
effIn    = computeEffInMins(actual clockIn, leaveType, isErpApproved)   // std snap 적용
virtualIn = effIn - backtrack
  backtrack: 오전반차 ERP승인 → 300분(5h) / 오전반반차 ERP승인 → 120분(2h) / 그 외 0분
급여용 연장(computePayOtMins) = floor( max(0, clockOut - (virtualIn + 600분)) / 30분 ) × 30분
직책자(computeLeaderPayOtMins) = max(0, clockOut - (virtualIn + 600분))   ※ 30분 절삭 없음, ERP 가드 없음
```

전개하면 `OT = 경과시간(effIn~clockOut) - (600분 - backtrack)` 이 되어, **backtrack이 클수록
"OT 시작까지 유예해주는 총량(600분)"이 줄어들고, 그만큼이 통째로 연장근로 쪽으로 편입**된다.
즉 virtualIn은 "OT가 언제부터 시작인가"를 정하는 경계선 역할만 해야 하는데, 산식상으로는
그 backtrack 분량이 실질적으로 "인정시간"으로 환산되어 버린다 — 이게 §4 버그의 근본 원인.

`compute4141BreakMins(elapsedMins) = min(max(0,elapsed-240),60) + min(max(0,elapsed-540),60)`
(4시간 초과분 60분 상한 + 9시간 초과분 60분 상한, 최대 120분) — 이건 순근무(stdH) 계산 전용이며
OT 계산식에는 전혀 반영되지 않는다(별개 산식이라는 점 주의, break가 이중으로 안 빠지는 것도 이 때문).

## 3. 비직책자 vs 직책자 분기 (거의 모든 집계 코드에 반복되는 패턴)

```js
const isSlackInj     = verificationNote에 'ERP 미신청' 포함 여부
const isErpApproved  = leaveType ? !isSlackInj : true
const credit         = (!isUnpaidLeave && !isSlackInj) ? erpLeaveAmount * 8 : 0   // 0.25→2h, 0.5→4h, 1.0→8h
const netRecH         = max(0, (clockOut - effectiveClockIn) - compute4141BreakMins(elapsed)) / 60

if (직책자) {
  total = netRecH(uncapped) + credit          // ✅ OT를 total에 안 더해서 원래부터 이중계상 없음
} else {
  approvedOt = erpOtApplied ? r.overtimeHours : 0
  stdH       = min(netRecH, 8)
  total      = ??? (§4가 이 부분)
}
```

Slack 주입 반차(`verificationNote.includes('ERP 미신청')`)는 backtrack 없음 + credit 없음 —
`isErpApproved=false`라서 위 공식들이 자동으로 0 처리한다.

## 4. ★ "총 근로시간" 집계 지점별 공식 비교 (2026-07-08 기준)

동일한 사람·같은 날짜인데도 화면마다 다른 숫자가 나올 수 있다. 아래 표가 원인이다.

| 파일:라인 | 용도 | 비직책자 공식 |
|---|---|---|
| `EmployeeCalendarGrid.tsx` (empStats, `roundedTotal`) | 그리드 상단 "총 근로" 배지 | ✅ **수정됨** `approvedOt>0 ? 8+approvedOt : min(netRecH,8)+credit` |
| `EmployeeCalendarGrid.tsx` (`hoursFilter==='over52'`) | 그리드 주52시간 초과 필터 | ✅ **수정됨** 위와 동일 |
| `SummaryTab.tsx` (`baseH`) | 부서별 52시간 초과자 리포트 | ✅ **수정됨** 위와 동일 |
| `AttendanceResultTable.tsx` (`finalWorkH`, GridRow) | 일자별 상세 테이블 "최종근무" 컬럼 | `min(netWork **uncapped**,∞)+credit` — OT를 아예 더하지 않음(연장은 별도 컬럼) |
| `exportCsv.ts` (`finalWork`) | CSV 내보내기 "최종근무" | 위와 동일 (uncapped net + credit, OT 별도) |
| `deptReportExcel.ts` (`recognizedHours`) | 법정근로초과 Excel 시트 | 위와 동일 |
| `PeopleAnalyticsTab.tsx` (`computeFinalWorkH`) | 주간 분석 | 위와 동일 |
| `statusSlidePptx.ts` (52h 슬라이드) | PPT 리포트 | 위와 동일 |
| `AllowanceTab.tsx` | 연장/휴일 수당 | credit 자체를 안 씀. `r.overtimeHours` 그대로 누적 → 이슈 없음 |

**해석:** 뒤 5개(AttendanceResultTable/CSV/Excel/PeopleAnalytics/PPT)는 "실제 순근무(uncapped) + credit"만
보여주고 OT를 별도로 더하지 않으므로 애초에 이중계상 버그가 없다. 대신 **그리드(위 3개, 수정 후)와는
값이 다르게 나오는 게 정상**이다 — 예: 오전반반차+연장 있는 날, 그리드는 `8+연장(절삭)`, 나머지는
`실제순근무(uncapped)+credit`. 둘 중 뭘 "정답"으로 통일할지는 아직 미결정 (연락 없이 임의 통일 금지).

### 수정된 로직 (2026-07-08, 커밋 4c921a6)
```js
// 연장근로가 ERP 승인되어 발생한 날 → 급여용 연장(approvedOt)이 이미 backtrack을 흡수했으므로
// credit을 또 더하면 이중계상. 8h 고정 + approvedOt만 사용, credit 생략.
// 연장이 없는 날(미신청 포함) → 기존처럼 min(netRecH,8) + credit
const dayTotal = approvedOt > 0 ? (8 + approvedOt) : (Math.min(netRecH, 8) + credit)
```
영향 범위: **ERP 승인된 오전반차(5h backtrack)/오전반반차(2h backtrack) + 그날 연장근로 발생** 조합에서만
차이 발생 (오전반차 최대 -5h, 오전반반차 최대 -2h 과다계상 교정). 그 외 케이스는 수정 전후 동일.

## 5. 알려진 버그/불일치 (요약 — 상세는 루트 CLAUDE.md §13, 메모리 `project_tag_bugs.md`)

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
| **B9** | ✅ **수정됨(2026-07-08)** | 연장근로 발생일 credit 이중계상 — §4 참고 |
| — | 🟠 확인필요 | 02-19 케이스처럼 **ERP 연장 미신청**이면 실제 심야근무(야간수당 포함)를 해도 총근로/연장/야간에서 전부 0 처리됨 — 정책 의도 확인 필요 (법정 야간수당은 신청 여부 무관하게 발생하는 게 원칙) |

## 6. 앞으로 비슷한 버그를 피하기 위한 체크리스트

새로운 "총 근로/총 지급시간" 집계 코드를 추가하거나 수정할 때:
1. `r.overtimeHours`(또는 `computePayOtMins`/`computeLeaderPayOtMins` 재계산값)를 쓰고 있다면, 그 값이
   이미 backtrack을 흡수했는지 확인하고, **동시에 credit(`erpLeaveAmount*8`)을 또 더하고 있지 않은지** 확인.
2. ERP 미승인(`erpOtApplied=false` 또는 Slack 주입 `ERP 미신청`) 레코드는 backtrack=0, credit=0으로
   자동 처리되므로 별도 분기 불필요 — 단, "실제 야간근무했는데 수당이 0"이 되는 게 맞는 정책인지는 별개 검토.
3. 직책자(리더) 분기는 OT를 total에 더하지 않는 구조라 이 버그 계열에서 원래 안전하다 — 리더 분기까지
   손대지 않도록 주의.
4. 그리드류(캡핑+OT+credit)와 상세테이블류(uncapped net+credit)는 **의도적으로 다른 공식**이 아니라
   합의 없이 따로 구현된 결과다. 수치 불일치 리포트가 오면 이 문서 §4 표부터 확인.
