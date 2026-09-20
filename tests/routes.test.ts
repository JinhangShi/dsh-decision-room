import { describe, expect, it } from "vitest"
import { createRoutes, trustedLocalRequest, type RequestLike, type ResponseLike } from "../src/server/routes.js"
import { complete, input, setup } from "./fixtures.js"

function request(path: string, method = "GET", value?: unknown, headers: Record<string, string> = {}): RequestLike {
  return {
    method,
    url: path,
    headers: { host: "localhost:4318", "sec-fetch-site": "same-origin", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (value !== undefined) {
        yield Buffer.from(JSON.stringify(value))
      }
    },
  }
}
async function invoke(
  handler: ReturnType<typeof createRoutes>,
  req: RequestLike,
): Promise<{ status: number; text: string; headers: Record<string, string>; json(): unknown }> {
  let status = 0
  let text = ""
  let headers: Record<string, string> = {}
  const response: ResponseLike = {
    writeHead(code, value) {
      status = code
      headers = value ?? {}
    },
    end(value) {
      text = String(value ?? "")
    },
  }
  await handler(req, response)
  return { status, text, headers, json: () => JSON.parse(text) }
}
describe("本地访问与任务授权边界", () => {
  it("本地 socket、Host、Origin 和 Fetch Metadata 同时检查", () => {
    expect(trustedLocalRequest(request("/"))).toBe(true)
    expect(trustedLocalRequest({ ...request("/"), socket: { remoteAddress: "10.0.0.1" } })).toBe(false)
    expect(trustedLocalRequest(request("/", "GET", undefined, { host: "evil.test:4318" }))).toBe(false)
    expect(trustedLocalRequest(request("/", "GET", undefined, { origin: "http://localhost:9000" }))).toBe(false)
    expect(trustedLocalRequest(request("/", "GET", undefined, { "sec-fetch-site": "cross-site" }))).toBe(false)
  })
  it("读写 API 都需要启动凭证，返回模型目录不会泄漏密钥环境名", async () => {
    const { engine } = await setup()
    const routes = createRoutes(engine, new URL("../lib/web/", import.meta.url))
    const bootstrap = await invoke(routes, request("/decision-room/api/bootstrap"))
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.text).not.toContain("apiKeyEnv")
    expect(bootstrap.text).not.toContain("AI_GATEWAY_API_KEY")
    const result = await invoke(
      routes,
      request("/decision-room/api/runs", "POST", input(), { "content-type": "application/json" }),
    )
    expect(result.status).toBe(403)
    expect(engine.store.list()).toHaveLength(0)
  })
  it("跨会话读取、操作、导出均拒绝，合法导出包含异议", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    const routes = createRoutes(engine, new URL("../lib/web/", import.meta.url))
    const bootstrap = (await invoke(routes, request("/decision-room/api/bootstrap"))).json() as { token: string }
    const headers = { "x-decision-token": bootstrap.token, "content-type": "application/json" }
    const wrong = new URLSearchParams({ sessionId: "other", workspaceId: run.scope.workspaceId })
    for (const suffix of ["", "/export"]) {
      expect(
        (
          await invoke(
            routes,
            request(`/decision-room/api/runs/${run.id}${suffix}?${wrong}`, "GET", undefined, headers),
          )
        ).status,
      ).toBe(403)
    }
    expect(
      (
        await invoke(
          routes,
          request(
            `/decision-room/api/runs/${run.id}/control`,
            "POST",
            { scope: { ...run.scope, sessionId: "other" }, revision: run.revision, action: "cancel" },
            headers,
          ),
        )
      ).status,
    ).toBe(403)
    const own = new URLSearchParams(run.scope)
    const exported = await invoke(
      routes,
      request(`/decision-room/api/runs/${run.id}/export?${own}`, "GET", undefined, headers),
    )
    expect(exported.status).toBe(200)
    expect(exported.text).toContain("未解决问题与异议")
    expect(exported.text).toContain("演示数据")
  })
  it("请求超过大小上限时不创建任务", async () => {
    const { engine } = await setup()
    const routes = createRoutes(engine, new URL("../lib/web/", import.meta.url))
    const bootstrap = (await invoke(routes, request("/decision-room/api/bootstrap"))).json() as { token: string }
    const result = await invoke(
      routes,
      request(
        "/decision-room/api/runs",
        "POST",
        { data: "x".repeat(760000) },
        { "x-decision-token": bootstrap.token, "content-type": "application/json" },
      ),
    )
    expect(result.status).toBe(413)
    expect(engine.store.list()).toHaveLength(0)
  })
})
