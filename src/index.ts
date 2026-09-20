import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { DecisionEngine, publicRun } from "./core/engine.js"
import { DshGateway, HttpGateway, RoutedGateway, type DshLlm } from "./core/gateway.js"
import { briefSchema, DecisionError, assertScope, type Scope } from "./core/schema.js"
import { defaultConfiguration } from "./core/models.js"
import { domainPersistence, RunStore, type StorageDomain } from "./core/store.js"
import { loadConfiguration } from "./server/config.js"
import { createRoutes, type WebServer } from "./server/routes.js"

export const inject = ["webServer", "storageDomain", "tools", "skills"] as const
type Execution = { agent?: { session: { id: string; header?: { cwd?: string } } } }
type ToolDefinition = {
  name: string
  description: string
  parameters: object
  output: { schema: object; render(args: unknown, value: unknown): Array<{ type: "text"; text: string }> }
  execute(args: unknown, execution: Execution): Promise<unknown>
}
export type HostContext = {
  webServer: WebServer
  storageDomain: StorageDomain
  tools: { register(definition: ToolDefinition): () => void }
  skills: {
    register(skill: {
      name: string
      description: string
      whenToUse: string
      content: string
      source: "bundled"
      resourceBase: { kind: "directory"; path: string }
      metadata: Record<string, unknown>
    }): () => void
  }
  effect(setup: () => void | (() => void)): unknown
  get?(name: string): unknown
  logger?: { warn?(message: string): void }
}
function executionScope(execution: Execution): Scope {
  const session = execution.agent?.session
  if (!session?.id || !session.header?.cwd) {
    throw new DecisionError("SESSION", "当前工具调用缺少会话或工作空间来源")
  }
  return { sessionId: session.id, workspaceId: session.header.cwd }
}
export function apply(ctx: HostContext): void {
  const ready = (async () => {
    const configuration = await loadConfiguration()
    const llm = ctx.get?.("llm") as DshLlm | undefined
    const store = new RunStore(await domainPersistence(ctx.storageDomain))
    const gateway = new RoutedGateway(
      new HttpGateway(configuration.env),
      llm && typeof llm.stream === "function" ? new DshGateway(llm) : undefined,
    )
    const engine = new DecisionEngine(store, configuration.models, gateway)
    await engine.initialize()
    return { engine, routes: createRoutes(engine, new URL("./web/", import.meta.url)) }
  })()
  // Fail closed if durable storage or configuration cannot be initialized.
  ready.catch(() =>
    ctx.logger?.warn?.("[dsh-decision-room] 初始化失败，请核对 Host 环境和持久存储；没有回退到临时内存执行"),
  )
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/decision-room",
      async handler(req, res) {
        try {
          await (await ready).routes(req, res)
        } catch {
          res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
          res.end(JSON.stringify({ error: "决策室未能初始化，请核对模型配置与 Profile 存储" }))
        }
      },
    })
    return () => {
      dispose()
      void ready.then(({ engine }) => engine.dispose()).catch(() => {})
    }
  })
  ctx.effect(() => {
    const output = {
      schema: {},
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }],
    }
    const prepare = ctx.tools.register({
      name: "decision_room_prepare",
      description:
        "将用户明确提交的方案登记为当前会话的决策室草稿。不会调用模型或开始计费；请引导用户在当前会话的“打开决策室”中检查模型、范围和预算并开始。禁止用猜测补全硬约束。",
      parameters: z.toJSONSchema(briefSchema),
      output,
      async execute(args, execution) {
        const { engine } = await ready
        const run = await engine.create({
          scope: executionScope(execution),
          brief: briefSchema.parse(args),
          config: defaultConfiguration(engine.models),
        })
        return {
          id: run.id,
          status: run.status,
          message: "已保存草稿。请在当前会话输入区点击“打开决策室”，核对模型和预算后开始评审。",
        }
      },
    })
    const status = ctx.tools.register({
      name: "decision_room_status",
      description: "只读查看当前会话的决策任务、完整修订稿和保留异议。不会启动、续议或增加额度。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output,
      async execute(args, execution) {
        const { id } = z.object({ id: z.string().uuid() }).strict().parse(args)
        const run = (await ready).engine.store.get(id)
        assertScope(run, executionScope(execution))
        const visible = publicRun(run)
        return {
          id,
          version: run.version,
          status: run.status,
          phase: run.phase,
          stopReason: run.stopReason,
          issues: visible.issues,
          revision: visible.revisionResult,
          verification: visible.verification,
          humanDecision: visible.humanDecision,
        }
      },
    })
    return () => {
      prepare()
      status()
    }
  })
  const directory = new URL("../skills/decision-room/", import.meta.url)
  ctx.effect(() =>
    ctx.skills.register({
      name: "decision-room",
      description: "以独立多模型角色评审方案，保留证据缺口与分歧，生成完整修订稿，再由人取舍和续议。",
      whenToUse: "用户希望头脑风暴、客观评审业务方案、讨论增长与风险、比较方案或组织多模型决策时。",
      content: readFileSync(new URL("SKILL.md", directory), "utf8").replace(/^---[\s\S]*?---\s*/, ""),
      source: "bundled",
      resourceBase: { kind: "directory", path: fileURLToPath(directory) },
      metadata: { version: "0.1.1", author: "QCC" },
    }),
  )
}
