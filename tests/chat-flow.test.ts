import { describe, expect, it } from "vitest"
import { DecisionChatActions } from "../src/dsh/chat-actions.js"
import { composeDecisionRequest, fillDecisionDraft } from "../src/composer.js"
import { decisionProgress } from "../src/dsh/messages.js"
import { progressNodeDefinition } from "../src/chat-messages.js"
import { input, setup } from "./fixtures.js"

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
    expect(replay.calls).toHaveLength(11)
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
  })
})
