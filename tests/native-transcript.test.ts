import { describe, expect, it, vi } from "vitest"
import { KNOWN_SESSION_EVENT_TYPES, SessionId } from "@deepseek-ai/dsh-session"
import { registerDecisionSessionEvents } from "../src/index.js"
import { DecisionTranscript } from "../src/dsh/transcript.js"
import { decisionMessages } from "../src/dsh/messages.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { complete, input, setup } from "./fixtures.js"
import { nativeRuntime } from "./native-runtime.js"

describe("DSH 0.2 主聊天持久化", () => {
  it("原生会话卸载和冷恢复后完整保留多版本聊天，恢复投影不会重复调用或发布", async () => {
    registerDecisionSessionEvents(KNOWN_SESSION_EVENT_TYPES)
    const demo = new DemoGateway(0)
    const generate = vi.fn(demo.generate.bind(demo))
    const runtime = await nativeRuntime({ generate })
    const { engine } = await setup(runtime.gateway)
    const warn = vi.fn()
    let transcript = new DecisionTranscript(runtime.gateway.services, engine.store, engine.models, warn)
    try {
      const first = await complete(engine)
      const second = await engine.create(input({ parentId: first.id, feedback: "补充合成反馈后再次评审" }))
      await engine.control(second.id, second.scope, "start", second.revision)
      await engine.idle(second.id)
      await transcript.idle()
      const completed = [engine.store.get(first.id), engine.store.get(second.id)]
      expect(completed.every(run => run.status === "completed")).toBe(true)
      const parentId = SessionId(first.scope.sessionId)
      const before = runtime.ctx.sessions.get(parentId)!.snapshotEvents()
      const expectedIds = completed.flatMap(run => decisionMessages(run, engine.models).map(message => message.id))
      expect(before.filter(event => event.type === "decision-room/message").map(event => event.data.id)).toEqual(
        expectedIds,
      )
      const requestsBefore = generate.mock.calls.length
      await transcript.dispose()
      await runtime.parent.dispose()
      expect(runtime.ctx.sessions.get(parentId)).toBeUndefined()
      transcript = new DecisionTranscript(runtime.gateway.services, engine.store, engine.models, warn)
      transcript.reconcile()
      await transcript.idle()
      expect(warn).not.toHaveBeenCalled()
      const restored = runtime.ctx.sessions.get(parentId)!.snapshotEvents()
      expect(restored.slice(0, before.length)).toEqual(before)
      // Native restore appends a resume boundary; plugin projections must not be republished.
      expect(restored.slice(before.length).map(event => event.type)).toEqual(["session/end-seed"])
      expect(generate).toHaveBeenCalledTimes(requestsBefore)
      await using stored = await runtime.ctx.sessionPersistence.open(parentId, "read")
      expect((await stored.read()).events).toEqual(restored)
    } finally {
      await transcript.dispose()
      await engine.dispose()
      await runtime.dispose()
    }
  }, 30000)
})
