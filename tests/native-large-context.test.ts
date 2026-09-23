import { describe, expect, it, vi } from "vitest"
import type { Message } from "@deepseek-ai/dsh-llm"
import { DecisionEngine } from "../src/core/engine.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import type { ModelRequest } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { MemoryPersistence, RunStore } from "../src/core/store.js"
import { spent } from "../src/core/budget.js"
import { FIND_TOOLS, schemaTokens } from "../src/dsh/tool-selection.js"
import { nativeInputEstimate } from "../src/dsh/request-context.js"
import { complete, input } from "./fixtures.js"
import { largeCatalog, nativeRuntime } from "./native-runtime.js"

describe("真实 DSH 大工具目录回归", () => {
  it("151 个大工具经过真实流水线仍完成评审，最终发送过滤迟到的技能注入", async () => {
    const demo = new DemoGateway(0)
    const requests: ModelRequest[] = []
    const tools = largeCatalog()
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeGreaterThan(170000)
    const native = await nativeRuntime(
      {
        async generate(request) {
          requests.push(request)
          return demo.generate(request)
        },
      },
      tools,
    )
    const loggedForeign: string[] = []
    native.ctx.on("session/event", (_session, event) => {
      if (event.type === "user/message" && JSON.stringify(event.data).includes("unavailable-skill-catalog"))
        loggedForeign.push(event.type)
    })
    const stream = native.gateway.stream.bind(native.gateway)
    vi.spyOn(native.gateway, "stream").mockImplementation(options =>
      stream({
        ...options,
        messages: [
          ...options.messages,
          {
            id: "late" as Message["id"],
            role: "user",
            source: { kind: "plugin", plugin: "late-foreign" },
            content: [{ type: "text", text: "unavailable-skill-catalog" }],
          },
        ],
      }),
    )
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, native.gateway, "demo")
    try {
      await engine.initialize()
      const run = await complete(engine)
      expect(run.status, run.stopReason).toBe("completed")
      expect(requests).toHaveLength(17)
      expect(loggedForeign).toEqual([])
      for (const request of requests) {
        expect(JSON.stringify(request.dshMessages)).not.toContain("unavailable-skill-catalog")
        expect(request.dshMessages).toHaveLength(1)
        expect(request.tools!.filter(tool => tool.name.startsWith("mcp__")).length).toBeLessThanOrEqual(8)
        expect(schemaTokens(request.tools!)).toBeLessThanOrEqual(8000)
        expect(
          nativeInputEstimate(request.system, request.dshMessages!, request.tools) + request.maxOutputTokens,
        ).toBeLessThan(40000)
        const persisted = request.context!.currentRun!().calls.find(call => call.id === request.context!.callId)!
        expect(persisted.dispatchState).toBe("sending")
        expect(persisted.contextEstimate?.toolNames).toEqual(request.tools!.map(tool => tool.name))
      }
      expect(run.calls.every(call => call.contextEstimate && call.dispatchState === "sending")).toBe(true)
    } finally {
      await engine.dispose()
      await native.dispose()
    }
  })

  it("单个巨大工具定义不会被截断成错误 schema，也不会阻断评审", async () => {
    const tools = largeCatalog().slice(0, 1)
    tools[0]!.description = "客户交付风险证据查询".repeat(20000)
    const demo = new DemoGateway(0)
    const native = await nativeRuntime(
      {
        async generate(request) {
          expect(request.tools!.some(tool => tool.name === tools[0]!.name)).toBe(false)
          return demo.generate(request)
        },
      },
      tools,
    )
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, native.gateway, "demo")
    try {
      await engine.initialize()
      expect((await complete(engine)).status).toBe("completed")
    } finally {
      await engine.dispose()
      await native.dispose()
    }
  })

  it("未向模型展示的 MCP 即使被模型猜中也不能执行", async () => {
    const demo = new DemoGateway(0)
    let attempted = false
    let executed = 0
    const native = await nativeRuntime(
      {
        async generate(request) {
          const response = await demo.generate(request)
          if (request.context!.phase === "discuss" && !attempted) {
            attempted = true
            expect(request.tools!.some(tool => tool.name === "mcp__fixture__lookup_150")).toBe(false)
            return {
              ...response,
              finishReason: "tool_calls" as const,
              toolCalls: [
                { id: "unexposed", name: "mcp__fixture__lookup_150", arguments: JSON.stringify({ query: "合成主体" }) },
              ],
            }
          }
          return response
        },
      },
      largeCatalog(async () => {
        executed += 1
        return {}
      }),
    )
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, native.gateway, "demo")
    try {
      await engine.initialize()
      expect((await complete(engine)).status).toBe("completed")
      expect(attempted).toBe(true)
      expect(executed).toBe(0)
    } finally {
      await engine.dispose()
      await native.dispose()
    }
  })

  it("工具检索切换完整 schema，真实工具续答保留配对并缩小结果，原文留档", async () => {
    const demo = new DemoGateway(0)
    let step = 0
    let executed = 0
    let fullResultLogged = false
    const native = await nativeRuntime(
      {
        async generate(request) {
          if (request.context!.phase !== "discuss" || request.context!.seatId !== "business" || step >= 3)
            return demo.generate(request)
          step += 1
          const response = await demo.generate(request)
          if (step === 1)
            return {
              ...response,
              finishReason: "tool_calls" as const,
              toolCalls: [{ id: "find", name: FIND_TOOLS, arguments: JSON.stringify({ query: "needle_unique" }) }],
            }
          if (step === 2) {
            expect(request.tools!.some(tool => tool.name === "mcp__fixture__lookup_150")).toBe(true)
            expect(request.context!.currentRun!().mcpCalls).toHaveLength(0)
            return {
              ...response,
              finishReason: "tool_calls" as const,
              toolCalls: [
                { id: "lookup", name: "mcp__fixture__lookup_150", arguments: JSON.stringify({ query: "合成主体" }) },
              ],
            }
          }
          const results = request.dshMessages!.flatMap(message =>
            message.content.filter(block => block.type === "tool-result"),
          )
          expect(results.map(result => result.toolCallId)).toEqual(["find", "lookup"])
          expect(JSON.stringify(results)).toContain("Host：工具结果摘录")
          expect(Buffer.byteLength(JSON.stringify(results))).toBeLessThan(6500)
          return response
        },
      },
      largeCatalog(async () => {
        executed += 1
        return { text: "完整外部材料".repeat(20000) }
      }),
    )
    native.ctx.on("session/event", (_session, event) => {
      if (event.type === "tool/result" && JSON.stringify(event.data).length > 100000) fullResultLogged = true
    })
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, native.gateway, "demo")
    try {
      await engine.initialize()
      const run = await complete(engine)
      expect(run.status, run.stopReason).toBe("completed")
      expect(step).toBe(3)
      expect(executed).toBe(1)
      expect(fullResultLogged).toBe(true)
      expect(run.mcpCalls).toHaveLength(1)
      expect(run.mcpEvidence).toHaveLength(1)
      expect(run.calls.filter(call => call.purpose === "tool_followup")).toHaveLength(2)
      expect(run.calls.every(call => call.accounting === "reported")).toBe(true)
    } finally {
      await engine.dispose()
      await native.dispose()
    }
  })

  it("单份材料确实超限时不派发、不扣预留，保留诊断和失败记录", async () => {
    let sent = 0
    const native = await nativeRuntime({
      async generate() {
        sent += 1
        throw new Error("Unexpected dispatch")
      },
    })
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), DEFAULT_MODELS, native.gateway, "demo")
    try {
      await engine.initialize()
      const value = input()
      value.brief.plan = "材料内容。".repeat(10000)
      const run = await complete(engine, value)
      expect(run.status).toBe("paused")
      expect(run.stopCode).toBe("CONTEXT")
      expect(run.stopReason).toContain("材料和任务上下文过大")
      expect(sent).toBe(0)
      expect(spent(run)).toMatchObject({ tokens: 0, calls: 0, uncertain: 0 })
      expect(run.calls.length).toBeGreaterThan(0)
      expect(run.calls.every(call => call.dispatchState === "not_sent")).toBe(true)
    } finally {
      await engine.dispose()
      await native.dispose()
    }
  })
})
