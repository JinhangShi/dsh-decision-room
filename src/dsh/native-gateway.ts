import { createHash, randomUUID } from "node:crypto"
import {
  attributionHeaders,
  LlmAdapter,
  type GenerateOptions,
  type LlmRuntime,
  type Message,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm"
import type { Agent, AgentHandle, AgentRegistry } from "@deepseek-ai/dsh-agent"
import type { SessionId, SessionStore } from "@deepseek-ai/dsh-session"
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence"
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter"
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt"
import { DecisionError } from "../core/schema.js"
import { GatewayError, type ModelGateway, type ModelRequest, type ModelResponse } from "../core/gateway.js"
import type { Model } from "../core/models.js"

export type NativeServices = {
  agentPresets: { mount(ctx: Agent["ctx"], id?: string): Promise<unknown> }
  agents: AgentRegistry
  sessions: SessionStore
  sessionPersistence: SessionPersistence
  tokenMeter: TokenMeter
  llm: LlmRuntime
}
type Active = { request: ModelRequest; response?: ModelResponse; error?: unknown; dispatched: boolean }
const PROVIDER = "dsh-decision-room"
const textContent = (message: Message) =>
  message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")

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
      512 +
      output
    )
  }
  private async agent(request: ModelRequest): Promise<Agent> {
    const context = request.context!
    const id = `session-dr-${context.run.id}-${context.seatId}` as SessionId
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
          tools: { restrict(value: { allow: string[] }): unknown; guard?(guard: () => string): unknown }
        }
        scoped.tools.restrict({ allow: [] })
        scoped.tools.guard?.(() => "决策室评审角色只允许文本评审，禁止执行工具")
        scoped.systemPrompt.section({ name: "decision-room-review", order: -1000, complete: true, text: system })
        scoped.on("system-prompt/assemble", async (_assembly, _context, next) => {
          const result = await next()
          result.contexts = []
          result.tools = []
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
    const state: Active = { request, dispatched: false }
    this.active.set(agent.id, state)
    const abort = () => agent.cancel({ kind: "user" })
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      request.signal.throwIfAborted()
      const data = JSON.parse(request.prompt) as Record<string, unknown>
      if (agent.session.deriveMessages().length > 0) {
        const { title, question, objective, constraints } = request.context.run.brief
        data.brief = {
          title,
          question,
          objective,
          constraints,
          note: "完整原始方案和材料已在本角色 DSH 会话中提交；以当前硬约束为准。",
        }
      }
      const prompt = JSON.stringify(data)
      agent.followup({
        id: randomUUID() as Message["id"],
        role: "user",
        source: { kind: "plugin", plugin: "dsh-decision-room" },
        content: [{ type: "text", text: prompt }],
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
    const purpose = options.purpose === "compaction" ? "compaction" : "review"
    if (purpose === "review" && state.dispatched) {
      throw new DecisionError("RETRY_LIMIT", "本次步骤已发起模型请求，额外重试需要从检查点继续")
    }
    const output = Math.min(options.maxTokens ?? request.maxOutputTokens, request.maxOutputTokens)
    const input =
      this.estimate(options.system ?? "", "", 0) +
      options.messages.reduce((total, message) => total + this.services.tokenMeter.estimateMessage(message), 0)
    let receiptId: string | undefined
    let response: ModelResponse | undefined
    try {
      if (input + output > request.model.contextTokens) {
        throw new DecisionError(
          "CONTEXT",
          `${request.model.label} 经 DSH 处理后仍需约 ${input + output} Token，当前配置容量为 ${request.model.contextTokens}。请核对模型容量或拆分单份过大的材料；已有评审和角色会话已保留。`,
        )
      }
      receiptId = await request.context!.authorize({
        purpose,
        inputTokens: input,
        outputTokens: output,
        hash: createHash("sha256").update(JSON.stringify(options.messages)).digest("hex"),
        sessionId: String(options.sessionId),
      })
      if (purpose === "review") {
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
        headers: attributionHeaders(),
        signal,
      })
      await request.context!.receipt(receiptId, response)
      if (purpose === "review") {
        state.response = response
      }
      yield { type: "block-start", index: 0, blockType: "text" }
      yield { type: "text-delta", index: 0, text: response.text }
      yield { type: "block-end", index: 0, block: { type: "text", text: response.text } }
      if (response.usage) {
        yield {
          type: "usage",
          usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
        }
      }
      yield { type: "finish", reason: { kind: "stop" } }
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
