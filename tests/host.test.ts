import { afterEach, describe, expect, it, vi } from "vitest"
import { apply, inject, type HostContext } from "../src/index.js"
import type { RequestLike } from "../src/server/routes.js"
import { input } from "./fixtures.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
describe("DSH Host 接入契约", () => {
  it("注册 Bundle Skill、工具和路由；原生草稿继承调用者范围且不启动模型", async () => {
    vi.stubEnv("DSH_DECISION_ENV_FILE", "")
    vi.stubEnv("DSH_DECISION_MODELS_FILE", "")
    const tools = new Map<string, Parameters<HostContext["tools"]["register"]>[0]>()
    const table = new Map<string, unknown>()
    const disposers: Array<() => void> = []
    let route: Parameters<HostContext["webServer"]["register"]>[0] | undefined
    let skill: Parameters<HostContext["skills"]["register"]>[0] | undefined
    const context: HostContext = {
      webServer: {
        register(value) {
          route = value
          return () => {
            route = undefined
          }
        },
      },
      storageDomain: {
        async open(spec) {
          expect(spec).toMatchObject({ name: "decision_room_v1", version: 1 })
          return {
            table: () => ({
              entries: () => table.entries(),
              put(key, value) {
                table.set(key, value)
              },
            }),
          }
        },
      },
      tools: {
        register(value) {
          tools.set(value.name, value)
          return () => {
            tools.delete(value.name)
          }
        },
      },
      skills: {
        register(value) {
          skill = value
          return () => {
            skill = undefined
          }
        },
      },
      effect(setup) {
        const dispose = setup()
        if (dispose) {
          disposers.push(dispose)
        }
      },
      get: () => undefined,
    }
    apply(context)
    expect(inject).toContain("storageDomain")
    expect(skill?.name).toBe("decision-room")
    expect(skill?.content).toContain("decision_room_prepare")
    const execution = { agent: { session: { id: "native-session", header: { cwd: "/workspace/native" } } } }
    const prepared = (await tools.get("decision_room_prepare")!.execute(input().brief, execution)) as {
      id: string
      status: string
    }
    expect(prepared.status).toBe("draft")
    expect(table.size).toBe(1)
    const stored = table.get(prepared.id) as { scope: unknown; calls: unknown[] }
    expect(stored.scope).toEqual({ sessionId: "native-session", workspaceId: "/workspace/native" })
    expect(stored.calls).toHaveLength(0)
    const status = await tools.get("decision_room_status")!.execute({ id: prepared.id }, execution)
    expect(JSON.parse(JSON.stringify(status))).toEqual(status)
    expect(status).not.toHaveProperty("verification")
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        "decision_room_start",
        "decision_room_continue",
        "decision_room_control",
        "decision_room_limits",
        "decision_room_decide",
      ]),
    )
    await expect(
      tools
        .get("decision_room_status")!
        .execute({ id: prepared.id }, { agent: { session: { id: "other", header: { cwd: "/workspace/native" } } } }),
    ).rejects.toThrow("当前工作空间和会话")
    let code = 0
    let response = ""
    const request: RequestLike = {
      method: "GET",
      url: "/decision-room/api/bootstrap",
      headers: { host: "localhost:4318" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {},
    }
    await route!.handler(request, {
      writeHead(status) {
        code = status
      },
      end(value) {
        response = String(value)
      },
    })
    expect(code).toBe(200)
    expect(JSON.parse(response).token).toHaveLength(64)
    for (const dispose of disposers.reverse()) {
      dispose()
    }
    expect(tools.size).toBe(0)
    expect(route).toBeUndefined()
    expect(skill).toBeUndefined()
  })
})
