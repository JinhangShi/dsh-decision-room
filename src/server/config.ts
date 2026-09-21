import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseEnv } from "node:util"
import { z } from "zod"
import { DEFAULT_MODELS, modelSchema, type Model } from "../core/models.js"
import { DecisionError } from "../core/schema.js"

export const gatewaySettingsSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine(value => {
      const parsed = new URL(value)
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    }, "网关地址必须是无凭据、无查询参数的 HTTPS 地址")
    .transform(value => value.replace(/\/+$/u, "")),
  apiKey: z.string().trim().min(1).max(1000),
})
export type GatewaySettingsInput = z.input<typeof gatewaySettingsSchema>
export type GatewaySettingsView = { configured: boolean; baseUrl: string }

export function gatewaySettingsView(env: NodeJS.ProcessEnv): GatewaySettingsView {
  return {
    configured: Boolean(env.AI_GATEWAY_BASE_URL?.trim() && env.AI_GATEWAY_API_KEY?.trim()),
    baseUrl: env.AI_GATEWAY_BASE_URL?.trim() ?? "",
  }
}

export function applyGatewaySettings(env: NodeJS.ProcessEnv, input: GatewaySettingsInput): void {
  const value = gatewaySettingsSchema.parse(input)
  env.AI_GATEWAY_BASE_URL = value.baseUrl
  env.AI_GATEWAY_API_KEY = value.apiKey
}

export function clearGatewaySettings(env: NodeJS.ProcessEnv): void {
  delete env.AI_GATEWAY_BASE_URL
  delete env.AI_GATEWAY_API_KEY
}

const persistedGatewaySchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string(),
  apiKey: z.string(),
  updatedAt: z.number().int().nonnegative(),
})
export type GatewaySettingsStore = {
  load(): Promise<boolean>
  save(input: GatewaySettingsInput): Promise<void>
  clear(): Promise<void>
}

export async function createGatewaySettingsStore(env: NodeJS.ProcessEnv): Promise<GatewaySettingsStore> {
  const file = env.DSH_DECISION_SETTINGS_FILE?.trim() || join(homedir(), ".dsh", "decision-room", "gateway.json")
  return {
    async load() {
      if (env.AI_GATEWAY_BASE_URL?.trim() && env.AI_GATEWAY_API_KEY?.trim()) return true
      try {
        const settings = persistedGatewaySchema.parse(JSON.parse(await readFile(file, "utf8")))
        if (!settings.configured) return false
        applyGatewaySettings(env, settings)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw new DecisionError("SETTINGS_STORAGE", "决策室网关配置损坏，已停止启动，请检查本地配置文件", 500)
      }
    },
    async save(input) {
      const settings = { configured: true, ...gatewaySettingsSchema.parse(input), updatedAt: Date.now() }
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 })
      await rename(temporary, file)
      applyGatewaySettings(env, settings)
    },
    async clear() {
      await rm(file, { force: true })
      clearGatewaySettings(env)
    },
  }
}

export async function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ models: Model[]; env: NodeJS.ProcessEnv }> {
  const resolved = { ...env }
  if (env.DSH_DECISION_ENV_FILE) {
    const imported = parseEnv(await readFile(env.DSH_DECISION_ENV_FILE, "utf8"))
    for (const [key, value] of Object.entries(imported)) {
      if (/^(?:AI_GATEWAY_|DECISION_PROVIDER_)/.test(key) && !resolved[key]) {
        resolved[key] = value
      }
    }
  }
  const models = env.DSH_DECISION_MODELS_FILE
    ? z
        .array(modelSchema)
        .min(1)
        .max(100)
        .parse(JSON.parse(await readFile(env.DSH_DECISION_MODELS_FILE, "utf8")))
    : structuredClone(DEFAULT_MODELS)
  if (new Set(models.map(model => model.key)).size !== models.length) {
    throw new Error("模型配置 key 重复")
  }
  return { models, env: resolved }
}
