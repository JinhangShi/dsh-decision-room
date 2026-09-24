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
  it("两席运行满 20 轮、耗尽 1000 次 MCP 后仍完成修订和复核，并能重载全部证据", async () => {
    let inserted = false
    const { engine, persistence } = await setup(
      changingBallots(async request => {
        const context = request.context!
        if (context.phase !== "discuss" || inserted) return
        inserted = true
        const attempts = await Promise.allSettled(
          Array.from({ length: 1001 }, (_, index) =>
            context.authorizeTool(`capacity-${index}`, "mcp__synthetic__lookup", { index }),
          ),
        )
        expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1000)
        expect(attempts[1000]).toMatchObject({ status: "rejected", reason: { code: "MCP_LIMIT" } })
        for (let index = 0; index < 1000; index++) {
          await context.toolReceipt(`capacity-${index}`, "mcp__synthetic__lookup", `合成证据 ${index}`)
        }
      }),
    )
    try {
      const value = input()
      value.config.seats = value.config.seats.slice(0, 2)
      value.config.limits = structuredClone(REVIEW_MODES.find(mode => mode.id === "quick")!.limits)
      const run = await complete(engine, value)
      expect(run.status).toBe("completed")
      expect(run.round).toBe(20)
      expect(run.calls).toHaveLength(65)
      expect(run.mcpCalls).toHaveLength(1000)
      expect(run.mcpEvidence).toHaveLength(1000)
      expect(run.calls.slice(-2).map(call => call.phase)).toEqual(["revise", "verify"])
      expect(runSchema.safeParse(run).success).toBe(true)
      expect(limitsSchema.safeParse({ ...run.config.limits, maxMcpCalls: 1001 }).success).toBe(false)
      await engine.dispose()
      const restored = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, changingBallots(), "demo")
      try {
        await restored.initialize()
        expect(restored.store.get(run.id)).toEqual(run)
      } finally {
        await restored.dispose()
      }
    } finally {
      await engine.dispose()
    }
  }, 180000)

  it("四席在第 40 轮暂停并重载，继续跑满 200 轮，突破旧 400 次限制后完成收尾", async () => {
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
      value.config.limits = structuredClone(REVIEW_MODES.find(mode => mode.id === "deep")!.limits)
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
        expect(run.round).toBe(200)
        expect(run.calls.filter(call => call.status === "succeeded")).toHaveLength(1007)
        expect(run.calls).toHaveLength(1008)
        expect(run.calls.slice(-2).map(call => call.phase)).toEqual(["revise", "verify"])
        expect(run.calls.slice(0, checkpoint.calls.length)).toEqual(checkpoint.calls)
      } finally {
        await restored.dispose()
      }
      const exhausted = structuredClone(run)
      while (exhausted.calls.length < 2000) {
        exhausted.calls.push({ ...exhausted.calls[0]!, id: `boundary-${exhausted.calls.length}` })
      }
      expect(spent(exhausted).calls).toBe(2000)
      expect(() => reserveCheck(exhausted, 1, null)).toThrow("已达到模型调用次数上限")
      expect(limitsSchema.safeParse({ ...run.config.limits, maxCalls: 2001 }).success).toBe(false)
      expect(limitsSchema.safeParse({ ...run.config.limits, maxRounds: 201 }).success).toBe(false)
    } finally {
      await engine.dispose()
    }
  }, 600000)
})
