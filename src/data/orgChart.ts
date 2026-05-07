import type { Employee } from '@/types/tag'

export const EMPLOYEES: Employee[] = [
  { id: 'E1111111', name: '강악어', division: '피플본부', team: '인사기획팀', part: 'Biz파트', jobTitle: '매니저' },
  { id: 'E1111112', name: '박인사', division: '피플본부', team: '인사기획팀', part: 'Biz파트', jobTitle: '선임' },
  { id: 'E1111113', name: '최코어', division: '피플본부', team: '인사기획팀', part: 'Core파트', jobTitle: '책임' },
  { id: 'E1111114', name: '이조직', division: '피플본부', team: '조직문화팀', jobTitle: '매니저' },
  { id: 'E2222221', name: '김경영', division: '경영기획본부', team: '경영관리팀', jobTitle: '팀장' },
  { id: 'E2222222', name: '정재무', division: '경영기획본부', team: '재무회계팀', jobTitle: '매니저' },
  { id: 'E2222223', name: '한리스크', division: '경영기획본부', team: '리스크매니지먼트팀', jobTitle: '선임' },
  { id: 'E3333331', name: '오에스오피', division: 'SCM본부', team: 'S&OP팀', jobTitle: '책임' },
  { id: 'E3333332', name: '류물류', division: 'SCM본부', team: '물류운영팀', jobTitle: '매니저' },
  { id: 'E4444441', name: '신씨브이에스', division: 'GTM본부', team: 'GTM팀', part: 'CVS&Catering파트', jobTitle: '선임' },
  { id: 'E4444442', name: '임하이퍼', division: 'GTM본부', team: 'GTM팀', part: 'HYPER&B2B파트', jobTitle: '매니저' },
  { id: 'E5555551', name: '윤에이치엠알', division: 'HMR사업부문', team: '상품기획팀', jobTitle: '책임' },
  { id: 'E5555552', name: '조디자인', division: 'HMR사업부문', team: '디자인팀', jobTitle: '선임' },
  { id: 'E6666661', name: '서마케팅', division: '음료사업부문', team: '마케팅1팀', jobTitle: '매니저' },
  { id: 'E6666662', name: '문프로덕트', division: '음료사업부문', team: '프로덕트팀', part: '브랜드디자인파트', jobTitle: '선임' },
  { id: 'E7777771', name: '권헬스', division: '헬스케어사업부문', team: '브랜드1팀', jobTitle: '팀장' },
  { id: 'E7777772', name: '황온라인', division: '헬스케어사업부문', team: '온라인MD팀', jobTitle: '매니저' },
  { id: 'E8888881', name: '김그로스', division: '뷰티사업부문', team: '브레이마케팅팀', part: '그로스파트', jobTitle: '책임' },
  { id: 'E8888882', name: '안콘텐츠', division: '뷰티사업부문', team: '브레이마케팅팀', part: '콘텐츠파트', jobTitle: '선임' },
  { id: 'E9999991', name: '백신사업', division: '신사업본부', team: '신사업팀', part: '마케팅파트', jobTitle: '책임' },
  { id: 'E9999992', name: '하해외', division: '신사업본부', team: '신사업팀', part: '해외파트', jobTitle: '매니저' },
  { id: 'E0000001', name: '전전략', division: 'HQ', team: '전략기획팀', jobTitle: '팀장' },
  { id: 'E0000002', name: '송큐에이', division: 'HQ', team: '품질관리팀', part: 'QA파트', jobTitle: '선임' },
]

export function getDivisions(): string[] {
  return [...new Set(EMPLOYEES.map(e => e.division))]
}
