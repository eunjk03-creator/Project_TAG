'use client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, CartesianGrid,
} from 'recharts'
import type { DivisionMetrics } from '@/hooks/useManagementMetrics'
import type { Section } from './MetricDeepDive'
import type { RiskThresholds } from '@/types/tag'

// ── Palette ────────────────────────────────────────────────────────────────

const BU_PALETTE = ['#3b82f6', '#7c3aed', '#10b981', '#f97316', '#ec4899', '#14b8a6', '#fb7185', '#f59e0b']

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtH(h: number): string {
  if (h <= 0) return '—'
  const m  = Math.round(h * 60)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`
}

function fmtAxis(v: number): string { return `${Math.round(v)}h` }

type DerivedMap = Record<string, number>

// ── Row type (shared across all sections) ──────────────────────────────────

type Row = {
  name:       string
  division:   string
  colorIdx:   number
  headcount:  number
  totalHours: number
  avgHours:   number
  highest:    number
  avgOt:      number
  totalOt:    number
  overCount:  number
  anomalies:  number
  missed:     number
  late:       number
  early:      number
  severe:     number
}

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  section:        Section
  metrics:        DivisionMetrics[]
  selectedBUs:    string[]
  riskThresholds: RiskThresholds
  highestTotal:   DerivedMap
  otOverCount:    DerivedMap
  missedTag:      DerivedMap
  lateCount:      DerivedMap
  earlyCount?:    DerivedMap
  severeCount?:   DerivedMap
}

// ── Custom tooltip helpers ─────────────────────────────────────────────────

function TooltipRow({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-gray-400">{label}</span>
      <span className={`font-semibold tabular-nums ${cls ?? 'text-gray-700'}`}>{value}</span>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TT = { active?: boolean; payload?: ReadonlyArray<any>; label?: string }

function TotalTooltip({ active, payload, rt }: TT & { rt: RiskThresholds }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as Row
  const warnAvg  = d.avgHours > rt.totalAmberH
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-3 text-xs min-w-[190px] z-50">
      <p className="font-bold text-gray-800 mb-2 pb-1.5 border-b border-gray-100">{d.division}</p>
      <div className="space-y-1">
        <TooltipRow label="총 근로시간" value={fmtH(d.totalHours)} cls="text-blue-600" />
        <TooltipRow label="1인 평균"   value={fmtH(d.avgHours)}   cls={warnAvg ? 'text-amber-600' : 'text-gray-700'} />
        <TooltipRow label="최대 개인"  value={fmtH(d.highest)}    />
        <TooltipRow label="인원"       value={`${d.headcount}명`} />
      </div>
      {warnAvg && (
        <p className="mt-2 pt-1.5 border-t border-gray-100 text-[10px] text-amber-600 font-medium">
          1인 평균이 기준({fmtH(rt.totalAmberH)})을 초과합니다
        </p>
      )}
    </div>
  )
}

function OvertimeTooltip({ active, payload, rt }: TT & { rt: RiskThresholds }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as Row
  const risk      = d.avgOt > rt.otRedH ? 'danger' : d.avgOt > rt.otAmberH ? 'warning' : 'normal'
  const riskLabel = { danger: '위험', warning: '주의', normal: '정상' }[risk]
  const riskCls   = { danger: 'text-red-600', warning: 'text-amber-600', normal: 'text-emerald-600' }[risk]
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-3 text-xs min-w-[200px] z-50">
      <p className="font-bold text-gray-800 mb-2 pb-1.5 border-b border-gray-100">{d.division}</p>
      <div className="space-y-1">
        <TooltipRow label="1인 평균 연장" value={fmtH(d.avgOt)}   cls={riskCls} />
        <TooltipRow label="총 연장근로"   value={fmtH(d.totalOt)} cls="text-amber-600" />
        <TooltipRow
          label={`>${rt.otRedH}h 초과인원`}
          value={d.overCount > 0 ? `${d.overCount}명` : '없음'}
          cls={d.overCount >= 3 ? 'text-red-600' : d.overCount > 0 ? 'text-orange-500' : 'text-gray-400'}
        />
        <TooltipRow label="인원" value={`${d.headcount}명`} />
      </div>
      <div className={`mt-2 pt-1.5 border-t border-gray-100 text-[10px] font-semibold ${riskCls}`}>
        리스크 수준: {riskLabel}
      </div>
    </div>
  )
}

function AnomalyTooltip({ active, payload }: TT) {
  if (!active || !payload?.length) return null
  const d    = payload[0].payload as Row
  const rate = d.headcount > 0 ? ((d.anomalies / d.headcount) * 100).toFixed(1) : '0.0'
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-3 text-xs min-w-[185px] z-50">
      <p className="font-bold text-gray-800 mb-2 pb-1.5 border-b border-gray-100">{d.division}</p>
      <div className="space-y-1">
        <TooltipRow label="합계 (이상치)"  value={`${d.anomalies}건`} cls={d.anomalies > 0 ? 'text-red-600 font-bold' : 'text-gray-400'} />
        <div className="pl-2 space-y-0.5 border-l-2 border-gray-100 mt-1">
          <TooltipRow label="미태깅"   value={`${d.missed}건`}  cls={d.missed  > 0 ? 'text-red-500'    : 'text-gray-300'} />
          <TooltipRow label="지각"     value={`${d.late}건`}    cls={d.late    > 0 ? 'text-amber-600'  : 'text-gray-300'} />
          <TooltipRow label="조기퇴근" value={`${d.early}건`}   cls={d.early   > 0 ? 'text-orange-500' : 'text-gray-300'} />
          <TooltipRow label="근태이상" value={`${d.severe}건`}  cls={d.severe  > 0 ? 'text-red-700'    : 'text-gray-300'} />
        </div>
        <TooltipRow label="이상치율"   value={`${rate}%`} />
      </div>
    </div>
  )
}

// ── Legend row (shared) ────────────────────────────────────────────────────

function BULegend({ rows }: { rows: Row[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
      {rows.map((r, i) => (
        <span key={r.division} className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: BU_PALETTE[i % BU_PALETTE.length] }} />
          {r.division}
        </span>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export function SectionComparisonChart({
  section, metrics, selectedBUs,
  riskThresholds: rt, highestTotal, otOverCount, missedTag, lateCount,
  earlyCount = {}, severeCount = {},
}: Props) {

  const rows: Row[] = selectedBUs.flatMap((bu, i) => {
    const m = metrics.find(x => x.division === bu)
    if (!m) return []
    return [{
      name:       bu.replace(/본부$/, ''),
      division:   bu,
      colorIdx:   i,
      headcount:  m.headcount,
      totalHours: m.totalHours,
      avgHours:   m.headcount > 0 ? m.totalHours / m.headcount : 0,
      highest:    highestTotal[bu] ?? 0,
      avgOt:      m.avgOtPerPerson,
      totalOt:    m.otHours,
      overCount:  otOverCount[bu] ?? 0,
      anomalies:  m.anomalies,
      missed:     missedTag[bu]  ?? 0,
      late:       lateCount[bu]  ?? 0,
      early:      earlyCount[bu]  ?? 0,
      severe:     severeCount[bu] ?? 0,
    }]
  })

  if (rows.length < 2) return null

  const H = 200

  // ── 총 근로시간 ────────────────────────────────────────────────────────
  if (section === 'total') {
    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <p className="text-[11px] font-semibold text-gray-500 mb-4">본부 비교 분석</p>
        <div className="grid grid-cols-2 gap-6">

          {/* Total hours */}
          <div>
            <p className="text-[10px] text-gray-400 font-medium text-center mb-2">총 근로시간</p>
            <ResponsiveContainer width="100%" height={H}>
              <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={36} />
                <Tooltip
                  content={(p) => <TotalTooltip active={p.active} payload={p.payload} rt={rt} />}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="totalHours" radius={[4, 4, 0, 0]} maxBarSize={52}>
                  {rows.map((r, i) => (
                    <Cell key={r.division} fill={BU_PALETTE[i % BU_PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Avg per person */}
          <div>
            <p className="text-[10px] text-gray-400 font-medium text-center mb-2">1인 평균 근로</p>
            <ResponsiveContainer width="100%" height={H}>
              <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={36} />
                <Tooltip
                  content={(p) => <TotalTooltip active={p.active} payload={p.payload} rt={rt} />}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="avgHours" radius={[4, 4, 0, 0]} maxBarSize={52}>
                  {rows.map((r, i) => (
                    <Cell
                      key={r.division}
                      fill={BU_PALETTE[i % BU_PALETTE.length]}
                      fillOpacity={0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <BULegend rows={rows} />
      </div>
    )
  }

  // ── 연장근로 ──────────────────────────────────────────────────────────
  if (section === 'overtime') {
    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <p className="text-[11px] font-semibold text-gray-500 mb-4">본부 비교 분석</p>
        <div className="grid grid-cols-2 gap-6">

          {/* Avg OT — risk-colored */}
          <div>
            <p className="text-[10px] text-gray-400 font-medium text-center mb-2">1인 평균 연장 (리스크 기준)</p>
            <ResponsiveContainer width="100%" height={H}>
              <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={36} />
                <Tooltip
                  content={(p) => <OvertimeTooltip active={p.active} payload={p.payload} rt={rt} />}
                  cursor={{ fill: '#fffbeb' }}
                />
                <Bar dataKey="avgOt" radius={[4, 4, 0, 0]} maxBarSize={52}>
                  {rows.map((r, i) => (
                    <Cell key={r.division} fill={BU_PALETTE[i % BU_PALETTE.length]} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Total OT */}
          <div>
            <p className="text-[10px] text-gray-400 font-medium text-center mb-2">총 연장근로</p>
            <ResponsiveContainer width="100%" height={H}>
              <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={36} />
                <Tooltip
                  content={(p) => <OvertimeTooltip active={p.active} payload={p.payload} rt={rt} />}
                  cursor={{ fill: '#fffbeb' }}
                />
                <Bar dataKey="totalOt" radius={[4, 4, 0, 0]} maxBarSize={52}>
                  {rows.map((r, i) => (
                    <Cell key={r.division} fill={BU_PALETTE[i % BU_PALETTE.length]} fillOpacity={0.6} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 items-center">
          <BULegend rows={rows} />
        </div>
      </div>
    )
  }

  // ── 이상치 — stacked bar ───────────────────────────────────────────────
  return (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <p className="text-[11px] font-semibold text-gray-500 mb-4">본부 비교 분석</p>
      <ResponsiveContainer width="100%" height={H}>
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={36} />
          <Tooltip
            content={(p) => <AnomalyTooltip active={p.active} payload={p.payload} />}
            cursor={{ fill: '#fef2f2' }}
          />
          <Bar dataKey="missed" name="퇴근 미태깅" stackId="s" fill="#f87171" maxBarSize={52} />
          <Bar dataKey="late"   name="지각"        stackId="s" fill="#fbbf24" radius={[4, 4, 0, 0]} maxBarSize={52} />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-3">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-600">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-400 shrink-0" /> 퇴근 미태깅
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-600">
          <span className="w-2.5 h-2.5 rounded-sm bg-amber-400 shrink-0" /> 지각
        </span>
      </div>
    </div>
  )
}
