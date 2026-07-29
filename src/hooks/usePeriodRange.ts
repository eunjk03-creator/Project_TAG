import { useMemo, useState } from 'react'

export type PeriodGranularity = 'day' | 'week' | 'month'

const DOW_KR = ['일', '월', '화', '수', '목', '금', '토']

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toDate(dateStr: string): Date {
  return new Date(dateStr + 'T12:00:00')
}

function fromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(dateStr: string, n: number): string {
  const d = toDate(dateStr)
  d.setDate(d.getDate() + n)
  return fromDate(d)
}

function addMonths(dateStr: string, n: number): string {
  const d = toDate(dateStr)
  d.setMonth(d.getMonth() + n)
  return fromDate(d)
}

/** Monday of the week containing dateStr. */
function weekStart(dateStr: string): string {
  const d   = toDate(dateStr)
  const dow = d.getDay() // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1
  d.setDate(d.getDate() - back)
  return fromDate(d)
}

function monthStart(dateStr: string): string {
  const [y, m] = dateStr.split('-')
  return `${y}-${m}-01`
}

function monthEnd(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const d = new Date(y, m, 0) // day 0 of next month = last day of this month
  return fromDate(d)
}

function fmtDayLabel(dateStr: string): string {
  const d = toDate(dateStr)
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`
}

export interface PeriodRange {
  granularity: PeriodGranularity
  setGranularity: (g: PeriodGranularity) => void
  from: string
  to: string
  label: string
  shift: (dir: 1 | -1) => void
  goToday: () => void
}

/**
 * 오늘/이번주/이번달 + 앞뒤 이동 기간 선택기. DateRangeContext(그리드/테이블이 쓰는 자유 범위
 * 선택기)와는 완전히 독립적 — Overview 페이지가 기간을 바꿔도 다른 탭에 영향 없음.
 */
export function usePeriodRange(): PeriodRange {
  const [granularity, setGranularityState] = useState<PeriodGranularity>('day')
  const [refDate, setRefDate] = useState<string>(() => todayStr())

  const { from, to, label } = useMemo(() => {
    if (granularity === 'day') {
      return { from: refDate, to: refDate, label: fmtDayLabel(refDate) }
    }
    if (granularity === 'week') {
      const mon = weekStart(refDate)
      const sun = addDays(mon, 6)
      return { from: mon, to: sun, label: `${mon} ~ ${sun}` }
    }
    const from = monthStart(refDate)
    const to   = monthEnd(refDate)
    const [y, m] = refDate.split('-')
    return { from, to, label: `${y}년 ${Number(m)}월` }
  }, [granularity, refDate])

  function setGranularity(g: PeriodGranularity) {
    setGranularityState(g)
    setRefDate(todayStr()) // 단위를 바꾸면 "오늘이 속한" 기간으로 리셋
  }

  function shift(dir: 1 | -1) {
    setRefDate(prev => {
      if (granularity === 'day')   return addDays(prev, dir)
      if (granularity === 'week')  return addDays(prev, dir * 7)
      return addMonths(prev, dir)
    })
  }

  function goToday() {
    setRefDate(todayStr())
  }

  return { granularity, setGranularity, from, to, label, shift, goToday }
}
