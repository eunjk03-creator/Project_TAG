import { NextRequest, NextResponse } from 'next/server'

interface SlackApiUser {
  id:       string
  deleted?: boolean
  is_bot?:  boolean
  name?:    string
  real_name?: string
  profile?: { real_name?: string; display_name?: string; email?: string }
}

// Slack 워크스페이스 전체 멤버 목록 (users.list, 페이지네이션 처리) — 직원↔Slack 계정 매칭용
export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json() as { token: string }
    if (!token) return NextResponse.json({ ok: false, error: 'token required' }, { status: 400 })

    const members: SlackApiUser[] = []
    let cursor: string | undefined

    do {
      const params = new URLSearchParams({ limit: '200' })
      if (cursor) params.set('cursor', cursor)

      const res  = await fetch(`https://slack.com/api/users.list?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const data = await res.json() as {
        ok: boolean; error?: string; members?: SlackApiUser[]
        response_metadata?: { next_cursor?: string }
      }
      if (!data.ok) return NextResponse.json({ ok: false, error: data.error ?? 'users.list failed' }, { status: 400 })

      members.push(...(data.members ?? []))
      cursor = data.response_metadata?.next_cursor || undefined
    } while (cursor)

    const users = members
      .filter(m => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT')
      .map(m => ({
        id:          m.id,
        name:        m.name ?? '',
        realName:    m.profile?.real_name ?? m.real_name ?? '',
        displayName: m.profile?.display_name ?? '',
        email:       m.profile?.email ?? '',
      }))

    return NextResponse.json({ ok: true, users })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
