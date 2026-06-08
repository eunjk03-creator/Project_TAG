'use client'
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
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
  saveOverride:       (employeeId: string, workDate: string) => void
  deletedKeys:        Set<string>
  deleteRecord:       (employeeId: string, workDate: string) => void
}

const AttendanceDataContext = createContext<AttendanceDataContextType>({
  recordOverrides:    {},
  setRecordOverrides: () => {},
  resolutions:        {},
  setResolutions:     () => {},
  saveOverride:       () => {},
  deletedKeys:        new Set(),
  deleteRecord:       () => {},
})

export function AttendanceDataProvider({ children }: { children: ReactNode }) {
  const [recordOverrides, setRecordOverrides] = useState<Record<string, RecordOverride>>({})
  const [resolutions,     setResolutions]     = useState<Record<string, ResolutionData>>({})
  const [deletedKeys,     setDeletedKeys]     = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)

  // ── 초기 로드: DB에서 저장된 수정 이력 복원 ────────────────────────────
  useEffect(() => {
    fetch('/api/attendance-overrides')
      .then(r => r.json())
      .then((rows: {
        employeeId: string; workDate: string
        reasonLabel?: string | null; memo?: string | null
        clockIn?: string | null; clockOut?: string | null
        erpOtApplied?: boolean | null; erpLeaveType?: string | null
        editHistory?: unknown
      }[]) => {
        const newOverrides: Record<string, RecordOverride> = {}
        const newResolutions: Record<string, ResolutionData> = {}

        const newDeleted = new Set<string>()
        for (const row of rows) {
          const key = `${row.employeeId}_${row.workDate}`

          // 삭제 마킹된 레코드 분리
          if (row.reasonLabel === '__DELETED__') {
            newDeleted.add(key)
            continue
          }

          // recordOverrides 복원 (시간/ERP 수정값)
          if (row.clockIn !== null || row.clockOut !== null ||
              row.erpOtApplied !== null || row.erpLeaveType) {
            newOverrides[key] = {
              clockIn:      row.clockIn      ?? null,
              clockOut:     row.clockOut     ?? null,
              erpOtApplied: row.erpOtApplied ?? null,
              erpLeaveType: row.erpLeaveType ?? '없음',
              editHistory:  Array.isArray(row.editHistory) ? row.editHistory as RecordOverride['editHistory'] : [],
            }
          }

          // resolutions 복원 (최종 상태 라벨)
          if (row.reasonLabel) {
            newResolutions[key] = {
              reasonLabel: row.reasonLabel,
              memo:        row.memo ?? '',
            }
          }
        }
        setDeletedKeys(newDeleted)

        setRecordOverrides(newOverrides)
        setResolutions(newResolutions)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  // ── 저장: 한 건의 수정 내역을 DB에 upsert ─────────────────────────────
  const saveOverride = useCallback((employeeId: string, workDate: string) => {
    const key = `${employeeId}_${workDate}`

    // 최신 state를 읽기 위해 함수형 업데이트 패턴 대신 ref를 쓰기가 어려우므로
    // 호출 시점의 state를 클로저로 캡처 — 저장 직후 호출되므로 충분히 최신 값임
    setRecordOverrides(overrides => {
      setResolutions(resols => {
        const ov = overrides[key]
        const rs = resols[key]

        fetch('/api/attendance-overrides', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employeeId,
            workDate,
            reasonLabel:  rs?.reasonLabel  ?? null,
            memo:         rs?.memo         ?? null,
            clockIn:      ov?.clockIn      ?? null,
            clockOut:     ov?.clockOut     ?? null,
            erpOtApplied: ov?.erpOtApplied ?? null,
            erpLeaveType: ov?.erpLeaveType ?? null,
            editHistory:  ov?.editHistory  ?? [],
          }),
        }).catch(() => {})

        return resols  // state 변경 없음 — 읽기 전용
      })
      return overrides  // state 변경 없음 — 읽기 전용
    })
  }, [])

  const deleteRecord = useCallback((employeeId: string, workDate: string) => {
    const key = `${employeeId}_${workDate}`
    setDeletedKeys(prev => new Set([...prev, key]))
    fetch('/api/attendance-overrides', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId,
        workDate,
        reasonLabel:  '__DELETED__',
        memo:         null,
        clockIn:      null,
        clockOut:     null,
        erpOtApplied: null,
        erpLeaveType: null,
        editHistory:  [],
      }),
    }).catch(() => {})
  }, [])

  return (
    <AttendanceDataContext.Provider
      value={{ recordOverrides, setRecordOverrides, resolutions, setResolutions, saveOverride, deletedKeys, deleteRecord }}
    >
      {loaded ? children : null}
    </AttendanceDataContext.Provider>
  )
}

export function useAttendanceData() {
  return useContext(AttendanceDataContext)
}
