import { createHash } from "node:crypto"
import type { LlmRuntime } from "@deepseek-ai/dsh-llm"
import { modelSchema, type Model } from "../core/models.js"

const ownProvider = "dsh-decision-room"

function family(modelId: string): string {
  const name = modelId.split("/").at(-1)?.toLowerCase() ?? modelId.toLowerCase()
  return (
    /^(?:qwen|deepseek|claude|kimi|glm|gpt|gemini|llama|mistral)/.exec(name)?.[0] ??
    name.match(/^[a-z]+/)?.[0] ??
    createHash("sha256").update(modelId).digest("hex").slice(0, 16)
  )
}

/** Only adapter-declared metadata is used; catalog entries do not prove upstream availability or identity. */
export async function hostModels(
  llm: Pick<LlmRuntime, "listProviders" | "listModels" | "resolveModelInfo">,
): Promise<Model[]> {
  const models: Model[] = []
  for (const provider of llm.listProviders()) {
    if (provider.id === ownProvider) continue
    for (const entry of await llm.listModels(provider.id)) {
      if (entry.inputModalities && !entry.inputModalities.includes("text")) continue
      const detail = await llm.resolveModelInfo(provider.id, entry.id)
      const capacity = detail.context?.contextWindow
      if (!capacity || capacity < 2048 || capacity > 2000000) continue
      const key = `dsh_${createHash("sha256")
        .update(JSON.stringify([provider.id, entry.id]))
        .digest("hex")
        .slice(0, 24)}`
      models.push(
        modelSchema.parse({
          key,
          label: `${provider.name} · ${entry.name}`.slice(0, 160),
          family: family(entry.id),
          model: entry.id,
          provider: provider.id,
          transport: "dsh",
          enabled: true,
          availability: "unverified",
          note: "DSH 提供方目录声明；实际可用性和上游身份以调用结果为准。",
          contextTokens: capacity,
          inputCnyPerMillion: null,
          outputCnyPerMillion: null,
        }),
      )
    }
  }
  return models
}
