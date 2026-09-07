'use client'
import { useEffect, useMemo, useState } from 'react'
import { CsvUploader } from '@/components/admin/CsvUploader'
import StatusExportButton from '@/components/admin/StatusExportButton'
import { useAttendanceSource } from '@/context/AttendanceSourceContext'
import { useDateRange } from '@/context/DateRangeContext'
import { useScopedProcessedRecords } from '@/hooks/useProcessedAttendance'
import { exportXlsx } from '@/utils/exportCsv'

type Segment = 'upload' | 'report' | 'raw'

interface ExportHistoryRow {
  id: string
  reportType: string
  format: string
  dept: string | null
  dateFrom: string
  dateTo: string
  createdAt: string
}

const REPORT_TYPE_LABEL: Record<string, string> = {
  'dept-report':         '부문별 요약',
  'productivity-report': '급여 전달용',
  'status-slides':       '현황 슬라이드',
}

type RawTableKey = 'caps' | 'erp' | 'daily' | 'export'

const RAW_TABLE_LABEL: Record<RawTableKey, string> = {
  caps:   'CAPS 원본 (caps_daily_logs)',
  erp:    'ERP 원본 (erp_applications)',
  daily:  '근태 정규화 (daily_attendance)',
  export: '내보내기 이력 (export_history)',
}

interface RawColumn { field: string; label: string; l?: true }

const RAW_TABLE_COLUMNS: Record<RawTableKey, RawColumn[]> = {
  caps: [
    { field: 'employeeId', label: '사원번호', l: true }, { field: 'name', label: '이름', l: true },
    { field: 'workDate', label: '근무일자' }, { field: 'clockIn', label: '출근' },
    { field: 'clockOut', label: '퇴근' }, { field: 'rawDept', label: '부서(원본)', l: true },
    { field: 'jobTitle', label: '직책', l: true }, { field: 'uploadedAt', label: '업로드시각' },
  ],
  erp: [
    { field: 'employeeId', label: '사원번호', l: true }, { field: 'name', label: '이름', l: true },
    { field: 'leaveType', label: '근태코드', l: true }, { field: 'approvalStatus', label: '승인상태', l: true },
    { field: 'startDate', label: '시작일' }, { field: 'startTime', label: '시작시간' },
    { field: 'endDate', label: '종료일' }, { field: 'endTime', label: '종료시간' },
    { field: 'submitDate', label: '신청일' }, { field: 'recognizedTime', label: '인정시간' },
    { field: 'leaveDays', label: '일수' }, { field: 'category', label: '구분', l: true },
    { field: 'syncedAt', label: '동기화시각' },
  ],
  daily: [
    { field: 'employeeId', label: '사원ID', l: true }, { field: 'workDate', label: '근무일자' },
    { field: 'dayType', label: '요일구분' }, { field: 'clockIn', label: '출근' },
    { field: 'clockOut', label: '퇴근' }, { field: 'effectiveClockIn', label: '유효출근' },
    { field: 'regularHours', label: '정규(h)' }, { field: 'overtimeHours', label: 'OT(h)' },
    { field: 'nightHours', label: '야간(h)' }, { field: 'holidayHours', label: '휴일(h)' },
    { field: 'erpOtApplied', label: 'ERP OT승인' }, { field: 'leaveType', label: '휴가유형', l: true },
    { field: 'erpLeaveAmount', label: '휴가량' }, { field: 'isUnpaidLeave', label: '무급' },
    { field: 'isLeader', label: '직책자' }, { field: 'finalStatus', label: '최종상태', l: true },
    { field: 'flag', label: '플래그', l: true }, { field: 'calculatedAt', label: '계산시각' },
  ],
  export: [
    { field: 'reportType', label: '리포트종류', l: true }, { field: 'format', label: '포맷' },
    { field: 'dept', label: '부서', l: true }, { field: 'dateFrom', label: '시작일' },
    { field: 'dateTo', label: '종료일' }, { field: 'createdAt', label: '생성시각' },
  ],
}

/** 현재 페이지 주변 + 처음/끝만 남기고 나머지는 'ellipsis'로 접는다 — 800페이지짜리
 *  테이블(caps_daily_logs)도 .tfoot에 버튼 전부를 못 박지 않고 감당하기 위함. */
function pageWindow(current: number, total: number): (number | 'ellipsis')[] {
  const keep = new Set([1, total, current - 1, current, current + 1].filter(p => p >= 1 && p <= total))
  const sorted = [...keep].sort((a, b) => a - b)
  const out: (number | 'ellipsis')[] = []
  let prev = 0
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('ellipsis')
    out.push(p)
    prev = p
  }
  return out
}

