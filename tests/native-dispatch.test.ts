import { describe, expect, it } from "vitest"
import type { Agent, AgentHandle, PreStepDecision } from "@deepseek-ai/dsh-agent"
import type { GenerateOptions, Message, UserMessage } from "@deepseek-ai/dsh-llm"
import { DecisionEngine } from "../src/core/engine.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import type { ModelGateway, ModelRequest } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { MemoryPersistence, RunStore } from "../src/core/store.js"
import { NativeGateway, type NativeServices } from "../src/dsh/native-gateway.js"
import { FIND_TOOLS } from "../src/dsh/tool-selection.js"
import { complete } from "./fixtures.js"

/** Exercise the native adapter boundary without a provider or a user's DSH profile. */
function harness(http: ModelGateway, compact = false) {
  const sessions: Array<{ id: string; messages: UserMessage[]; disposed: boolean }> = []
  let gateway: NativeGateway
  type PreStep = (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
  type Assembly = { contexts: unknown[]; tools: NonNullable<GenerateOptions["tools"]>; system: string }
  type Assemble = (payload: unknown, context: unknown, next: () => Promise<Assembly>) => Promise<Assembly>
  const services = {
    sessionPersistence: { list: async () => [] },
    tokenMeter: { estimateMessage: (message: Message) => JSON.stringify(message.content).length / 4 },
    llm: { registerAdapter: () => () => {} },
    sessions: { flush: async () => true },
    agentPresets: { mount: async () => {} },
    agents: {
      get: () => undefined,
      async create(options: Parameters<NativeServices["agents"]["create"]>[0]) {
        const row = { id: String(options.sessionId), messages: [] as UserMessage[], disposed: false }
        sessions.push(row)
        const handlers = new Map<string, unknown>()
        let system = ""
        const ctx = {
          tools: { guard: () => {}, register: () => {} },
          systemPrompt: {
            section: (section: { text: string }) => {
              system = section.text
            },
          },
          on: (name: string, listener: unknown) => {
            handlers.set(name, listener)
          },
        }
        await options.setup?.(ctx as unknown as Agent["ctx"])
        const agent = {
          id: options.sessionId,
          status: "idle",
          session: { id: options.sessionId },
          cancel: () => {},
          followup(message: UserMessage) {
            row.messages.push(message)
          },
          async whenIdle() {
            const foreign: UserMessage = {
              id: "foreign-catalog" as Message["id"],
              role: "user",
              source: { kind: "plugin", plugin: "foreign-skills", form: "catalog" },
              content: [{ type: "text", text: "unavailable-skill-catalog" }],
            }
            const decision = await (handlers.get("agent/pre-step") as PreStep)({}, async () => ({
              kind: "enter",
              messages: [...row.messages, foreign],
            }))
            if (decision.kind !== "enter") throw new Error("Unexpected rejection")
            row.messages = decision.messages
            const assembly = await (handlers.get("system-prompt/assemble") as Assemble)({}, {}, async () => ({
              contexts: ["foreign task"],
              system,
              tools: [
                { name: "shell", description: "unavailable", parameters: {} },
                { name: "mcp__registry__lookup", description: "read material", parameters: { type: "object" } },
              ],
            }))
            expect(assembly.contexts).toEqual([])
            const request: GenerateOptions = {
              provider: "dsh-decision-room",
              model: options.agentOptions!.model!,
              sessionId: options.sessionId,
              messages: row.messages,
              system: assembly.system,
              tools: assembly.tools,
              maxTokens: 1000,
            }
            if (compact) {
              for await (const _chunk of gateway.stream({ ...request, purpose: "compaction" })) {
                /* drain */
              }
              for await (const _chunk of gateway.stream({ ...request, purpose: "compaction" })) {
                /* no reduction */
              }
            } else {
              for await (const _chunk of gateway.stream(request)) {
                /* drain */
              }
            }
          },
        }
        return {
          agent,
          dispose: async () => {
            row.disposed = true
          },
        } as unknown as AgentHandle
      },
    },
  } as unknown as NativeServices
  gateway = new NativeGateway(services, DEFAULT_MODELS, http)
  return { gateway, sessions }
}

describe("原生请求边界", () => {
  it("真实适配链按调用隔离上下文，过滤技能注入并仅向讨论阶段提供 MCP", async () => {
    const demo = new DemoGateway(0)
    const dispatched: ModelRequest[] = []
    const { gateway, sessions } = harness({
      async generate(request) {
        dispatched.push(request)
        expect(JSON.stringify(request.dshMessages)).not.toContain("unavailable-skill-catalog")
        expect(request.dshMessages).toHaveLength(1)
        expect(request.prompt).toContain("不得导出客户个人信息")
        const phase = request.context!.phase
        expect(request.tools?.map(tool => tool.name)).toEqual(phase === "discuss" ? [FIND_TOOLS] : [])
        return demo.generate(request)
      },
    })
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, gateway, "demo")
    await engine.initialize()
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(dispatched).toHaveLength(17)
    expect(new Set(sessions.map(session => session.id)).size).toBe(17)
    expect(sessions.every(session => session.disposed)).toBe(true)
    expect(run.calls.every(call => call.inputEstimate !== undefined && call.contextSessionId !== undefined)).toBe(true)
    await engine.dispose()
  })

  it("未缩短上下文的重复压缩在第二次外部派发前停止且保留已报告用量", async () => {
    let sent = 0
    const { gateway } = harness(
      {
        async generate() {
          sent += 1
          return { text: "压缩摘要", usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 } }
        },
      },
      true,
    )
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, gateway, "demo")
    await engine.initialize()
    const run = await complete(engine)
    expect(run.status).toBe("paused")
    // Each attempted native invocation sends at most one compaction; subsequent unchanged input is blocked.
    expect(run.calls.filter(call => call.purpose === "compaction")).toHaveLength(sent)
    expect(run.calls.filter(call => call.purpose === "compaction").every(call => call.accountedTokens === 500)).toBe(
      true,
    )
    expect(run.calls.some(call => call.error?.includes("连续压缩未有效缩短"))).toBe(true)
    await engine.dispose()
  })
})
