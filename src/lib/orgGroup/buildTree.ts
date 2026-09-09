export interface DeptRow {
  division: string
  team: string | null
  order: number
}

export interface GroupNode {
  key: string
  name: string
  parentKey: string | null
  order: number
}

/** Department 행 목록 → OrgGroup 트리 노드 목록. division당 정확히 1개 노드 + team마다 1개. */
export function buildGroupNodesFromDepartments(rows: DeptRow[]): GroupNode[] {
  const divisionOrder = new Map<string, number>()
  const teamRows: DeptRow[] = []

  for (const row of rows) {
    if (row.team === null) {
      if (!divisionOrder.has(row.division)) divisionOrder.set(row.division, row.order)
    } else {
      teamRows.push(row)
      if (!divisionOrder.has(row.division)) divisionOrder.set(row.division, row.order)
    }
  }

  const nodes: GroupNode[] = []
  for (const [division, order] of divisionOrder) {
    nodes.push({ key: division, name: division, parentKey: null, order })
  }
  for (const row of teamRows) {
    const key = `${row.division}::${row.team}`
    nodes.push({ key, name: row.team!, parentKey: row.division, order: row.order })
  }
  return nodes
}
