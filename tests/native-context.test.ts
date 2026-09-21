import { describe, expect, it } from "vitest"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { spent } from "../src/core/budget.js"
import { makePrompt } from "../src/core/prompts.js"
import { decisionMessages } from "../src/dsh/messages.js"
import { DecisionTranscript } from "../src/dsh/transcript.js"
import type { NativeServices } from "../src/dsh/native-gateway.js"
import { decisionNodeDefinition } from "../src/chat-messages.js"
import { complete, input, setup } from "./fixtures.js"

describe("原生 DSH 上下文和主聊天", () => {
  it("讨论只发送分配的问题，保留首轮结论但不重复整份问题清单", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    run.phase = "discuss"
    run.round = 2
    const prompt = JSON.parse(makePrompt(run, "discuss", "growth"))
    expect(prompt.issues.map((issue: { id: string }) => issue.id)).toEqual(prompt.assignedIssueIds)
    expect(prompt.reviews).toHaveLength(4)
    expect(prompt.reviews[0]).toHaveProperty("summary")
    expect(prompt.reviews[0]).not.toHaveProperty("result")
    expect(prompt.reviews[0]).not.toHaveProperty("issues")
    expect(prompt.brief.constraints).toBe(run.brief.constraints)
    for (const item of prompt.recentDiscussion) {
      expect(
        item.result.responses.every((response: { issueId: string }) =>
          prompt.assignedIssueIds.includes(response.issueId),
        ),
      ).toBe(true)
    }
  })

  it("原生压缩请求先记预算，不会作为首轮评审结果或漏计调用", async () => {
    const demo = new DemoGateway(0)
    let dispatched = 0
    const { engine } = await setup({
      managedContext: true,
      estimate: () => 1000,
      async generate(request) {
        const context = request.context!
        const compact = await context.authorize({
          purpose: "compaction",
          inputTokens: 400,
          outputTokens: 600,
          hash: "summary",
          sessionId: "native-child",
        })
        dispatched += 1
        expect(engine.store.get(context.run.id).calls.find(call => call.id === compact)?.accounting).toBe("reserved")
        await context.receipt(compact, {
          text: "DSH 摘要",
          usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
        })
        await context.authorize({
          purpose: "review",
          inputTokens: 500,
          outputTokens: 500,
          hash: "review",
          sessionId: "native-child",
        })
        dispatched += 1
        return demo.generate(request)
      },
    })
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.calls.filter(call => call.purpose === "compaction")).toHaveLength(17)
    expect(spent(run).calls).toBe(dispatched)
    expect(run.issues).toHaveLength(4)
  })

  it("上下文处理预算不足时不发起隐形调用", async () => {
    let sent = 0
    const { engine } = await setup({
      managedContext: true,
      estimate: () => 1000,
      async generate(request) {
        await request.context!.authorize({
          purpose: "compaction",
          inputTokens: 10000,
          outputTokens: 1000,
          hash: "compact",
          sessionId: "child",
        })
        sent += 1
        throw new Error("不应到达")
      },
    })
    const value = input()
    value.config.limits.tokenBudget = 2000
    const run = await complete(engine, value)
    expect(sent).toBe(0)
    expect(run.status).toBe("paused")
    expect(run.stopReason).toContain("预算")
  })

  it("主聊天恢复幂等，首轮揭示前不发布评审内容，重启回放使用同一消息身份", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const blind = { ...run, phase: "independent" as const }
    expect(decisionMessages(blind, engine.models).filter(message => message.kind === "review")).toHaveLength(0)
    const events: Array<{ type: string; data: { id: string } }> = []
    const services = {
      sessions: {
        get: () => ({
          header: { cwd: run.scope.workspaceId },
          events,
          append(type: string, data: { id: string }) {
            events.push({ type, data })
          },
        }),
        flush: async () => true,
      },
    } as unknown as NativeServices
    const warnings: string[] = []
    const mirror = new DecisionTranscript(services, engine.store, engine.models, message => warnings.push(message))
    mirror.reconcile()
    await mirror.idle()
    const count = events.length
    expect(count).toBe(decisionMessages(run, engine.models).length + 1)
    expect(events.filter(event => event.type === "decision-room/message")).toHaveLength(
      decisionMessages(run, engine.models).length,
    )
    mirror.reconcile()
    await mirror.idle()
    expect(events).toHaveLength(count)
    expect(warnings).toEqual([])
    const event = { type: "decision-room/message", seq: 15, data: events[1]!.data }
    expect(decisionNodeDefinition.match(event)?.id).toBe(event.data.id)
    expect(
      decisionNodeDefinition.buildViewNode({ key: "stable", id: event.data.id, start: { event }, state: event.data }),
    ).toMatchObject({ target: "chat", kind: "decision-room", visibility: "visible", anchorSeq: 15 })
    await mirror.dispose()
  })
})
