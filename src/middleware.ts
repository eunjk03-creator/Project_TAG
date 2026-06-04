import { NextRequest, NextResponse } from 'next/server'

const ACCESS_KEY    = process.env.ADMIN_ACCESS_KEY ?? ''
const COOKIE_NAME   = 'tag_access'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30  // 30일

export function middleware(req: NextRequest) {
  // /admin 경로만 보호
  if (!req.nextUrl.pathname.startsWith('/admin')) return NextResponse.next()

  // 환경 변수 미설정 시 개발 편의상 통과
  if (!ACCESS_KEY) return NextResponse.next()

  // 이미 인증된 쿠키가 있으면 통과
  const cookie = req.cookies.get(COOKIE_NAME)
  if (cookie?.value === ACCESS_KEY) return NextResponse.next()

  // URL에 ?access=KEY 가 있으면 인증 쿠키 발급 후 키 없는 URL로 리다이렉트
  const keyParam = req.nextUrl.searchParams.get('access')
  if (keyParam === ACCESS_KEY) {
    const url = req.nextUrl.clone()
    url.searchParams.delete('access')
    const res = NextResponse.redirect(url)
    res.cookies.set(COOKIE_NAME, ACCESS_KEY, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   COOKIE_MAX_AGE,
      path:     '/',
    })
    return res
  }

  // 인증 실패 → 403 페이지
  return new NextResponse(
    `<!DOCTYPE html><html><head><title>접근 제한</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
    .box{text-align:center;padding:2rem;border-radius:1rem;background:white;box-shadow:0 1px 8px #0001}
    h1{font-size:1.25rem;color:#111}p{color:#6b7280;font-size:.9rem;margin-top:.5rem}</style></head>
    <body><div class="box"><h1>🔒 접근 제한</h1><p>올바른 접근 링크가 필요합니다.</p></div></body></html>`,
    { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

export const config = {
  matcher: ['/admin/:path*'],
}
