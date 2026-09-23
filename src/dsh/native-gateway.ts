import { createHash, randomUUID } from "node:crypto"
import {
  attributionHeaders,
  LlmAdapter,
  type GenerateOptions,
  type LlmRuntime,
  type Message,
  type UserMessage,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm"
import type { Agent, AgentHandle, AgentRegistry, PreStepDecision } from "@deepseek-ai/dsh-agent"
import type { SessionId, SessionStore } from "@deepseek-ai/dsh-session"
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence"
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter"
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt"
import { DecisionError, type Phase, type Run } from "../core/schema.js"
import { GatewayError, type ModelGateway, type ModelRequest, type ModelResponse } from "../core/gateway.js"
import type { Model } from "../core/models.js"
import { mcpBlockedReason } from "../core/mcp-status.js"

export type NativeServices = {
  agentPresets: { mount(ctx: Agent["ctx"], id?: string): Promise<unknown> }
  agents: AgentRegistry
  sessions: SessionStore
  sessionPersistence: SessionPersistence
  tokenMeter: TokenMeter
  llm: LlmRuntime
}
type Active = {
  request: ModelRequest
  response?: ModelResponse
  primaryResponse?: ModelResponse
  error?: unknown
  dispatched: boolean
  compactionInputs: number[]
}
const PROVIDER = "dsh-decision-room"
const textContent = (message: Message) =>
  message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")

export function mcpToolsForPhase<T extends { name: string }>(tools: T[], phase: Phase | undefined): T[] {
  return phase === "discuss" ? tools.filter(tool => tool.name.startsWith("mcp__")) : []
}

export function reviewMessages(messages: UserMessage[]): UserMessage[] {
  return messages.filter(
    message =>
      message.source.kind === "tool" ||
      (message.source.kind === "plugin" && message.source.plugin === "dsh-decision-room"),
  )
}

/** A UTF-8 density bound complements DSH's fixed four-characters heuristic for Chinese text. */
export function nativeInputEstimate(system: string, messages: Message[], tools: GenerateOptions["tools"]): number {
  return (
    512 +
    Math.ceil(
      Buffer.byteLength(
        JSON.stringify({
          system,
          messages: messages.map(message => ({ role: message.role, content: message.content })),
          tools: tools ?? [],
        }),
        "utf8",
      ) / 2,
    )
  )
}

export function calibratedInputEstimate(run: Run, modelKey: string, estimate: number): number {
  const ratios = run.calls
    .filter(call => call.modelKey === modelKey && call.inputEstimate && call.usage)
    .map(call => call.usage!.inputTokens / call.inputEstimate!)
  return Math.ceil(estimate * Math.max(1, ...ratios.map(ratio => (ratio > 1 ? ratio * 1.1 : 1))))
}

export function reviewSessionId(request: ModelRequest): SessionId {
  const context = request.context!
  // Each authorized attempt owns a fresh context. Its complete log remains durable.
  return `session-dr-${context.run.id}-${context.seatId}-${context.callId ?? randomUUID()}` as SessionId
}

class DecisionAdapter extends LlmAdapter {
  constructor(private owner: NativeGateway) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: "决策室（受任务预算控制）" }
  }
  override providerRetryPolicy() {
    return {
      mode: "normal" as const,
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 500,
      maxDelayMs: 1000,
      jitterRatio: 0,
    }
  }
  override async listModels() {
    return this.owner.models
      .filter(model => model.enabled)
      .map(model => ({ provider: PROVIDER, id: model.key, name: model.label, inputModalities: ["text" as const] }))
  }
  override async resolveModel(provider: string, key: string) {
    const model = this.owner.models.find(value => value.key === key && value.enabled)
    if (!model) {
      throw new DecisionError("MODEL_UNAVAILABLE", "决策席位模型不可用")
    }
    return {
      provider,
      id: key,
      name: model.label,
      context: { contextWindow: model.contextTokens },
      defaultMaxTokens: 8000,
      inputModalities: ["text" as const],
    }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.owner.stream(options)
  }
}

