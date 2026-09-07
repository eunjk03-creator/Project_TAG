'use client'
import { type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PolicyProvider } from '@/context/PolicyContext'
import { OrgFilterProvider } from '@/context/OrgFilterContext'
import { DateRangeProvider } from '@/context/DateRangeContext'
import { EmployeeExceptionsProvider } from '@/context/EmployeeExceptionsContext'
import { AttendanceDataProvider } from '@/context/AttendanceDataContext'
import { AttendanceSourceProvider } from '@/context/AttendanceSourceContext'
import { SlackProvider } from '@/context/SlackContext'
import { EmployeeDrawer } from '@/components/admin/EmployeeDrawer'
import '@/styles/admin-v3.css'

// 디자인 시스템 3단계 — 주 내비게이션을 상단 탭에서 좌측 패널(폭 비율 1:9)로 이동
// (2026-09-07, 사용자 요청). "실제로 재스킨된 화면"만 노출하는 원칙은 그대로 유지
// (1단계의 근무제/리포트 임시 매핑은 눌러보면 다른 용도 화면이 나와 혼란을 줘서 제거된 채임
// — plans/functional-roaming-boot.md 참고). 설정/조직도는 실제로 동작하는 페이지라
// 상단 유틸 링크 쪽에 남겨둔다.
const NAV = [
  { href: '/admin',           label: '근태 현황' },
  { href: '/admin/overview',  label: '경영진 현황' },
  { href: '/admin/anomalies', label: '이상치 · 승인 검토' },
] as const

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <PolicyProvider>
      <AttendanceSourceProvider>
      <OrgFilterProvider>
        <DateRangeProvider>
        <AttendanceDataProvider>
        <EmployeeExceptionsProvider>
        <SlackProvider>
          <div className="admin-v3">
            <div className="topbar">
              <Link href="/admin" className="brand">T.A.G. <em>HR Admin</em></Link>
              <nav className="util">
                <Link href="/admin/employees">직원 정보</Link>
                <Link href="/admin/data">업로드/리포트</Link>
                <Link href="/admin/settings">설정</Link>
                <Link href="/admin/org-chart">조직도</Link>
                <span className="mute">알림</span>
              </nav>
            </div>

            <div style={{ display: 'flex', alignItems: 'stretch' }}>
              <aside
                style={{
                  flex: '0 0 10%', minWidth: 128, maxWidth: 220,
                  background: '#fff', boxShadow: 'inset -1px 0 0 var(--line)',
                  display: 'flex', flexDirection: 'column', gap: 2, padding: '16px 10px',
                }}
              >
                {NAV.map(t => {
                  const active = pathname === t.href
                  return (
                    <Link
                      key={t.href}
                      href={t.href}
                      style={{
                        display: 'block', padding: '10px 12px', borderRadius: 8,
                        fontSize: 14, fontWeight: 600, lineHeight: '19px',
                        color: active ? 'var(--ink)' : 'var(--ink-3)',
                        background: active ? '#f7faff' : 'transparent',
                        boxShadow: active ? 'inset 3px 0 0 var(--pri)' : 'none',
                      }}
                    >
                      {t.label}
                    </Link>
                  )
                })}
              </aside>

              <div style={{ flex: '1 1 90%', minWidth: 0 }}>
                <div className="head">
                  <div className="titlerow">
                    <span className="state">근태 조회 중</span>
                    <h1>T.A.G. 근태 관리</h1>
                  </div>
                </div>

                <main>{children}</main>
              </div>
            </div>
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
