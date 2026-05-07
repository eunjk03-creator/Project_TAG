'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Inline SVG icons — no external dependency, always stable
function Icon({ d, className }: { d: string | string[]; className?: string }) {
  const paths = Array.isArray(d) ? d : [d]
  return (
    <svg
      className={`w-[18px] h-[18px] shrink-0 ${className ?? ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  )
}

const ICONS = {
  dashboard: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  attendance: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  anomalies: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  employees: [
    'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  ],
  settings: [
    'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  ],
  help: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  logout: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
}

const NAV_MAIN = [
  { href: '/admin',           label: 'Dashboard',  sub: '대시보드',   icon: 'dashboard',  exact: true },
  { href: '/admin',           label: 'Attendance', sub: '근태 현황',  icon: 'attendance', exact: true },
  { href: '/admin/anomalies', label: 'Anomalies',  sub: '이상치 관리', icon: 'anomalies' },
  { href: '/admin/employees', label: 'Employees',  sub: '직원 관리',   icon: 'employees' },
  { href: '/admin/settings',  label: 'Settings',   sub: '설정',        icon: 'settings' },
] as const

const NAV_FOOTER = [
  { href: '#',      label: 'Support',  icon: 'help',   danger: false },
  { href: '/login', label: 'Log out',  icon: 'logout', danger: true  },
] as const

export function NavLinks() {
  const pathname = usePathname()

  function isActive(item: { href: string; exact?: boolean }, idx: number) {
    // When two items share the same href, only the first one claims "active"
    if (item.exact) {
      if (pathname !== item.href) return false
      // For duplicate hrefs, only the first with this href is active
      const firstWithHref = NAV_MAIN.findIndex(n => n.href === item.href)
      return firstWithHref === idx
    }
    return pathname.startsWith(item.href)
  }

  return (
    <div className="flex flex-col flex-1 p-3 min-h-0 overflow-y-auto">
      {/* Main nav */}
      <div className="flex-1 space-y-0.5">
        {NAV_MAIN.map((item, i) => {
          const active = isActive(item, i)
          return (
            <Link
              key={i}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                active
                  ? 'bg-blue-50 text-blue-700 shadow-sm shadow-blue-100'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
              }`}
            >
              <Icon
                d={ICONS[item.icon]}
                className={active ? 'text-blue-600' : 'text-gray-400'}
              />
              <span className="min-w-0">
                <span className="block text-[13px] leading-tight">{item.label}</span>
                <span className={`block text-[10px] leading-tight font-normal ${active ? 'text-blue-500' : 'text-gray-400'}`}>
                  {item.sub}
                </span>
              </span>
              {active && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
              )}
            </Link>
          )
        })}
      </div>

      {/* Footer nav */}
      <div className="border-t border-gray-100 pt-2 mt-4 space-y-0.5 shrink-0">
        {NAV_FOOTER.map((item, i) => (
          <Link
            key={i}
            href={item.href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all ${
              item.danger
                ? 'text-gray-400 hover:bg-red-50 hover:text-red-600'
                : 'text-gray-400 hover:bg-gray-50 hover:text-gray-700'
            }`}
          >
            <Icon
              d={ICONS[item.icon]}
              className={item.danger ? '' : 'text-gray-300'}
            />
            <span className="text-[13px]">{item.label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