function formatRawCell(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Y' : '—'
  if (/(At)$/.test(field)) {
    const d = new Date(value as string)
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('ko-KR')
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  return String(value)
}

export default function DataPage() {
  const [segment, setSegment] = useState<Segment>('upload')
  const { employees, dataVersion } = useAttendanceSource()
  const { dateRange } = useDateRange()

  const divisions = useMemo(
    () => [...new Set(employees.map(e => e.division).filter(Boolean))],
    [employees],
  )

  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null)

  const [detailFrom, setDetailFrom] = useState(dateRange.from)
  const [detailTo,   setDetailTo]   = useState(dateRange.to)
  const [detailBusy, setDetailBusy] = useState(false)
  const detailRecords = useScopedProcessedRecords(detailFrom, detailTo, dataVersion)

  const [history,        setHistory]        = useState<ExportHistoryRow[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/export/history')
      if (res.ok) setHistory(await res.json())
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    if (segment === 'report') loadHistory()
  }, [segment])

  const [rawTable,   setRawTable]   = useState<RawTableKey>('caps')
  const [rawQInput,  setRawQInput]  = useState('')
  const [rawQ,       setRawQ]       = useState('')
  const [rawPage,    setRawPage]    = useState(1)
  const [rawSort,    setRawSort]    = useState<{ field: string; dir: 'asc' | 'desc' }>({ field: '', dir: 'desc' })
  const [rawRows,    setRawRows]    = useState<Record<string, unknown>[]>([])
  const [rawTotal,   setRawTotal]   = useState(0)
  const [rawLoading, setRawLoading] = useState(false)
  const rawPageSize = 50

  useEffect(() => {
    if (segment !== 'raw') return
    let cancelled = false
    setRawLoading(true)
    const params = new URLSearchParams({
      table: rawTable, q: rawQ, page: String(rawPage), pageSize: String(rawPageSize),
    })
    if (rawSort.field) { params.set('sortField', rawSort.field); params.set('sortDir', rawSort.dir) }
    fetch(`/api/raw-data?${params}`)
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        if (cancelled || !json) return
        setRawRows(json.rows ?? [])
        setRawTotal(json.total ?? 0)
      })
      .finally(() => { if (!cancelled) setRawLoading(false) })
    return () => { cancelled = true }
  }, [segment, rawTable, rawQ, rawPage, rawSort])

  function toggleRawSort(field: string) {
    setRawSort(prev => prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'desc' })
  }

  const rawTotalPages = Math.max(1, Math.ceil(rawTotal / rawPageSize))

  function downloadDetail() {
    if (!detailRecords || detailRecords.length === 0) {
      alert('해당 기간에 데이터가 없습니다')
      return
    }
    setDetailBusy(true)
    try {
      const fromLabel = detailFrom.replace(/-/g, '').slice(2)
      const toLabel   = detailTo.replace(/-/g, '').slice(2)
      exportXlsx(detailRecords, employees, `근태상세_이상치검토_${fromLabel}-${toLabel}.xlsx`)
    } finally {
      setDetailBusy(false)
    }
  }

  return (
    <div className="wrap">
      <div className="col wide" style={{ maxWidth: 'none' }}>
        <div className="ptitle">
          <h2>업로드 · 리포트</h2>
          <div className="sp" />
        </div>

        <div className="tabs" style={{ marginBottom: 16 }}>
          <button className={`tab${segment === 'upload' ? ' on' : ''}`} onClick={() => setSegment('upload')}>업로드</button>
          <button className={`tab${segment === 'report' ? ' on' : ''}`} onClick={() => setSegment('report')}>리포트</button>
          <button className={`tab${segment === 'raw' ? ' on' : ''}`} onClick={() => setSegment('raw')}>Raw 데이터</button>
        </div>

        {segment === 'upload' && (
          <div className="card" style={{ padding: 20 }}>
            {progress && (
              <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--ink-2)' }}>
                청크 {progress.step}/{progress.total} 처리 중…
              </div>
            )}
            <CsvUploader
              confirmBeforeRemove
              onProgress={(step, total) => setProgress(step < total ? { step, total } : null)}
            />
          </div>
        )}

        {segment === 'report' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card">
              <div className="px-4 py-3 border-b border-[var(--line)]">
                <span className="text-sm font-semibold text-[var(--ink)]">근태 상세 · 이상치 검토 내역</span>
                <p className="text-xs text-[var(--ink-3)] mt-1">
                  지정한 기간의 근태결과·요약·이상치 시트를 하나의 엑셀 파일로 내보냅니다.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap px-4 py-3">
                <input type="date" className="sel" value={detailFrom} onChange={e => setDetailFrom(e.target.value)} />
                <span className="text-[var(--ink-3)]">~</span>
                <input type="date" className="sel" value={detailTo} onChange={e => setDetailTo(e.target.value)} />
                <button className="solid blue" style={{ marginLeft: 8 }} onClick={downloadDetail} disabled={detailBusy || !detailRecords}>
                  {detailRecords ? '엑셀 다운로드' : '불러오는 중…'}
                </button>
              </div>
            </div>

            <div className="card">
              <div className="px-4 py-3 border-b border-[var(--line)]">
                <span className="text-sm font-semibold text-[var(--ink)]">현황 리포트</span>
                <p className="text-xs text-[var(--ink-3)] mt-1">
                  부문별 요약(Excel), 급여 전달용(Excel), 현황 슬라이드(PPTX)를 부서·기간을 선택해 내보냅니다.
                </p>
              </div>
              <div className="px-4 py-3">
                <StatusExportButton dateRange={dateRange} divisions={divisions} />
              </div>
            </div>

            <div className="card">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--line)]">
                <span className="text-sm font-semibold text-[var(--ink)]">내보내기 이력</span>
                <button className="ghost" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={loadHistory} disabled={historyLoading}>
                  {historyLoading ? '불러오는 중…' : '새로고침'}
                </button>
              </div>
              <div className="px-4 py-3">
                {!history || history.length === 0 ? (
                  <p className="text-xs text-[var(--ink-3)] text-center py-4">{historyLoading ? '불러오는 중…' : '내보내기 이력이 없습니다'}</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>시각</th>
                        <th className="l">종류</th>
                        <th>포맷</th>
                        <th className="l">부서</th>
                        <th className="l">기간</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(row => (
                        <tr key={row.id}>
                          <td>{new Date(row.createdAt).toLocaleString('ko-KR')}</td>
                          <td className="l">{REPORT_TYPE_LABEL[row.reportType] ?? row.reportType}</td>
                          <td>{row.format}</td>
                          <td className="l">{row.dept ?? '전체'}</td>
                          <td className="l">{row.dateFrom} ~ {row.dateTo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {segment === 'raw' && (
          <div className="card">
            <div className="tbar">
              <select
                className="sel"
                value={rawTable}
                onChange={e => { setRawTable(e.target.value as RawTableKey); setRawPage(1); setRawSort({ field: '', dir: 'desc' }) }}
              >
                {(Object.keys(RAW_TABLE_LABEL) as RawTableKey[]).map(k => (
                  <option key={k} value={k}>{RAW_TABLE_LABEL[k]}</option>
                ))}
              </select>
              <input
                type="text"
                className="search"
                placeholder={rawTable === 'export' ? '리포트종류/부서 검색' : '사원번호/이름 검색'}
                value={rawQInput}
                onChange={e => setRawQInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { setRawQ(rawQInput); setRawPage(1) } }}
              />
              <button className="ghost" onClick={() => { setRawQ(rawQInput); setRawPage(1) }}>검색</button>
              <span className="ct">
                {rawLoading ? '불러오는 중…' : `총 ${rawTotal.toLocaleString()}건`}
              </span>
            </div>

            <div className="tscroll">
              <table>
                <thead>
                  <tr>
                    {RAW_TABLE_COLUMNS[rawTable].map(col => (
                      <th
                        key={col.field}
                        className={col.l ? 'l' : undefined}
                        onClick={() => toggleRawSort(col.field)}
                        style={{ cursor: 'pointer', userSelect: 'none' }}
                        title="클릭해서 정렬"
                      >
                        {col.label}{rawSort.field === col.field ? (rawSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rawRows.length === 0 ? (
                    <tr><td className="mute" colSpan={RAW_TABLE_COLUMNS[rawTable].length}>
                      {rawLoading ? '불러오는 중…' : '데이터가 없습니다'}
                    </td></tr>
                  ) : rawRows.map((row, i) => (
                    <tr key={i}>
                      {RAW_TABLE_COLUMNS[rawTable].map(col => (
                        <td key={col.field} className={col.l ? 'l' : undefined}>{formatRawCell(col.field, row[col.field])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="tfoot">
              <button onClick={() => setRawPage(p => Math.max(1, p - 1))} disabled={rawPage <= 1} aria-label="이전 페이지">‹</button>
              {pageWindow(rawPage, rawTotalPages).map((p, i) =>
                p === 'ellipsis'
                  ? <span key={`e${i}`} style={{ color: 'var(--ink-4)', padding: '0 2px' }}>…</span>
                  : <button key={p} aria-current={p === rawPage} onClick={() => setRawPage(p)}>{p}</button>
              )}
              <button onClick={() => setRawPage(p => Math.min(rawTotalPages, p + 1))} disabled={rawPage >= rawTotalPages} aria-label="다음 페이지">›</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
