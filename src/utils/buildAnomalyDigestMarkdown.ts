import type { AnomalyRow } from '@/utils/overviewAggregations'

/**
 * 부문별 이상치 요약을 Slack mrkdwn 문법으로 생성한다. 지금은 미리보기+복사 전용이지만,
 * 나중에 /api/slack/notify로 그대로 발송할 걸 대비해 처음부터 실제 Slack 문법(*굵게*, 불릿)
 * 으로 만든다 — 미리보기와 발송 텍스트가 갈라지지 않게.
 */
export function buildAnomalyDigestMarkdown(
  rows:         AnomalyRow[],
  cadenceLabel: string,
  periodLabel:  string,
): string {
  const active = rows.filter(r => r.total > 0)
  const grandTotal = active.reduce((s, r) => s + r.total, 0)

  const lines = [`*📊 부문별 이상치 요약 (${cadenceLabel} · ${periodLabel})*`, '']

  if (active.length === 0) {
    lines.push('_이상치 없음_')
  } else {
    for (const r of active) {
      lines.push(`• ${r.label} — ${r.total}건 (지각 ${r.late} · 미달 ${r.shortage} · 미태깅 ${r.notag})`)
    }
    lines.push('', `_총 이상치 ${grandTotal}건_`)
  }

  return lines.join('\n')
}
