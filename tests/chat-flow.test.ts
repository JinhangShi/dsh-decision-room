import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DecisionChatActions } from "../src/dsh/chat-actions.js"
import { composeDecisionRequest, fillDecisionDraft } from "../src/composer.js"
import { decisionMessages, decisionProgress, type DecisionMessage } from "../src/dsh/messages.js"
import { DecisionProgressCard, progressNodeDefinition } from "../src/chat-messages.js"
import { DecisionChatMessage } from "../src/decision-chat-message.js"
import { complete, input, setup } from "./fixtures.js"

describe("主聊天驱动决策", () => {
  it("回填材料只写入原生草稿，保留模型、预算和附件，不覆盖未发送内容", () => {
    const value = input()
    value.brief.sources = [{ id: "evidence-a", title: "访谈摘要", text: "合成材料：客户假设尚未核验。" }]
    const text = composeDecisionRequest(value.brief, value.config)
    let draft = ""
    const composer = {
      state: { getSnapshot: () => ({ draft }) },
      setDraft: (text: string) => {
        draft = text
      },
    }
    fillDecisionDraft(composer, text)
    expect(draft).toContain(value.brief.plan)
    expect(draft).toContain("evidence-a")
    expect(draft).toContain(String(value.config.limits.tokenBudget))
    expect(draft).toContain("decision_room_start")
    expect(() => fillDecisionDraft(composer, "另一份材料")).toThrow("没有覆盖")
    expect(draft).toBe(text)
    fillDecisionDraft(composer, "修订后的草稿", text)
    expect(draft).toBe("修订后的草稿")
    draft = "用户手工补充的内容"
    expect(() => fillDecisionDraft(composer, text, "修订后的草稿")).toThrow("没有覆盖")
  })
  it("同一用户消息并发重复启动只创建一个任务，重载服务后仍去重", async () => {
    const { engine } = await setup()
    const chat = new DecisionChatActions(engine)
    const value = input()
    const [first, duplicate] = await Promise.all([
      chat.start(value.scope, { brief: value.brief, config: value.config }, "human-message-1"),
      chat.start(value.scope, { brief: value.brief, config: value.config }, "human-message-1"),
    ])
    expect(first.id).toBe(duplicate.id)
    await engine.idle(first.id)
    const replay = await new DecisionChatActions(engine).start(value.scope, { brief: value.brief }, "human-message-1")
    expect(replay.id).toBe(first.id)
    expect(engine.store.list()).toHaveLength(1)
    expect(replay.calls).toHaveLength(17)
  })
  it("主聊天续议基于上次修订稿，默认仅暂存，明确请求可直接启动且保留旧版本", async () => {
    const { engine } = await setup()
    const chat = new DecisionChatActions(engine)
    const value = input()
    const first = await chat.start(value.scope, { brief: value.brief, config: value.config }, "human-1")
    await engine.idle(first.id)
    const parent = engine.store.get(first.id)
    const snapshot = structuredClone(parent)
    const draft = await chat.continue(
      value.scope,
      { parentId: first.id, feedback: "先记录补充的证据要求。" },
      "human-2",
    )
    expect(draft.status).toBe("draft")
    expect(draft.calls).toHaveLength(0)
    expect(draft.brief.plan).toBe(parent.revisionResult?.fullPlan)
    const second = await chat.continue(
      value.scope,
      { parentId: first.id, feedback: "收窄范围并再次评审。", start: true },
      "human-3",
    )
    await engine.idle(second.id)
    expect(engine.store.get(second.id).status).toBe("completed")
    expect(second.config).toEqual(parent.config)
    expect(engine.store.get(first.id)).toEqual(snapshot)
    await expect(
      chat.continue(
        { ...value.scope, sessionId: "other" },
        { parentId: first.id, feedback: "伪造续议", start: true },
        "human-4",
      ),
    ).rejects.toThrow("当前工作空间和会话")
  })
  it("进度卡片更新同一节点，展示调用状态但不会泄露尚未揭示的首评内容", async () => {
    const { engine } = await setup()
    const run = await engine.create(input())
    const progress = decisionProgress(run, engine.models)
    expect(run.config.limits.outputTokens).toBe(8000)
    expect(JSON.parse(JSON.stringify(progress))).toEqual(progress)
    const start = { type: "decision-room/progress", seq: 1, data: { initial: true, progress } }
    const update = {
      type: "decision-room/progress",
      seq: 20,
      data: { initial: false, progress: { ...progress, status: "running", revision: 2 } },
    }
    expect(progressNodeDefinition.match(start)).toEqual({ id: progress.id, role: "start" })
    expect(progressNodeDefinition.match(update)).toEqual({ id: progress.id, role: "update" })
    const state = progressNodeDefinition.update({ key: "card", id: progress.id }, { event: update })
    const card = progressNodeDefinition.buildViewNode({ key: "card", id: progress.id, start: { event: start }, state })
    expect(card).toMatchObject({ anchorSeq: 1, data: { status: "running", revision: 2 } })
    const partialHistory = progressNodeDefinition.buildViewNode({
      key: "card",
      id: progress.id,
      matches: [{ event: update }],
    })
    expect(partialHistory).toMatchObject({ data: { status: "running" } })
    expect(progress).not.toHaveProperty("brief")
    expect(progress).not.toHaveProperty("issues")
    expect(progress).not.toHaveProperty("ballot")
  })
  it("首评公开后在主聊天显示 Host 聚合的逐问题覆盖、票型、证据和阻断项", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const progress = decisionProgress(run, engine.models)
    expect(progress.ballot).toBeDefined()
    expect(progress.ballot?.issues.length).toBeGreaterThan(0)
    expect(progress.ballot?.issues[0]).toMatchObject({
      reviewerCount: expect.any(Number),
      requiredReviewers: expect.any(Number),
      modelFamilyCount: expect.any(Number),
      requiredModelFamilies: expect.any(Number),
      blockingVotes: expect.any(Number),
      positions: expect.objectContaining({ needs_evidence: expect.any(Number) }),
      evidence: expect.objectContaining({ missing: expect.any(Number) }),
    })
    expect(progress.maxRounds).toBe(run.config.limits.maxRounds)
    expect(progress.ballotHistory).toHaveLength(run.round)
    expect(progress.ballotHistory.every(snapshot => snapshot.interpretation)).toBe(true)
    const html = renderToStaticMarkup(createElement(DecisionProgressCard, { node: { data: progress } }))
    expect(html).toContain("表决总览")
    expect(html).toContain("最低")
    expect(html).toContain("模型族")
    expect(html).toContain("阻断票")
    expect(html).toContain("待补证")
    expect(html).toContain("证据：支持")
    expect(html).toContain("多数意见当作事实")
    const compactHtml = renderToStaticMarkup(
      createElement(DecisionProgressCard, { compact: true, node: { data: progress } }),
    )
    expect(compactHtml).toContain("讨论轮次")
    expect(compactHtml).toContain("模型调用")
    expect(compactHtml).toContain("逐轮表决")
    expect(compactHtml).toContain("第 1 轮")
    expect(compactHtml).toContain("第 2 轮")
    expect(compactHtml).toContain("当前不宜直接扩大投入")
  })
  it("MCP 工具跟进成功但没有独立结构化结果时不会让进度侧栏白屏", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const primary = run.calls.find(call => call.phase === "discuss" && call.status === "succeeded")!
    run.calls.push({
      ...primary,
      id: "tool-followup-without-result",
      key: "tool-followup-without-result",
      purpose: "tool_followup",
      result: undefined,
    })
    expect(() => decisionProgress(run, engine.models)).not.toThrow()
    expect(() => decisionMessages(run, engine.models)).not.toThrow()
    expect(decisionProgress(run, engine.models).ballotHistory).toHaveLength(run.round)
  })
  it("每轮讨论完成后在主聊天追加不可变的 Host 表决快照", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const ballots = decisionMessages(run, engine.models).filter(message => message.kind === "ballot")
    expect(ballots).toHaveLength(run.round)
    expect(ballots.map(message => message.id)).toEqual(
      Array.from({ length: run.round }, (_, index) => `${run.id}:ballot-round-${index + 1}`),
    )
    expect(ballots[0]?.text).toContain("第 1 轮表决快照")
    expect(ballots[0]?.text).toContain("主持解读")
    expect(ballots[0]?.text).toContain("建议下一步")
    expect(ballots[0]?.text).toContain("最低")
    expect(ballots[0]?.text).toContain("阻断票")
    expect(ballots.at(-1)?.text).toContain("后续改票会出现在下一轮快照")
  })
  it("调用中断后明确告知用户不会自动重试以及如何恢复", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const progress = decisionProgress(run, engine.models)
    progress.status = "paused"
    progress.stopReason = "调用已停止或超时；保留预留额度等待对账"
    progress.calls[0]!.status = "interrupted"
    const html = renderToStaticMarkup(createElement(DecisionProgressCard, { node: { data: progress } }))
    expect(html).toContain("需要你确认后重试")
    expect(html).toContain("不会自动重试")
    expect(html).toContain("继续评审")
    expect(html).toContain("已完成席位不会重复调用")
  })
  it("决策消息使用安全 Markdown 渲染，而不是显示原始标记或执行 HTML", () => {
    const message: DecisionMessage = {
      id: "message-markdown",
      runId: "run-markdown",
      version: 1,
      role: "独立复核",
      model: "测试模型",
      phase: "独立复核",
      text: "## 结论\n\n- 保留 **人工复核**\n- 拒绝 `<script>alert(1)</script>`",
      at: 1,
      kind: "review",
    }
    const html = renderToStaticMarkup(createElement(DecisionChatMessage, { data: message }))
    expect(html).toContain("<h2>结论</h2>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<strong>人工复核</strong>")
    expect(html).not.toContain("<script>")
  })
})
