'use client'

const WEEKLY_DATA = [
  { day: '월', date: '04/28', clockIn: '08:47', clockOut: '18:22', regular: 8.0, ot: 0.5, status: 'NORMAL' },
  { day: '화', date: '04/29', clockIn: '09:12', clockOut: '20:05', regular: 8.0, ot: 1.5, status: 'LATE' },
  { day: '수', date: '04/30', clockIn: '-', clockOut: '-', regular: 0, ot: 0, status: 'ON_LEAVE' },
  { day: '목', date: '05/01', clockIn: '-', clockOut: '-', regular: 0, ot: 0, status: 'HOLIDAY' },
  { day: '금 (오늘)', date: '05/02', clockIn: '08:55', clockOut: '진행중', regular: 5.2, ot: 0, status: 'TODAY' },
]

const TOTAL_HOURS = 23.2
const OT_HOURS = 2.0
const ANOMALIES = [
  { date: '2026-04-29', type: '지각', step: 'Step 1', status: '미해결', note: '09:12 출근 태깅' },
  { date: '2026-04-15', type: 'CAPS 미태깅', step: 'Step 3', status: '처리완료', note: 'Slack 외근 확인됨' },
  { date: '2026-04-03', type: '지각', step: 'Step 2', status: '처리완료', note: '연차 처리됨' },
]

function WorkHourGauge({ total, ot }: { total: number; ot: number }) {
  const pct = Math.min((total / 52) * 100, 100)
  const std40pct = (40 / 52) * 100

  let barColor = 'bg-green-500'
  if (total > 52) barColor = 'bg-red-500'
  else if (total > 40) barColor = 'bg-amber-500'

  return (
    <div className="space-y-3">
      <div className="relative h-8 bg-gray-100 rounded-full overflow-visible">
        <div
          className={`h-full rounded-full transition-all ${barColor} ${total > 52 ? 'animate-pulse' : ''}`}
          style={{ width: `${pct}%` }}
        >
          {pct > 10 && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-white">
              {total}h
            </span>
          )}
        </div>
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-gray-400"
          style={{ left: `${std40pct}%` }}
        />
        <span
          className="absolute -bottom-5 text-xs text-gray-400"
          style={{ left: `${std40pct}%`, transform: 'translateX(-50%)' }}
        >
          40h 기준
        </span>
        <div className="absolute top-0 bottom-0 w-0.5 bg-red-300 right-0" />
        <span className="absolute -bottom-5 right-0 text-xs text-red-400">52h 한도</span>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-4 text-center">
        <div>
          <p className="text-xs text-gray-400">오늘 출근</p>
          <p className="text-lg font-bold text-gray-800">08:55</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">예정 퇴근</p>
          <p className="text-lg font-bold text-gray-800">18:25</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">이번 주 OT</p>
          <p className="text-lg font-bold text-amber-500">{ot}h</p>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    NORMAL: 'bg-green-50 text-green-700 border-green-200',
    LATE: 'bg-red-50 text-red-700 border-red-200',
    ON_LEAVE: 'bg-blue-50 text-blue-700 border-blue-200',
    HOLIDAY: 'bg-gray-100 text-gray-500 border-gray-200',
    TODAY: 'bg-amber-50 text-amber-700 border-amber-200',
  }
  const label: Record<string, string> = {
    NORMAL: '정상', LATE: '지각', ON_LEAVE: '연차', HOLIDAY: '공휴일', TODAY: '진행중',
  }
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full border font-medium ${map[status]}`}>
      {label[status]}
    </span>
  )
}

export default function MyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* TopBar */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-blue-600 font-bold text-xl">T.A.G.</span>
          <span className="text-gray-300">|</span>
          <span className="text-gray-700 font-medium">내 근태 현황</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 text-sm font-bold">
            강
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800">강은정</p>
            <p className="text-xs text-gray-400">개발팀 · 과장</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* 주간 근무시간 게이지 */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-500 mb-6">이번 주 근무시간</h2>
          <WorkHourGauge total={TOTAL_HOURS} ot={OT_HOURS} />
        </div>

        {/* 주간 근태 상세 */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-500">주간 근태 상세</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-400 text-xs">
                <th className="px-4 py-3 text-left font-medium">날짜</th>
                <th className="px-4 py-3 text-center font-medium">출근</th>
                <th className="px-4 py-3 text-center font-medium">퇴근</th>
                <th className="px-4 py-3 text-center font-medium">근무</th>
                <th className="px-4 py-3 text-center font-medium">OT</th>
                <th className="px-4 py-3 text-center font-medium">상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {WEEKLY_DATA.map((row) => (
                <tr
                  key={row.day}
                  className={
                    row.status === 'TODAY'
                      ? 'border border-dashed border-gray-300 text-gray-400'
                      : row.status === 'LATE'
                      ? 'bg-red-50/50'
                      : ''
                  }
                >
                  <td className="px-4 py-3 font-medium text-gray-700">
                    {row.day} <span className="text-xs text-gray-400 ml-1">{row.date}</span>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600">{row.clockIn}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{row.clockOut}</td>
                  <td className="px-4 py-3 text-center text-gray-600">
                    {row.regular > 0 ? `${row.regular}h` : '-'}
                  </td>
                  <td className={`px-4 py-3 text-center font-semibold ${row.ot > 0 ? 'text-amber-600' : 'text-gray-300'}`}>
                    {row.ot > 0 ? `+${row.ot}h` : '-'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold text-gray-700">
                <td className="px-4 py-3">주간 합계</td>
                <td colSpan={2} />
                <td className="px-4 py-3 text-center">{TOTAL_HOURS}h</td>
                <td className="px-4 py-3 text-center text-amber-600">+{OT_HOURS}h</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 이상치 이력 */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-500">최근 이상치 이력</h2>
            <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded-full border border-red-200">
              미해결 1건
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-400 text-xs">
                <th className="px-4 py-3 text-left font-medium">날짜</th>
                <th className="px-4 py-3 text-left font-medium">유형</th>
                <th className="px-4 py-3 text-center font-medium">Sieve</th>
                <th className="px-4 py-3 text-center font-medium">처리상태</th>
                <th className="px-4 py-3 text-left font-medium">비고</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {ANOMALIES.map((a) => (
                <tr key={a.date}>
                  <td className="px-4 py-3 text-gray-600">{a.date}</td>
                  <td className="px-4 py-3 text-gray-700 font-medium">{a.type}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">{a.step}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                      a.status === '미해결'
                        ? 'bg-red-50 text-red-600 border-red-200'
                        : 'bg-gray-100 text-gray-500 border-gray-200'
                    }`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{a.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 안내 배너 */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-700">
          연차·반차·출장 신청은 ERP 시스템에서 별도로 진행해주세요. T.A.G.가 자동으로 반영합니다.
        </div>
      </main>
    </div>
  )
}
