'use client'
import { OrgGroupManageTab } from '@/components/admin/OrgGroupManageTab'

/**
 * 상단 네비게이션 "조직도" 페이지 — OrgGroup/OrgGroupMember 기반 조직도 관리 전용
 * (2026-09-09). 예전 엑셀 동기화 기반 "조직도"/"이상치" 토글 화면은 사용자 요청으로
 * 이 페이지에서 완전히 제거함 — git 이력(이 커밋 이전)에 남아있어 필요하면 복구 가능.
 */
export default function OrgChartPage() {
  return (
    <div className="p-6 space-y-5 max-w-[1600px]">
      <h1 className="text-lg font-bold text-gray-900">조직도</h1>
      <OrgGroupManageTab />
    </div>
  )
}
