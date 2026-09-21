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
  it.each(["deepseek-v4.1-flash", "deepseek-v4-1-flash-260910"])(
    "接受 DeepSeek 已知返回标识 %s，保留实际身份和用量，请求路由不变",
    async returnedModel => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: returnedModel,
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
        ),
      )
      const model = DEFAULT_MODELS.find(item => item.key === "deepseek")!
      const response = await new HttpGateway(env, fetcher).generate({ ...request(), model })
      expect(response).toEqual({
        text: "{}",
        returnedModel,
        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      })
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).model).toBe("deepseek-v4.1-flash")
    },
  )
  it.each(["deepseek-v4-1-flash-260911", "deepseek-v4-pro-20260813", "deepseek-v4-flash-20260731", "other-model"])(
    "拒绝未知版本或其他模型 %s，不按前缀、日期或系列名宽松匹配",
    async returnedModel => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: returnedModel,
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
        ),
      )
      await expect(
        new HttpGateway(env, fetcher).generate({
          ...request(),
          model: DEFAULT_MODELS.find(item => item.key === "deepseek")!,
        }),
      ).rejects.toMatchObject({
        code: "MODEL_MISMATCH",
        response: { returnedModel, usage: { totalTokens: 33 } },
      })
    },
  )
  it("DeepSeek 版本标识不能被另一个请求模型复用", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "deepseek-v4-1-flash-260910",
          choices: [{ message: { content: "{}" } }],
        }),
      ),
    )
    await expect(new HttpGateway(env, fetcher).generate(request())).rejects.toMatchObject({ code: "MODEL_MISMATCH" })
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
    const history = [
      { role: "user" as const, content: "原始方案" },
      { role: "assistant" as const, content: "上一轮评审" },
      { role: "user" as const, content: "交叉回应任务" },
    ]
    const gateway = new DshGateway({
      async *stream(options) {
        expect(options.messages.map(message => ({ role: message.role, content: message.content[0]?.text }))).toEqual(
          history,
        )
        expect(options.messages.every(message => message.source.kind === "plugin")).toBe(true)
        yield { type: "reasoning-delta", text: "不应返回的推理" }
        yield { type: "text-delta", text: "{}" }
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 4 } }
        yield { type: "finish", reason: { kind: "stop" } }
      },
    })
    const response = await gateway.generate({ ...request(), messages: history })
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
