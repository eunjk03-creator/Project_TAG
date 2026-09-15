/** items를 limit개씩 동시에 처리 — 순서 보장 없음(완료되는 대로), 하나가 실패해도 이미
 *  시작된 나머지는 끝까지 진행한다(에러 처리는 호출부의 fn 안에서 담당). 업로드 청크 전송
 *  (AttendanceSourceContext)과 이상치 일괄 저장(anomalies 페이지) 양쪽에서 공유. */
export async function runWithConcurrency<T>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  async function worker() {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}
