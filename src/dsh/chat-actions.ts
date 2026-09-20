import { z } from "zod"
import { defaultConfiguration } from "../core/models.js"
import { assertScope, briefSchema, DecisionError, runConfigSchema, type Scope, type Run } from "../core/schema.js"
import type { DecisionEngine } from "../core/engine.js"

export const startReviewSchema = z.object({ brief: briefSchema, config: runConfigSchema.optional() }).strict()
export const continueReviewSchema = z
  .object({
    parentId: z.string().uuid(),
    feedback: z.string().min(1).max(10000),
    brief: briefSchema.optional(),
    config: runConfigSchema.optional(),
    start: z.boolean().default(false),
  })
  .strict()

/** Serialize one conversation's mutations and reuse the same human submission across tool retries. */
export class DecisionChatActions {
  private pending = new Map<string, Promise<unknown>>()
  constructor(private engine: DecisionEngine) {}
  private async serial<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope)
    const task = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.pending.set(key, task)
    try {
      return await task
    } finally {
      if (this.pending.get(key) === task) {
        this.pending.delete(key)
      }
    }
  }
  private existing(scope: Scope, messageId?: string): Run | undefined {
    return messageId
      ? this.engine.store
          .list()
          .find(
            run =>
              run.scope.sessionId === scope.sessionId &&
              run.scope.workspaceId === scope.workspaceId &&
              run.submissionMessageId === messageId,
          )
      : undefined
  }
  start(scope: Scope, value: unknown, messageId?: string): Promise<Run> {
    const input = startReviewSchema.parse(value)
    return this.serial(scope, async () => {
      const existing = this.existing(scope, messageId)
      if (existing) {
        return existing
      }
      if (
        this.engine.store
          .list()
          .some(
            run =>
              run.scope.sessionId === scope.sessionId &&
              run.scope.workspaceId === scope.workspaceId &&
              run.status === "running",
          )
      ) {
        throw new DecisionError("ACTIVE_REVIEW", "当前会话已有评审在运行，请先暂停或等待完成，再发起新评审")
      }
      const run = await this.engine.create({
        scope,
        brief: input.brief,
        config: input.config ?? defaultConfiguration(this.engine.models),
        submissionMessageId: messageId,
      })
      return this.engine.control(run.id, scope, "start", run.revision)
    })
  }
  continue(scope: Scope, value: unknown, messageId?: string): Promise<Run> {
    const input = continueReviewSchema.parse(value)
    return this.serial(scope, async () => {
      const parent = this.engine.store.get(input.parentId)
      assertScope(parent, scope)
      const existing = this.existing(scope, messageId)
      if (existing) {
        return existing
      }
      const run = await this.engine.create({
        scope,
        parentId: parent.id,
        feedback: input.feedback,
        brief: input.brief ?? { ...parent.brief, plan: parent.revisionResult?.fullPlan ?? parent.brief.plan },
        config: input.config ?? parent.config,
        submissionMessageId: messageId,
      })
      return input.start ? this.engine.control(run.id, scope, "start", run.revision) : run
    })
  }
}
