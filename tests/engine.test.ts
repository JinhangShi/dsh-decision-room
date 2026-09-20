import { afterEach, describe, expect, it, vi } from "vitest"
import { spent } from "../src/core/budget.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { DecisionEngine, publicRun } from "../src/core/engine.js"
import { GatewayError, type ModelGateway, type ModelRequest, type ModelResponse } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { makePrompt, parseResult } from "../src/core/prompts.js"
import { RunStore } from "../src/core/store.js"
import { complete, input, setup, until } from "./fixtures.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("决策室完整流程", () => {
  it("完成四席独立评审、问题讨论、完整修订和复核，保留未核验事实", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.calls).toHaveLength(11)
    expect(run.calls.every(call => call.status === "succeeded")).toBe(true)
    expect(run.revisionResult?.fullPlan.length).toBeGreaterThan(80)
    expect(run.issues).toHaveLength(4)
    expect(run.issues.every(issue => issue.status === "needs_evidence")).toBe(true)
    expect(run.humanDecision).toBeUndefined()
    expect(spent(run).tokens).toBe(11 * 540)
    expect(spent(run).costCny).toBeNull()
  })
  it("首轮上下文不包含他人结论，首轮屏障也保护浏览器投影", async () => {
    const { engine } = await setup()
    const draft = await engine.create(input())
    const synthetic = {
      ...draft,
      calls: [{ id: "marker", result: { summary: "另一位评审的秘密意见" } }],
    } as unknown as typeof draft
    const prompt = makePrompt(synthetic, "independent", "growth")
    expect(prompt).not.toContain("另一位评审的秘密意见")
    expect(publicRun(synthetic).calls[0]?.result).toBeUndefined()
    expect(synthetic.calls[0]?.result).toBeDefined()
  })
  it("编辑使用最新一轮交叉回应，讨论时仍不看同一轮尚在提交的回应", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const debate = run.calls.find(call => call.phase === "discuss")!
    debate.result = { summary: "最新一轮的独特交叉质询", continueDiscussion: false, responses: [] }
    expect(makePrompt(run, "revise", "editor")).toContain("最新一轮的独特交叉质询")
    expect(makePrompt(run, "discuss", "growth")).not.toContain("最新一轮的独特交叉质询")
  })
  it("持续产生问题时可运行 24 轮，不被固定 11 次调用截断", async () => {
    const demo = new DemoGateway(0)
    const gateway: ModelGateway = {
      async generate(request) {
        const response = await demo.generate(request)
        const prompt = JSON.parse(request.prompt)
        if (prompt.phase === "discuss") {
          const value = JSON.parse(response.text)
          value.continueDiscussion = true
          for (const answer of value.responses) {
            answer.position = "maintain"
            answer.reasoning = `第 ${prompt.round} 轮仍有待分析的权衡`
          }
          response.text = JSON.stringify(value)
        }
        return response
      },
    }
    const { engine } = await setup(gateway)
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.round).toBe(24)
    expect(run.calls).toHaveLength(103)
    expect(run.config.limits.maxDurationMinutes).toBe(240)
  })
  it("提前保护修订和复核的调用额度", async () => {
    const { engine } = await setup()
    const value = input()
    value.config.limits.maxCalls = 8
    const run = await complete(engine, value)
    expect(run.status).toBe("completed")
    expect(run.calls).toHaveLength(7)
    expect(run.calls.some(call => call.phase === "discuss")).toBe(false)
  })
  it("复核模型声称事实已处理时仍保留待补证状态", async () => {
    const demo = new DemoGateway(0)
    const { engine } = await setup({
      async generate(request) {
        const response = await demo.generate(request)
        if (JSON.parse(request.prompt).phase === "verify") {
          const value = JSON.parse(response.text)
          value.issues.forEach((issue: { verdict: string }) => {
            issue.verdict = "addressed"
          })
          response.text = JSON.stringify(value)
        }
        return response
      },
    })
    const run = await complete(engine)
    expect(run.issues.find(issue => issue.kind === "missing_evidence")?.status).toBe("needs_evidence")
    expect(run.issues.find(issue => issue.kind === "design")?.status).toBe("addressed")
  })
})

