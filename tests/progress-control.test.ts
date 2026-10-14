import { afterEach, describe, expect, it, vi } from "vitest"
import { createProgressControl } from "../src/progress-control.js"
import { createRoutes } from "../src/server/routes.js"
import { input, setup, until } from "./fixtures.js"

afterEach(() => vi.unstubAllGlobals())

describe("进度卡片直接控制 Host", () => {
  it.each(["pause", "cancel"] as const)("%s 中断在途请求、保留计费，并拒绝跨会话控制", async action => {
    const signals: AbortSignal[] = []
    const { engine } = await setup({
      generate(request) {
        signals.push(request.signal)
        return new Promise(() => {})
      },
    })
    const routes = createRoutes(engine, new URL("../lib/web/", import.meta.url))
    vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
      let status = 0
      let body = ""
      await routes(
        {
          method: options.method ?? "GET",
          url,
            headers: {
              host: "localhost:4318",
              "sec-fetch-site": "same-origin",
              ...Object.fromEntries(new Headers(options.headers)),
            },
          socket: { remoteAddress: "127.0.0.1" },
          async *[Symbol.asyncIterator]() {
            if (options.body) yield Buffer.from(String(options.body))
          },
        },
        {
          writeHead(code) {
            status = code
          },
          end(value) {
            body = String(value)
          },
        },
      )
      return new Response(body, { status })
    })
    try {
      const run = await engine.create(input())
      await engine.control(run.id, run.scope, "start", run.revision)
      await until(() => signals.length > 0)
      const before = engine.store.get(run.id)
      for (const scope of [
        { ...run.scope, sessionId: "other" },
        { ...run.scope, workspaceId: "/other" },
      ]) {
        await expect(createProgressControl(() => scope)(run.id, run.revision, action)).rejects.toThrow()
        expect(engine.store.get(run.id).status).toBe("running")
        expect(signals.every(signal => !signal.aborted)).toBe(true)
      }
      // Old card revisions must still be able to stop live work.
      await createProgressControl(() => run.scope)(run.id, run.revision, action)
      await engine.idle(run.id)
      const stopped = engine.store.get(run.id)
      expect(stopped.status).toBe(action === "pause" ? "paused" : "cancelled")
      expect(signals.every(signal => signal.aborted)).toBe(true)
      expect(stopped.calls.length).toBe(before.calls.length)
      expect(stopped.calls.every(call => call.status === "interrupted")).toBe(true)
      expect(stopped.calls.map(call => call.accountedTokens)).toEqual(before.calls.map(call => call.accountedTokens))
      expect(stopped.calls.every(call => call.accountedTokens > 0)).toBe(true)
    } finally {
      await engine.dispose()
    }
  })

  it("连接失败向卡片返回错误，重试重新获取凭证", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("网络断开"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "new-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "任务已结束" }), { status: 409 }))
    vi.stubGlobal("fetch", fetcher)
    const control = createProgressControl(() => input().scope)
    await expect(control("run", 1, "cancel")).rejects.toThrow("网络断开")
    await expect(control("run", 1, "cancel")).rejects.toThrow("任务已结束")
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
