'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'
import type { DateRange } from '@/types/tag'

const DEFAULT_RANGE: DateRange = { from: '2026-04-01', to: '2026-04-29' }

interface DateRangeState {
  dateRange: DateRange
  setDateRange: (r: DateRange) => void
}

const DateRangeContext = createContext<DateRangeState>({
  dateRange: DEFAULT_RANGE,
  setDateRange: () => {},
})

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [dateRange, setDateRange] = useState<DateRange>(DEFAULT_RANGE)
  return (
    <DateRangeContext.Provider value={{ dateRange, setDateRange }}>
      {children}
    </DateRangeContext.Provider>
  )
}

export function useDateRange() {
  return useContext(DateRangeContext)
}