describe("持久化、并发额度与停止", () => {
  it("并发调用前原子预留，不会先发请求再发现额度不足", async () => {
    let calls = 0
    const demo = new DemoGateway(100)
    const { engine } = await setup({
      async generate(request) {
        calls += 1
        return demo.generate(request)
      },
    })
    const value = input()
    const draft = await engine.create(value)
    const { estimateTokens } = await import("../src/core/budget.js")
    const { SYSTEM } = await import("../src/core/prompts.js")
    const firstTokens = estimateTokens(
      SYSTEM,
      makePrompt(draft, "independent", "growth"),
      value.config.limits.outputTokens,
    )
    const updated = await engine.changeLimits(draft.id, draft.scope, draft.revision, {
      ...value.config.limits,
      tokenBudget: firstTokens + 10,
    })
    await engine.control(updated.id, updated.scope, "start", updated.revision)
    await engine.idle(updated.id)
    const run = engine.store.get(updated.id)
    expect(calls).toBe(1)
    expect(run.status).toBe("paused")
    expect(spent(run).tokens).toBeLessThanOrEqual(run.config.limits.tokenBudget)
    expect(run.calls[0]?.accounting).toBe("uncertain")
  })
  it("暂停后迟到结果不写入结论，恢复后跳过已完成调用", async () => {
    let resolveLate: ((response: ModelResponse) => void) | undefined
    const demo = new DemoGateway(0)
    let pending: ModelRequest | undefined
    const { engine } = await setup({
      async generate(request) {
        if (!pending) {
          pending = request
          return new Promise<ModelResponse>(resolve => {
            resolveLate = resolve
          })
        }
        return demo.generate(request)
      },
    })
    const value = input()
    value.config.limits.concurrency = 1
    const draft = await engine.create(value)
    await engine.control(draft.id, draft.scope, "start", draft.revision)
    await until(() => Boolean(resolveLate))
    let run = engine.store.get(draft.id)
    await engine.control(run.id, run.scope, "pause", run.revision)
    await engine.idle(run.id)
    resolveLate?.({ text: '{"summary":"迟到内容"}', returnedModel: "qwen3.8-max" })
    run = engine.store.get(run.id)
    expect(run.status).toBe("paused")
    expect(run.calls[0]?.status).toBe("interrupted")
    expect(run.calls[0]?.result).toBeUndefined()
    await engine.control(run.id, run.scope, "resume", run.revision)
    await engine.idle(run.id)
    run = engine.store.get(run.id)
    expect(run.status).toBe("completed")
    expect(run.calls).toHaveLength(12)
    expect(run.calls[0]?.result).toBeUndefined()
  })
  it("重启恢复会暂停，保留中断调用的预留额度且不自动重发", async () => {
    const { engine, persistence } = await setup()
    const draft = await engine.create(input())
    await engine.store.update(draft.id, run => {
      run.status = "running"
      run.activeSince = Date.now() - 2000
      run.calls.push({
        id: "interrupted",
        key: "independent:0:growth",
        phase: "independent",
        round: 0,
        epoch: 1,
        seatId: "growth",
        modelKey: "qwen",
        status: "running",
        attempt: 1,
        startedAt: Date.now(),
        reservedTokens: 1234,
        reservedCost: null,
        accountedTokens: 1234,
        accountedCost: null,
        accounting: "reserved",
        promptHash: "hash",
      })
    })
    const generate = vi.fn()
    const recovered = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, { generate })
    await recovered.initialize()
    const run = recovered.store.get(draft.id)
    expect(run.status).toBe("paused")
    expect(run.elapsedMs).toBeGreaterThanOrEqual(2000)
    expect(run.calls[0]?.accounting).toBe("uncertain")
    expect(spent(run).tokens).toBe(1234)
    expect(generate).not.toHaveBeenCalled()
  })
  it("错误输出保留实际用量，最多重试三次", async () => {
    const { engine } = await setup({
      async generate() {
        return { text: "不是 JSON", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }
      },
    })
    const value = input()
    value.config.limits.concurrency = 1
    let run = await complete(engine, value)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await engine.control(run.id, run.scope, "resume", run.revision)
      await engine.idle(run.id)
      run = engine.store.get(run.id)
    }
    expect(run.status).toBe("paused")
    expect(run.calls).toHaveLength(3)
    expect(spent(run).tokens).toBe(450)
    expect(run.stopReason).toContain("三次")
  })
  it("模型身份不一致时停止，并计入已报告用量", async () => {
    const { engine } = await setup({
      async generate() {
        throw new GatewayError("MODEL_MISMATCH", "模型身份不一致", {
          text: "",
          returnedModel: "wrong-model",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        })
      },
    })
    const value = input()
    value.config.limits.concurrency = 1
    const run = await complete(engine, value)
    expect(run.status).toBe("paused")
    expect(run.calls[0]?.returnedModel).toBe("wrong-model")
    expect(spent(run).tokens).toBe(30)
  })
  it("达到时间上限不再派发新请求", async () => {
    const { engine } = await setup()
    const run = await engine.create(input())
    await engine.store.update(run.id, draft => {
      draft.elapsedMs = draft.config.limits.maxDurationMinutes * 60000
    })
    const latest = engine.store.get(run.id)
    await expect(engine.control(run.id, run.scope, "start", latest.revision)).rejects.toThrow("时间上限")
    expect(engine.store.get(run.id).calls).toHaveLength(0)
  })
  it("实时进度推进不会阻止用户使用稍旧的 revision 暂停任务", async () => {
    const { engine } = await setup(new DemoGateway(100))
    const draft = await engine.create(input())
    const started = await engine.control(draft.id, draft.scope, "start", draft.revision)
    await until(() => engine.store.get(draft.id).calls.length > 0)
    expect(engine.store.get(draft.id).revision).toBeGreaterThan(started.revision)
    await engine.control(draft.id, draft.scope, "pause", started.revision)
    await engine.idle(draft.id)
    expect(engine.store.get(draft.id).status).toBe("paused")
  })
  it("并发启动三个任务时仅允许两个进入运行，Profile 总并发不超过四个", async () => {
    let active = 0
    let peak = 0
    const demo = new DemoGateway(100)
    const { engine } = await setup({
      async generate(request) {
        active += 1
        peak = Math.max(peak, active)
        try {
          return await demo.generate(request)
        } finally {
          active -= 1
        }
      },
    })
    const value = input()
    value.config.limits.concurrency = 4
    const drafts = await Promise.all([engine.create(value), engine.create(value), engine.create(value)])
    const results = await Promise.allSettled(
      drafts.map(run => engine.control(run.id, run.scope, "start", run.revision)),
    )
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2)
    await until(() => peak === 4)
    await engine.dispose()
    expect(peak).toBe(4)
  })
})

