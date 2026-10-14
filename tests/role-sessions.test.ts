import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session"
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence"
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import SessionQueryEngine from "@deepseek-ai/dsh-session-query"
import SubagentRuntime, { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent"
import { describe, expect, it, vi } from "vitest"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { repairRoleSessionCatalog } from "../src/dsh/role-sessions.js"
import { complete, setup, until } from "./fixtures.js"
import { nativeRuntime } from "./native-runtime.js"

/** Real query reads/projections; these tests do not need a full-text search backend. */
class CatalogQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> {
    throw new Error("No search in catalog tests")
  }
  async searchEvents(): Promise<never> {
    throw new Error("No search in catalog tests")
  }
}
async function mountCatalog(ctx: Context) {
  ctx.plugin(CatalogQuery)
  ctx.plugin(SubagentRuntime, {})
  await until(() => Boolean(ctx.get("sessionQuery") && ctx.get("subagents")))
}
async function inspect(persistence: SessionPersistence, id: SessionId) {
  await using handle = await persistence.open(id, "read")
  return { meta: handle.header, events: (await handle.read()).events, inheritedEventCount: handle.inheritedEventCount }
}
async function persist(persistence: SessionPersistence, session: Session) {
  await using handle = await persistence.create(session.header)
  await handle.append(session.snapshotEvents())
  await handle.flush()
}
async function catalogRuntime(root: string) {
  const ctx = new Context()
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(JsonlSessionPersistence, { root, compression: "none" })
  await until(() => Boolean(ctx.get("sessionPersistence")))
  await mountCatalog(ctx)
  return ctx
}

