'use client'
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react'
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
  | 'easy_logis'          // 이지로지스: suppress all anomaly flags
  | 'fixed_schedule_a'
  | 'fixed_schedule_b'
  | 'pregnant_reduced'
  | 'global_exclusion'
  | 'resigned'

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

// Prisma row shape → ExceptionRule (Prisma returns camelCase)
function fromRow(row: Record<string, unknown>): ExceptionRule {
  return {
    id:             String(row.id             ?? ''),
    employeeId:     String(row.employeeId     ?? ''),
    employeeName:   String(row.employeeName   ?? ''),
    jobTitle:       String(row.jobTitle       ?? ''),
    division:       String(row.division       ?? ''),
    team:           String(row.team           ?? ''),
    ruleType:       (row.ruleType             ?? '') as RuleType,
    excludeFromOt:  Boolean(row.excludeFromOt ?? false),
    shortenedHours: Number(row.shortenedHours ?? 0),
    validFrom:      String(row.validFrom      ?? ''),
    validTo:        String(row.validTo        ?? ''),
  }
}

export type { EmployeeAttributeOverrides }

/** Maps every EmployeeAttributeOverrides boolean field → its DB RuleType. */
export const ATTR_RULE_MAP: Partial<Record<keyof EmployeeAttributeOverrides, RuleType>> = {
  isLeader:           'manager_exemption',
  isParentalLeave:    'parental_leave',
  isShortenedHours:   'shortened_hours',
  isTenAMStarter:     'ten_am_starter',
  isDispatchedWorker: 'dispatched_worker',
  isEasyLogis:        'easy_logis',
  isResigned:         'resigned',
  isFixedScheduleA:   'fixed_schedule_a',
  isFixedScheduleB:   'fixed_schedule_b',
  isPregnantReduced:  'pregnant_reduced',
  isGlobalExclusion:  'global_exclusion',
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

  // Exception rules (ExceptionRulesTab ↔ EmployeeDrawer ↔ EmployeeCalendarGrid)
  exceptionRules:   ExceptionRule[]
  rulesLoading:     boolean
  addRule:          (data: Omit<ExceptionRule, 'id'>) => Promise<void>
  patchRule:        (id: string, patch: Partial<ExceptionRule>) => Promise<void>
  deleteRule:       (id: string) => Promise<void>
  deleteRules:      (ids: string[]) => Promise<void>
  /** Set of employeeIds whose `excludeFromOt` flag is true — used by grid */
  excludeFromOtIds: Set<string>

  // Per-employee attribute overrides — derived from exceptionRules (single source of truth)
  employeeAttrMap: Map<string, EmployeeAttributeOverrides>
  getEmployeeAttr: (empId: string) => EmployeeAttributeOverrides
}

const EmployeeExceptionsContext = createContext<EmployeeExceptionsState>({
  selectedId:       null,
  openDrawer:       () => {},
  closeDrawer:      () => {},
  exceptions:       {},
  saveException:    () => {},
  getException:     () => DEFAULT_EXCEPTION,
  exceptionRules:   [],
  rulesLoading:     false,
  addRule:          async () => {},
  patchRule:        async () => {},
  deleteRule:       async () => {},
  deleteRules:      async () => {},
  excludeFromOtIds: new Set(),
  employeeAttrMap:  new Map(),
  getEmployeeAttr:  () => ({}),
})

// ── Provider ──────────────────────────────────────────────────────────────

