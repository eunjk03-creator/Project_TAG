import { type ReactNode } from 'react'
import { PolicyProvider } from '@/context/PolicyContext'
import { OrgFilterProvider } from '@/context/OrgFilterContext'
import { DateRangeProvider } from '@/context/DateRangeContext'
import { EmployeeExceptionsProvider } from '@/context/EmployeeExceptionsContext'
import { AttendanceDataProvider } from '@/context/AttendanceDataContext'
import { AttendanceSourceProvider } from '@/context/AttendanceSourceContext'
import { SlackProvider } from '@/context/SlackContext'
import { NavLinks } from '@/components/admin/NavLinks'
import { EmployeeDrawer } from '@/components/admin/EmployeeDrawer'

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <PolicyProvider>
      <AttendanceSourceProvider>
      <OrgFilterProvider>
        <DateRangeProvider>
        <AttendanceDataProvider>
        <EmployeeExceptionsProvider>
        <SlackProvider>
          <div className="flex h-screen bg-gray-50">
            <aside className="w-52 bg-white border-r border-gray-200 flex flex-col shrink-0 sticky top-0 overflow-y-auto">
              <div className="px-5 py-5 border-b border-gray-100 shrink-0">
                <span className="text-blue-600 font-bold text-lg tracking-tight">T.A.G.</span>
                <p className="text-xs text-gray-400 mt-0.5">HR Admin Console</p>
              </div>

              <NavLinks />
            </aside>

            <main className="flex-1 overflow-y-auto flex flex-col">{children}</main>
          </div>

          {/* Global right-side drawer — accessible from any admin page */}
          <EmployeeDrawer />
        </SlackProvider>
        </EmployeeExceptionsProvider>
        </AttendanceDataProvider>
        </DateRangeProvider>
      </OrgFilterProvider>
      </AttendanceSourceProvider>
    </PolicyProvider>
  )
}