import type { Model } from "./models.js"
import type { ContentBlock, Message, ToolSchema } from "@deepseek-ai/dsh-llm"
import { acceptsReturnedModel } from "./model-identity.js"
import { DecisionError, type ContextEstimate, type Phase, type Run, type Usage } from "./schema.js"

export type WireMessage = { role: "user" | "assistant"; content: string }
export type ContextDispatch = {
  purpose: "review" | "compaction" | "tool_followup"
  inputTokens: number
  inputEstimate?: number
  contextEstimate?: ContextEstimate
  outputTokens: number
  hash: string
  sessionId: string
}
export type ReviewContext = {
  run: Run
  callId?: string
  currentRun?(): Run
  phase: Phase
  seatId: string
  authorize(dispatch: ContextDispatch): Promise<string>
  preflight?(dispatch: ContextDispatch): Promise<void>
  receipt(id: string, response: ModelResponse | undefined, error?: string): Promise<void>
  authorizeTool(callId: string, name: string, args: unknown): Promise<void>
  toolDecision(
    callId: string,
    decision: "awaiting_approval" | "running" | "denied" | "failed",
    reason?: string,
  ): Promise<void>
  toolReceipt(callId: string, name: string, content: string, error?: string): Promise<void>
}

export type ModelRequest = {
  model: Model
  system: string
  prompt: string
  maxOutputTokens: number
  signal: AbortSignal
  messages?: WireMessage[]
  dshMessages?: Message[]
  tools?: ToolSchema[]
  headers?: Record<string, string>
  context?: ReviewContext
}
export type ModelResponse = {
  text: string
  returnedModel?: string
  usage?: Usage
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason?: "stop" | "tool_calls"
}
export interface ModelGateway {
  readonly managedContext?: boolean
  estimate?(system: string, prompt: string, output: number): number
  generate(request: ModelRequest): Promise<ModelResponse>
  dispose?(): Promise<void>
}
type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
function textBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n")
}
function chatMessages(messages: Message[]): JsonObject[] {
  return messages.flatMap<JsonObject>(message => {
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool-result" }> => block.type === "tool-result",
    )
    if (toolResults.length) {
      return toolResults.map(toolResult => ({
        role: "tool",
        tool_call_id: toolResult.toolCallId,
        content: textBlocks(toolResult.content),
      }))
    }
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: "tool-call" }> => block.type === "tool-call")
      .map(block => ({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } }))
    return {
      role: message.role === "system" ? "system" : message.role,
      content: textBlocks(message.content) || (toolCalls.length ? null : ""),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
  })
}
export class GatewayError extends DecisionError {
  constructor(
    code: string,
    message: string,
    public response?: ModelResponse,
  ) {
    super(code, message, 502)
  }
}

