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
import { NativeGateway, type NativeServices } from "./dsh/native-gateway.js"
import { DecisionTranscript } from "./dsh/transcript.js"
import { DemoGateway } from "./core/demo-gateway.js"
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt"

export const inject = [
  "webServer",
  "storageDomain",
  "tools",
  "skills",
  "agents",
  "sessions",
  "sessionPersistence",
  "llm",
  "tokenMeter",
  "agentPresets",
  "systemPrompt",
] as const
type Execution = { agent?: { session: { id: string; header?: { cwd?: string } } } }
type ToolDefinition = {
  name: string
  description: string
  parameters: object
  output: { schema: object; render(args: unknown, value: unknown): Array<{ type: "text"; text: string }> }
  execute(args: unknown, execution: Execution): Promise<unknown>
}
export type HostContext = {
  agentPresets?: NativeServices["agentPresets"]
  agents?: NativeServices["agents"]
  sessions?: NativeServices["sessions"]
  sessionPersistence?: NativeServices["sessionPersistence"]
  llm?: NativeServices["llm"]
  tokenMeter?: NativeServices["tokenMeter"]
  systemPrompt?: SystemPrompt
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
    const native =
      ctx.agents && ctx.sessions && ctx.sessionPersistence && ctx.llm && ctx.tokenMeter && ctx.agentPresets
        ? {
            agents: ctx.agents,
            sessions: ctx.sessions,
            sessionPersistence: ctx.sessionPersistence,
            llm: ctx.llm,
            tokenMeter: ctx.tokenMeter,
            agentPresets: ctx.agentPresets,
          }
        : undefined
    const demo = process.env.DSH_DECISION_DEMO === "1"
    const gateway = native
      ? new NativeGateway(
          native,
          configuration.models,
          demo
            ? new DemoGateway(20)
            : new RoutedGateway(new HttpGateway(configuration.env), new DshGateway(native.llm as unknown as DshLlm)),
        )
      : new RoutedGateway(
          new HttpGateway(configuration.env),
          llm && typeof llm.stream === "function" ? new DshGateway(llm) : undefined,
        )
    const engine = new DecisionEngine(store, configuration.models, gateway, demo ? "demo" : "live")
    await engine.initialize()
    const transcript = native
      ? new DecisionTranscript(native, store, configuration.models, message => ctx.logger?.warn?.(message))
      : undefined
    transcript?.reconcile()
    const stopContext = ctx.systemPrompt?.context({
      name: "decision-room-current-task",
      order: 80,
      text: context => {
        const run = store.list().find(item => item.scope.sessionId === context.agent?.id)
        if (!run) {
          return ""
        }
        return `当前会话有决策室任务。角色发言已在主聊天展示。可用 decision_room_status 读取结果；用户反馈后使用 decision_room_continue 创建下一版草稿，让用户在侧栏核对并开始。不要把用户偏好当成已证实事实，也不要自行扩大额度。\n${JSON.stringify({ id: run.id, version: run.version, status: run.status, question: run.brief.question, constraints: run.brief.constraints, summary: run.revisionResult?.summary, unresolved: run.issues.filter(issue => issue.status !== "addressed").map(issue => ({ id: issue.id, title: issue.title, status: issue.status })) })}`
      },
    })
    return { engine, transcript, stopContext, routes: createRoutes(engine, new URL("./web/", import.meta.url)) }
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
      void ready
        .then(async ({ engine, transcript, stopContext }) => {
          await engine.dispose()
          await transcript?.dispose()
          stopContext?.()
        })
        .catch(() => {})
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
    const continueReview = ctx.tools.register({
      name: "decision_room_continue",
      description:
        "将当前会话中用户明确提出的反馈保存为决策室下一版草稿，保留原方案与硬约束，不启动模型、不增加额度。运行中必须先由用户暂停。",
      parameters: {
        type: "object",
        properties: { parentId: { type: "string" }, feedback: { type: "string" } },
        required: ["parentId", "feedback"],
        additionalProperties: false,
      },
      output,
      async execute(args, execution) {
        const input = z
          .object({ parentId: z.string().uuid(), feedback: z.string().min(1).max(10000) })
          .strict()
          .parse(args)
        const { engine } = await ready
        const scope = executionScope(execution)
        const parent = engine.store.get(input.parentId)
        assertScope(parent, scope)
        const run = await engine.create({
          scope,
          brief: parent.brief,
          config: parent.config,
          parentId: parent.id,
          feedback: input.feedback,
        })
        return {
          id: run.id,
          version: run.version,
          status: run.status,
          message: "反馈已保存为下一版草稿。请在侧栏选择新版本，核对材料与预算后开始；未发起模型调用。",
        }
      },
    })
    return () => {
      prepare()
      status()
      continueReview()
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
      metadata: { version: "0.2.0", author: "QCC" },
    }),
  )
}
