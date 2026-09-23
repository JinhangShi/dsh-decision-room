import { describe, expect, it } from "vitest"
import { reserveCheck, spent } from "../src/core/budget.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { DecisionEngine } from "../src/core/engine.js"
import type { ModelGateway, ModelRequest } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { limitsSchema, readDebateResult, REVIEW_MODES, runSchema } from "../src/core/schema.js"
import { RunStore } from "../src/core/store.js"
import { complete, input, setup } from "./fixtures.js"

function changingBallots(before?: (request: ModelRequest) => Promise<void>): ModelGateway {
  const demo = new DemoGateway(0)
  return {
    estimate: () => 2000,
    async generate(request) {
      await before?.(request)
      const response = await demo.generate(request)
      if (request.context?.phase === "discuss") {
        const result = JSON.parse(response.text)
        result.continueDiscussion = true
        for (const item of result.responses) {
          const previous = request.context.run.calls
            .filter(call => call.seatId === request.context!.seatId && call.phase === "discuss" && call.result)
            .flatMap(call => readDebateResult(call.result).responses)
            .findLast(ballot => ballot.issueId === item.issueId)
          const seatIndex = request.context.run.config.seats.findIndex(seat => seat.id === request.context!.seatId)
          item.position = previous
            ? previous.position === "reject"
              ? "revise"
              : "reject"
            : ["maintain", "revise", "reject", "abstain"][seatIndex % 4]
          item.blocking = true
        }
        response.text = JSON.stringify(result)
      }
      return response
    },
  }
}

describe("高额度边界与恢复", () => {
  it("两席真实状态机运行满 80 轮、耗尽 100 次 MCP 后仍完成修订和复核", async () => {
    let inserted = false
    const { engine } = await setup(
      changingBallots(async request => {
        const context = request.context!
        if (context.phase !== "discuss" || inserted) return
        inserted = true
        const attempts = await Promise.allSettled(
          Array.from({ length: 101 }, (_, index) =>
            context.authorizeTool(`capacity-${index}`, "mcp__synthetic__lookup", { index }),
          ),
        )
        expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(100)
        expect(attempts[100]).toMatchObject({ status: "rejected", reason: { code: "MCP_LIMIT" } })
        for (let index = 0; index < 100; index++) {
          await context.toolReceipt(`capacity-${index}`, "mcp__synthetic__lookup", `合成证据 ${index}`)
        }
      }),
    )
    try {
      const value = input()
      value.config.seats = value.config.seats.slice(0, 2)
      value.config.limits = structuredClone(REVIEW_MODES.find(mode => mode.id === "overnight")!.limits)
      const run = await complete(engine, value)
      expect(run.status).toBe("completed")
      expect(run.round).toBe(80)
      expect(run.calls).toHaveLength(245)
      expect(run.mcpCalls).toHaveLength(100)
      expect(run.mcpEvidence).toHaveLength(100)
      expect(run.calls.slice(-2).map(call => call.phase)).toEqual(["revise", "verify"])
      expect(runSchema.safeParse(run).success).toBe(true)
    } finally {
      await engine.dispose()
    }
  }, 60000)

  it("四席在第 40 轮暂停并重载，继续后在 400 次上限前完成收尾", async () => {
    let paused = false
    const gateway = changingBallots(async request => {
      const context = request.context!
      if (context.phase === "interpret" && context.run.round === 40 && !paused) {
        paused = true
        await engine.control(context.run.id, context.run.scope, "pause", context.run.revision)
      }
    })
    const { engine, persistence } = await setup(gateway)
    try {
      const value = input()
      value.config.limits = structuredClone(REVIEW_MODES.find(mode => mode.id === "overnight")!.limits)
      const checkpoint = await complete(engine, value)
      expect(checkpoint.status).toBe("paused")
      expect(checkpoint.round).toBe(40)
      await engine.dispose()
      const restored = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, changingBallots(), "demo")
      let run = checkpoint
      try {
        await restored.initialize()
        expect(restored.store.get(checkpoint.id)).toEqual(checkpoint)
        await restored.control(checkpoint.id, checkpoint.scope, "resume", checkpoint.revision)
        await restored.idle(checkpoint.id)
        run = restored.store.get(checkpoint.id)
        expect(run.status).toBe("completed")
        expect(run.round).toBe(78)
        expect(run.calls).toHaveLength(393)
        expect(run.calls.slice(-2).map(call => call.phase)).toEqual(["revise", "verify"])
        expect(run.calls.slice(0, checkpoint.calls.length)).toEqual(checkpoint.calls)
      } finally {
        await restored.dispose()
      }
      const exhausted = structuredClone(run)
      while (exhausted.calls.length < 400) {
        exhausted.calls.push({ ...exhausted.calls[0]!, id: `boundary-${exhausted.calls.length}` })
      }
      expect(spent(exhausted).calls).toBe(400)
      expect(() => reserveCheck(exhausted, 1, null)).toThrow("已达到模型调用次数上限")
      expect(limitsSchema.safeParse({ ...run.config.limits, maxCalls: 401 }).success).toBe(false)
    } finally {
      await engine.dispose()
    }
  }, 60000)
})
