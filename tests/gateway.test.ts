import { afterEach, describe, expect, it, vi } from "vitest"
import { DshGateway, HttpGateway } from "../src/core/gateway.js"
import { DEFAULT_MODELS, modelSchema } from "../src/core/models.js"

const env = {
  AI_GATEWAY_BASE_URL: "https://gateway.example.test/api/v1",
  AI_GATEWAY_API_KEY: "fixture-secret-never-print",
}
const request = () => ({
  model: DEFAULT_MODELS[0]!,
  system: "只输出 JSON",
  prompt: "测试",
  maxOutputTokens: 1000,
  signal: new AbortController().signal,
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("模型协议与身份检查", () => {
  it("只将凭据发送到 Host 配置的 HTTPS 地址，禁止跟随重定向", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3.8-max",
          choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      ),
    )
    const response = await new HttpGateway(env, fetcher).generate(request())
    expect(response.usage?.totalTokens).toBe(30)
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe("https://gateway.example.test/api/v1/chat/completions")
    expect(options?.redirect).toBe("error")
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: "qwen3.8-max",
      max_tokens: 1000,
      enable_thinking: false,
    })
  })
  it("拒绝网关悄悄改路由，但保留计费用量", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "other",
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
      ),
    )
    await expect(new HttpGateway(env, fetcher).generate(request())).rejects.toMatchObject({
      code: "MODEL_MISMATCH",
      response: { returnedModel: "other", usage: { totalTokens: 33 } },
    })
  })
  it("HTTP 200 的上游错误和截断输出都不能伪装成成功", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "upstream failed" } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ model: "qwen3.8-max", choices: [{ message: { content: "{}" }, finish_reason: "length" }] }),
        ),
      )
    const gateway = new HttpGateway(env, fetcher)
    await expect(gateway.generate(request())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" })
    await expect(gateway.generate(request())).rejects.toMatchObject({ code: "TRUNCATED" })
  })
  it("Messages 和 Responses 转换请求并读取各自用量", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "claude-test",
            content: [{ type: "text", text: "{}" }],
            usage: { input_tokens: 12, output_tokens: 34 },
            stop_reason: "end_turn",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "gpt-test",
            output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
            usage: { input_tokens: 15, output_tokens: 25 },
            status: "completed",
          }),
        ),
      )
    const gateway = new HttpGateway(env, fetcher)
    const messageRequest = {
      ...request(),
      model: modelSchema.parse({ ...DEFAULT_MODELS[0], model: "claude-test", transport: "messages", extraBody: {} }),
    }
    expect((await gateway.generate(messageRequest)).usage?.totalTokens).toBe(46)
    const responsesRequest = {
      ...request(),
      model: modelSchema.parse({ ...DEFAULT_MODELS[0], model: "gpt-test", transport: "responses", extraBody: {} }),
    }
    expect((await gateway.generate(responsesRequest)).usage?.totalTokens).toBe(40)
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).store).toBe(false)
  })
  it("底层错误或错误响应中的凭据不会回传给客户端", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`网络失败 ${env.AI_GATEWAY_API_KEY}`))
    try {
      await new HttpGateway(env, fetcher).generate(request())
      throw new Error("expected failure")
    } catch (error) {
      expect(String(error)).not.toContain(env.AI_GATEWAY_API_KEY)
      expect(String(error)).toContain("网络请求失败")
    }
  })
  it("DSH 原生流读取可见文本和 usage，不把推理或未知身份当作证明", async () => {
    const gateway = new DshGateway({
      async *stream() {
        yield { type: "reasoning-delta", text: "不应返回的推理" }
        yield { type: "text-delta", text: "{}" }
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 4 } }
        yield { type: "finish", reason: { kind: "stop" } }
      },
    })
    const response = await gateway.generate(request())
    expect(response).toEqual({ text: "{}", usage: { inputTokens: 14, outputTokens: 20, totalTokens: 34 } })
  })
  it("Messages 输入计费包含缓存读取和缓存写入，避免低估已报告用量", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "test",
          content: [{ type: "text", text: "{}" }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 30,
          },
          stop_reason: "end_turn",
        }),
      ),
    )
    const model = modelSchema.parse({ ...DEFAULT_MODELS[0], model: "test", transport: "messages", extraBody: {} })
    expect((await new HttpGateway(env, fetcher).generate({ ...request(), model })).usage).toEqual({
      inputTokens: 140,
      outputTokens: 20,
      totalTokens: 160,
    })
  })
})
