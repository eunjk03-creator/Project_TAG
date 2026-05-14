'use client'
import { createContext, useContext, useState, useMemo, type ReactNode } from 'react'
import type { EmployeeAttributeOverrides } from '@/types/tag'

// ── Per-employee drawer exception (used by EmployeeDrawer) ────────────────

export interface EmployeeException {
  bypassOtLimits: boolean
  flexibleCoreTime: boolean
  note: string
}

export const DEFAULT_EXCEPTION: EmployeeException = {
  bypassOtLimits: false,
  flexibleCoreTime: false,
  note: '',
}

// ── Exception rules (used by ExceptionRulesTab + EmployeeCalendarGrid) ────

export type RuleType =
  | 'manager_exemption'   // 직책자: OT/LATE exempt
  | 'shortened_hours'     // 단축근로: reduced std hours
  | 'ten_am_starter'      // 10시 출근자: snap+late threshold at 10:00
  | 'dispatched_worker'   // 파견자: skip missing-punch flag
  | 'parental_leave'      // 육아휴직자: all anomalies suppressed
  | 'fixed_schedule_a'
  | 'fixed_schedule_b'
  | 'pregnant_reduced'
  | 'global_exclusion'

export interface ExceptionRule {
  id:             string
  employeeId:     string
  employeeName:   string
  jobTitle:       string
  division:       string
  team:           string
  ruleType:       RuleType
  excludeFromOt:  boolean
  shortenedHours: number
  validFrom:      string
  validTo:        string
}

const LS_RULES = 'tag_exception_rules'
const LS_ATTRS = 'tag_employee_attrs'

export type { EmployeeAttributeOverrides }

function loadRules(): ExceptionRule[] {
  if (typeof window === 'undefined') return []
  try {
    const s = localStorage.getItem(LS_RULES)
    return s ? (JSON.parse(s) as ExceptionRule[]) : []
  } catch {
    return []
  }
}

function saveRules(rules: ExceptionRule[]) {
  try { localStorage.setItem(LS_RULES, JSON.stringify(rules)) } catch {}
}

function load<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

// ── Context interface ─────────────────────────────────────────────────────

interface EmployeeExceptionsState {
  // Drawer
  selectedId:    string | null
  openDrawer:    (id: string) => void
  closeDrawer:   () => void
  exceptions:    Record<string, EmployeeException>
  saveException: (id: string, settings: EmployeeException) => void
  getException:  (id: string) => EmployeeException

  // Exception rules (ExceptionRulesTab ↔ EmployeeCalendarGrid)
  exceptionRules:   ExceptionRule[]
  addRule:          (data: Omit<ExceptionRule, 'id'>) => void
  patchRule:        (id: string, patch: Partial<ExceptionRule>) => void
  deleteRule:       (id: string) => void
  deleteRules:      (ids: string[]) => void
  /** Set of employeeIds whose `excludeFromOt` flag is true — used by grid */
  excludeFromOtIds: Set<string>

  // Per-employee processing attribute overrides (EmployeeDrawer ↔ useAttendanceLogic)
  employeeAttrMap:  Map<string, EmployeeAttributeOverrides>
  setEmployeeAttr:  (empId: string, patch: Partial<EmployeeAttributeOverrides>) => void
  getEmployeeAttr:  (empId: string) => EmployeeAttributeOverrides
}

const EmployeeExceptionsContext = createContext<EmployeeExceptionsState>({
  selectedId:       null,
  openDrawer:       () => {},
  closeDrawer:      () => {},
  exceptions:       {},
  saveException:    () => {},
  getException:     () => DEFAULT_EXCEPTION,
  exceptionRules:   [],
  addRule:          () => {},
  patchRule:        () => {},
  deleteRule:       () => {},
  deleteRules:      () => {},
  excludeFromOtIds: new Set(),
  employeeAttrMap:  new Map(),
  setEmployeeAttr:  () => {},
  getEmployeeAttr:  () => ({}),
})

// ── Provider ──────────────────────────────────────────────────────────────

