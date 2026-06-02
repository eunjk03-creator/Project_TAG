'use client'
import { useMemo } from 'react'
import type { ProcessedRecord } from '@/types/tag'

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일']

type DaySummary = {
  date: string
  day: number
  isWeekend: boolean
  empCount: number
  anomalyCount: number
  otCount: number
}

type Props = {
  year: number
  month: number
  records: ProcessedRecord[]
  selectedDate: string | null
  dateRange: { from: string; to: string }
  onDayClick: (date: string) => void
  onPrevMonth: () => void
  onNextMonth: () => void
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

export function AttendanceCalendar({
  year,
  month,
  records,
  selectedDate,
  dateRange,
  onDayClick,
  onPrevMonth,
  onNextMonth,
}: Props) {
  const { days, blanks } = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1)
    const daysInMonth = new Date(year, month, 0).getDate()
    // Mon=0 … Sun=6
    const firstWeekday = (firstDay.getDay() + 6) % 7

    const days: DaySummary[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${pad(month)}-${pad(d)}`
      const dow = (new Date(year, month - 1, d).getDay() + 6) % 7
      const dayRecs = records.filter(r => r.date === date)
      days.push({
        date,
        day: d,
        isWeekend: dow >= 5,
        empCount: dayRecs.length,
        anomalyCount: dayRecs.filter(r => r.flag !== null).length,
        otCount: dayRecs.filter(r => r.overtimeHours > 0).length,
      })
    }

    return { days, blanks: firstWeekday }
  }, [year, month, records])

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Month nav */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <button
          onClick={onPrevMonth}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors text-lg"
        >
          ‹
        </button>
        <h2 className="text-sm font-semibold text-gray-700">
          {year}년 {month}월
        </h2>
        <button
          onClick={onNextMonth}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors text-lg"
        >
          ›
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-gray-100">
        {WEEKDAYS.map(wd => (
          <div
            key={wd}
            className={`py-2 text-center text-xs font-semibold ${
              wd === '토' || wd === '일' ? 'text-red-400' : 'text-gray-400'
            }`}
          >
            {wd}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {Array.from({ length: blanks }).map((_, i) => (
          <div key={`b${i}`} className="min-h-[80px] border-r border-b border-gray-100 bg-gray-50/30" />
        ))}

        {days.map((day, i) => {
          const isInRange = day.date >= dateRange.from && day.date <= dateRange.to
          const isSelected = selectedDate === day.date

          return (
            <div
              key={day.date}
              onClick={() => isInRange && onDayClick(day.date)}
              className={`min-h-[80px] border-r border-b border-gray-100 p-2 transition-colors ${
                isSelected
                  ? 'bg-blue-50 ring-1 ring-inset ring-blue-300'
                  : isInRange
                  ? day.isWeekend
                    ? 'bg-gray-50/50 hover:bg-gray-100/60 cursor-pointer'
                    : 'hover:bg-blue-50/30 cursor-pointer'
                  : 'bg-gray-50/60 opacity-40 cursor-default'
              }`}
            >
              <p
                className={`text-xs font-semibold mb-1.5 ${
                  day.isWeekend
                    ? 'text-red-400'
                    : isSelected
                    ? 'text-blue-600'
                    : 'text-gray-600'
                }`}
              >
                {day.day}
              </p>

              {isInRange && day.empCount > 0 && (
                <div className="space-y-0.5">
                  <p className="text-[10px] text-gray-400">{day.empCount}명</p>
                  <div className="flex flex-wrap gap-0.5">
                    {day.otCount > 0 && (
                      <span className="text-[10px] px-1 py-0.5 bg-amber-50 text-amber-600 rounded font-medium leading-none">
                        OT {day.otCount}
                      </span>
                    )}
                    {day.anomalyCount > 0 && (
                      <span className="text-[10px] px-1 py-0.5 bg-red-50 text-red-500 rounded font-medium leading-none">
                        이상 {day.anomalyCount}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {isInRange && day.empCount > 0 && day.anomalyCount === 0 && day.otCount === 0 && (
                <span className="text-[10px] text-green-500 font-medium">정상</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
