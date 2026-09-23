import type { ToolSchema } from "@deepseek-ai/dsh-llm"

export const FIND_TOOLS = "decision_room_find_tools"
export const TOOL_TOKEN_LIMIT = 8000
export const TOOL_COUNT_LIMIT = 8
export const discoverySchema: ToolSchema = {
  name: FIND_TOOLS,
  description:
    "在当前已注册的 MCP 工具中按需求检索，下一步加载匹配工具的完整参数。仅检索本地目录，不执行外部查询。找不到合适工具时保留证据缺口。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", minLength: 1, maxLength: 256 } },
    required: ["query"],
    additionalProperties: false,
  },
}

export const schemaTokens = (tools: ToolSchema[]) => Math.ceil(Buffer.byteLength(JSON.stringify(tools), "utf8") / 2)

function terms(text: string): string[] {
  const normalized = text.toLowerCase()
  const words: string[] = [...(normalized.match(/[a-z0-9]+/g) ?? [])]
  for (const phrase of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i < phrase.length - 1; i += 1) words.push(phrase.slice(i, i + 2))
  }
  return [...new Set(words)].filter(word => word.length > 1)
}

/** Ranking is local and deterministic. Full parameter schemas never enter the search result. */
export function selectTools(catalog: ToolSchema[], query: string, budget = TOOL_TOKEN_LIMIT): ToolSchema[] {
  const keywords = terms(query)
  const ranked = catalog
    .map(tool => {
      const name = tool.name.toLowerCase()
      const description = tool.description.toLowerCase()
      const score = keywords.reduce(
        (sum, word) => sum + (name.includes(word) ? 4 : description.includes(word) ? 1 : 0),
        0,
      )
      return { tool, score }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
  const selected: ToolSchema[] = []
  for (const { tool } of ranked) {
    if (selected.length >= TOOL_COUNT_LIMIT) break
    if (schemaTokens([...selected, tool]) <= budget) selected.push(tool)
  }
  return selected
}