describe("作用域与人工决策", () => {
  it("拒绝跨会话操作和过期 revision", async () => {
    const { engine } = await setup()
    const run = await engine.create(input())
    await expect(engine.control(run.id, { ...run.scope, sessionId: "other" }, "start", run.revision)).rejects.toThrow(
      "当前工作空间和会话",
    )
    await expect(engine.control(run.id, run.scope, "start", 99)).rejects.toThrow("刷新")
  })
  it("续议创建新版本，人工取舍不会抹掉旧报告和异议", async () => {
    const { engine } = await setup()
    const original = await complete(engine)
    const decided = await engine.decide(
      original.id,
      original.scope,
      original.revision,
      "adopt",
      "接受有限试点，保留证据风险",
    )
    const snapshot = JSON.stringify(decided)
    const next = await engine.create(
      input({ parentId: decided.id, feedback: "新增事实：试点样本可在下周取得，仍需核验。" }),
    )
    expect(next.version).toBe(2)
    expect(next.parentId).toBe(original.id)
    expect(next.calls).toHaveLength(0)
    expect(JSON.stringify(engine.store.get(original.id))).toBe(snapshot)
    await expect(engine.decide(decided.id, decided.scope, decided.revision, "reject", "改主意")).rejects.toThrow(
      "尚未记录",
    )
  })
  it("金额预算不能绕过未知价格，禁用模型不能成为席位", async () => {
    const { engine } = await setup()
    const value = input()
    value.config.limits.maxCostCny = 10
    await expect(engine.create(value)).rejects.toThrow("实际 API 价格")
    value.config.limits.maxCostCny = null
    value.config.seats[0]!.modelKey = "openai"
    await expect(engine.create(value)).rejects.toThrow("未接通")
  })
  it("结构化输出拒绝伪造证据和遗漏问题", async () => {
    const { engine } = await setup()
    const run = await engine.create(input())
    const response = await new DemoGateway(0).generate({
      model: DEFAULT_MODELS[0]!,
      system: "",
      prompt: makePrompt(run, "independent", "growth"),
      maxOutputTokens: 1000,
      signal: new AbortController().signal,
    })
    const value = JSON.parse(response.text)
    value.issues[0].evidenceIds = ["不存在的外部来源"]
    expect(() => parseResult(JSON.stringify(value), run, "independent", "growth")).toThrow()
    const completed = await complete(engine)
    const revision = { ...completed.revisionResult, changes: [] }
    expect(() => parseResult(JSON.stringify(revision), completed, "revise", "editor")).toThrow("引用")
  })
})
