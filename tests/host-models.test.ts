import { describe, expect, it } from "vitest"
import { hostModels } from "../src/dsh/host-models.js"
import { publicModels } from "../src/core/models.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { DecisionEngine } from "../src/core/engine.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { REVIEW_MODES } from "../src/core/schema.js"
import { MemoryPersistence, RunStore } from "../src/core/store.js"
import { input } from "./fixtures.js"

describe("DSH 模型目录", () => {
  it("使用宿主声明的提供方、模型和容量，不复制凭据或编造价格", async () => {
    const llm = {
      listProviders: () => [
        { id: "dsh-decision-room", name: "决策室" },
        { id: "gateway-a", name: "内部网关" },
      ],
      listModels: async (provider: string) => {
        expect(provider).toBe("gateway-a")
        return [
          { provider, id: "qwen-test", name: "Qwen Test", inputModalities: ["text"] },
          { provider, id: "image-only", name: "Image", inputModalities: ["image"] },
          { provider, id: "unknown-capacity", name: "Unknown" },
        ]
      },
      resolveModelInfo: async (_provider: string, model: string) => ({
        provider: "gateway-a",
        id: model,
        name: model,
        ...(model === "qwen-test" ? { context: { contextWindow: 64000 } } : {}),
      }),
    } as unknown as Parameters<typeof hostModels>[0]
    const models = await hostModels(llm)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      provider: "gateway-a",
      model: "qwen-test",
      transport: "dsh",
      family: "qwen",
      contextTokens: 64000,
      availability: "unverified",
      inputCnyPerMillion: null,
      outputCnyPerMillion: null,
    })
    expect(models[0]?.key).toMatch(/^dsh_[a-f0-9]{24}$/)
    expect(JSON.stringify(publicModels(models))).not.toContain("apiKey")
    expect(await hostModels(llm)).toEqual(models)
  })

  it("模型目录变化时，旧深度任务恢复为暂停而不自动派发", async () => {
    const persistence = new MemoryPersistence()
    const original = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, new DemoGateway(0), "demo")
    await original.initialize()
    const value = input()
    value.config.limits = structuredClone(REVIEW_MODES[2].limits)
    const created = await original.create(value)
    persistence.records.set(created.id, { ...created, status: "running", activeSince: Date.now() })
    const changed = [{ ...DEFAULT_MODELS[0]!, label: "新目录" }, ...DEFAULT_MODELS.slice(1)]
    const restored = new DecisionEngine(new RunStore(persistence), changed, new DemoGateway(0), "demo")
    try {
      await restored.initialize()
      expect(restored.store.get(created.id).status).toBe("paused")
      expect(restored.store.get(created.id).calls).toHaveLength(0)
    } finally {
      await restored.dispose()
      await original.dispose()
    }
  })

  it("没有符合容量要求的宿主模型时不创建评审任务", async () => {
    const engine = new DecisionEngine(new RunStore(new MemoryPersistence()), [], new DemoGateway(0), "live")
    await engine.initialize()
    await expect(engine.create(input())).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" })
    expect(engine.store.list()).toHaveLength(0)
    await engine.dispose()
  })
})
