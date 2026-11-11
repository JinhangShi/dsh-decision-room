import { afterEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import type { ToolCallId } from "@deepseek-ai/dsh-llm"
import type { ToolDefinition } from "@deepseek-ai/dsh-tools"
import { apply, type HostContext } from "../src/index.js"
import { runSchema } from "../src/core/schema.js"
import { input, until } from "./fixtures.js"
import { largeCatalog, nativeHost } from "./native-runtime.js"

afterEach(() => vi.unstubAllEnvs())

async function pluginHost() {
  vi.stubEnv("DSH_DECISION_DEMO", "1")
  const host = await nativeHost(largeCatalog().slice(0, 2))
  const records = new Map<string, unknown>()
  const tools = new Map<string, Parameters<HostContext["tools"]["register"]>[0]>()
  const disposers: Array<() => void> = []
  const context: HostContext = {
    ...host.services,
    systemPrompt: host.ctx.systemPrompt,
    webServer: { register: () => () => {} },
    skills: { register: () => () => {} },
    storageDomain: {
      async open() {
        return {
          table: () => ({
            entries: () => records.entries(),
            put: (key, value) => {
              records.set(key, structuredClone(value))
            },
          }),
        }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return host.ctx.tools.register(definition as ToolDefinition)
      },
    },
    effect(setup) {
      const dispose = setup()
      if (dispose) disposers.push(dispose)
    },
  }
  apply(context)
  const invoke = async (name: string, value: unknown) => {
    const batch = await host.ctx.tools.execute({
      calls: [{ type: "tool-call", id: randomUUID() as ToolCallId, name, arguments: JSON.stringify(value) }],
      agent: host.parent.agent,
      signal: new AbortController().signal,
    })
    const result = batch.results[0]!.result
    if (result.isError) throw new Error(result.error.message)
    return result.value as Record<string, unknown>
  }
  return {
    ...host,
    tools,
    invoke,
    read: (id: string) => runSchema.parse(records.get(id)),
    settled: (id: string) =>
      vi.waitUntil(
        () => {
          const run = runSchema.parse(records.get(id))
          return run.status !== "running" ? run : undefined
        },
        { timeout: 15000, interval: 10 },
      ),
    async dispose() {
      for (const dispose of disposers.reverse()) dispose()
      await until(() => !host.ctx.llm.listProviders().some(provider => provider.id === "dsh-decision-room"))
      await host.dispose()
    },
  }
}

describe("完整插件与真实 DSH 执行链", () => {
  it("全部工具可被宿主投影，首评、讨论、修订、复核及下一版在同一注册环境完成", async () => {
    const host = await pluginHost()
    try {
      // This uses DSH's strict lossless JSON projector, including hidden properties.
      const schemas = host.ctx.tools.schemas()
      expect(schemas.filter(tool => tool.name.startsWith("decision_room_"))).toHaveLength(7)
      const value = input()
      await expect(
        host.invoke("decision_room_start", {
          brief: value.brief,
          config: { ...value.config, limits: { ...value.config.limits, outputTokens: 100000 } },
        }),
      ).rejects.toThrow()
      const prepared = await host.invoke("decision_room_prepare", value.brief)
      expect(prepared.status).toBe("draft")
      const limits = await host.invoke("decision_room_limits", { id: prepared.id, limits: value.config.limits })
      expect(limits.limits).toEqual(value.config.limits)
      await host.invoke("decision_room_control", { id: prepared.id, action: "cancel" })
      const start = await host.invoke("decision_room_start", { brief: value.brief, config: value.config })
      expect(start.message).toContain("不代表模型已经收到请求")
      const id = String(start.id)
      const run = await host.settled(id)
      expect(run.status, run.stopReason).toBe("completed")
      expect(new Set(run.calls.map(call => call.phase))).toEqual(
        new Set(["independent", "organize", "discuss", "interpret", "revise", "verify"]),
      )
      expect(run.calls.every(call => call.status === "succeeded" && call.contextSessionId)).toBe(true)
      expect((await host.invoke("decision_room_status", { id })).status).toBe("completed")
      await host.invoke("decision_room_decide", { id, decision: "defer", reason: "合成验收：待补充证据后再决定。" })
      const original = host.read(id)
      const next = await host.invoke("decision_room_continue", {
        parentId: id,
        feedback: "新增合成反馈：维持原边界，复核交付依赖。",
        start: true,
      })
      const nextId = String(next.id)
      await host.settled(nextId)
      expect(host.read(nextId).status, host.read(nextId).stopReason).toBe("completed")
      expect(host.read(id)).toEqual(original)
      expect(host.parent.agent.session.snapshotEvents().some(event => event.type === "decision-room/progress")).toBe(
        true,
      )
    } finally {
      await host.dispose()
    }
  }, 30000)

  it("角色准备阶段错误保留原因并暂停；修复后在原任务预算内恢复", async () => {
    const host = await pluginHost()
    const remove = host.ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
      const scope = context.scope
      if (scope && "id" in scope && typeof scope.id === "string" && scope.id.startsWith("session-dr-")) {
        throw new Error("synthetic schema projection failure")
      }
      return next()
    })
    try {
      const value = input()
      value.config.limits.concurrency = 1
      const start = await host.invoke("decision_room_start", { brief: value.brief, config: value.config })
      const id = String(start.id)
      const failed = await host.settled(id)
      expect(failed.status).toBe("paused")
      expect(failed.stopCode).toBe("NATIVE_TURN_ERROR")
      expect(failed.stopReason).toContain("synthetic schema projection failure")
      expect(failed.calls).toHaveLength(1)
      expect(failed.calls[0]).toMatchObject({ accounting: "not_sent", accountedTokens: 0 })
      const receipt = structuredClone(failed.calls[0])
      remove()
      await host.invoke("decision_room_control", { id, action: "resume" })
      const restored = await host.settled(id)
      expect(restored.status, restored.stopReason).toBe("completed")
      expect(restored.config).toEqual(failed.config)
      expect(restored.calls[0]).toEqual(receipt)
    } finally {
      remove()
      await host.dispose()
    }
  }, 30000)
})
