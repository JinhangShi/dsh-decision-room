export const PERSPECTIVES = [
  { id: "business", label: "商业/用户价值" },
  { id: "delivery", label: "产品与交付" },
  { id: "risk", label: "财务/风险/合规" },
  { id: "challenge", label: "独立反方" },
  { id: "domain", label: "领域专家" },
] as const

export function perspectiveLabel(value: string): string {
  return PERSPECTIVES.find(item => item.id === value)?.label ?? value
}

export function perspectiveValue(label: string): string {
  return PERSPECTIVES.find(item => item.label === label)?.id ?? label
}
