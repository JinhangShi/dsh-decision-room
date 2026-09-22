import { afterEach, describe, expect, it, vi } from "vitest"
import { spent } from "../src/core/budget.js"
import { assessDeliberation } from "../src/core/deliberation.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { DecisionEngine, publicRun } from "../src/core/engine.js"
import { GatewayError, type ModelGateway, type ModelRequest, type ModelResponse } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { makePrompt, parseResult } from "../src/core/prompts.js"
import { configurationWarnings, readDebateResult, REVIEW_MODES, SEAT_TEMPLATES } from "../src/core/schema.js"
import { RunStore } from "../src/core/store.js"
import { complete, input, setup, until } from "./fixtures.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("决策室完整流程", () => {
  it("四种评审模式包含持续运行的完整固定额度，默认模型目录只含已接通模型", () => {
    expect(REVIEW_MODES.map(mode => [mode.id, mode.limits.maxDurationMinutes])).toEqual([
      ["quick", 15],
      ["standard", 60],
      ["deep", 240],
      ["overnight", 480],
    ])
    expect(REVIEW_MODES.map(mode => mode.limits.tokenBudget)).toEqual([1000000, 3000000, 6000000, 15000000])
    expect(REVIEW_MODES.find(mode => mode.id === "overnight")?.limits).toMatchObject({
      maxRounds: 64,
      maxCalls: 360,
      callTimeoutSeconds: 300,
    })
    expect(DEFAULT_MODELS.map(model => model.key)).toEqual(["qwen", "glm", "kimi", "deepseek"])
    expect(DEFAULT_MODELS.every(model => model.enabled)).toBe(true)
  })
  it("所有内置模板符合席位协议并保留关键视角", () => {
    for (const template of SEAT_TEMPLATES) {
      const value = input()
      value.config.seats = structuredClone(template.seats)
      expect(configurationWarnings(value.config).filter(item => item.includes("缺少"))).toEqual([])
    }
  })
  it("五席企业尽调模板可在快速模式内完成跨模型族双人覆盖", async () => {
    const { engine } = await setup()
    const value = input()
    value.config.seats = structuredClone(SEAT_TEMPLATES.find(template => template.id === "due_diligence")!.seats)
    value.config.limits = { ...value.config.limits, maxRounds: 2, maxCalls: 24 }
    const run = await complete(engine, value)
    expect(run.status).toBe("completed")
    expect(run.round).toBe(2)
    expect(run.calls.filter(call => call.phase === "interpret")).toHaveLength(2)
    expect(run.calls.length).toBeLessThanOrEqual(24)
    const assessment = assessDeliberation(run)
    expect(assessment.coverageSatisfied).toBe(true)
    expect(
      assessment.issues.every(
        issue =>
          issue.reviewerCount >= issue.requiredReviewers && issue.modelFamilyCount >= issue.requiredModelFamilies,
      ),
    ).toBe(true)
  })
  it("完成四席独立评审、问题讨论、完整修订和复核，保留未核验事实", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.calls).toHaveLength(17)
    expect(run.calls.every(call => call.status === "succeeded")).toBe(true)
    expect(run.revisionResult?.fullPlan.length).toBeGreaterThan(80)
    expect(run.issues).toHaveLength(4)
    expect(run.issues.every(issue => issue.status === "needs_evidence")).toBe(true)
    expect(run.humanDecision).toBeUndefined()
    expect(spent(run).tokens).toBe(17 * 540)
    expect(spent(run).costCny).toBeNull()
    expect(run.round).toBe(2)
    const assessment = assessDeliberation(run)
    expect(assessment.coverageSatisfied).toBe(true)
    expect(assessment.issues.every(issue => issue.reviewerCount >= 2)).toBe(true)
  })
  it("主持将语义相同的独立首评问题归并为议题簇并保留全部来源 ID", async () => {
    const demo = new DemoGateway(0)
    const gateway: ModelGateway = {
      async generate(request) {
        const response = await demo.generate(request)
        const prompt = JSON.parse(request.prompt)
        if (prompt.phase !== "organize") return response
        const issueIds = prompt.issues.map((issue: { id: string }) => issue.id)
        return {
          ...response,
          text: JSON.stringify({
            summary: "四个席位指出同一项根因。",
            priorityIssueIds: issueIds,
            issueGroups: [{ title: "统一的关键证据缺口", memberIssueIds: issueIds }],
          }),
        }
      },
    }
    const { engine } = await setup(gateway)
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.issues).toHaveLength(1)
    expect(run.issues[0]).toMatchObject({
      title: "统一的关键证据缺口",
      severity: "high",
      sourceIssueIds: expect.arrayContaining(["I-business-1", "I-delivery-1", "I-risk-1", "I-challenge-1"]),
    })
    expect(run.issues[0]?.rationale).toContain("[I-business-1]")
    expect(run.events.some(item => item.type === "issues_grouped")).toBe(true)
  })
  it("复核使用未知枚举时由 Host 保守归一化，不阻断任务", async () => {
    const demo = new DemoGateway(0)
    let verifyAttempts = 0
    const gateway: ModelGateway = {
      async generate(request) {
        const response = await demo.generate(request)
        const prompt = JSON.parse(request.prompt)
        if (prompt.phase !== "verify") {
          return response
        }
        verifyAttempts += 1
        const invalid = JSON.parse(response.text)
        invalid.issues[0].verdict = "partial"
        return { ...response, text: JSON.stringify(invalid) }
      },
    }
    const { engine } = await setup(gateway)
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    const verificationCalls = run.calls.filter(call => call.phase === "verify")
    expect(verificationCalls).toHaveLength(1)
    expect(verificationCalls[0]?.status).toBe("succeeded")
    expect(verifyAttempts).toBe(1)
    expect(run.verification?.issues[0]?.verdict).toBe("open")
    expect(run.events.some(item => item.type === "call_retry")).toBe(false)
  })
  it("修订实验遗漏停止条件时由 Host 补充保守停止条件", async () => {
    const demo = new DemoGateway(0)
    let revisionAttempts = 0
    const gateway: ModelGateway = {
      async generate(request) {
        const response = await demo.generate(request)
        const prompt = JSON.parse(request.prompt)
        if (prompt.phase !== "revise") return response
        revisionAttempts += 1
        const invalid = JSON.parse(response.text)
        delete invalid.experiments[0].stopCondition
        return { ...response, text: JSON.stringify(invalid) }
      },
    }
    const { engine } = await setup(gateway)
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.calls.filter(call => call.phase === "revise").map(call => call.status)).toEqual(["succeeded"])
    expect(revisionAttempts).toBe(1)
    expect(run.revisionResult?.experiments[0]?.stopCondition).toContain("硬约束")
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
    const debate = run.calls.find(call => call.phase === "discuss" && call.round === run.round)!
    debate.result = { summary: "最新一轮的独特交叉质询", continueDiscussion: false, responses: [] }
    expect(makePrompt(run, "revise", "editor")).toContain("最新一轮的独特交叉质询")
    expect(makePrompt(run, "discuss", "growth")).not.toContain("最新一轮的独特交叉质询")
  })
  it("旧版讨论记录可恢复，但不会被误当成无新增信息", () => {
    const legacy = readDebateResult({
      summary: "历史讨论",
      continueDiscussion: false,
      responses: [
        {
          issueId: "I-growth-1",
          position: "needs_evidence",
          reasoning: "仍缺少材料",
          evidenceIds: ["proposal"],
          proposedChange: "补充试点数据",
        },
      ],
    })
    expect(legacy.responses[0]).toMatchObject({ evidenceStatus: "missing", newInformation: true })
  })
  it("同一模型族的两个角色不构成高风险问题的双模型覆盖", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const firstIssue = run.issues[0]!
    const ballots = run.calls.filter(
      call =>
        call.phase === "discuss" &&
        call.status === "succeeded" &&
        readDebateResult(call.result).responses.some(response => response.issueId === firstIssue.id),
    )
    expect(ballots.length).toBeGreaterThanOrEqual(2)
    const firstFamily = run.config.seats.find(seat => seat.id === ballots[0]!.seatId)!.modelFamily
    for (const ballot of ballots) {
      const seat = run.config.seats.find(item => item.id === ballot.seatId)!
      seat.modelFamily = firstFamily
    }
    const assessment = assessDeliberation(run)
    const summary = assessment.issues.find(issue => issue.issueId === firstIssue.id)!
    expect(summary.reviewerCount).toBeGreaterThanOrEqual(2)
    expect(summary.modelFamilyCount).toBe(1)
    expect(assessment.coverageSatisfied).toBe(false)
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
    const value = input()
    value.config.limits = structuredClone(REVIEW_MODES.find(mode => mode.id === "deep")!.limits)
    const run = await complete(engine, value)
    expect(run.status).toBe("completed")
    expect(run.round).toBe(24)
    expect(run.calls).toHaveLength(127)
    expect(run.config.limits.maxDurationMinutes).toBe(240)
    for (const issue of assessDeliberation(run).issues) {
      const total = Object.values(issue.positions).reduce((sum, count) => sum + count, 0)
      expect(total).toBe(issue.reviewerCount)
      expect(total).toBeLessThanOrEqual(run.config.seats.length)
      expect(issue.blockingVotes).toBeLessThanOrEqual(run.config.seats.length)
    }
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
      makePrompt(draft, "independent", value.config.seats[0]!.id),
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
    expect(run.calls).toHaveLength(18)
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
  it("非 JSON 输出作为自由意见保留，不因格式问题暂停或重复计费", async () => {
    const { engine } = await setup({
      async generate() {
        return { text: "不是 JSON", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }
      },
    })
    const value = input()
    value.config.limits.concurrency = 1
    value.config.limits.maxRounds = 1
    value.config.limits.maxCalls = 24
    const run = await complete(engine, value)
    expect(["completed", "paused"]).toContain(run.status)
    expect(run.stopReason ?? "").not.toMatch(/格式|结构化评审|引用不合法/)
    expect(spent(run).tokens).toBe(run.calls.length * 150)
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
    expect(spent(run).tokens).toBeGreaterThanOrEqual(30)
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
    expect(JSON.parse(makePrompt(next, "independent", next.config.seats[0]!.id)).materialIds).toContain("humanFeedback")
    const response = await new DemoGateway(0).generate({
      model: DEFAULT_MODELS[0]!,
      system: "",
      prompt: makePrompt(next, "independent", next.config.seats[0]!.id),
      maxOutputTokens: 1000,
      signal: new AbortController().signal,
    })
    const citedFeedback = JSON.parse(response.text)
    citedFeedback.issues[0].evidenceIds = ["humanFeedback"]
    expect(() =>
      parseResult(JSON.stringify(citedFeedback), next, "independent", next.config.seats[0]!.id),
    ).not.toThrow()
    const sanitized = parseResult(
      JSON.stringify(citedFeedback),
      original,
      "independent",
      original.config.seats[0]!.id,
    ) as { issues: Array<{ evidenceIds: string[] }> }
    expect(sanitized.issues[0]?.evidenceIds).toEqual([])
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
  it("Host 丢弃未知证据并补齐遗漏的问题映射", async () => {
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
    const review = parseResult(JSON.stringify(value), run, "independent", "growth") as {
      issues: Array<{ evidenceIds: string[] }>
    }
    expect(review.issues[0]?.evidenceIds).toEqual([])
    const completed = await complete(engine)
    const revision = { ...completed.revisionResult, changes: [] }
    const normalized = parseResult(JSON.stringify(revision), completed, "revise", "editor") as {
      changes: Array<{ issueId: string }>
    }
    expect(normalized.changes.map(item => item.issueId)).toEqual(completed.issues.map(issue => issue.id))
  })
  it("丢弃模型输出中的冗余字段，并为缺失字段提供保守默认值", async () => {
    const { engine } = await setup()
    const completed = await complete(engine)
    const prompt = makePrompt(completed, "discuss", "delivery")
    const advertised = JSON.parse(prompt).outputSchema
    expect(advertised.additionalProperties).toBe(false)
    expect(advertised.properties.responses.items.additionalProperties).toBe(false)
    const response = await new DemoGateway(0).generate({
      model: DEFAULT_MODELS[1]!,
      system: "",
      prompt,
      maxOutputTokens: 1000,
      signal: new AbortController().signal,
    })
    const value = JSON.parse(response.text) as { responses: Array<Record<string, unknown>> }
    value.responses[0]!.unexpectedBallotField = "应被丢弃的冗余字段"
    const parsed = parseResult(JSON.stringify(value), completed, "discuss", "delivery")
    expect(parsed).not.toHaveProperty("responses.0.unexpectedBallotField")

    delete value.responses[0]!.proposedChange
    const normalized = parseResult(JSON.stringify(value), completed, "discuss", "delivery") as {
      responses: Array<{ proposedChange: string }>
    }
    expect(normalized.responses[0]?.proposedChange).toContain("保留当前问题")
  })
})
