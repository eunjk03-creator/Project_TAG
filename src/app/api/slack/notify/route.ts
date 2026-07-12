import { NextRequest, NextResponse } from 'next/server'

interface NotifyItem { slackUserId: string; text: string }
interface NotifyResult { slackUserId: string; ok: boolean; error?: string }

// chat.postMessage — channel 파라미터에 개인 user ID(U...)를 넣으면 봇이 그 사람과의
// DM(app conversation)으로 바로 보낸다 (conversations.open 없이도 동작).
export async function POST(req: NextRequest) {
  try {
    const { token, items } = await req.json() as { token: string; items: NotifyItem[] }
    if (!token)            return NextResponse.json({ ok: false, error: 'token required' }, { status: 400 })
    if (!items?.length)    return NextResponse.json({ ok: false, error: 'items required' }, { status: 400 })

    const results: NotifyResult[] = []
    for (const item of items) {
      try {
        const res  = await fetch('https://slack.com/api/chat.postMessage', {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ channel: item.slackUserId, text: item.text }),
        })
        const data = await res.json() as { ok: boolean; error?: string }
        results.push({ slackUserId: item.slackUserId, ok: data.ok, error: data.ok ? undefined : data.error })
      } catch (err) {
        results.push({ slackUserId: item.slackUserId, ok: false, error: String(err) })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
