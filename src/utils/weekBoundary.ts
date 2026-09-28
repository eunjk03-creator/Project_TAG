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
