import { Context } from "@deepseek-ai/cordis"
import AgentRegistry from "@deepseek-ai/dsh-agent"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import SessionStore from "@deepseek-ai/dsh-session"
import { LlmRuntime, type UserMessage } from "@deepseek-ai/dsh-llm"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools"
import TokenMeter from "@deepseek-ai/dsh-token-meter"
import { NativeGateway, type NativeServices } from "../src/dsh/native-gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import type { ModelGateway } from "../src/core/gateway.js"
import { until } from "./fixtures.js"

/** Real Cordis waterfalls, AgentLoop, tool execution, session replay and LLM routing. Only the upstream is fake. */
export async function nativeRuntime(http: ModelGateway, definitions: ToolDefinition[] = []) {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(SessionStore)
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentRegistry)
  ctx.plugin(TokenMeter, {})
  ctx.plugin(ToolRuntime, {})
  ctx.plugin(AgentLoop, { agents: [] })
  await until(() => Boolean(ctx.get("agentLoop")))
  definitions.forEach(tool => ctx.tools.register(tool))
  const services = {
    agents: ctx.agents,
    sessions: ctx.sessions,
    llm: ctx.llm,
    tokenMeter: ctx.tokenMeter,
    sessionPersistence: { list: async () => [] },
    agentPresets: {
      async mount(scope) {
        scope.on("agent/pre-step", async (_payload, next) => {
          const decision = await next()
          const foreign = {
            id: "foreign-catalog",
            role: "user",
            source: { kind: "skill-catalog", form: "catalog", entries: [] },
            content: [{ type: "text", text: "unavailable-skill-catalog" }],
          } as unknown as UserMessage
          return decision.kind === "enter" ? { ...decision, messages: [...decision.messages, foreign] } : decision
        })
      },
    },
  } satisfies NativeServices
  const gateway = new NativeGateway(services, DEFAULT_MODELS, http)
  return {
    ctx,
    gateway,
    async dispose() {
      await gateway.dispose()
      await ctx.fiber.dispose()
    },
  }
}

export function largeCatalog(
  execute: ToolDefinition["execute"] = async () => ({ text: "合成材料" }),
): ToolDefinition[] {
  return Array.from({ length: 151 }, (_, index) => ({
    name: `mcp__fixture__lookup_${index}`,
    description: `${index === 150 ? "needle_unique 司法执行查询" : "客户交付风险证据查询"} ${"合成工具说明，不代表外部事实。".repeat(20)}`,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "合成查询参数".repeat(20) } },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute,
  }))
}
