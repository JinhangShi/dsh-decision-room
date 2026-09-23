import type { ContentBlock, Message, ToolSchema } from "@deepseek-ai/dsh-llm"
import type { ContextEstimate } from "../core/schema.js"

const plugin = "dsh-decision-room"
export function nativeInputEstimate(system: string, messages: Message[], tools: ToolSchema[] = []): number {
  return (
    512 +
    Math.ceil(
      Buffer.byteLength(
        JSON.stringify({
          system,
          messages: messages.map(message => ({ role: message.role, content: message.content })),
          tools,
        }),
        "utf8",
      ) / 2,
    )
  )
}

function excerpt(text: string, bytes: number, note: string): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text
  return `${Buffer.from(text)
    .subarray(0, Math.max(0, bytes - Buffer.byteLength(note)))
    .toString("utf8")
    .replace(/\ufffd$/u, "")}\n${note}`
}

/** Build a detached request view; the immutable session and full tool receipts remain intact. */
export function requestMessages(messages: Message[], modelKey: string): Message[] {
  const pairedResults = new Set(
    messages
      .filter(message => message.source.kind === "tool")
      .flatMap(message => message.content.filter(block => block.type === "tool-result").map(block => block.toolCallId)),
  )
  const calls = new Set<string>()
  let resultBytes = 12000
  let historyBytes = 16000
  return messages.flatMap(message => {
    if (message.source.kind === "plugin" && message.source.plugin === plugin && message.role === "user")
      return [structuredClone(message)]
    if (
      message.role === "assistant" &&
      message.source.kind === "model" &&
      message.source.provider === plugin &&
      message.source.model === modelKey
    ) {
      const content = message.content.flatMap((block): ContentBlock[] => {
        if (block.type === "tool-call") {
          if (!pairedResults.has(block.id)) return []
          calls.add(block.id)
          return [structuredClone(block)]
        }
        if (block.type !== "text") return []
        const text = excerpt(block.text, Math.min(4000, historyBytes), "[Host：历史回应摘录，完整原文保存在角色会话。]")
        historyBytes = Math.max(0, historyBytes - Buffer.byteLength(text))
        return [{ type: "text", text }]
      })
      return content.length ? [{ ...message, content }] : []
    }
    if (message.source.kind !== "tool") return []
    const content = message.content.flatMap((block): ContentBlock[] => {
      if (block.type !== "tool-result" || !calls.has(block.toolCallId)) return []
      const text = block.content
        .map(item => (item.type === "text" ? item.text : "[非文本工具结果，原文留档]"))
        .join("\n")
      const note = `[Host：工具结果摘录，调用 ${block.toolCallId}；完整结果保存在原始工具记录，未核验。]`
      const bounded = excerpt(text, Math.min(4000, resultBytes), note)
      resultBytes = Math.max(0, resultBytes - Buffer.byteLength(bounded))
      return [{ ...block, content: [{ type: "text", text: bounded }] }]
    })
    return content.length ? [{ ...message, content }] : []
  })
}

export function contextEstimate(
  system: string,
  messages: Message[],
  tools: ToolSchema[],
  outputTokens: number,
  contextTokens: number,
  availableTools: number,
): ContextEstimate {
  const size = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 2)
  const sum = (test: (message: Message) => boolean) =>
    messages.filter(test).reduce((total, message) => total + size({ role: message.role, content: message.content }), 0)
  return {
    systemTokens: size(system),
    materialTokens: sum(message => message.source.kind === "plugin"),
    historyTokens: sum(message => message.role === "assistant"),
    toolResultTokens: sum(message => message.source.kind === "tool"),
    toolDefinitionTokens: size(tools),
    inputTokens: nativeInputEstimate(system, messages, tools),
    outputTokens,
    contextTokens,
    toolCount: tools.filter(tool => tool.name.startsWith("mcp__")).length,
    availableTools,
    toolNames: tools.map(tool => tool.name),
    messageIds: messages.map(message => message.id),
  }
}

export function contextError(estimate: ContextEstimate, model: string): string {
  const cause =
    estimate.toolResultTokens > estimate.materialTokens
      ? "工具结果及续答过大"
      : estimate.historyTokens > estimate.materialTokens
        ? "历史回应过大"
        : "材料和任务上下文过大"
  const inputLimit = estimate.maxInputTokens === undefined ? "" : `，输入上限 ${estimate.maxInputTokens}`
  return `${model} 本地预检未通过（尚未发送）：${cause}。保守估算输入 ${estimate.inputTokens} + 输出预留 ${estimate.outputTokens}，配置容量 ${estimate.contextTokens}${inputLimit}；材料 ${estimate.materialTokens}、历史 ${estimate.historyTokens}、工具结果 ${estimate.toolResultTokens}、工具定义 ${estimate.toolDefinitionTokens} Token。已按需加载 ${estimate.toolCount}/${estimate.availableTools} 个 MCP 工具；已有结果保留。`
}
