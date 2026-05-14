import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const { token, channelId, oldest, latest, cursor } = await req.json() as {
      token: string
      channelId: string
      oldest: number
      latest: number
      cursor?: string
    }

    const params = new URLSearchParams({
      channel:   channelId,
      oldest:    String(oldest),
      latest:    String(latest),
      limit:     '200',
      inclusive: '1',
    })
    if (cursor) params.set('cursor', cursor)

    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })

    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
