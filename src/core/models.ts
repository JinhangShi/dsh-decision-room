import { z } from "zod"
import { DEFAULT_LIMITS, DEFAULT_SEATS, DecisionError, type RunConfig } from "./schema.js"

export const modelSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/),
    label: z.string().min(1).max(160),
    family: z.string().min(1).max(80),
    model: z.string().min(1).max(200),
    transport: z.enum(["chat", "messages", "responses", "dsh"]),
    provider: z.string().optional(),
    baseUrlEnv: z.string().default("AI_GATEWAY_BASE_URL"),
    apiKeyEnv: z.string().default("AI_GATEWAY_API_KEY"),
    enabled: z.boolean(),
    availability: z.enum(["tested", "unverified", "unavailable"]),
    note: z.string().max(1000),
    inputCnyPerMillion: z.number().nonnegative().nullable().default(null),
    outputCnyPerMillion: z.number().nonnegative().nullable().default(null),
    contextTokens: z.number().int().min(2048).max(2000000).default(64000),
    maxInputTokens: z.number().int().min(1).max(2000000).optional(),
    outputParameter: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
    extraBody: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((model, ctx) => {
    const allowed = new Set(["thinking", "enable_thinking", "reasoning_effort", "temperature", "response_format"])
    for (const key of Object.keys(model.extraBody)) {
      if (!allowed.has(key)) {
        ctx.addIssue({ code: "custom", message: `extraBody 不允许字段 ${key}` })
      }
    }
    if (model.transport === "dsh" && (!model.provider || model.provider === "dsh-decision-room")) {
      ctx.addIssue({ code: "custom", message: "DSH 模型需要已配置的上游 provider，不能指向决策室自身" })
    }
  })
export type Model = z.infer<typeof modelSchema>
export const DEFAULT_MODELS: Model[] = [
  {
    key: "qwen",
    label: "千问 3.8 Max",
    family: "Qwen",
    model: "qwen3.8-max",
    // Official declared window; a configured gateway may impose a lower limit.
    // https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max (2026-09-23)
    contextTokens: 1000000,
    maxInputTokens: 991808,
    extraBody: { enable_thinking: false },
  },
  { key: "glm", label: "智谱 GLM 5.1", family: "GLM", model: "glm-5.1", extraBody: { thinking: { type: "disabled" } } },
  { key: "kimi", label: "Kimi K2.6", family: "Kimi", model: "kimi-k2.6", extraBody: {} },
  {
    key: "deepseek",
    label: "DeepSeek V4.1 Flash",
    family: "DeepSeek",
    model: "deepseek-v4.1-flash",
    extraBody: { thinking: { type: "disabled" } },
  },
].map(model =>
  modelSchema.parse({
    ...model,
    transport: "chat",
    enabled: true,
    availability: "tested",
    note: "2026-09-18：现有网关短文本调用成功，返回的 model 一致；结构化评审以实际调用为准。",
  }),
)
export function getModel(models: Model[], key: string): Model {
  const model = models.find(item => item.key === key)
  if (!model || !model.enabled) {
    throw new DecisionError("MODEL_UNAVAILABLE", `模型席位 ${key} 尚未接通或已禁用`)
  }
  return model
}
export function publicModels(models: Model[]): Array<Omit<Model, "apiKeyEnv" | "baseUrlEnv" | "extraBody">> {
  return models.map(({ apiKeyEnv: _key, baseUrlEnv: _url, extraBody: _body, ...model }) => model)
}

export function defaultConfiguration(models: Model[]): RunConfig {
  const enabled = models.filter(model => model.enabled)
  const select = (preferred: string, index: number) =>
    enabled.find(model => model.key === preferred)?.key ??
    enabled[index % Math.max(1, enabled.length)]?.key ??
    preferred
  return {
    seats: DEFAULT_SEATS.map((seat, index) => {
      const modelKey = select(seat.modelKey, index)
      return { ...seat, modelKey, modelFamily: getModel(models, modelKey).family }
    }),
    moderatorKey: select("qwen", 0),
    verifierKey: select("kimi", 1),
    limits: { ...DEFAULT_LIMITS },
  }
}
