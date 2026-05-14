'use client'
import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from 'react'
import type { RecordOverride, ResolutionData } from '@/types/tag'

type AttendanceDataContextType = {
  recordOverrides:    Record<string, RecordOverride>
  setRecordOverrides: Dispatch<SetStateAction<Record<string, RecordOverride>>>
  resolutions:        Record<string, ResolutionData>
  setResolutions:     Dispatch<SetStateAction<Record<string, ResolutionData>>>
}

const AttendanceDataContext = createContext<AttendanceDataContextType>({
  recordOverrides:    {},
  setRecordOverrides: () => {},
  resolutions:        {},
  setResolutions:     () => {},
})

export function AttendanceDataProvider({ children }: { children: ReactNode }) {
  const [recordOverrides, setRecordOverrides] = useState<Record<string, RecordOverride>>({})
  const [resolutions,     setResolutions]     = useState<Record<string, ResolutionData>>({})

  return (
    <AttendanceDataContext.Provider
      value={{ recordOverrides, setRecordOverrides, resolutions, setResolutions }}
    >
      {children}
    </AttendanceDataContext.Provider>
  )
}

export function useAttendanceData() {
  return useContext(AttendanceDataContext)
}
