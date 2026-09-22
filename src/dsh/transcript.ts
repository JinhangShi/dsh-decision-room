import type { SessionId } from "@deepseek-ai/dsh-session"
import type { AgentHandle } from "@deepseek-ai/dsh-agent"
import type { RunStore } from "../core/store.js"
import type { Model } from "../core/models.js"
import type { Run } from "../core/schema.js"
import type { NativeServices } from "./native-gateway.js"
import { decisionMessages, decisionProgress } from "./messages.js"

/** Persist role messages as native plugin conversation events; never impersonate a human or mutate the agent loop's turn counter. */
export class DecisionTranscript {
  private pending = new Map<string, Promise<void>>()
  private latest = new Map<string, Run>()
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
    this.latest.set(key, run)
    if (this.pending.has(key)) return
    const task = this.drain(key)
    this.pending.set(key, task)
    void task
      .catch(() => this.warn("决策室主聊天同步失败，原始评审已保存；请重新打开会话后刷新"))
      .finally(() => {
        if (this.pending.get(key) === task) {
          this.pending.delete(key)
        }
      })
  }
  private async drain(key: string): Promise<void> {
    while (!this.closing) {
      const run = this.latest.get(key)
      if (!run) return
      this.latest.delete(key)
      await this.publish(run)
    }
  }
  private async publish(run: Run): Promise<void> {
    if (run.status === "draft") {
      return
    }
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
    const previous = session.events
      .filter(event => event.type === "decision-room/progress")
      .filter(event => event.data.progress.runId === run.id)
      .at(-1)
    if (!previous || previous.data.progress.revision < run.revision) {
      session.append("decision-room/progress", { initial: !previous, progress: decisionProgress(run, this.models) })
    }
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
