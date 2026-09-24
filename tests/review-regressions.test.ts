import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Message, UserMessage } from "@deepseek-ai/dsh-llm"
import { closingHold, reserveCheck, spent } from "../src/core/budget.js"
import { assessDeliberation, discussionDelta } from "../src/core/deliberation.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { DecisionEngine } from "../src/core/engine.js"
import type { ModelGateway } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { mcpBlockedReason } from "../src/core/mcp-status.js"
import { makePrompt } from "../src/core/prompts.js"
import { reportMarkdown } from "../src/core/report.js"
import { readDebateResult, REVIEW_MODES, type Run } from "../src/core/schema.js"
import { RunStore } from "../src/core/store.js"
import { DecisionProgressCard } from "../src/chat-messages.js"
import { decisionMessages, decisionProgress, type DecisionMessage } from "../src/dsh/messages.js"
import {
  calibratedInputEstimate,
  nativeInputEstimate,
  reviewMessages,
  reviewSessionId,
  type NativeServices,
} from "../src/dsh/native-gateway.js"
import { DecisionTranscript } from "../src/dsh/transcript.js"
import { complete, input, setup } from "./fixtures.js"

function frozenGateway(continueDiscussion: boolean): ModelGateway {
  const demo = new DemoGateway(0)
  return {
    async generate(request) {
      const response = await demo.generate(request)
      const prompt = JSON.parse(request.prompt)
      if (prompt.phase === "discuss") {
        const result = JSON.parse(response.text)
        result.continueDiscussion = continueDiscussion
        for (const item of result.responses) {
          item.position = "maintain"
          item.blocking = true
          item.newInformation = true
          item.reasoning = `第 ${prompt.round} 轮重新表述同一项证据缺口`
        }
        response.text = JSON.stringify(result)
      }
      return response
    },
  }
}

