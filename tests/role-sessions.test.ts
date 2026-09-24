import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import SessionStore, { Session, type SessionId } from "@deepseek-ai/dsh-session"
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import SubagentRuntime, { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent"
import { describe, expect, it, vi } from "vitest"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { repairRoleSessionCatalog } from "../src/dsh/role-sessions.js"
import { complete, input, setup, until } from "./fixtures.js"
import { nativeRuntime } from "./native-runtime.js"

async function mountCatalog(ctx: Context, root: string) {
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SubagentRuntime)
  ctx.plugin(JsonlSessionPersistence, { root })
  await until(() => Boolean(ctx.get("sessionPersistence") && ctx.get("subagents")))
}

describe("角色会话目录登记与修复", () => {
  it("兼容早期共享角色会话 ID，多个账本引用只登记一次且不跨工作空间", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-shared-role-"))
    const ctx = new Context()
    ctx.plugin(SessionStore)
    const { engine } = await setup()
    try {
      await mountCatalog(ctx, root)
      const run = await complete(engine)
      const seatId = run.calls[0]!.seatId
      const id = `session-dr-${run.id}-${seatId}` as SessionId
      const session = Session.create(id, [], {
        version: 0,
        id,
        createdAt: Date.now(),
        origin: "subagent",
        parentSession: run.scope.sessionId as SessionId,
        cwd: run.scope.workspaceId,
      })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      await ctx.sessions.flush(session)
      detach()
      const ledger = structuredClone(run)
      ledger.calls = ledger.calls.filter(call => call.seatId === seatId)
      ledger.calls.forEach(call => {
        call.contextSessionId = id
      })
      expect(ledger.calls.length).toBeGreaterThan(1)
      expect(
        await repairRoleSessionCatalog(
          ctx,
          [{ ...ledger, scope: { ...ledger.scope, workspaceId: "/foreign" } }],
          () => {},
        ),
      ).toEqual({ repaired: 0, skipped: 1, failed: 0 })
      expect(await repairRoleSessionCatalog(ctx, [ledger], () => {})).toEqual({ repaired: 1, skipped: 0, failed: 0 })
      const rows = await ctx.subagents.listChildren(run.scope.sessionId as SessionId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: "child", mode: "one-shot", label: expect.stringContaining("历史会话") })
      expect(await repairRoleSessionCatalog(ctx, [ledger], () => {})).toEqual({ repaired: 0, skipped: 1, failed: 0 })
      expect(engine.store.get(run.id)).toEqual(run)
    } finally {
      await engine.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("真实 DSH 创建的角色会话在派发前已登记，卸载后目录仍可读且只能作为一次性历史", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-role-catalog-"))
    const demo = new DemoGateway(0)
    const runtime = await nativeRuntime({
      async generate(request) {
        const call = request.context!
        const id = `session-dr-${call.run.id}-${call.seatId}-${call.callId}` as SessionId
        const persisted = await runtime.ctx.sessionPersistence.inspect(id)
        expect(foldSubagentDescriptor(persisted.events)).toMatchObject({
          mode: "one-shot",
          provider: "dsh-decision-room",
        })
        expect(persisted.meta.seedLength).toBe(0)
        expect(JSON.stringify(request.messages)).not.toContain("subagent/descriptor")
        return demo.generate(request)
      },
    })
    const { engine } = await setup(runtime.gateway)
    try {
      await mountCatalog(runtime.ctx, root)
      const run = await complete(engine)
      expect(run.status).toBe("completed")
      const rows = await runtime.ctx.subagents.listChildren(run.scope.sessionId as SessionId)
      expect(rows).toHaveLength(run.calls.length)
      expect(rows.every(row => row.kind === "child" && row.mode === "one-shot" && row.activity === "inactive")).toBe(
        true,
      )
      expect(rows.every(row => row.kind === "child" && row.label?.includes("V1"))).toBe(true)
      const callsBefore = structuredClone(run.calls)
      expect(await repairRoleSessionCatalog(runtime.ctx, [run], () => {})).toEqual({
        repaired: 0,
        skipped: run.calls.length,
        failed: 0,
      })
      expect(engine.store.get(run.id).calls).toEqual(callsBefore)
    } finally {
      await engine.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it("旧目录补登记保留前缀与模型历史，隔离作用域、占用与单条读取失败，重启后幂等", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-role-repair-"))
    const demo = new DemoGateway(0)
    let dispatched = 0
    const runtime = await nativeRuntime({
      async generate(request) {
        dispatched++
        return demo.generate(request)
      },
    })
    const { engine } = await setup(runtime.gateway)
    let reloaded: Context | undefined
    try {
      await mountCatalog(runtime.ctx, root)
      const create = runtime.ctx.agents.create.bind(runtime.ctx.agents)
      let first = true
      const legacy = vi.spyOn(runtime.ctx.agents, "create").mockImplementation(options => {
        const seed = first
          ? [
              {
                type: "subagent/descriptor" as const,
                seq: 0,
                time: Date.now(),
                data: { version: 999, mode: "one-shot" as const, provider: "other" },
              },
            ]
          : undefined
        first = false
        return create({ ...options, seed })
      })
      const value = input()
      value.config.limits = { ...value.config.limits, maxRounds: 2, maxCalls: 24 }
      const run = await complete(engine, value)
      legacy.mockRestore()
      expect(run.status).toBe("completed")
      const ids = run.calls.map(call => call.contextSessionId as SessionId)
      const snapshots = await Promise.all(ids.map(id => runtime.ctx.sessionPersistence.inspect(id)))
      expect(
        (await runtime.ctx.subagents.listChildren(run.scope.sessionId as SessionId)).every(
          row => row.kind === "diagnostic",
        ),
      ).toBe(true)
      const warn = vi.fn()
      const missingCatalog = vi
        .spyOn(runtime.ctx.sessionPersistence, "list")
        .mockRejectedValueOnce(new Error("offline"))
      expect(await repairRoleSessionCatalog(runtime.ctx, [run], warn)).toEqual({ repaired: 0, skipped: 0, failed: 1 })
      expect(warn).toHaveBeenCalledTimes(1)
      missingCatalog.mockRestore()
      warn.mockClear()
      const foreign = { ...run, scope: { ...run.scope, sessionId: "foreign-parent" } }
      expect(await repairRoleSessionCatalog(runtime.ctx, [foreign], warn)).toEqual({
        repaired: 0,
        skipped: ids.length,
        failed: 0,
      })

      using busy = await runtime.ctx.sessionPersistence.prepare(ids[1]!)
      const detach = runtime.ctx.sessions.enter(busy.session)
      runtime.ctx.sessions.announce(busy.session)
      const inspect = runtime.ctx.sessionPersistence.inspect.bind(runtime.ctx.sessionPersistence)
      const unavailable = vi.spyOn(runtime.ctx.sessionPersistence, "inspect").mockImplementation((id, signal) => {
        if (id === ids[2]) throw new Error("synthetic unavailable log")
        return inspect(id, signal)
      })
      try {
        expect(await repairRoleSessionCatalog(runtime.ctx, [run], warn)).toEqual({
          repaired: ids.length - 3,
          skipped: 2,
          failed: 1,
        })
      } finally {
        unavailable.mockRestore()
        detach()
      }
      expect(warn).toHaveBeenCalledTimes(1)
      expect(await repairRoleSessionCatalog(runtime.ctx, [run], warn)).toEqual({
        repaired: 2,
        skipped: ids.length - 2,
        failed: 0,
      })
      for (const [index, id] of ids.entries()) {
        const after = await runtime.ctx.sessionPersistence.inspect(id)
        const before = snapshots[index]!
        expect(after.meta).toEqual(before.meta)
        expect(after.events.slice(0, before.events.length)).toEqual(before.events)
        expect(Session.create(id, after.events, after.meta).deriveMessages()).toEqual(
          Session.create(id, before.events, before.meta).deriveMessages(),
        )
        expect(after.events.filter(event => event.type === "subagent/descriptor")).toHaveLength(1)
      }
      expect(engine.store.get(run.id)).toEqual(run)
      expect(dispatched).toBe(run.calls.length)
      await engine.dispose()
      await runtime.dispose()

      reloaded = new Context()
      reloaded.plugin(SessionStore)
      await mountCatalog(reloaded, root)
      const beforeReloadRepair = await Promise.all(ids.map(id => reloaded!.sessionPersistence.inspect(id)))
      expect(await repairRoleSessionCatalog(reloaded, [run], warn)).toEqual({
        repaired: 0,
        skipped: ids.length,
        failed: 0,
      })
      expect(await Promise.all(ids.map(id => reloaded!.sessionPersistence.inspect(id)))).toEqual(beforeReloadRepair)
      const rows = await reloaded.subagents.listChildren(run.scope.sessionId as SessionId)
      expect(rows.filter(row => row.kind === "child" && row.mode === "one-shot")).toHaveLength(ids.length - 1)
      expect(rows.find(row => row.id === ids[0])).toMatchObject({ kind: "diagnostic", reason: "corrupt" })
    } finally {
      await engine.dispose()
      await runtime.dispose()
      await reloaded?.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
