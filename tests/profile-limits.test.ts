import { describe, expect, it } from "vitest"
import { DecisionEngine } from "../src/core/engine.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { REVIEW_MODES, reviewCountLimitsSchema } from "../src/core/schema.js"
import { MemoryPersistence, RunStore } from "../src/core/store.js"
import { DecisionChatActions } from "../src/dsh/chat-actions.js"
import { complete, input, setup } from "./fixtures.js"

const limits = { maxRounds: 80, maxCalls: 400, maxMcpCalls: 1000 }
function host(persistence = new MemoryPersistence()) {
  return new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, new DemoGateway(0), "demo", limits)
}

describe("Profile 统一次数上限", () => {
  it("仅统一 MCP 时，三档轮次和模型额度在新建、续议与重载后仍各自生效", async () => {
    const persistence = new MemoryPersistence()
    const policy = reviewCountLimitsSchema.parse({ maxMcpCalls: 1000 })
    const engine = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, new DemoGateway(0), "demo", policy)
    try {
      await engine.initialize()
      for (const mode of REVIEW_MODES) {
        const value = input({ scope: { sessionId: mode.id, workspaceId: "/modes" } })
        value.config.limits = { ...mode.limits, maxMcpCalls: 100 }
        const run = await engine.create(value)
        expect(run.config.limits).toEqual(mode.limits)
        const parent = await engine.control(run.id, run.scope, "pause", run.revision)
        const child = await new DecisionChatActions(engine).continue(run.scope, {
          parentId: parent.id,
          feedback: "保留当前档位继续补证",
        })
        expect(child.config.limits).toEqual(mode.limits)
      }
      const snapshot = engine.store.list()
      await engine.dispose()
      const restored = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, new DemoGateway(0), "demo", policy)
      try {
        await restored.initialize()
        expect(restored.store.list()).toEqual(snapshot)
      } finally {
        await restored.dispose()
      }
    } finally {
      await engine.dispose()
    }
  })

  it("聊天显式传入旧额度并遗漏 MCP 字段时，Host 持久化统一额度；续议同样适用", async () => {
    const engine = host()
    try {
      await engine.initialize()
      const value = input()
      const { maxMcpCalls: _legacy, ...legacyLimits } = value.config.limits
      const config = { ...value.config, limits: { ...legacyLimits, maxRounds: 64, maxCalls: 360 } }
      const chat = new DecisionChatActions(engine)
      const started = await chat.start(value.scope, { brief: value.brief, config }, "profile-start")
      expect(started.config.limits).toMatchObject(limits)
      await engine.idle(started.id)
      const parent = engine.store.get(started.id)
      const child = await chat.continue(value.scope, { parentId: parent.id, feedback: "合成补充意见", config })
      expect(child.config.limits).toMatchObject(limits)
      expect(child.status).toBe("draft")
      expect(engine.store.get(parent.id)).toEqual(parent)
      const changed = await engine.changeLimits(child.id, child.scope, child.revision, {
        ...child.config.limits,
        maxRounds: 2,
        maxCalls: 24,
        maxMcpCalls: 4,
      })
      expect(changed.config.limits).toMatchObject(limits)
      expect(changed.config.limits.tokenBudget).toBe(value.config.limits.tokenBudget)
      await expect(
        engine.changeLimits(
          child.id,
          { ...child.scope, sessionId: "another-session" },
          changed.revision,
          changed.config.limits,
        ),
      ).rejects.toMatchObject({ code: "SCOPE" })
    } finally {
      await engine.dispose()
    }
  })

  it("全部已有状态和会话统一额度，保留历史调用与结论，重复启动不重复迁移", async () => {
    const { engine: old, persistence } = await setup()
    const value = input()
    value.config.limits = { ...value.config.limits, maxRounds: 2, maxCalls: 24, maxMcpCalls: 100 }
    const completed = await complete(old, value)
    const draft = await old.create({ ...value, scope: { sessionId: "old-draft", workspaceId: "/other" } })
    const pausedDraft = await old.create({ ...value, scope: { sessionId: "old-paused", workspaceId: "/third" } })
    const paused = await old.control(pausedDraft.id, pausedDraft.scope, "pause", pausedDraft.revision)
    await old.dispose()
    const migrated = host(persistence)
    try {
      await migrated.initialize()
      for (const before of [completed, draft, paused]) {
        const after = migrated.store.get(before.id)
        expect(after.config.limits).toMatchObject(limits)
        expect(after.status).toBe(before.status)
        expect(after.updatedAt).toBe(before.updatedAt)
        expect(after.calls).toEqual(before.calls)
        expect(after.issues).toEqual(before.issues)
        expect(after.revisionResult).toEqual(before.revisionResult)
        expect(after.verification).toEqual(before.verification)
        expect(after.events.slice(0, before.events.length)).toEqual(before.events)
        expect(after.events.at(-1)?.text).toContain(JSON.stringify(before.config.limits))
      }
      const snapshot = migrated.store.list()
      await migrated.dispose()
      const reloaded = host(persistence)
      try {
        await reloaded.initialize()
        expect(reloaded.store.list()).toEqual(snapshot)
      } finally {
        await reloaded.dispose()
      }
    } finally {
      await migrated.dispose()
    }
  })
})
