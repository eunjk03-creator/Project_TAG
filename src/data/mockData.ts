import type { RawRecord, DayType } from '@/types/tag'

function fromMins(mins: number): string {
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function seededRand(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

const HOLIDAYS = new Set(['2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-01'])

function getDayType(dateStr: string): { dayType: DayType; dayLabel: string } {
  if (HOLIDAYS.has(dateStr)) {
    const labels: Record<string, string> = {
      '2026-01-01': '신정', '2026-02-17': '설날',
      '2026-02-16': '설날연휴', '2026-02-18': '설날연휴', '2026-03-01': '삼일절',
    }
    return { dayType: 'HOLIDAY', dayLabel: labels[dateStr] || '공휴일' }
  }
  const dow = new Date(dateStr).getDay()
  if (dow === 0 || dow === 6) return { dayType: 'WEEKEND', dayLabel: '휴일' }
  return { dayType: 'WEEKDAY', dayLabel: '평일' }
}

function generateRecords(
  employeeId: string,
  startDate: string,
  endDate: string,
  seed: number,
  pattern: 'normal' | 'overworker' | 'standard'
): RawRecord[] {
  const rand = seededRand(seed)
  const records: RawRecord[] = []
  const cur = new Date(startDate)
  const end = new Date(endDate)

  while (cur <= end) {
    const dateStr = cur.toISOString().split('T')[0]
    const { dayType, dayLabel } = getDayType(dateStr)

    if (dayType !== 'WEEKDAY') {
      records.push({ employeeId, date: dateStr, dayType, dayLabel, clockIn: null, clockOut: null, erpOtApplied: false })
      cur.setDate(cur.getDate() + 1)
      continue
    }

    if (rand() < 0.05) {
      records.push({ employeeId, date: dateStr, dayType, dayLabel, clockIn: null, clockOut: null, erpOtApplied: false })
      cur.setDate(cur.getDate() + 1)
      continue
    }

    const inBase = pattern === 'overworker' ? 495 : pattern === 'standard' ? 525 : 510
    const inJitter = Math.floor((rand() - 0.5) * 40)
    const isLate = rand() < 0.08
    const actualIn = isLate ? 545 + Math.floor(rand() * 60) : Math.max(460, Math.min(600, inBase + inJitter))

    const outBase = pattern === 'overworker' ? 1200 : pattern === 'standard' ? 1050 : 1080
    const hasOt = rand() < (pattern === 'overworker' ? 0.7 : pattern === 'normal' ? 0.4 : 0.2)
    const otExtra = hasOt ? Math.floor(rand() * 240 + 60) : 0
    const outMins = outBase + otExtra + Math.floor((rand() - 0.5) * 30)
    const erpOtApplied = hasOt ? rand() > 0.15 : false

    records.push({
      employeeId,
      date: dateStr,
      dayType,
      dayLabel,
      clockIn: fromMins(actualIn),
      clockOut: outMins >= 1440 ? `+${fromMins(outMins - 1440)}` : fromMins(outMins),
      erpOtApplied,
    })
    cur.setDate(cur.getDate() + 1)
  }
  return records
}

// 강악어 실제 데이터 (Excel 원본)
const KANG_DATA: Array<[string, string, string | null, string | null]> = [
  ['2026-01-01','신정',null,null],['2026-01-02','평일','08:51','20:11'],
  ['2026-01-03','휴일',null,null],['2026-01-04','휴일',null,null],
  ['2026-01-05','평일','08:51','23:12'],['2026-01-06','평일','07:27','20:41'],
  ['2026-01-07','평일','08:51','18:13'],['2026-01-08','평일','08:52','21:05'],
  ['2026-01-09','평일','08:50','12:31'],['2026-01-10','휴일',null,null],
  ['2026-01-11','휴일',null,null],['2026-01-12','평일','08:54','20:33'],
  ['2026-01-13','평일','08:54','19:50'],['2026-01-14','평일','10:48','19:35'],
  ['2026-01-15','평일','08:48','22:16'],['2026-01-16','평일',null,null],
  ['2026-01-17','휴일',null,null],['2026-01-18','휴일',null,null],
  ['2026-01-19','평일','08:54','19:13'],['2026-01-20','평일','08:49','19:58'],
  ['2026-01-21','평일','08:52','20:54'],['2026-01-22','평일','08:48','20:05'],
  ['2026-01-23','평일','08:49','21:12'],['2026-01-24','휴일',null,null],
  ['2026-01-25','휴일',null,null],['2026-01-26','평일','09:50','18:32'],
  ['2026-01-27','평일','08:48','21:10'],['2026-01-28','평일','08:52','21:00'],
  ['2026-01-29','평일','08:50','23:00'],['2026-01-30','평일','08:48','21:19'],
  ['2026-01-31','휴일',null,null],['2026-02-01','휴일',null,null],
  ['2026-02-02','평일','08:54','20:12'],['2026-02-03','평일','08:53','19:19'],
  ['2026-02-04','평일','08:53','23:00'],['2026-02-05','평일','08:54','18:56'],
  ['2026-02-06','평일','08:47','19:15'],['2026-02-07','휴일',null,null],
  ['2026-02-08','휴일',null,null],['2026-02-09','평일','08:49','19:08'],
  ['2026-02-10','평일','10:38','19:12'],['2026-02-11','평일','08:45','15:27'],
  ['2026-02-12','평일','08:42','19:32'],['2026-02-13','평일',null,null],
  ['2026-02-14','휴일',null,null],['2026-02-15','휴일',null,null],
  ['2026-02-16','설날연휴',null,null],['2026-02-17','설날',null,null],
  ['2026-02-18','설날연휴',null,null],['2026-02-19','평일','08:40','20:25'],
  ['2026-02-20','평일','08:45','18:20'],['2026-02-21','휴일',null,null],
  ['2026-02-22','휴일',null,null],['2026-02-23','평일','08:42','19:09'],
  ['2026-02-24','평일','08:43','18:50'],['2026-02-25','평일','08:41','20:01'],
  ['2026-02-26','평일','08:41','19:35'],['2026-02-27','평일','08:42','18:44'],
  ['2026-02-28','휴일',null,null],['2026-03-01','삼일절',null,null],
  ['2026-03-02','평일',null,null],['2026-03-03','평일','08:44','19:44'],
  ['2026-03-04','평일','08:43','21:14'],['2026-03-05','평일','08:41','19:47'],
  ['2026-03-06','평일','08:42','19:38'],['2026-03-07','휴일',null,null],
  ['2026-03-08','휴일',null,null],['2026-03-09','평일','08:39','17:50'],
  ['2026-03-10','평일','08:43','18:17'],['2026-03-11','평일','08:42','18:12'],
  ['2026-03-12','평일','08:42','19:05'],['2026-03-13','평일','08:42','19:23'],
  ['2026-03-14','휴일',null,null],['2026-03-15','휴일',null,null],
  ['2026-03-16','평일','08:43','19:00'],['2026-03-17','평일','08:43','19:47'],
  ['2026-03-18','평일','08:45','21:22'],['2026-03-19','평일','08:42','18:41'],
  ['2026-03-20','평일',null,null],['2026-03-21','휴일',null,null],
  ['2026-03-22','휴일',null,null],['2026-03-23','평일','08:42','20:43'],
  ['2026-03-24','평일','08:40','18:44'],['2026-03-25','평일','08:40','20:06'],
  ['2026-03-26','평일','08:41','21:24'],['2026-03-27','평일','08:41','19:42'],
  ['2026-03-28','휴일',null,null],['2026-03-29','휴일',null,null],
  ['2026-03-30','평일',null,null],['2026-03-31','평일',null,null],
  ['2026-04-01','평일','08:43','21:29'],['2026-04-02','평일','08:41','20:54'],
  ['2026-04-03','평일','09:46','20:19'],['2026-04-04','휴일',null,null],
  ['2026-04-05','휴일',null,null],['2026-04-06','평일','08:40','+00:00'],
  ['2026-04-07','평일','08:44','20:08'],['2026-04-08','평일','08:46','19:13'],
  ['2026-04-09','평일','08:42','23:02'],['2026-04-10','평일','08:47','23:00'],
  ['2026-04-11','휴일',null,null],['2026-04-12','휴일',null,null],
  ['2026-04-13','평일','08:44','20:51'],['2026-04-14','평일','08:43','18:42'],
  ['2026-04-15','평일','08:44','20:50'],['2026-04-16','평일','08:40','23:40'],
  ['2026-04-17','평일',null,null],['2026-04-18','휴일',null,null],
  ['2026-04-19','휴일',null,null],['2026-04-20','평일','08:43','19:25'],
  ['2026-04-21','평일','08:43','23:02'],['2026-04-22','평일','08:44','18:57'],
  ['2026-04-23','평일','08:42','18:35'],['2026-04-24','평일','08:43','19:28'],
  ['2026-04-25','휴일',null,null],['2026-04-26','휴일',null,null],
  ['2026-04-27','평일','08:42','23:15'],['2026-04-28','평일','08:39','18:52'],
  ['2026-04-29','평일','08:43','+00:32'],
]

const KANG_RECORDS: RawRecord[] = KANG_DATA.map(([date, label, ci, co]) => {
  const isHoliday = HOLIDAYS.has(date)
  const dow = new Date(date).getDay()
  const dayType: DayType = isHoliday ? 'HOLIDAY' : (dow === 0 || dow === 6) ? 'WEEKEND' : 'WEEKDAY'
  return {
    employeeId: 'E1111111',
    date,
    dayType,
    dayLabel: label,
    clockIn: ci,
    clockOut: co,
    erpOtApplied: co !== null && !co.startsWith('+')
      ? parseInt(co.split(':')[0]) * 60 + parseInt(co.split(':')[1]) > 1140
      : co !== null,
  }
})

const P = { s: '2026-01-01', e: '2026-04-29' }

export const ALL_RECORDS: RawRecord[] = [
  ...KANG_RECORDS,
  ...generateRecords('E1111112', P.s, P.e, 1112, 'normal'),
  ...generateRecords('E1111113', P.s, P.e, 1113, 'overworker'),
  ...generateRecords('E1111114', P.s, P.e, 1114, 'standard'),
  ...generateRecords('E2222221', P.s, P.e, 2221, 'normal'),
  ...generateRecords('E2222222', P.s, P.e, 2222, 'overworker'),
  ...generateRecords('E2222223', P.s, P.e, 2223, 'standard'),
  ...generateRecords('E3333331', P.s, P.e, 3331, 'overworker'),
  ...generateRecords('E3333332', P.s, P.e, 3332, 'normal'),
  ...generateRecords('E4444441', P.s, P.e, 4441, 'normal'),
  ...generateRecords('E4444442', P.s, P.e, 4442, 'overworker'),
  ...generateRecords('E5555551', P.s, P.e, 5551, 'standard'),
  ...generateRecords('E5555552', P.s, P.e, 5552, 'normal'),
  ...generateRecords('E6666661', P.s, P.e, 6661, 'overworker'),
  ...generateRecords('E6666662', P.s, P.e, 6662, 'normal'),
  ...generateRecords('E7777771', P.s, P.e, 7771, 'standard'),
  ...generateRecords('E7777772', P.s, P.e, 7772, 'normal'),
  ...generateRecords('E8888881', P.s, P.e, 8881, 'overworker'),
  ...generateRecords('E8888882', P.s, P.e, 8882, 'standard'),
  ...generateRecords('E9999991', P.s, P.e, 9991, 'normal'),
  ...generateRecords('E9999992', P.s, P.e, 9992, 'overworker'),
  ...generateRecords('E0000001', P.s, P.e, 101, 'normal'),
  ...generateRecords('E0000002', P.s, P.e, 102, 'standard'),
]
