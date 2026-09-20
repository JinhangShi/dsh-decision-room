import type { SessionId } from "@deepseek-ai/dsh-session"
import type { AgentHandle } from "@deepseek-ai/dsh-agent"
import type { RunStore } from "../core/store.js"
import type { Model } from "../core/models.js"
import type { Run } from "../core/schema.js"
import type { NativeServices } from "./native-gateway.js"
import { decisionMessages } from "./messages.js"

/** Persist role messages as native plugin conversation events; never impersonate a human or mutate the agent loop's turn counter. */
export class DecisionTranscript {
  private pending = new Map<string, Promise<void>>()
  private owned = new Map<string, AgentHandle>()
  private unsubscribe: () => void
  private closing = false
  constructor(
    private services: NativeServices,
    private store: RunStore,
    private models: Model[],
    private warn: (message: string) => void,
  ) {
    this.unsubscribe = store.subscribe(run => this.schedule(run))
  }
  reconcile(): void {
    for (const run of this.store.list()) {
      this.schedule(run)
    }
  }
  private schedule(run: Run): void {
    if (this.closing) {
      return
    }
    const key = run.scope.sessionId
    const task = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.publish(run))
    this.pending.set(key, task)
    void task
      .catch(() => this.warn("决策室主聊天同步失败，原始评审已保存；请重新打开会话后刷新"))
      .finally(() => {
        if (this.pending.get(key) === task) {
          this.pending.delete(key)
        }
      })
  }
  private async publish(run: Run): Promise<void> {
    const sessionId = run.scope.sessionId as SessionId
    let session = this.services.sessions.get(sessionId)
    if (!session) {
      const existing = (await this.services.sessionPersistence.list()).find(header => header.id === sessionId)
      const setup = async (ctx: import("@deepseek-ai/dsh-agent").Agent["ctx"]) => {
        await this.services.agentPresets.mount(ctx, existing?.agentPreset)
      }
      const handle = existing
        ? await this.services.agents.resume({ resumeSessionId: sessionId, setup })
        : await this.services.agents.create({ sessionId, setup, meta: { cwd: run.scope.workspaceId } })
      this.owned.set(sessionId, handle)
      session = handle.agent.session
    }
    if (session.header.cwd !== run.scope.workspaceId) {
      throw new Error("主聊天与任务工作空间不一致")
    }
    const published = new Set(
      session.events.filter(event => event.type === "decision-room/message").map(event => event.data.id),
    )
    for (const message of decisionMessages(run, this.models)) {
      if (!published.has(message.id)) {
        session.append("decision-room/message", message)
        published.add(message.id)
      }
    }
    await this.services.sessions.flush(session)
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
  }
  async dispose(): Promise<void> {
    this.closing = true
    this.unsubscribe()
    await this.idle()
    // UI may have acquired the main agent since publication. Its lifecycle remains owned by DSH until plugin unload.
    await Promise.allSettled([...this.owned.values()].map(handle => handle.dispose()))
  }
}