export function EmployeeExceptionsProvider({ children }: { children: ReactNode }) {
  // Drawer state
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [exceptions, setExceptions] = useState<Record<string, EmployeeException>>({})

  // Exception rules — persisted to localStorage
  const [exceptionRules, setExceptionRulesRaw] = useState<ExceptionRule[]>(loadRules)

  // Per-employee attribute overrides — persisted to localStorage
  const [employeeAttrsRaw, setEmployeeAttrsRaw] = useState<Record<string, EmployeeAttributeOverrides>>(
    () => load<Record<string, EmployeeAttributeOverrides>>(LS_ATTRS) ?? {},
  )
  // Two-layer merge:
  //   Layer 1 — exceptionRules (structured tab rules, lower priority)
  //   Layer 2 — employeeAttrsRaw (manual drawer toggles, higher priority)
  const employeeAttrMap = useMemo(() => {
    const merged = new Map<string, EmployeeAttributeOverrides>()

    for (const rule of exceptionRules) {
      const ex = merged.get(rule.employeeId) ?? {}
      switch (rule.ruleType) {
        case 'manager_exemption':
          merged.set(rule.employeeId, { ...ex, isLeader: rule.excludeFromOt ? true : ex.isLeader })
          break
        case 'shortened_hours':
          merged.set(rule.employeeId, { ...ex, isShortenedHours: true, shortenedHoursValue: rule.shortenedHours })
          break
        case 'ten_am_starter':
          merged.set(rule.employeeId, { ...ex, isTenAMStarter: true })
          break
        case 'dispatched_worker':
          merged.set(rule.employeeId, { ...ex, isDispatchedWorker: true })
          break
        case 'parental_leave':
          merged.set(rule.employeeId, { ...ex, isParentalLeave: true })
          break
        case 'fixed_schedule_a':
          merged.set(rule.employeeId, { ...ex, isFixedScheduleA: true })
          break
        case 'fixed_schedule_b':
          merged.set(rule.employeeId, { ...ex, isFixedScheduleB: true })
          break
        case 'pregnant_reduced':
          merged.set(rule.employeeId, { ...ex, isPregnantReduced: true })
          break
        case 'global_exclusion':
          merged.set(rule.employeeId, { ...ex, isGlobalExclusion: true })
          break
      }
    }

    // Manual drawer toggles override rule-based defaults
    for (const [empId, attrs] of Object.entries(employeeAttrsRaw)) {
      merged.set(empId, { ...(merged.get(empId) ?? {}), ...attrs })
    }

    return merged
  }, [employeeAttrsRaw, exceptionRules])

  function setExceptionRules(updater: (prev: ExceptionRule[]) => ExceptionRule[]) {
    setExceptionRulesRaw(prev => {
      const next = updater(prev)
      saveRules(next)
      return next
    })
  }

  // Derived: set of employee IDs with OT exemption ON
  const excludeFromOtIds = useMemo(
    () => new Set(
      exceptionRules
        .filter(r => r.ruleType === 'manager_exemption' && r.excludeFromOt)
        .map(r => r.employeeId),
    ),
    [exceptionRules],
  )

  // ── Attr handlers ────────────────────────────────────────────────────
  function setEmployeeAttr(empId: string, patch: Partial<EmployeeAttributeOverrides>) {
    setEmployeeAttrsRaw(prev => {
      const next = { ...prev, [empId]: { ...prev[empId], ...patch } }
      try { localStorage.setItem(LS_ATTRS, JSON.stringify(next)) } catch {}
      return next
    })
  }
  function getEmployeeAttr(empId: string): EmployeeAttributeOverrides {
    return employeeAttrsRaw[empId] ?? {}
  }

  // ── Drawer handlers ───────────────────────────────────────────────────
  function openDrawer(id: string) { setSelectedId(id) }
  function closeDrawer() { setSelectedId(null) }
  function saveException(id: string, settings: EmployeeException) {
    setExceptions(prev => ({ ...prev, [id]: settings }))
  }
  function getException(id: string): EmployeeException {
    return exceptions[id] ?? DEFAULT_EXCEPTION
  }

  // ── Rule handlers ─────────────────────────────────────────────────────
  function addRule(data: Omit<ExceptionRule, 'id'>) {
    setExceptionRules(prev => [...prev, { ...data, id: `ex-${Date.now()}` }])
  }
  function patchRule(id: string, patch: Partial<ExceptionRule>) {
    setExceptionRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }
  function deleteRule(id: string) {
    setExceptionRules(prev => prev.filter(r => r.id !== id))
  }
  function deleteRules(ids: string[]) {
    const set = new Set(ids)
    setExceptionRules(prev => prev.filter(r => !set.has(r.id)))
  }

  return (
    <EmployeeExceptionsContext.Provider value={{
      selectedId, openDrawer, closeDrawer,
      exceptions, saveException, getException,
      exceptionRules, addRule, patchRule, deleteRule, deleteRules,
      excludeFromOtIds,
      employeeAttrMap, setEmployeeAttr, getEmployeeAttr,
    }}>
      {children}
    </EmployeeExceptionsContext.Provider>
  )
}

export function useEmployeeExceptions() {
  return useContext(EmployeeExceptionsContext)
}
