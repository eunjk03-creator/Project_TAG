'use client'
import { useMemo } from 'react'
import type { ProcessedRecord, Employee, RiskThresholds } from '@/types/tag'
import type { DivisionMetrics } from '@/hooks/useManagementMetrics'
import { DrilldownBreadcrumb } from './DrilldownBreadcrumb'

// ── Risk helpers ───────────────────────────────────────────────────────────

type Risk = 'danger' | 'warning' | 'normal'

function getRisk(avgOt: number, intensity: number, t: RiskThresholds): Risk {
  if (avgOt > t.otRedH        || intensity > t.intensityRed)   return 'danger'
  if (avgOt > t.otAmberH      || intensity > t.intensityAmber) return 'warning'
  return 'normal'
}

const RISK: Record<Risk, { label: string; icon: string; cls: string }> = {
  danger:  { label: '위험', icon: '🚨', cls: 'bg-red-100    text-red-700    border border-red-200'    },
  warning: { label: '주의', icon: '⚠️', cls: 'bg-amber-100  text-amber-700  border border-amber-200'  },
  normal:  { label: '정상', icon: '✅', cls: 'bg-emerald-100 text-emerald-700 border border-emerald-200' },
}

function otCls(h: number, t: RiskThresholds) {
  return h > t.otRedH ? 'text-red-600' : h > t.otAmberH ? 'text-amber-600' : 'text-emerald-600'
}
function intCls(p: number, t: RiskThresholds) {
  return p > t.intensityRed ? 'text-red-600' : p > t.intensityAmber ? 'text-amber-600' : 'text-emerald-600'
}

