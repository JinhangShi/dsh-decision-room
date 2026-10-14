import { afterEach, describe, expect, it, vi } from "vitest"
import { CallWatchdog } from "../src/core/call-watchdog.js"
import { DecisionEngine } from "../src/core/engine.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { GatewayError, type ModelRequest } from "../src/core/gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { DecisionError, type CallProgress } from "../src/core/schema.js"
import { RunStore } from "../src/core/store.js"
import { complete, input, setup } from "./fixtures.js"
import { nativeRuntime } from "./native-runtime.js"

const progress = (state: CallProgress["state"] = "streaming"): CallProgress => ({
  state,
  requestStartedAt: Date.now(),
  firstResponseAt: Date.now(),
  lastResponseAt: Date.now(),
  textChars: 0,
  reasoningChars: 20,
})
afterEach(() => vi.useRealTimers())

describe("调用期限与可恢复中断", () => {
  it("思考流刷新空闲计时，总期限不延长；工具等待不算模型无响应", async () => {
    vi.useFakeTimers()
    const watch = new CallWatchdog(new AbortController().signal, 20000, 5000)
    watch.activity(progress("waiting"))
    await vi.advanceTimersByTimeAsync(4000)
    watch.activity(progress())
    await vi.advanceTimersByTimeAsync(4000)
    expect(watch.signal.aborted).toBe(false)
    watch.activity(progress("finished"))
    await vi.advanceTimersByTimeAsync(7000)
    expect(watch.signal.aborted).toBe(false)
    watch.activity(progress("waiting"))
    await vi.advanceTimersByTimeAsync(4000)
    watch.activity(progress())
    await vi.advanceTimersByTimeAsync(1000)
    expect(watch.signal.reason.code).toBe("CALL_TIMEOUT")
  })

  it.each([false, true])("超时只派发一次，暂停且不递延到下一轮（idle=%s）", async idle => {
    vi.useFakeTimers()
    let request: ModelRequest | undefined
    const { engine, persistence } = await setup({
      async generate(value) {
        request = value
        await value.onProgress?.({ ...progress("waiting"), firstResponseAt: undefined, lastResponseAt: undefined })
        return new Promise(() => {})
      },
    })
    const value = input()
    value.config.limits.concurrency = 1
    value.config.limits.callTimeoutSeconds = idle ? 10 : 5
    value.config.limits.callIdleTimeoutSeconds = idle ? 5 : undefined
    const untouched = await engine.create(input({ scope: { sessionId: "other", workspaceId: "/other" } }))
    const run = await engine.create(value)
    await engine.control(run.id, run.scope, "start", run.revision)
    await vi.waitFor(() => expect(request).toBeDefined())
    await vi.advanceTimersByTimeAsync(5100)
    await engine.idle(run.id)
    const stopped = engine.store.get(run.id)
    expect(stopped.status).toBe("paused")
    expect(stopped.calls).toHaveLength(1)
    expect(stopped.calls[0]).toMatchObject({
      status: "interrupted",
      accounting: "uncertain",
      errorCode: idle ? "CALL_IDLE_TIMEOUT" : "CALL_TIMEOUT",
    })
    expect(stopped.calls[0]!.accountedTokens).toBe(stopped.calls[0]!.reservedTokens)
    expect(stopped.events.some(e => ["call_retry", "call_deferred"].includes(e.type))).toBe(false)
    expect(engine.store.get(untouched.id)).toEqual(untouched)
    const recovered = new DecisionEngine(new RunStore(persistence), DEFAULT_MODELS, new DemoGateway(0), "demo")
    await recovered.initialize()
    expect(recovered.store.get(run.id).calls).toEqual(stopped.calls)
    // A provider that ignores cancellation must not overwrite diagnostics after the task stops.
    await request!.onProgress?.({ ...progress(), textChars: 99999 })
    expect(engine.store.get(run.id).calls).toEqual(stopped.calls)
    await engine.dispose()
    await recovered.dispose()
  })

  it.each([
    new DecisionError("ABORTED", "宿主中断"),
    new Error("网络错误"),
    new GatewayError("TRUNCATED", "达到输出上限", {
      text: "{",
      usage: { inputTokens: 10, outputTokens: 8000, totalTokens: 8010 },
    }),
  ])("中断、未知异常和输出截断都不自动重试", async error => {
    const { engine } = await setup({
      async generate() {
        throw error
      },
    })
    const value = input()
    value.config.limits.concurrency = 1
    const stopped = await complete(engine, value)
    expect(stopped.status).toBe("paused")
    expect(stopped.calls).toHaveLength(1)
    expect(stopped.events.some(e => e.type === "call_retry" || e.type === "call_deferred")).toBe(false)
    await engine.dispose()
  })

  it("完整返回且用量已知的格式错误仍可有限重试", async () => {
    const demo = new DemoGateway(0)
    let attempts = 0
    const { engine } = await setup({
      async generate(request) {
        const result = await demo.generate(request)
        if (++attempts === 1) throw new GatewayError("OUTPUT_SCHEMA", "结构化评审校验失败", result)
        return result
      },
    })
    const run = await complete(engine)
    expect(run.status).toBe("completed")
    expect(run.events.filter(e => e.type === "call_retry")).toHaveLength(1)
    expect(run.calls[0]?.accounting).toBe("reported")
    await engine.dispose()
  })

  it("原生角色调用持久化流元数据，不存思考正文，恢复后保留", async () => {
    const demo = new DemoGateway(0)
    const runtime = await nativeRuntime({
      async generate(request) {
        await request.onProgress?.(progress("waiting"))
        await request.onProgress?.(progress())
        const result = await demo.generate(request)
        await request.onProgress?.({
          ...progress("finished"),
          textChars: result.text.length,
          finishReason: "stop",
          usage: result.usage,
        })
        return result
      },
    })
    const { engine, persistence } = await setup(runtime.gateway)
    try {
      const run = await complete(engine)
      expect(run.status).toBe("completed")
      expect(run.calls.every(c => c.progress?.finishReason === "stop" && c.progress.reasoningChars === 20)).toBe(true)
      const recovered = new RunStore(persistence)
      await recovered.initialize()
      expect(recovered.get(run.id).calls).toEqual(run.calls)
    } finally {
      await engine.dispose()
      await runtime.dispose()
    }
  })
})