describe("DSH 0.2 角色会话目录登记与修复", () => {
  it("共享角色 ID 只登记一次，父目录持久化且不跨工作空间", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-shared-role-"))
    const ctx = await catalogRuntime(root)
    const { engine } = await setup()
    try {
      const run = await complete(engine)
      const parentId = SessionId(run.scope.sessionId)
      await persist(
        ctx.sessionPersistence,
        Session.create(parentId, [], {
          version: SESSION_FORMAT_VERSION,
          id: parentId,
          createdAt: Date.now(),
          isSeeded: false,
          cwd: run.scope.workspaceId,
        }),
      )
      const seatId = run.calls[0]!.seatId
      const id = SessionId(`session-dr-${run.id}-${seatId}`)
      await persist(
        ctx.sessionPersistence,
        Session.create(id, [], {
          version: SESSION_FORMAT_VERSION,
          id,
          createdAt: Date.now(),
          isSeeded: false,
          origin: "subagent",
          parentSession: parentId,
          cwd: run.scope.workspaceId,
        }),
      )
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
      const rows = await ctx.subagents.listChildren(parentId)
      expect(rows).toEqual([
        expect.objectContaining({ id, mode: "one-shot", label: expect.stringContaining("历史会话") }),
      ])
      const parentBefore = await inspect(ctx.sessionPersistence, parentId)
      expect(await repairRoleSessionCatalog(ctx, [ledger], () => {})).toEqual({ repaired: 0, skipped: 1, failed: 0 })
      expect(await inspect(ctx.sessionPersistence, parentId)).toEqual(parentBefore)
      expect(engine.store.get(run.id)).toEqual(run)
    } finally {
      await engine.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("真实 AgentLoop 在派发前持久化子描述符和父目录，全部尝试保留为一次性历史", async () => {
    const demo = new DemoGateway(0)
    const runtime = await nativeRuntime({
      async generate(request) {
        const call = request.context!
        const id = SessionId(`session-dr-${call.run.id}-${call.seatId}-${call.callId}`)
        const persisted = await inspect(runtime.ctx.sessionPersistence, id)
        expect(foldSubagentDescriptor(persisted.events)).toMatchObject({
          mode: "one-shot",
          provider: "dsh-decision-room",
        })
        expect(persisted.meta.isSeeded).toBe(false)
        expect(persisted.inheritedEventCount).toBe(0)
        const parent = await inspect(runtime.ctx.sessionPersistence, SessionId(call.run.scope.sessionId))
        expect(parent.events.some(event => event.type === "subagent/catalog" && event.data.childId === id)).toBe(true)
        expect(JSON.stringify(request.messages)).not.toContain("subagent/descriptor")
        return demo.generate(request)
      },
    })
    const { engine } = await setup(runtime.gateway)
    try {
      await mountCatalog(runtime.ctx)
      const run = await complete(engine)
      expect(run.status).toBe("completed")
      const rows = await runtime.ctx.subagents.listChildren(SessionId(run.scope.sessionId))
      expect(rows).toHaveLength(run.calls.length)
      expect(rows.every(row => row.mode === "one-shot" && row.label?.includes("V1"))).toBe(true)
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
    }
  }, 30000)

  it("旧日志补登记保留历史前缀，拒绝占用和越界，单条失败可重试且重启幂等", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-role-repair-"))
    const ctx = await catalogRuntime(root)
    const { engine } = await setup()
    let reloaded: Context | undefined
    try {
      const run = structuredClone(await complete(engine))
      const parentId = SessionId(run.scope.sessionId)
      await persist(
        ctx.sessionPersistence,
        Session.create(parentId, [], {
          version: SESSION_FORMAT_VERSION,
          id: parentId,
          createdAt: Date.now(),
          isSeeded: false,
          cwd: run.scope.workspaceId,
        }),
      )
      for (const [index, call] of run.calls.entries()) {
        const id = SessionId(`session-dr-${run.id}-${call.seatId}-${call.id}`)
        call.contextSessionId = id
        const child = Session.create(id, [], {
          version: SESSION_FORMAT_VERSION,
          id,
          createdAt: Date.now(),
          isSeeded: false,
          cwd: run.scope.workspaceId,
          parentSession: parentId,
          origin: "subagent",
        })
        if (index === 0) child.append("subagent/descriptor", { version: 999, mode: "one-shot", provider: "other" })
        child.append(
          "user/message",
          {
            id: `legacy-${index}` as import("@deepseek-ai/dsh-llm").MessageId,
            role: "user",
            source: { kind: "dsh-decision-room" },
            content: [{ type: "text", text: "原始合成材料" }],
          },
          { surfaceOp: "append" },
        )
        await persist(ctx.sessionPersistence, child)
      }
      const ids = run.calls.map(call => SessionId(call.contextSessionId!))
      const snapshots = await Promise.all(ids.map(id => inspect(ctx.sessionPersistence, id)))
      const warn = vi.fn()
      vi.spyOn(ctx.sessionPersistence, "list").mockRejectedValueOnce(new Error("offline"))
      expect(await repairRoleSessionCatalog(ctx, [run], warn)).toEqual({ repaired: 0, skipped: 0, failed: 1 })
      expect(warn).toHaveBeenCalledTimes(1)
      vi.restoreAllMocks()
      warn.mockClear()
      expect(
        await repairRoleSessionCatalog(ctx, [{ ...run, scope: { ...run.scope, sessionId: "foreign" } }], warn),
      ).toEqual({ repaired: 0, skipped: ids.length, failed: 0 })
      const busy = await ctx.sessionPersistence.open(ids[1]!, "write")
      const faulty = {
        sessions: ctx.sessions,
        sessionPersistence: {
          list: ctx.sessionPersistence.list.bind(ctx.sessionPersistence),
          open: ((id, access, options) => {
            if (id === ids[2]) throw new Error("synthetic unavailable log")
            return ctx.sessionPersistence.open(id, access, options)
          }) satisfies SessionPersistence["open"],
        },
      }
      try {
        expect(await repairRoleSessionCatalog(faulty, [run], warn), JSON.stringify(warn.mock.calls)).toEqual({
          repaired: ids.length - 3,
          skipped: 1,
          failed: 2,
        })
      } finally {
        await busy.close()
      }
      expect(warn).toHaveBeenCalledTimes(2)
      expect(await repairRoleSessionCatalog(ctx, [run], warn)).toEqual({
        repaired: 2,
        skipped: ids.length - 2,
        failed: 0,
      })
      for (const [index, id] of ids.entries()) {
        const after = await inspect(ctx.sessionPersistence, id)
        const before = snapshots[index]!
        expect(after.meta).toEqual(before.meta)
        expect(after.events.slice(0, before.events.length)).toEqual(before.events)
        expect(Session.create(id, after.events, after.meta).deriveMessages()).toEqual(
          Session.create(id, before.events, before.meta).deriveMessages(),
        )
        expect(after.events.filter(event => event.type === "subagent/descriptor")).toHaveLength(1)
      }
      await ctx.fiber.dispose()
      reloaded = await catalogRuntime(root)
      const beforeReload = await Promise.all([...ids, parentId].map(id => inspect(reloaded!.sessionPersistence, id)))
      expect(await repairRoleSessionCatalog(reloaded, [run], warn)).toEqual({
        repaired: 0,
        skipped: ids.length,
        failed: 0,
      })
      expect(await Promise.all([...ids, parentId].map(id => inspect(reloaded!.sessionPersistence, id)))).toEqual(
        beforeReload,
      )
      const rows = await reloaded.subagents.listChildren(parentId)
      expect(rows.filter(row => row.mode === "one-shot")).toHaveLength(ids.length - 1)
      expect(rows.some(row => row.id === ids[0])).toBe(false)
    } finally {
      await engine.dispose()
      await ctx.fiber.dispose()
      await reloaded?.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