function fmtH(h: number): string {
  if (h <= 0) return '—'
  const m = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

// ── Position-distribution helpers ──────────────────────────────────────────

const JOB_ORDER = ['팀장', '매니저', '책임', '선임']

const JOB_BAR: Record<string, string> = {
  '팀장':  'bg-violet-500',
  '매니저': 'bg-blue-500',
  '책임':  'bg-amber-500',
  '선임':  'bg-emerald-500',
}
const JOB_DOT: Record<string, string> = {
  '팀장':  'bg-violet-500',
  '매니저': 'bg-blue-500',
  '책임':  'bg-amber-500',
  '선임':  'bg-emerald-500',
}
const JOB_TXT: Record<string, string> = {
  '팀장':  'text-violet-700',
  '매니저': 'text-blue-700',
  '책임':  'text-amber-700',
  '선임':  'text-emerald-700',
}

// ── Props ──────────────────────────────────────────────────────────────────

type Props = {
  metrics:          DivisionMetrics[]
  bizDays:          number
  total:            Omit<DivisionMetrics, 'division'>
  processedRecords: ProcessedRecord[]
  employees:        Employee[]
  selectedBUs:      string[]
  onBUsChange:      (bus: string[]) => void
  selectedRank:     string | null
  onRankChange:     (rank: string | null) => void
  riskThresholds:   RiskThresholds
}

// ── Component ──────────────────────────────────────────────────────────────

export function ExecutiveBoard({
  metrics, bizDays, total,
  processedRecords, employees,
  selectedBUs, onBUsChange,
  selectedRank, onRankChange,
  riskThresholds,
}: Props) {

  // ── Position distribution — only meaningful in single-BU drill-down ───────
  const positionData = useMemo(() => {
    const selectedBU = selectedBUs.length === 1 ? selectedBUs[0] : null
    if (!selectedBU) return []
    const divEmps = employees.filter(e => e.division === selectedBU)
    const empIds  = new Set(divEmps.map(e => e.id))
    const recs    = processedRecords.filter(r => empIds.has(r.employeeId))

    const otByTitle: Record<string, number> = {}
    for (const e of divEmps) otByTitle[e.jobTitle] = 0
    for (const r of recs) {
      const t = employees.find(e => e.id === r.employeeId)?.jobTitle
      if (t) otByTitle[t] = (otByTitle[t] ?? 0) + r.overtimeHours
    }

    const grandTotal = Object.values(otByTitle).reduce((s, v) => s + v, 0)
    return JOB_ORDER
      .filter(t => t in otByTitle)
      .map(t => ({ title: t, ot: otByTitle[t], pct: grandTotal > 0 ? (otByTitle[t] / grandTotal) * 100 : 0 }))
  }, [selectedBUs, processedRecords, employees])

  function handleRow(div: string) {
    if (selectedBUs.includes(div)) {
      const next = selectedBUs.filter(b => b !== div)
      onBUsChange(next)
      if (next.length === 0) onRankChange(null)
    } else {
      onBUsChange([...selectedBUs, div])
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* ── Summary Table ────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <DrilldownBreadcrumb
              selectedBU={selectedBUs.length === 1 ? selectedBUs[0] : null}
              selectedRank={selectedRank}
              onBUChange={(bu) => { if (!bu) onBUsChange([]) }}
              onRankChange={onRankChange}
            />
            {selectedBUs.length >= 2 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-semibold border border-violet-200 shrink-0">
                비교 중 {selectedBUs.length}개 본부
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-400 shrink-0">
            영업일 <span className="font-semibold text-gray-600">{bizDays}일</span> 기준
            <span className="text-gray-300 mx-1.5">·</span>
            행 클릭으로 선택 · 2개 이상 시 비교 분석
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500">
                <th className="text-left   px-3 py-2.5">본부명</th>
                <th className="text-center px-3 py-2.5">인원</th>
                <th className="text-center px-3 py-2.5">총 근로</th>
                <th className="text-center px-3 py-2.5 text-blue-500">야간</th>
                <th className="text-center px-3 py-2.5">1인당 평균 연장</th>
                <th className="text-center px-3 py-2.5">가동률</th>
                <th className="text-center px-3 py-2.5 text-orange-500">주 52시간 위험군</th>
                <th className="text-center px-3 py-2.5">리스크</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => {
                const risk    = getRisk(m.avgOtPerPerson, m.workloadIntensity, riskThresholds)
                const r       = RISK[risk]
                const active  = selectedBUs.includes(m.division)
                return (
                  <tr
                    key={m.division}
                    onClick={() => handleRow(m.division)}
                    className={`border-b border-gray-100 cursor-pointer transition-colors select-none ${
                      active         ? 'bg-blue-50 hover:bg-blue-100' :
                      i % 2 === 0    ? 'bg-white    hover:bg-gray-50' :
                                       'bg-gray-50/40 hover:bg-gray-100/60'
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center text-[9px] font-bold transition-all duration-150 ${
                          active
                            ? 'bg-blue-500 border-blue-500 text-white'
                            : 'border-gray-300 text-transparent'
                        }`}>
                          ✓
                        </span>
                        <span className={`font-semibold ${active ? 'text-blue-700' : 'text-gray-800'}`}>
                          {m.division}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center text-gray-600 tabular-nums">{m.headcount}명</td>
                    <td className="px-3 py-2.5 text-center text-gray-600 tabular-nums">{fmtH(m.totalHours)}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {m.nightHours > 0
                        ? <span className="text-blue-500 font-semibold">{fmtH(m.nightHours)}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      <span className={`font-bold text-[12px] ${otCls(m.avgOtPerPerson, riskThresholds)}`}>
                        {fmtH(m.avgOtPerPerson)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      <span className={`font-bold text-[12px] ${intCls(m.workloadIntensity, riskThresholds)}`}>
                        {m.workloadIntensity.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">
                      {m.weeklyOver45 > 0
                        ? <span className={`font-bold text-[12px] ${m.weeklyOver45 >= 3 ? 'text-red-600' : 'text-orange-500'}`}>
                            {m.weeklyOver45}명
                          </span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${r.cls}`}>
                        {r.icon} {r.label}
                      </span>
                    </td>
                  </tr>
                )
              })}

              {/* Grand total row */}
              <tr className="bg-gray-100 border-t-2 border-gray-300 font-semibold text-[12px]">
                <td className="px-3 py-2.5 text-gray-700">전체</td>
                <td className="px-3 py-2.5 text-center text-gray-700 tabular-nums">{total.headcount}명</td>
                <td className="px-3 py-2.5 text-center text-gray-700 tabular-nums">{fmtH(total.totalHours)}</td>
                <td className="px-3 py-2.5 text-center tabular-nums">
                  {total.nightHours > 0
                    ? <span className="text-blue-500">{fmtH(total.nightHours)}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums">
                  <span className={`font-bold ${otCls(total.avgOtPerPerson, riskThresholds)}`}>{fmtH(total.avgOtPerPerson)}</span>
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums">
                  <span className={`font-bold ${intCls(total.workloadIntensity, riskThresholds)}`}>{total.workloadIntensity.toFixed(1)}%</span>
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums">
                  {total.weeklyOver45 > 0
                    ? <span className={`font-bold ${total.weeklyOver45 >= 3 ? 'text-red-600' : 'text-orange-500'}`}>{total.weeklyOver45}명</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2.5" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Position Distribution Bar — single-BU drill-down only ────────── */}
      {selectedBUs.length === 1 && positionData.length > 0 && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
          <p className="text-[11px] font-semibold text-gray-600 mb-3">
            <span className="text-blue-600">{selectedBUs[0]}</span> · 직급별 연장근로 비중
          </p>

          {/* Stacked bar — each segment is clickable */}
          <div className="flex h-5 rounded-md overflow-hidden gap-px mb-3">
            {positionData.filter(p => p.pct > 0).map(p => {
              const isActive = selectedRank === p.title
              const isDimmed = selectedRank !== null && !isActive
              return (
                <button
                  key={p.title}
                  onClick={() => onRankChange(isActive ? null : p.title)}
                  className={`${JOB_BAR[p.title] ?? 'bg-gray-400'} flex items-center justify-center transition-all duration-200 ${
                    isDimmed ? 'opacity-30' : 'opacity-100'
                  }`}
                  style={{ width: `${p.pct}%` }}
                  title={isActive ? `${p.title} 필터 해제` : `${p.title}: ${p.pct.toFixed(1)}%`}
                >
                  {p.pct >= 12 && (
                    <span className="text-white text-[9px] font-bold leading-none select-none pointer-events-none">
                      {p.pct.toFixed(0)}%
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Legend — clickable to drill into job title */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {positionData.map(p => {
              const isActive = selectedRank === p.title
              const isDimmed = selectedRank !== null && !isActive
              return (
                <button
                  key={p.title}
                  onClick={() => onRankChange(isActive ? null : p.title)}
                  className={`flex items-center gap-1.5 transition-opacity ${isDimmed ? 'opacity-30' : 'opacity-100'} hover:opacity-100`}
                  title={isActive ? '직급 필터 해제' : `${p.title}만 보기`}
                >
                  <div className={`w-2 h-2 rounded-sm shrink-0 ${JOB_DOT[p.title] ?? 'bg-gray-400'} ${isActive ? 'ring-1 ring-offset-1 ring-current' : ''}`} />
                  <span className={`text-[11px] font-semibold ${isActive ? (JOB_TXT[p.title] ?? 'text-gray-700') : 'text-gray-600'}`}>
                    {p.title}
                  </span>
                  <span className="text-[11px] text-gray-500 tabular-nums">
                    {fmtH(p.ot)}
                    <span className="text-gray-400 ml-0.5">({p.pct.toFixed(1)}%)</span>
                  </span>
                  {isActive && <span className="text-[9px] text-blue-500 font-bold">✓</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
