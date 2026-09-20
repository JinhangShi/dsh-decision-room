import { DemoGateway } from "../src/core/demo-gateway.js"
import { DecisionEngine } from "../src/core/engine.js"
import type { ModelGateway } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { DEFAULT_LIMITS, DEFAULT_SEATS, type CreateInput, type Run } from "../src/core/schema.js"
import { MemoryPersistence, RunStore } from "../src/core/store.js"

export function input(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    scope: { sessionId: "session-test", workspaceId: "/workspace/test" },
    brief: {
      title: "企业服务产品试点",
      question: "是否进入小范围试点？",
      objective: "在安全可控的前提下验证增长机会",
      constraints: "不得导出客户个人信息。只做有限试点，人工决定是否扩大。",
      plan: "为企业服务产品设计一个可逆的付费试点。先明确客户需求和交付范围，控制人力投入，记录实际客户反馈，再决定是否扩大。",
      sources: [],
    },
    config: {
      seats: structuredClone(DEFAULT_SEATS),
      moderatorKey: "qwen",
      verifierKey: "kimi",
      limits: { ...DEFAULT_LIMITS, callTimeoutSeconds: 5 },
    },
    ...overrides,
  }
}
export async function setup(
  gateway: ModelGateway = new DemoGateway(0),
  persistence = new MemoryPersistence(),
): Promise<{ engine: DecisionEngine; persistence: MemoryPersistence }> {
  const engine = new DecisionEngine(new RunStore(persistence), structuredClone(DEFAULT_MODELS), gateway, "demo")
  await engine.initialize()
  return { engine, persistence }
}
export async function complete(engine: DecisionEngine, value = input()): Promise<Run> {
  const draft = await engine.create(value)
  await engine.control(draft.id, draft.scope, "start", draft.revision)
  await engine.idle(draft.id)
  return engine.store.get(draft.id)
}
export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("等待条件超时")
}
