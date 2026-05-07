'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'

export interface EmployeeException {
  bypassOtLimits: boolean
  flexibleCoreTime: boolean
  note: string
}

const DEFAULT_EXCEPTION: EmployeeException = {
  bypassOtLimits: false,
  flexibleCoreTime: false,
  note: '',
}

interface EmployeeExceptionsState {
  selectedId: string | null
  openDrawer: (id: string) => void
  closeDrawer: () => void
  exceptions: Record<string, EmployeeException>
  saveException: (id: string, settings: EmployeeException) => void
  getException: (id: string) => EmployeeException
}

const EmployeeExceptionsContext = createContext<EmployeeExceptionsState>({
  selectedId: null,
  openDrawer: () => {},
  closeDrawer: () => {},
  exceptions: {},
  saveException: () => {},
  getException: () => DEFAULT_EXCEPTION,
})

export function EmployeeExceptionsProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [exceptions, setExceptions] = useState<Record<string, EmployeeException>>({})

  function openDrawer(id: string) { setSelectedId(id) }
  function closeDrawer() { setSelectedId(null) }

  function saveException(id: string, settings: EmployeeException) {
    setExceptions(prev => ({ ...prev, [id]: settings }))
  }

  function getException(id: string): EmployeeException {
    return exceptions[id] ?? DEFAULT_EXCEPTION
  }

  return (
    <EmployeeExceptionsContext.Provider
      value={{ selectedId, openDrawer, closeDrawer, exceptions, saveException, getException }}
    >
      {children}
    </EmployeeExceptionsContext.Provider>
  )
}

export function useEmployeeExceptions() {
  return useContext(EmployeeExceptionsContext)
}

export { DEFAULT_EXCEPTION }
