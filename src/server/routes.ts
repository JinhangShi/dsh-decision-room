import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { DecisionEngine, publicRun } from "../core/engine.js"
import { defaultConfiguration, publicModels } from "../core/models.js"
import { reportHtml, reportMarkdown } from "../core/report.js"
import { assertScope, createSchema, DecisionError, scopeSchema } from "../core/schema.js"

export type RequestLike = AsyncIterable<Uint8Array> & {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string; encrypted?: boolean }
}
export type ResponseLike = {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}
export type WebServer = {
  register(input: { kind: "prefix"; path: string; handler(req: RequestLike, res: ResponseLike): unknown }): () => void
}
const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
}

export function trustedLocalRequest(req: RequestLike): boolean {
  const address = req.socket?.remoteAddress
  if (!address || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    return false
  }
  const host = req.headers.host
  if (typeof host !== "string" || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) {
    return false
  }
  const site = req.headers["sec-fetch-site"]
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return false
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (typeof origin !== "string") {
      return false
    }
    try {
      const parsed = new URL(origin)
      if (parsed.host !== host || !["http:", "https:"].includes(parsed.protocol)) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}
function send(res: ResponseLike, status: number, value: unknown): void {
  res.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(value))
}
async function body(req: RequestLike): Promise<unknown> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new DecisionError("CONTENT_TYPE", "请求必须使用 application/json", 415)
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 750000) {
      throw new DecisionError("BODY_LIMIT", "请求材料过大", 413)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new DecisionError("JSON", "请求不是有效 JSON")
  }
}
const mutationSchema = z.object({ scope: scopeSchema, revision: z.number().int().nonnegative() })

export function createRoutes(
  engine: DecisionEngine,
  assetDirectory: URL,
): (req: RequestLike, res: ResponseLike) => Promise<void> {
  // This capability stays in browser memory, never in URLs or task exports. Host is restricted to local trusted profiles.
  const token = randomBytes(32).toString("hex")
  return async (req, res) => {
    try {
      if (!trustedLocalRequest(req)) {
        throw new DecisionError("LOCAL_ONLY", "决策室首版只允许本机同源访问；请使用 localhost 打开 DSH", 403)
      }
      const url = new URL(req.url ?? "/", "http://localhost")
      const path = url.pathname.replace(/^\/decision-room/, "")
      if (req.method === "GET" && path === "/api/bootstrap") {
        return send(res, 200, {
          token,
          models: publicModels(engine.models),
          mode: engine.mode,
          defaults: defaultConfiguration(engine.models),
        })
      }
      if (req.method === "GET" && ["", "/", "/app.js", "/app.css"].includes(path)) {
        const name = path === "/app.js" ? "app.js" : path === "/app.css" ? "app.css" : "index.html"
        const content = await readFile(new URL(name, assetDirectory))
        res.writeHead(200, {
          ...securityHeaders,
          "content-type": name.endsWith(".js")
            ? "application/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
        })
        res.end(content)
        return
      }
      const supplied = req.headers["x-decision-token"]
      if (
        typeof supplied !== "string" ||
        supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        throw new DecisionError("CAPABILITY", "访问凭证失效，请刷新工作台", 403)
      }
      if (path === "/api/runs" && req.method === "POST") {
        return send(res, 201, publicRun(await engine.create(createSchema.parse(await body(req)))))
      }
      const scope = () =>
        scopeSchema.parse({
          sessionId: url.searchParams.get("sessionId"),
          workspaceId: url.searchParams.get("workspaceId"),
        })
      if (path === "/api/runs" && req.method === "GET") {
        const requested = scope()
        const runs = engine.store
          .list()
          .filter(run => run.scope.sessionId === requested.sessionId && run.scope.workspaceId === requested.workspaceId)
          .map(publicRun)
        return send(res, 200, runs)
      }
      const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(control|limits|decision|export))?$/.exec(path)
      if (!match) {
        throw new DecisionError("ROUTE", "接口不存在", 404)
      }
      const id = match[1]!
      const run = engine.store.get(id)
      if (!match[2] && req.method === "GET") {
        assertScope(run, scope())
        return send(res, 200, publicRun(run))
      }
      if (match[2] === "export" && req.method === "GET") {
        assertScope(run, scope())
        // Apply the same blind-review barrier to exports as to the live UI.
        const visible = publicRun(run)
        const html = url.searchParams.get("format") === "html"
        res.writeHead(200, {
          ...securityHeaders,
          "content-type": html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="decision-${id}-v${run.version}.${html ? "html" : "md"}"`,
        })
        res.end(html ? reportHtml(visible, engine.models) : reportMarkdown(visible, engine.models))
        return
      }
      if (match[2] === "control" && req.method === "POST") {
        const input = mutationSchema
          .extend({ action: z.enum(["start", "resume", "pause", "cancel", "finish"]) })
          .strict()
          .parse(await body(req))
        return send(res, 200, publicRun(await engine.control(id, input.scope, input.action, input.revision)))
      }
      if (match[2] === "limits" && req.method === "PUT") {
        const input = mutationSchema
          .extend({ limits: z.unknown() })
          .strict()
          .parse(await body(req))
        return send(res, 200, publicRun(await engine.changeLimits(id, input.scope, input.revision, input.limits)))
      }
      if (match[2] === "decision" && req.method === "POST") {
        const input = mutationSchema
          .extend({ decision: z.enum(["adopt", "reject", "defer"]), reason: z.string().min(1).max(2000) })
          .strict()
          .parse(await body(req))
        return send(
          res,
          200,
          publicRun(await engine.decide(id, input.scope, input.revision, input.decision, input.reason)),
        )
      }
      throw new DecisionError("METHOD", "接口不支持此请求方法", 405)
    } catch (error) {
      const code = error instanceof DecisionError ? error.status : error instanceof z.ZodError ? 400 : 500
      const message =
        error instanceof DecisionError
          ? error.message
          : error instanceof z.ZodError
            ? `参数无效：${error.issues
                .slice(0, 3)
                .map(issue => issue.path.join(".") || "输入")
                .join("、")}`
            : "Host 处理失败，请检查配置和存储；没有返回内部敏感信息"
      send(res, code, { error: message })
    }
  }
}