async function readLimited(response: Response, maximum = 2_000_000): Promise<unknown> {
  if (!response.body) {
    throw new GatewayError("EMPTY", "模型返回空响应")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      size += result.value.length
      if (size > maximum) {
        throw new GatewayError("RESPONSE_LIMIT", "模型响应超过大小上限")
      }
      chunks.push(result.value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      throw new GatewayError("INVALID_JSON", "网关没有返回有效 JSON 响应")
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export class HttpGateway implements ModelGateway {
  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    private fetcher: typeof fetch = fetch,
  ) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { model, system, prompt, maxOutputTokens, signal } = request
    const base = this.env[model.baseUrlEnv]?.trim()
    const key = this.env[model.apiKeyEnv]?.trim()
    if (!base || !key) {
      throw new DecisionError("CREDENTIALS", `${model.label} 缺少 Host 端网关地址或凭据`, 503)
    }
    const url = new URL(
      base.replace(/\/+$/, "") +
        "/" +
        { chat: "chat/completions", messages: "messages", responses: "responses", dsh: "" }[model.transport],
    )
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new DecisionError("ENDPOINT", "模型网关必须使用不含凭据、查询参数和片段的 HTTPS 地址")
    }
    const headers: Record<string, string> = {
      ...request.headers,
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    }
    const messages = request.messages ?? [{ role: "user" as const, content: prompt }]
    let body: JsonObject
    if (model.transport === "messages") {
      headers["anthropic-version"] = "2023-06-01"
      // Gateways and official Anthropic endpoints differ; both credential headers refer to the same configured endpoint.
      headers["x-api-key"] = key
      body = {
        ...model.extraBody,
        model: model.model,
        system,
        messages,
        max_tokens: maxOutputTokens,
      }
    } else if (model.transport === "responses") {
      body = {
        ...model.extraBody,
        model: model.model,
        instructions: system,
        input: request.messages ?? prompt,
        max_output_tokens: maxOutputTokens,
        store: false,
      }
    } else {
      body = {
        ...model.extraBody,
        model: model.model,
        messages: request.dshMessages
          ? [{ role: "system", content: system }, ...chatMessages(request.dshMessages)]
          : [{ role: "system", content: system }, ...messages],
        ...(request.tools?.length
          ? {
              tools: request.tools.map(tool => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              tool_choice: "auto",
            }
          : {}),
        stream: false,
        [model.outputParameter]: maxOutputTokens,
      }
    }
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      })
    } catch {
      throw new GatewayError(
        signal.aborted ? "ABORTED" : "NETWORK",
        signal.aborted ? "调用已停止或超时；上游费用可能仍产生" : "模型网络请求失败；已隐藏可能包含凭据的底层错误",
      )
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new GatewayError(
        `HTTP_${response.status}`,
        `${model.label} 返回 HTTP ${response.status}；请核对模型权限、入口和限流设置`,
      )
    }
    const payload = object(await readLimited(response))
    const returnedModel = typeof payload.model === "string" ? payload.model.slice(0, 200) : undefined
    const rawUsage = object(payload.usage)
    const plainInput = count(rawUsage.prompt_tokens ?? rawUsage.input_tokens)
    const input =
      plainInput === undefined
        ? undefined
        : plainInput +
          (model.transport === "messages"
            ? (count(rawUsage.cache_read_input_tokens) ?? 0) + (count(rawUsage.cache_creation_input_tokens) ?? 0)
            : 0)
    const output = count(rawUsage.completion_tokens ?? rawUsage.output_tokens)
    const usage =
      input !== undefined && output !== undefined
        ? {
            inputTokens: input,
            outputTokens: output,
            totalTokens: Math.max(input + output, count(rawUsage.total_tokens) ?? 0),
          }
        : undefined
    let text = ""
    let toolCalls: ModelResponse["toolCalls"]
    let finishReason: ModelResponse["finishReason"]
    let truncated = false
    if (Array.isArray(payload.choices)) {
      const choice = object(payload.choices[0])
      const message = object(choice.message)
      text = typeof message.content === "string" ? message.content : ""
      toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
            .map(object)
            .map(call => ({ call, fn: object(call.function) }))
            .filter(({ call, fn }) => typeof call.id === "string" && typeof fn.name === "string")
            .map(({ call, fn }) => ({
              id: String(call.id).slice(0, 200),
              name: String(fn.name).slice(0, 300),
              arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
            }))
        : undefined
      finishReason = choice.finish_reason === "tool_calls" || toolCalls?.length ? "tool_calls" : undefined
      truncated = choice.finish_reason === "length"
    } else if (Array.isArray(payload.content)) {
      text = payload.content
        .map(object)
        .filter(item => item.type === "text")
        .map(item => (typeof item.text === "string" ? item.text : ""))
        .join("")
      truncated = payload.stop_reason === "max_tokens"
    } else if (Array.isArray(payload.output)) {
      text = payload.output
        .map(object)
        .filter(item => item.type === "message")
        .flatMap(item => (Array.isArray(item.content) ? item.content : []))
        .map(object)
        .filter(item => item.type === "output_text")
        .map(item => (typeof item.text === "string" ? item.text : ""))
        .join("")
      truncated = payload.status === "incomplete"
    }
    const result: ModelResponse = {
      text,
      returnedModel,
      usage,
      ...(toolCalls?.length ? { toolCalls, finishReason: finishReason ?? "tool_calls" } : {}),
    }
    if (payload.error) {
      throw new GatewayError("UPSTREAM_ERROR", "网关返回了错误状态，未将其计为成功评审", result)
    }
    if (returnedModel && !acceptsReturnedModel(model.model, returnedModel)) {
      throw new GatewayError(
        "MODEL_MISMATCH",
        `模型身份不一致：请求 ${model.model}，返回 ${returnedModel}。已停止本次评审，请先确认网关映射`,
        result,
      )
    }
    if (truncated) {
      throw new GatewayError("TRUNCATED", "模型输出被截断；请增加输出额度后创建新版本，或缩小方案范围", result)
    }
    if (!text.trim() && !toolCalls?.length) {
      throw new GatewayError("EMPTY_TEXT", "模型未返回可见文本", result)
    }
    return result
  }
}

