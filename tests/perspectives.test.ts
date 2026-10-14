import { describe, expect, it } from "vitest"
import { composeDecisionRequest } from "../src/composer.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { perspectiveLabel, perspectiveValue, PERSPECTIVES } from "../src/core/perspectives.js"
import { configurationWarnings, seatSchema } from "../src/core/schema.js"
import { RunStore } from "../src/core/store.js"
import { complete, input, setup } from "./fixtures.js"

describe("自定义评审视角", () => {
  it("兼容已有预设及缺省记录，限制自定义文本长度和空白", () => {
    const seat = input().config.seats[0]!
    for (const item of PERSPECTIVES) {
      expect(seatSchema.parse({ ...seat, perspective: item.id }).perspective).toBe(item.id)
      expect(perspectiveValue(perspectiveLabel(item.id))).toBe(item.id)
    }
    expect(seatSchema.parse({ ...seat, perspective: undefined }).perspective).toBeUndefined()
    expect(seatSchema.parse({ ...seat, perspective: "  无障碍体验  " }).perspective).toBe("无障碍体验")
    for (const value of ["", "   ", "a".repeat(121), { command: "unsafe" }]) {
      expect(seatSchema.safeParse({ ...seat, perspective: value }).success).toBe(false)
    }
  })

  it("自定义视角进入聊天草稿、真实派发提示词和持久化恢复", async () => {
    const demo = new DemoGateway(0)
    const prompts: Array<{ phase: string; role: { perspective?: string } }> = []
    const { engine, persistence } = await setup({
      generate: async request => {
        const prompt = JSON.parse(request.prompt)
        if (prompt.role) prompts.push({ phase: request.context!.phase, role: prompt.role })
        return demo.generate(request)
      },
    })
    const value = input()
    value.config.seats[0]!.perspective = "无障碍体验与包容性设计"
    expect(composeDecisionRequest(value.brief, value.config)).toContain("评审视角：无障碍体验与包容性设计")
    try {
      const run = await complete(engine, value)
      expect(
        prompts.some(p => p.phase === "independent" && p.role.perspective === value.config.seats[0]!.perspective),
      ).toBe(true)
      expect(
        prompts.some(p => p.phase === "discuss" && p.role.perspective === value.config.seats[0]!.perspective),
      ).toBe(true)
      const recovered = new RunStore(persistence)
      await recovered.initialize()
      expect(recovered.get(run.id).config.seats).toEqual(run.config.seats)
      const original = structuredClone(run)
      const next = await engine.create({ ...value, parentId: run.id, feedback: "补充可访问性材料" })
      expect(next.config.seats[0]!.perspective).toBe(value.config.seats[0]!.perspective)
      expect(engine.store.get(run.id)).toEqual(original)
    } finally {
      await engine.dispose()
    }
  })

  it("自定义名称不会被错误算作必需风险覆盖或额外模型族", () => {
    const config = input().config
    for (const seat of config.seats) seat.perspective = "风险与供应链韧性"
    expect(configurationWarnings(config).some(text => text.includes("缺少交付视角、风险视角、独立反方"))).toBe(true)
    for (const seat of config.seats) seat.modelFamily = "same-family"
    expect(configurationWarnings(config).some(text => text.includes("仅覆盖一个模型族"))).toBe(true)
  })
})
