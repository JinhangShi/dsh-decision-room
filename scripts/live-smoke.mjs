import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { build } from "esbuild"

// Explicit paid test command: uses synthetic material, never real business documents.
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local")
}
await mkdir(".decision-room", { recursive: true })
const output = resolve(".decision-room/live-smoke-runner.mjs")
await build({
  stdin: {
    contents: `
import { loadConfiguration } from "./src/server/config.ts"
import { DecisionEngine } from "./src/core/engine.ts"
import { HttpGateway } from "./src/core/gateway.ts"
import { FilePersistence, RunStore } from "./src/core/store.ts"
import { DEFAULT_LIMITS, DEFAULT_SEATS } from "./src/core/schema.ts"
import { spent } from "./src/core/budget.ts"
export async function smoke() {
 const config = await loadConfiguration()
 const engine = new DecisionEngine(new RunStore(new FilePersistence(".decision-room/live-smoke")), config.models, new HttpGateway(config.env))
 await engine.initialize()
 const draft = await engine.create({
  scope: { sessionId: "live-smoke", workspaceId: "synthetic-validation" },
  brief: { title: "合成验收：内部知识问答试点", question: "是否先做可逆的内部小范围试点？", objective: "在明确数据与资源边界下验证员工查询效率是否改善。", constraints: "只使用公开帮助文档。不得上传个人信息或客户资料。只提出方案，不操作业务系统。最多投入两名员工各一天；超过即停止。", plan: "拟用公开帮助文档做一个内部知识问答试点。先选取十个常见问题，由两名员工比较当前查找方式与问答方式的耗时及答案依据。试点持续一天，记录原始问答、出处和错误，不预设收益数字。若出现无法解释的答案或缺少引用，应停止扩大。试点结束后由人工评估是否继续，随时可回到原来的文档查找方式。", sources: [] },
  config: { seats: DEFAULT_SEATS, moderatorKey: "qwen", verifierKey: "kimi", limits: { ...DEFAULT_LIMITS, maxRounds: 1, maxCalls: 16, maxDurationMinutes: 15, outputTokens: 7000, tokenBudget: 600000, callTimeoutSeconds: 180 } }
 })
 await engine.control(draft.id, draft.scope, "start", draft.revision)
 await engine.idle(draft.id)
 const run = engine.store.get(draft.id)
 await engine.dispose()
 return { at: new Date().toISOString(), id: run.id, status: run.status, phase: run.phase, stopReason: run.stopReason, usage: spent(run), reportReady: Boolean(run.revisionResult && run.verification), calls: run.calls.map(c => ({ phase: c.phase, model: c.modelKey, returnedModel: c.returnedModel, status: c.status, error: c.error, usage: c.usage })) }
}`,
    resolveDir: process.cwd(),
    sourcefile: "live-smoke-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
})
const { smoke } = await import(pathToFileURL(output).href)
const result = await smoke()
await writeFile(".decision-room/live-smoke-result.json", JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (result.status !== "completed") {
  process.exitCode = 1
}