export type DshLlm = {
  stream(options: {
    provider: string
    model: string
    system: string
    messages: Array<{
      id: string
      role: "user" | "assistant"
      content: Array<{ type: "text"; text: string }>
      source: { kind: "plugin"; plugin: string }
    }>
    maxTokens: number
    signal: AbortSignal
  }): AsyncIterable<unknown>
}
export class DshGateway implements ModelGateway {
  constructor(private runtime: DshLlm) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    let text = ""
    let usage: Usage | undefined
    let finished = false
    for await (const raw of this.runtime.stream({
      provider: request.model.provider ?? "",
      model: request.model.model,
      system: request.system,
      messages: (request.messages ?? [{ role: "user" as const, content: request.prompt }]).map(message => ({
        id: crypto.randomUUID(),
        role: message.role,
        content: [{ type: "text" as const, text: message.content }],
        source: { kind: "plugin" as const, plugin: "dsh-decision-room" },
      })),
      maxTokens: request.maxOutputTokens,
      signal: request.signal,
    })) {
      const chunk = object(raw)
      if (request.signal.aborted) {
        throw new GatewayError("ABORTED", "宿主模型调用已停止", { text, usage })
      }
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text
      }
      if (text.length > 500000) {
        throw new GatewayError("RESPONSE_LIMIT", "宿主模型响应超过大小上限", { text: "", usage })
      }
      if (chunk.type === "usage") {
        const value = object(chunk.usage)
        const input = count(value.inputTokens)
        const output = count(value.outputTokens)
        if (input !== undefined && output !== undefined) {
          const allInput = input + (count(value.cacheReadTokens) ?? 0) + (count(value.cacheWriteTokens) ?? 0)
          usage = { inputTokens: allInput, outputTokens: output, totalTokens: allInput + output }
        }
      }
      if (chunk.type === "finish") {
        const reason = object(chunk.reason)
        if (reason.kind !== "stop") {
          throw new GatewayError("DSH_FINISH", "宿主模型未正常结束；请检查输出上限或模型连接", { text, usage })
        }
        finished = true
      }
    }
    if (!finished || !text.trim()) {
      throw new GatewayError("DSH_EMPTY", "宿主模型未完成有效文本响应", { text, usage })
    }
    // The provider-neutral stream does not attest to the upstream response model.
    return { text, usage }
  }
}
export class RoutedGateway implements ModelGateway {
  constructor(
    private http: ModelGateway,
    private dsh?: ModelGateway,
  ) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.model.transport === "dsh") {
      if (!this.dsh) {
        throw new DecisionError("DSH_LLM", "当前宿主没有可用的 llm 服务", 503)
      }
      return this.dsh.generate(request)
    }
    return this.http.generate(request)
  }
}
