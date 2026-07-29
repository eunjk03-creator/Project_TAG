import { NextRequest, NextResponse } from 'next/server'

// POST /api/upload-auth  { password }
// 파일 업로드(CAPS/ERP 원본 교체) 전 확인용 — 관리자 접속 자체는 middleware.ts의
// ADMIN_ACCESS_KEY가 이미 보호하고 있으므로, 이건 그 위에 실수/무단 업로드를 막는
// 추가 확인 단계일 뿐이다. 비밀번호는 서버에서만 비교하고 클라이언트로 내려주지 않는다.
export async function POST(req: NextRequest) {
  const configured = process.env.UPLOAD_PASSWORD ?? ''
  if (!configured) {
    // 환경 변수 미설정 시 개발 편의상 통과 (middleware.ts의 ADMIN_ACCESS_KEY와 동일 관례)
    return NextResponse.json({ ok: true })
  }

  const body = await req.json().catch(() => null) as { password?: string } | null
  const ok = !!body?.password && body.password === configured

  return NextResponse.json({ ok })
}