/** Native agents own history replay, token metering and automatic compaction. The adapter only translates the existing gateway. */
export class NativeGateway implements ModelGateway {
  readonly managedContext = true
  private active = new Map<string, Active>()
  private handles = new Map<string, AgentHandle>()
  private pending = new Map<string, Promise<Agent>>()
  private known: Promise<Set<string>>
  private unregister: () => void
  constructor(
    readonly services: NativeServices,
    readonly models: Model[],
    private http: ModelGateway,
  ) {
    this.known = services.sessionPersistence.list().then(headers => new Set(headers.map(header => String(header.id))))
    this.unregister = services.llm.registerAdapter([PROVIDER], new DecisionAdapter(this))
  }
  estimate(system: string, prompt: string, output: number): number {
    return (
      Math.max(
        nativeInputEstimate(
          system,
          [
            {
              id: "estimate" as Message["id"],
              role: "user",
              content: [{ type: "text", text: prompt }],
              source: { kind: "plugin", plugin: "dsh-decision-room" },
            },
          ],
          [],
        ),
        this.services.tokenMeter.estimateMessage({
          id: "estimate" as Message["id"],
          role: "system",
          content: [{ type: "text", text: system }],
          source: { kind: "plugin", plugin: "dsh-decision-room" },
        }) +
          this.services.tokenMeter.estimateMessage({
            id: "estimate-input" as Message["id"],
            role: "user",
            content: [{ type: "text", text: prompt }],
            source: { kind: "plugin", plugin: "dsh-decision-room" },
          }) +
          512,
      ) + output
    )
  }
  private async agent(request: ModelRequest): Promise<Agent> {
    const context = request.context!
    const id = reviewSessionId(request)
    const owned = this.handles.get(id)?.agent
    if (owned) {
      return owned
    }
    const pending = this.pending.get(id)
    if (pending) {
      return pending
    }
    const operation = (async () => {
      if (this.services.agents.get(id)) {
        throw new DecisionError("SESSION_OWNER", "评审角色会话已被其他运行实例占用")
      }
      const system = `${request.system}\n以下为本次评审不可被摘要或历史发言覆盖的任务边界：\n${JSON.stringify({ question: context.run.brief.question, objective: context.run.brief.objective, constraints: context.run.brief.constraints })}`
      const setup: NonNullable<Parameters<AgentRegistry["create"]>[0]["setup"]> = async ctx => {
        await this.services.agentPresets.mount(ctx, "standard")
        const scoped = ctx as typeof ctx & {
          systemPrompt: SystemPrompt
          tools: {
            guard?(guard: (exec: { name: string }) => string | undefined): unknown
          }
          on(
            name: "agent/pre-step",
            listener: (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
          ): unknown
          on(
            name: "tools/pre-execute",
            listener: (
              exec: { callId: string; name: string; arguments: unknown },
              next: () => Promise<{ kind: "allow" | "deny" | "ask"; reason?: string }>,
            ) => Promise<{ kind: "allow" | "deny" | "ask"; reason?: string }>,
          ): unknown
          on(
            name: "tools/post-execute",
            listener: (
              exec: { callId: string; name: string },
              result: { isError: boolean; content: Message["content"] },
              next: () => Promise<unknown>,
            ) => Promise<unknown>,
          ): unknown
        }
        scoped.tools.guard?.(exec =>
          exec.name.startsWith("mcp__") && this.active.get(id)?.request.context?.phase === "discuss"
            ? undefined
            : "决策室只在首轮结果公开后的交叉讨论阶段允许调用 MCP 工具",
        )
        scoped.on("tools/pre-execute", async (exec, next) => {
          if (!exec.name.startsWith("mcp__")) return { kind: "deny", reason: "仅允许 MCP 工具" }
          const active = this.active.get(id)
          if (!active?.request.context) return { kind: "deny", reason: "MCP 调用不属于活动评审任务" }
          if (active.request.context.phase !== "discuss") {
            return { kind: "deny", reason: "独立首评隔离期间不允许外部工具" }
          }
          try {
            await active.request.context.authorizeTool(String(exec.callId), exec.name, exec.arguments)
          } catch (error) {
            if (error instanceof DecisionError) return { kind: "deny", reason: error.message }
            throw error
          }
          try {
            // DSH remains the authority for the tool's actual permission. The model may
            // select any registered MCP, but it cannot bypass the host policy here.
            const decision = await next()
            await active.request.context.toolDecision(
              String(exec.callId),
              decision.kind === "ask" ? "awaiting_approval" : decision.kind === "allow" ? "running" : "denied",
              decision.reason,
            )
            return decision
          } catch (error) {
            await active.request.context.toolDecision(
              String(exec.callId),
              "failed",
              error instanceof DecisionError ? error.message : "DSH 工具策略处理失败",
            )
            throw error
          }
        })
        scoped.on("tools/post-execute", async (exec, result, next) => {
          const active = this.active.get(id)
          if (active?.request.context && exec.name.startsWith("mcp__")) {
            const content = result.content
              .map(block => (block.type === "text" ? block.text : JSON.stringify(block)))
              .join("\n")
            await active.request.context.toolReceipt(
              String(exec.callId),
              exec.name,
              content,
              result.isError ? content || "MCP 工具返回失败" : undefined,
            )
          }
          return next()
        })
        scoped.systemPrompt.section({ name: "decision-room-review", order: -1000, complete: true, text: system })
        scoped.on("agent/pre-step", async (_payload, next) => {
          const decision = await next()
          return decision.kind === "enter" ? { ...decision, messages: reviewMessages(decision.messages) } : decision
        })
        scoped.on("system-prompt/assemble", async (_assembly, _context, next) => {
          const result = await next()
          result.contexts = []
          const context = this.active.get(id)?.request.context
          const run = context?.currentRun?.() ?? context?.run
          result.tools = mcpToolsForPhase(result.tools, context?.phase).filter(
            tool => !run || (run.mcpCalls.length < run.config.limits.maxMcpCalls && !mcpBlockedReason(run, tool.name)),
          )
          return result
        })
        scoped.on("agent/request", async ({ agent }, next) => {
          const config = await next()
          const active = this.active.get(agent.id)
          return active
            ? {
                ...config,
                provider: PROVIDER,
                model: active.request.model.key,
                maxTokens: active.request.maxOutputTokens,
              }
            : config
        })
      }
      const agentOptions = { provider: PROVIDER, model: request.model.key, maxTokens: request.maxOutputTokens }
      const known = await this.known
      const handle = known.has(id)
        ? await this.services.agents.resume({ resumeSessionId: id, agentOptions, setup, signal: request.signal })
        : await this.services.agents.create({
            sessionId: id,
            agentOptions,
            setup,
            signal: request.signal,
            meta: {
              cwd: context.run.scope.workspaceId,
              parentSession: context.run.scope.sessionId as SessionId,
              origin: "subagent",
              delegationDepth: 1,
              agentPreset: "standard",
            },
          })
      this.handles.set(id, handle)
      known.add(id)
      return handle.agent
    })()
    this.pending.set(id, operation)
    try {
      return await operation
    } finally {
      this.pending.delete(id)
    }
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!request.context) {
      throw new DecisionError("NATIVE_CONTEXT", "评审调用缺少 DSH 会话归属")
    }
    const agent = await this.agent(request)
    if (agent.status !== "idle" || this.active.has(agent.id)) {
      throw new DecisionError("BUSY", "评审角色正在处理上一条消息")
    }
    const state: Active = { request, dispatched: false, compactionInputs: [] }
    this.active.set(agent.id, state)
    const abort = () => agent.cancel({ kind: "user" })
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      request.signal.throwIfAborted()
      agent.followup({
        id: randomUUID() as Message["id"],
        role: "user",
        source: { kind: "plugin", plugin: "dsh-decision-room" },
        content: [{ type: "text", text: request.prompt }],
      })
      await agent.whenIdle()
      await this.services.sessions.flush(agent.session)
      if (state.error) {
        throw state.error
      }
      if (request.signal.aborted) {
        throw new DecisionError("ABORTED", "DSH 评审已停止，保留原始会话记录")
      }
      if (!state.response) {
        throw new DecisionError("NATIVE_RESPONSE", "DSH 角色未完成评审，请查看会话与预算状态")
      }
      return state.response
    } finally {
      request.signal.removeEventListener("abort", abort)
      this.active.delete(agent.id)
      const handle = this.handles.get(agent.id)
      this.handles.delete(agent.id)
      await handle?.dispose()
    }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const state = options.sessionId ? this.active.get(options.sessionId) : undefined
    if (!state || !state.request.context || options.purpose === "session-title") {
      throw new DecisionError("AUTHORIZATION", "决策室模型只能在已授权的评审任务预算内调用")
    }
    const { request } = state
    if (state.error) {
      throw state.error
    }
    if (options.model !== request.model.key) {
      throw new DecisionError("MODEL_ROUTE", "DSH 会话路由与席位模型不一致")
    }
    const purpose = options.purpose === "compaction" ? "compaction" : state.dispatched ? "tool_followup" : "review"
    const output = Math.min(options.maxTokens ?? request.maxOutputTokens, request.maxOutputTokens)
    const heuristic =
      this.estimate(options.system ?? "", "", 0) +
      options.messages.reduce((total, message) => total + this.services.tokenMeter.estimateMessage(message), 0)
    const inputEstimate = Math.max(
      heuristic,
      nativeInputEstimate(options.system ?? "", options.messages, options.tools),
    )
    const input = calibratedInputEstimate(
      request.context!.currentRun?.() ?? request.context!.run,
      request.model.key,
      inputEstimate,
    )
    let receiptId: string | undefined
    let response: ModelResponse | undefined
    try {
      if (purpose === "compaction") {
        const previous = state.compactionInputs.at(-1)
        if (state.compactionInputs.length >= 2 || (previous !== undefined && input >= previous * 0.9)) {
          throw new DecisionError("CONTEXT", "连续压缩未有效缩短上下文；已停止重复压缩，原始材料和阶段结果已保留")
        }
        state.compactionInputs.push(input)
      }
      if (input + output > request.model.contextTokens) {
        throw new DecisionError(
          "CONTEXT",
          `${request.model.label} 经 DSH 处理后仍需约 ${input + output} Token，当前配置容量为 ${request.model.contextTokens}。请核对模型容量或拆分单份过大的材料；已有评审和角色会话已保留。`,
        )
      }
      receiptId = await request.context!.authorize({
        purpose,
        inputTokens: input,
        inputEstimate,
        outputTokens: output,
        hash: createHash("sha256").update(JSON.stringify(options.messages)).digest("hex"),
        sessionId: String(options.sessionId),
      })
      if (purpose !== "compaction") {
        state.dispatched = true
      }
      const signal = options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal
      response = await this.http.generate({
        ...request,
        system: options.system ?? request.system,
        maxOutputTokens: output,
        messages: options.messages
          .filter(message => message.role !== "system")
          .map(message => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: textContent(message),
          })),
        dshMessages: options.messages,
        tools: options.tools,
        headers: attributionHeaders(),
        signal,
      })
      await request.context!.receipt(receiptId, response)
      if (purpose === "review") {
        state.primaryResponse = response
      }
      if (response.finishReason === "tool_calls" && response.toolCalls?.length) {
        for (const [index, call] of response.toolCalls.entries()) {
          yield { type: "block-start", index, blockType: "tool-call" }
          yield {
            type: "tool-call-delta",
            index,
            id: call.id as Extract<StreamChunk, { type: "tool-call-delta" }>["id"],
            name: call.name,
            argumentsDelta: call.arguments,
          }
          yield {
            type: "block-end",
            index,
            block: {
              type: "tool-call",
              id: call.id as Extract<StreamChunk, { type: "tool-call-delta" }>["id"],
              name: call.name,
              arguments: call.arguments,
            },
          }
        }
      } else {
        if (purpose !== "compaction") {
          state.response =
            purpose === "tool_followup" && state.primaryResponse
              ? {
                  ...response,
                  returnedModel: state.primaryResponse.returnedModel ?? response.returnedModel,
                  usage: state.primaryResponse.usage,
                }
              : response
        }
        yield { type: "block-start", index: 0, blockType: "text" }
        yield { type: "text-delta", index: 0, text: response.text }
        yield { type: "block-end", index: 0, block: { type: "text", text: response.text } }
      }
      if (response.usage) {
        yield {
          type: "usage",
          usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
        }
      }
      yield {
        type: "finish",
        reason: { kind: response.finishReason === "tool_calls" ? "tool-calls" : "stop" },
      }
    } catch (error) {
      state.error = error
      if (receiptId) {
        await request.context!.receipt(
          receiptId,
          response ?? (error instanceof GatewayError ? error.response : undefined),
          error instanceof DecisionError ? error.message : "DSH 上下文处理失败",
        )
      }
      throw error
    }
  }
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
    this.unregister()
  }
}
