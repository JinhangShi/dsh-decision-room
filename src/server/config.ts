import { readFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { z } from "zod"
import { DEFAULT_MODELS, modelSchema, type Model } from "../core/models.js"

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
