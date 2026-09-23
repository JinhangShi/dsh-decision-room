import { describe, expect, it } from "vitest"
import { DecisionEngine } from "../src/core/engine.js"
import { DecisionError } from "../src/core/schema.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { MemoryPersistence, RunStore } from "../src/core/store.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { spent } from "../src/core/budget.js"
import { complete, input, setup, until } from "./fixtures.js"

describe("派发边界与记账", () => {
  it("重启只释放持久化为未发送的预留，旧记录和发送中记录保持保守计费", async () => {
    const { engine, persistence } = await setup()
    const run = await complete(engine)
    await engine.store.update(run.id, draft => {
      draft.status = "running"
      draft.calls = draft.calls.slice(0, 3).map((call, index) => ({
        ...call,
        status: "running",
        usage: undefined,
        accountedTokens: 500,
        reservedTokens: 500,
        accounting: "reserved",
        dispatchState: index === 0 ? "reserved" : index === 1 ? "sending" : undefined,
      }))
    })
    const recovered = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, new DemoGateway(0), "demo")
    await recovered.initialize()
    const value = recovered.store.get(run.id)
    expect(value.calls.map(call => call.accountedTokens)).toEqual([0, 500, 500])
    expect(value.calls.map(call => call.accounting)).toEqual(["not_sent", "uncertain", "uncertain"])
    expect(spent(value)).toMatchObject({ calls: 2, uncertain: 2, tokens: 1000 })
  })

  it("预检后取消禁止迟到授权，释放预留且不影响其他任务", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let sent = 0
    const { engine } = await setup({
      managedContext: true,
      async generate(request) {
        await gate
        await request.context!.authorize({
          purpose: "review",
          inputTokens: 100,
          outputTokens: 100,
          hash: "same",
          sessionId: "isolated",
        })
        sent += 1
        throw new Error("Must not send")
      },
    })
    const untouched = await engine.create(input({ scope: { sessionId: "other", workspaceId: "/other" } }))
    const run = await engine.create(input())
    await engine.control(run.id, run.scope, "start", run.revision)
    await until(() => engine.store.get(run.id).calls.length > 0)
    await engine.control(run.id, run.scope, "cancel", engine.store.get(run.id).revision)
    release()
    await engine.idle(run.id)
    expect(sent).toBe(0)
    expect(spent(engine.store.get(run.id))).toMatchObject({ tokens: 0, calls: 0, uncertain: 0 })
    expect(engine.store.get(untouched.id)).toEqual(untouched)
  })

  it("进入发送后超时仍保留预留，不能把未知结果当成未发送", async () => {
    const { engine } = await setup({
      managedContext: true,
      async generate(request) {
        await request.context!.authorize({
          purpose: "review",
          inputTokens: 100,
          outputTokens: 100,
          hash: "sent",
          sessionId: "isolated",
        })
        throw new DecisionError("CONTEXT", "发送后发生处理错误")
      },
    })
    const run = await complete(engine)
    expect(
      run.calls.some(
        call => call.dispatchState === "sending" && call.accountedTokens === 200 && call.accounting === "uncertain",
      ),
    ).toBe(true)
  })

  it("恢复旧版第一轮讨论时复用五个成功步骤，失败原记录保持不变", async () => {
    const persistence = new MemoryPersistence()
    const first = await setup(new DemoGateway(0), persistence)
    const run = await complete(first.engine)
    await first.engine.store.update(run.id, draft => {
      draft.status = "paused"
      draft.phase = "discuss"
      draft.round = 1
      draft.calls = draft.calls.slice(0, 5)
      delete draft.revisionResult
      delete draft.verification
      draft.calls.push({
        ...draft.calls[0]!,
        id: "legacy-blocked",
        key: "discuss:1:business",
        phase: "discuss",
        round: 1,
        status: "failed",
        result: undefined,
        usage: undefined,
        dispatchState: undefined,
        accounting: "uncertain",
        error: "旧版容量拦截",
      })
    })
    const legacy = first.engine.store.get(run.id).calls.at(-1)!
    const phases: string[] = []
    const demo = new DemoGateway(0)
    const resumed = await setup(
      {
        async generate(request) {
          phases.push(request.context!.phase)
          return demo.generate(request)
        },
      },
      persistence,
    )
    const paused = resumed.engine.store.get(run.id)
    await resumed.engine.control(run.id, run.scope, "resume", paused.revision)
    await resumed.engine.idle(run.id)
    const done = resumed.engine.store.get(run.id)
    expect(done.status).toBe("completed")
    expect(phases).not.toContain("independent")
    expect(phases).not.toContain("organize")
    expect(done.calls.find(call => call.id === legacy.id)).toEqual(legacy)
  })
})