export function EmployeeExceptionsProvider({ children }: { children: ReactNode }) {
  // Drawer state
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [exceptions, setExceptions] = useState<Record<string, EmployeeException>>({})

  // Exception rules — persisted in Supabase via /api/exception-rules (single source of truth)
  const [exceptionRules, setExceptionRules] = useState<ExceptionRule[]>([])
  const [rulesLoading,   setRulesLoading]   = useState(true)

  // ── Load rules from API on mount ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetch('/api/exception-rules')
      .then(r => r.json())
      .then((data: unknown) => {
        if (cancelled) return
        if (!Array.isArray(data)) {
          console.error('[ExceptionRules] unexpected response (table may not exist yet):', data)
          return
        }
        setExceptionRules((data as Record<string, unknown>[]).map(fromRow))
      })
      .catch(err => console.error('[ExceptionRules] load error', err))
      .finally(() => { if (!cancelled) setRulesLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Single-source merge: exceptionRules (DB) → EmployeeAttributeOverrides
  // The drawer writes directly to DB via addRule/deleteRule/patchRule,
  // so this map always reflects the true DB state with no localStorage shadow.
  const employeeAttrMap = useMemo(() => {
    const merged = new Map<string, EmployeeAttributeOverrides>()

    for (const rule of exceptionRules) {
      const ex = merged.get(rule.employeeId) ?? {}
      switch (rule.ruleType) {
        case 'manager_exemption':
          merged.set(rule.employeeId, {
            ...ex,
            isLeader:   rule.excludeFromOt ? true : ex.isLeader,
            leaderFrom: rule.validFrom || undefined,
            leaderTo:   rule.validTo   || undefined,
          })
          break
        case 'shortened_hours':
          merged.set(rule.employeeId, { ...ex, isShortenedHours: true,
            shortenedHoursValue: rule.shortenedHours,
            shortenedHoursFrom: rule.validFrom || undefined,
            shortenedHoursTo:   rule.validTo   || undefined })
          break
        case 'ten_am_starter':
          merged.set(rule.employeeId, { ...ex, isTenAMStarter: true })
          break
        case 'dispatched_worker':
          merged.set(rule.employeeId, { ...ex, isDispatchedWorker: true,
            dispatchedWorkerFrom: rule.validFrom || undefined,
            dispatchedWorkerTo:   rule.validTo   || undefined })
          break
        case 'parental_leave':
          merged.set(rule.employeeId, { ...ex, isParentalLeave: true,
            parentalLeaveFrom: rule.validFrom || undefined,
            parentalLeaveTo:   rule.validTo   || undefined })
          break
        case 'easy_logis':
          merged.set(rule.employeeId, { ...ex, isEasyLogis: true })
          break
        case 'fixed_schedule_a':
          merged.set(rule.employeeId, { ...ex, isFixedScheduleA: true })
          break
        case 'fixed_schedule_b':
          merged.set(rule.employeeId, { ...ex, isFixedScheduleB: true })
          break
        case 'pregnant_reduced':
          merged.set(rule.employeeId, {
            ...ex,
            isPregnantReduced:    true,
            pregnantReducedFrom:  rule.validFrom || undefined,
            pregnantReducedTo:    rule.validTo   || undefined,
          })
          break
        case 'global_exclusion':
          merged.set(rule.employeeId, { ...ex, isGlobalExclusion: true })
          break
        case 'resigned':
          merged.set(rule.employeeId, { ...ex, isResigned: true,
            resignedFrom: rule.validFrom || undefined })
          break
      }
    }

    return merged
  }, [exceptionRules])

  // Derived: set of employee IDs with OT exemption ON
  const excludeFromOtIds = useMemo(
    () => new Set(
      exceptionRules
        .filter(r => r.ruleType === 'manager_exemption' && r.excludeFromOt)
        .map(r => r.employeeId),
    ),
    [exceptionRules],
  )

  // ── Attr accessor — reads from DB-sourced employeeAttrMap ────────────
  function getEmployeeAttr(empId: string): EmployeeAttributeOverrides {
    return employeeAttrMap.get(empId) ?? {}
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

  // ── Rule handlers (optimistic + API sync) ─────────────────────────────
  async function addRule(data: Omit<ExceptionRule, 'id'>) {
    const tempId = `temp-${Date.now()}-${Math.random()}`
    const optimistic: ExceptionRule = { ...data, id: tempId }
    setExceptionRules(prev => [...prev, optimistic])
    try {
      const res  = await fetch('/api/exception-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const row = await res.json()
      if (!res.ok) throw new Error(row.error ?? 'create failed')
      setExceptionRules(prev => prev.map(r => r.id === tempId ? fromRow(row) : r))
    } catch (err) {
      console.error('[ExceptionRules] add error', err)
      setExceptionRules(prev => prev.filter(r => r.id !== tempId))
    }
  }

  async function patchRule(id: string, patch: Partial<ExceptionRule>) {
    setExceptionRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
    try {
      const res = await fetch(`/api/exception-rules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'patch failed')
    } catch (err) {
      console.error('[ExceptionRules] patch error', err)
    }
  }

  async function deleteRule(id: string) {
    setExceptionRules(prev => prev.filter(r => r.id !== id))
    try {
      const res = await fetch(`/api/exception-rules/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error('delete failed')
    } catch (err) {
      console.error('[ExceptionRules] delete error', err)
    }
  }

  async function deleteRules(ids: string[]) {
    const set = new Set(ids)
    setExceptionRules(prev => prev.filter(r => !set.has(r.id)))
    try {
      const res = await fetch('/api/exception-rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'bulk delete failed')
    } catch (err) {
      console.error('[ExceptionRules] bulk delete error', err)
    }
  }

  return (
    <EmployeeExceptionsContext.Provider value={{
      selectedId, openDrawer, closeDrawer,
      exceptions, saveException, getException,
      exceptionRules, rulesLoading, addRule, patchRule, deleteRule, deleteRules,
      excludeFromOtIds,
      employeeAttrMap, getEmployeeAttr,
    }}>
      {children}
    </EmployeeExceptionsContext.Provider>
  )
}

export function useEmployeeExceptions() {
  return useContext(EmployeeExceptionsContext)
}