describe("真实长评审故障回归", () => {
  it("重复改写并自报新信息不能阻止 Host 三轮收敛，异议仍留档", async () => {
    const { engine } = await setup(frozenGateway(true))
    const value = input()
    value.config.limits = structuredClone(REVIEW_MODES.find(mode => mode.id === "deep")!.limits)
    const run = await complete(engine, value)
    expect(run.status).toBe("completed")
    expect(run.round).toBe(4)
    expect(assessDeliberation(run).stagnantRounds).toBe(3)
    expect(discussionDelta(run, 4).reportedNewInformation).toBe(4)
    expect(reportMarkdown(run, engine.models)).toContain("第 4 轮重新表述同一项证据缺口")
  })

  it("席位一致建议停止且无 Host 增量时，覆盖达标即可修订", async () => {
    const { engine } = await setup(frozenGateway(false))
    const run = await complete(engine)
    expect(run.round).toBe(2)
    expect(run.status).toBe("completed")
    expect(assessDeliberation(run)).toMatchObject({
      coverageSatisfied: true,
      noNewInformation: true,
      noFurtherDiscussion: true,
    })
  })

  it("席位轮换不掩盖同一席位改票，缺席轮不能算作稳定或一致停止", async () => {
    const { engine } = await setup(frozenGateway(true))
    const run = await complete(engine)
    const base = run.calls.find(call => call.phase === "discuss" && call.round === 1)!
    const result = readDebateResult(base.result)
    run.calls.push({
      ...base,
      id: "changed",
      round: 5,
      result: { ...result, responses: result.responses.map(item => ({ ...item, position: "reject" })) },
    })
    const delta = discussionDelta(run, 5)
    expect(delta.changedBallots).toContainEqual({ seatId: base.seatId, issueId: result.responses[0]!.issueId })
    expect(assessDeliberation(run, 5)).toMatchObject({
      stableBallots: false,
      noFurtherDiscussion: false,
      stagnantRounds: 0,
    })
  })

  it("同一 MCP 内容再次获取不重置稳定窗口", async () => {
    const demo = frozenGateway(true)
    const { engine } = await setup({
      async generate(request) {
        const context = request.context!
        if (context.phase === "discuss" && context.seatId === "business") {
          const id = `lookup-${context.run.round}`
          await context.authorizeTool(id, "mcp__registry__lookup", {})
          await context.toolReceipt(id, "mcp__registry__lookup", "同一份未经独立核验的材料")
        }
        return demo.generate(request)
      },
    })
    const run = await complete(engine)
    expect(run.mcpEvidence).toHaveLength(1)
    expect(new Set(run.mcpCalls.map(call => call.evidenceId)).size).toBe(1)
    expect(run.round).toBe(4)
    expect(discussionDelta(run, 4).newEvidenceIds).toEqual([])
  })

  it("认证失败熔断同一连接器，保留尝试记录并允许其他连接器补证", async () => {
    const demo = new DemoGateway(0)
    let attempted = false
    const { engine } = await setup({
      async generate(request) {
        const context = request.context!
        if (context.phase === "discuss" && !attempted) {
          attempted = true
          await context.authorizeTool("expired", "mcp__registry__lookup", {})
          await context.toolReceipt("expired", "mcp__registry__lookup", "", "invalid_token")
          await expect(context.authorizeTool("blocked", "mcp__registry__risk", {})).rejects.toMatchObject({
            code: "MCP_UNAVAILABLE",
          })
          await context.authorizeTool("other", "mcp__public__search", {})
          await context.toolReceipt("other", "mcp__public__search", "另一连接器提供的材料")
        }
        return demo.generate(request)
      },
    })
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.mcpCalls).toHaveLength(2)
    const prompt = JSON.parse(makePrompt(run, "interpret", "moderator"))
    expect(prompt.mcpStatus).toMatchObject({ attempts: 2, successfulSources: 1 })
    expect(prompt.mcpStatus.calls[0]).toMatchObject({ status: "failed", failureKind: "authentication" })
    expect(mcpBlockedReason(run, "mcp__registry__risk")).toContain("认证失败")
    const otherScope = structuredClone(run)
    otherScope.mcpCalls = []
    expect(mcpBlockedReason(otherScope, "mcp__registry__risk")).toBeUndefined()
    run.events.push({ id: "user-resume", at: Date.now() + 1, type: "resume", text: "连接已修复，继续" })
    expect(mcpBlockedReason(run, "mcp__registry__risk")).toBeUndefined()
  })

  it("收尾预留在任何请求前持久化，低预算并发不能占用它", async () => {
    let sent = 0
    const demo = new DemoGateway(100)
    const { engine, persistence } = await setup({
      estimate: () => 1000,
      async generate(request) {
        sent += 1
        const saved = persistence.records.get(request.context!.run.id)!
        expect(saved.closingReserve).toBeDefined()
        expect(spent(saved).tokens + closingHold(saved, "independent").tokens).toBeLessThanOrEqual(
          saved.config.limits.tokenBudget,
        )
        return demo.generate(request)
      },
    })
    const value = input()
    value.config.limits.outputTokens = 512
    value.config.limits.tokenBudget = 5058
    const run = await complete(engine, value)
    expect(sent).toBe(1)
    expect(run.status).toBe("paused")
    expect(run.calls[0]?.accounting).toBe("uncertain")
    expect(run.stopCode).toBe("CLOSING_RESERVE")
    const generate = vi.fn()
    const recovered = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, { generate })
    await recovered.initialize()
    expect(recovered.store.get(run.id).closingReserve).toEqual(run.closingReserve)
    expect(generate).not.toHaveBeenCalled()
  })

  it("讨论中的压缩和工具续答也受收尾预留约束，转入修订仍能完成", async () => {
    const demo = frozenGateway(true)
    const { engine } = await setup({
      managedContext: true,
      estimate: () => 1000,
      async generate(request) {
        if (request.context!.phase === "discuss") {
          await request.context!.authorize({
            purpose: "compaction",
            inputTokens: 50000,
            outputTokens: 1000,
            hash: "large",
            sessionId: "isolated",
          })
          throw new Error("不应派发压缩")
        }
        return demo.generate(request)
      },
    })
    const value = input()
    value.config.limits.outputTokens = 512
    value.config.limits.tokenBudget = 60000
    const run = await complete(engine, value)
    expect(run.status).toBe("completed")
    expect(run.calls.some(call => call.purpose === "compaction")).toBe(false)
    expect(run.revisionResult).toBeDefined()
    expect(run.verification).toBeDefined()
    expect(spent(run).tokens).toBeLessThanOrEqual(60000)
    expect(() => reserveCheck({ ...run, status: "running", calls: [] }, 50000, null, "discuss")).toThrow("修订")
  })

  it("收尾时间窗口耗尽时提前修订，不等待总时限用尽", async () => {
    const demo = frozenGateway(true)
    const { engine } = await setup({
      estimate: () => 1000,
      async generate(request) {
        const result = await demo.generate(request)
        if (request.context!.phase === "organize")
          await engine.store.update(request.context!.run.id, run => {
            run.elapsedMs = run.config.limits.maxDurationMinutes * 60000 - closingHold(run, "discuss").durationMs - 1
          })
        return result
      },
    })
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.calls.some(call => call.phase === "discuss")).toBe(false)
  })

  it("中文和工具 schema 纳入估算，历史用量低估会提高后续预留", async () => {
    const messages: Message[] = [
      {
        id: "cn" as Message["id"],
        role: "user",
        source: { kind: "plugin", plugin: "dsh-decision-room" },
        content: [{ type: "text", text: "中文评审材料".repeat(100) }],
      },
    ]
    const bare = nativeInputEstimate("边界", messages, [])
    expect(bare).toBeGreaterThan(512 + 600 / 4)
    const withTools = nativeInputEstimate("边界", messages, [
      { name: "mcp__lookup", description: "查询说明".repeat(1000), parameters: { type: "object" } },
    ])
    expect(withTools).toBeGreaterThan(bare + 1000)
    const { engine } = await setup()
    const run = await complete(engine)
    run.calls[0]!.inputEstimate = 100
    run.calls[0]!.usage = { inputTokens: 400, outputTokens: 10, totalTokens: 410 }
    expect(calibratedInputEstimate(run, run.calls[0]!.modelKey, 1000)).toBeGreaterThanOrEqual(4400)
    expect(calibratedInputEstimate({ ...run, calls: [] }, "qwen", 1000)).toBe(1000)
  })

  it("每次授权请求使用独立原生上下文，注入的技能目录和其他插件上下文不会进入评审", async () => {
    const { engine } = await setup()
    const run = await engine.create(input())
    const base = {
      model: DEFAULT_MODELS[0]!,
      system: "",
      prompt: "",
      maxOutputTokens: 512,
      signal: new AbortController().signal,
    }
    // These are only session-id inputs; no model request is dispatched.
    const context = { run, phase: "independent", seatId: "business", callId: "attempt-one" } as const
    const request = { ...base, context } as Parameters<typeof reviewSessionId>[0]
    expect(reviewSessionId(request)).not.toBe(
      reviewSessionId({ ...request, context: { ...request.context!, callId: "attempt-two" } }),
    )
    const own: UserMessage = {
      id: "own" as Message["id"],
      role: "user",
      source: { kind: "plugin", plugin: "dsh-decision-room" },
      content: [{ type: "text", text: "冻结材料" }],
    }
    const foreign: UserMessage = {
      ...own,
      id: "foreign" as Message["id"],
      source: { kind: "plugin", plugin: "other", form: "catalog" },
      content: [{ type: "text", text: "其他技能与上下文" }],
    }
    expect(reviewMessages([foreign, own])).toEqual([own])
  })

  it("晚到主持解读单独发布，重启不改写快照且不重复追加", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const interpretations = run.calls.filter(call => call.phase === "interpret")
    await engine.store.update(run.id, draft => {
      draft.calls = draft.calls.filter(call => call.phase !== "interpret")
    })
    const events: Array<{ type: string; data: unknown }> = []
    const services = {
      sessions: {
        get: () => ({
          header: { cwd: run.scope.workspaceId },
          events,
          append: (type: string, data: unknown) => events.push({ type, data }),
        }),
        flush: async () => true,
      },
    } as unknown as NativeServices
    const mirror = new DecisionTranscript(services, engine.store, engine.models, () => {})
    mirror.reconcile()
    await mirror.idle()
    const snapshots = events.filter(
      event => event.type === "decision-room/message" && (event.data as DecisionMessage).kind === "ballot",
    )
    const original = JSON.stringify(snapshots)
    await engine.store.update(run.id, draft => {
      draft.calls.push(...interpretations)
    })
    await mirror.idle()
    expect(JSON.stringify(snapshots)).toBe(original)
    const count = events.length
    expect(
      events.filter(
        event => event.type === "decision-room/message" && (event.data as DecisionMessage).phase.startsWith("主持解读"),
      ),
    ).toHaveLength(interpretations.length)
    await mirror.dispose()
    const recovered = new DecisionTranscript(services, engine.store, engine.models, () => {})
    recovered.reconcile()
    await recovered.idle()
    expect(events).toHaveLength(count)
    await recovered.dispose()
  })

  it("预算耗尽显示阶段报告而不是继续按钮，当前轮次不混用历史成功和压缩结果", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    run.status = "paused"
    run.phase = "discuss"
    run.round += 1
    run.stopCode = "BUDGET_EXCEEDED"
    run.stopReason = "上下文用量超过预算"
    run.events.push({ id: "budget-stop", at: Date.now(), type: "paused", text: run.stopReason })
    run.calls.push({ ...run.calls[0]!, id: "compression", purpose: "compaction", round: run.round, phase: "discuss" })
    const progress = decisionProgress(run, engine.models)
    const html = renderToStaticMarkup(
      createElement(DecisionProgressCard, { node: { data: progress }, compact: true, request: () => {} }),
    )
    expect(html).toContain("本轮 0/4")
    expect(html).toContain("当前额度无法继续")
    expect(html).not.toContain(">继续</button>")
    expect(decisionMessages(run, engine.models).find(message => message.role === "阶段报告")?.text).toContain(
      "尚未完成完整修订与复核",
    )
  })

  it("同会话多个版本恢复不会互相覆盖，旧进度投影会升级但任务记录不变", async () => {
    const { engine } = await setup()
    const versions: Run[] = []
    for (let index = 0; index < 3; index += 1) versions.push(await complete(engine))
    const latest = versions.at(-1)!
    const legacy = decisionProgress(latest, engine.models)
    delete legacy.projectionVersion
    delete legacy.budgetBlocked
    const events: Array<{ type: string; data: unknown }> = [
      { type: "decision-room/progress", data: { initial: true, progress: legacy } },
    ]
    const services = {
      sessions: {
        get: () => ({
          header: { cwd: latest.scope.workspaceId },
          events,
          append: (type: string, data: unknown) => events.push({ type, data }),
        }),
        flush: async () => {
          await new Promise(resolve => setTimeout(resolve, 1))
        },
      },
    } as unknown as NativeServices
    const before = engine.store.list()
    const mirror = new DecisionTranscript(services, engine.store, engine.models, () => {})
    mirror.reconcile()
    await mirror.idle()
    const messages = events
      .filter(event => event.type === "decision-room/message")
      .map(event => event.data as DecisionMessage)
    for (const run of versions)
      expect(messages.filter(message => message.runId === run.id)).toHaveLength(
        decisionMessages(run, engine.models).length,
      )
    expect(events.filter(event => event.type === "decision-room/progress")).toHaveLength(4)
    expect(engine.store.list()).toEqual(before)
    const count = events.length
    mirror.reconcile()
    await mirror.idle()
    expect(events).toHaveLength(count)
    await mirror.dispose()
  })
})
