import { prisma } from '@/lib/prisma'
import { ShareDashboard } from '@/components/share/ShareDashboard'
import type { SnapshotData } from '@/components/share/ShareDashboard'

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let snapshot: SnapshotData | null = null
  try {
    const row = await prisma.sharedDataStore.findUnique({ where: { key: `snapshot_${id}` } })
    if (row?.data) snapshot = row.data as unknown as SnapshotData
  } catch (err) {
    console.error('[share page] DB error', err)
  }

  if (!snapshot) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center p-8 bg-white rounded-2xl shadow-sm">
          <div className="text-4xl mb-4">🔍</div>
          <h1 className="text-lg font-semibold text-gray-800 mb-2">스냅샷을 찾을 수 없습니다</h1>
          <p className="text-sm text-gray-500">링크가 잘못되었거나 삭제된 스냅샷입니다.</p>
        </div>
      </div>
    )
  }

  return <ShareDashboard snapshot={snapshot} />
}
