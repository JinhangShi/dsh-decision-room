import { createHash, randomUUID } from "node:crypto"
import { activeElapsed, cost, estimateTokens, reserveCheck, settle, spent } from "./budget.js"
import { GatewayError, type ModelGateway, type ModelResponse } from "./gateway.js"
import { getModel, type Model } from "./models.js"
import { assignedIssues, makePrompt, parseResult, SYSTEM } from "./prompts.js"
import {
  assertScope,
  createSchema,
  debateSchema,
  DecisionError,
  limitsSchema,
  organizeSchema,
  reviewSchema,
  revisionSchema,
  verificationSchema,
  type Call,
  type CreateInput,
  type Phase,
  type Run,
  type Scope,
} from "./schema.js"
import { RunStore } from "./store.js"

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
function event(run: Run, type: string, text: string): void {
  run.events.push({ id: randomUUID(), at: Date.now(), type, text })
}
function stopClock(run: Run): void {
  run.elapsedMs = activeElapsed(run)
  delete run.activeSince
}
function safeError(error: unknown): string {
  return error instanceof DecisionError ? error.message : "处理失败；检查点已保留。请检查 Host 日志和存储可用性"
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new DecisionError("ABORTED", "调用已停止或超时；保留预留额度等待对账"))
    }
    if (signal.aborted) {
      abort()
    } else {
      signal.addEventListener("abort", abort, { once: true })
    }
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {})
  })
}

export class DecisionEngine {
  private jobs = new Map<string, Promise<void>>()
  private controllers = new Map<string, AbortController>()
  private closing = false
  private activeCalls = 0
  private waiters: Array<() => void> = []
  private starts: Promise<unknown> = Promise.resolve()
  constructor(
    readonly store: RunStore,
    readonly models: Model[],
    private gateway: ModelGateway,
    readonly mode: "live" | "demo" = "live",
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize()
    for (const record of this.store.list()) {
      if (record.status === "running" || record.calls.some(call => call.status === "running")) {
        await this.store.update(record.id, run => {
          stopClock(run)
          run.status = "paused"
          run.epoch += 1
          run.stopReason = "宿主重启：已恢复检查点，待你继续。中断调用按预留额度保守计入，不自动重发"
          for (const call of run.calls.filter(item => item.status === "running")) {
            call.status = "interrupted"
            call.accounting = "uncertain"
            call.endedAt = Date.now()
          }
          event(run, "recovered", run.stopReason)
        })
      }
    }
  }
  async create(inputValue: CreateInput): Promise<Run> {
    const input = createSchema.parse(inputValue)
    const keys = new Set([
      ...input.config.seats.map(seat => seat.modelKey),
      input.config.moderatorKey,
      input.config.verifierKey,
    ])
    for (const key of keys) {
      const model = getModel(this.models, key)
      if (input.config.limits.maxCostCny !== null && cost(model, 1, 1) === null) {
        throw new DecisionError("PRICE_REQUIRED", "启用金额预算前，需要为所有参与模型配置实际 API 价格")
      }
    }
    let version = 1
    if (input.parentId) {
      const parent = this.store.get(input.parentId)
      assertScope(parent, input.scope)
      if (!["completed", "paused", "cancelled", "failed"].includes(parent.status)) {
        throw new DecisionError("PARENT_ACTIVE", "请先暂停或结束上一版本，再发起续议", 409)
      }
      if (!input.feedback?.trim()) {
        throw new DecisionError("FEEDBACK", "续议需要记录新增事实、约束或异议")
      }
      version = parent.version + 1
    }
    const now = Date.now()
    const run: Run = {
      schemaVersion: 1,
      id: randomUUID(),
      revision: 0,
      scope: input.scope,
      brief: input.brief,
      briefHash: hash(JSON.stringify(input.brief)),
      configurationHash: hash(JSON.stringify(this.models)),
      config: input.config,
      version,
      parentId: input.parentId,
      feedback: input.feedback,
      status: "draft",
      phase: "independent",
      round: 0,
      epoch: 0,
      elapsedMs: 0,
      createdAt: now,
      updatedAt: now,
      finishRequested: false,
      calls: [],
      issues: [],
      events: [],
      mode: this.mode,
    }
    event(
      run,
      "created",
      input.parentId ? "已创建人工反馈后的新版本；旧版本保持不变，重新进行独立评审" : "已冻结共同材料，等待开始评审",
    )
    return this.store.insert(run)
  }
  async control(
    id: string,
    scope: Scope,
    action: "start" | "resume" | "pause" | "cancel" | "finish",
    revision: number,
  ): Promise<Run> {
    if (action === "start" || action === "resume") {
      const operation = this.starts.catch(() => {}).then(() => this.controlInternal(id, scope, action, revision))
      this.starts = operation
      return operation
    }
    return this.controlInternal(id, scope, action, revision)
  }
  private async controlInternal(
    id: string,
    scope: Scope,
    action: "start" | "resume" | "pause" | "cancel" | "finish",
    revision: number,
  ): Promise<Run> {
    if (this.closing) {
      throw new DecisionError("CLOSING", "插件正在停止，请稍后重试", 503)
    }
    const next = await this.store.update(
      id,
      run => {
        assertScope(run, scope)
        if (action === "start" || action === "resume") {
          if (run.configurationHash !== hash(JSON.stringify(this.models))) {
            throw new DecisionError(
              "CONFIG_CHANGED",
              "Host 模型配置已变化，请核对新配置并创建下一版本，旧版本不会静默切换路由",
            )
          }
          if ((action === "start" && run.status !== "draft") || (action === "resume" && run.status !== "paused")) {
            throw new DecisionError("STATE", "当前任务状态不允许此操作", 409)
          }
          if (this.store.list().filter(item => item.status === "running").length >= 2) {
            throw new DecisionError("RUN_LIMIT", "当前 Profile 最多同时运行两个决策任务", 409)
          }
          reserveCheck(run, 0, 0)
          run.status = "running"
          run.epoch += 1
          run.activeSince = Date.now()
          delete run.stopReason
          event(run, action, "已授权在当前模型、材料、时间与预算内持续评审")
        } else if (action === "finish") {
          if (run.status !== "running") {
            throw new DecisionError("STATE", "只有运行中的任务可以转入修订", 409)
          }
          run.finishRequested = true
          event(run, "finish_requested", "将在当前阶段完成后转入方案修订与复核")
        } else {
          if (run.status === "completed" || run.status === "cancelled") {
            throw new DecisionError("STATE", "任务已结束", 409)
          }
          stopClock(run)
          run.epoch += 1
          run.status = action === "cancel" ? "cancelled" : "paused"
          run.stopReason = action === "cancel" ? "用户取消，已保留历史结果" : "用户暂停，可从检查点继续"
          event(run, action, run.stopReason)
        }
      },
      action === "start" ? revision : undefined,
    )
    if (action === "pause" || action === "cancel") {
      this.controllers.get(id)?.abort()
    }
    if (next.status === "running") {
      this.launch(id)
    }
    return next
  }
  async changeLimits(id: string, scope: Scope, revision: number, value: unknown): Promise<Run> {
    const limits = limitsSchema.parse(value)
    return this.store.update(
      id,
      run => {
        assertScope(run, scope)
        if (run.status !== "paused" && run.status !== "draft") {
          throw new DecisionError("STATE", "先暂停任务，再调整预算", 409)
        }
        if (limits.maxCostCny !== null) {
          for (const key of [
            ...run.config.seats.map(seat => seat.modelKey),
            run.config.moderatorKey,
            run.config.verifierKey,
          ]) {
            if (cost(getModel(this.models, key), 1, 1) === null) {
              throw new DecisionError("PRICE_REQUIRED", "所选模型缺少实际价格")
            }
          }
        }
        event(run, "limits_changed", `用户调整限制：${JSON.stringify(run.config.limits)} → ${JSON.stringify(limits)}`)
        run.config.limits = limits
      },
      revision,
    )
  }
  async decide(
    id: string,
    scope: Scope,
    revision: number,
    decision: "adopt" | "reject" | "defer",
    reason: string,
  ): Promise<Run> {
    if (!reason.trim() || reason.length > 2000) {
      throw new DecisionError("REASON", "请填写不超过 2000 字的人工取舍理由")
    }
    return this.store.update(
      id,
      run => {
        assertScope(run, scope)
        if (run.status !== "completed" || run.humanDecision) {
          throw new DecisionError("STATE", "仅可对尚未记录人工决策的已完成报告作出取舍", 409)
        }
        run.humanDecision = { decision, reason: reason.trim(), at: Date.now() }
        event(run, "human_decision", `人工取舍：${decision}；${reason.trim()}。原有风险、异议和证据状态继续保留`)
      },
      revision,
    )
  }
  private launch(id: string): void {
    if (this.jobs.has(id) || this.closing) {
      return
    }
    const epoch = this.store.get(id).epoch
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const job = this.drive(id, epoch, controller)
      .catch(async error => {
        await this.pauseForError(id, epoch, safeError(error)).catch(() => {})
      })
      .finally(() => {
        this.jobs.delete(id)
        if (this.controllers.get(id) === controller) {
          this.controllers.delete(id)
        }
        const run = this.store.get(id)
        if (!this.closing && run.status === "running" && run.epoch !== epoch) {
          this.launch(id)
        }
      })
    this.jobs.set(id, job)
  }
  async idle(id: string): Promise<void> {
    while (this.jobs.has(id)) {
      await this.jobs.get(id)
    }
  }
  async dispose(): Promise<void> {
    this.closing = true
    for (const [id, controller] of this.controllers) {
      const run = this.store.get(id)
      await this.pauseForError(id, run.epoch, "插件停止，检查点已保存").catch(() => {})
      controller.abort()
    }
    await Promise.allSettled([...this.jobs.values()])
  }
  private async pauseForError(id: string, epoch: number, reason: string): Promise<void> {
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) {
        return
      }
      stopClock(run)
      run.epoch += 1
      run.status = "paused"
      run.stopReason = reason
      event(run, "paused", reason)
    })
    this.controllers.get(id)?.abort()
  }
  private async call(
    id: string,
    epoch: number,
    phase: Phase,
    seatId: string,
    modelKey: string,
    controller: AbortController,
  ): Promise<void> {
    const release = await this.acquire(controller.signal)
    try {
      await this.callReserved(id, epoch, phase, seatId, modelKey, controller)
    } finally {
      release()
    }
  }
  private async acquire(signal: AbortSignal): Promise<() => void> {
    const release = () => {
      this.activeCalls -= 1
      this.waiters.shift()?.()
    }
    if (signal.aborted) {
      throw new DecisionError("ABORTED", "任务已停止")
    }
    if (this.activeCalls < 4) {
      this.activeCalls += 1
      return release
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", abort)
        this.activeCalls += 1
        resolve(release)
      }
      const abort = () => {
        this.waiters = this.waiters.filter(item => item !== grant)
        reject(new DecisionError("ABORTED", "排队中的任务已停止"))
      }
      this.waiters.push(grant)
      signal.addEventListener("abort", abort, { once: true })
    })
  }
  private async callReserved(
    id: string,
    epoch: number,
    phase: Phase,
    seatId: string,
    modelKey: string,
    controller: AbortController,
  ): Promise<void> {
    const snapshot = this.store.get(id)
    const key = `${phase}:${snapshot.round}:${seatId}`
    if (snapshot.calls.some(call => call.key === key && call.status === "succeeded")) {
      return
    }
    if (snapshot.status !== "running" || snapshot.epoch !== epoch) {
      return
    }
    const model = getModel(this.models, modelKey)
    const prompt = makePrompt(snapshot, phase, seatId)
    const tokens = estimateTokens(SYSTEM, prompt, snapshot.config.limits.outputTokens)
    if (tokens > model.contextTokens) {
      throw new DecisionError("CONTEXT", "材料和评审上下文超过所选模型的保守容量，请缩小范围后创建新版本")
    }
    const reservedCost = cost(model, tokens - snapshot.config.limits.outputTokens, snapshot.config.limits.outputTokens)
    const callId = randomUUID()
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) {
        throw new DecisionError("STALE", "任务状态已改变")
      }
      reserveCheck(run, tokens, reservedCost)
      const attempts = run.calls.filter(call => call.key === key).length
      if (attempts >= 3) {
        throw new DecisionError("RETRY_LIMIT", "该步骤已尝试三次，请修正模型配置或材料后创建新版本")
      }
      run.calls.push({
        id: callId,
        key,
        phase,
        round: run.round,
        epoch,
        seatId,
        modelKey,
        status: "running",
        attempt: attempts + 1,
        startedAt: Date.now(),
        reservedTokens: tokens,
        reservedCost,
        accountedTokens: tokens,
        accountedCost: reservedCost,
        accounting: "reserved",
        promptHash: hash(SYSTEM + prompt),
      })
      event(run, "call_started", `${phase} · ${seatId} · ${model.label}`)
    })
    const remainingMs = Math.max(1, snapshot.config.limits.maxDurationMinutes * 60000 - activeElapsed(snapshot))
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.ceil(Math.min(remainingMs, snapshot.config.limits.callTimeoutSeconds * 1000))),
    ])
    let response: ModelResponse | undefined
    try {
      response = await abortable(
        this.gateway.generate({
          model,
          system: SYSTEM,
          prompt,
          maxOutputTokens: snapshot.config.limits.outputTokens,
          signal,
        }),
        signal,
      )
      const result = parseResult(response.text, snapshot, phase, seatId)
      await this.store.update(id, run => {
        const call = run.calls.find(item => item.id === callId)!
        settle(call, model, response?.usage)
        call.returnedModel = response?.returnedModel
        if (run.status !== "running" || run.epoch !== epoch || signal.aborted) {
          call.status = "interrupted"
          event(run, "late_receipt", "已记录中断调用的用量，未将迟到文本写入评审结论")
          return
        }
        call.status = "succeeded"
        call.result = result
        event(run, "call_completed", `${phase} · ${seatId} 已提交`)
      })
      const updated = this.store.get(id)
      const used = spent(updated)
      if (
        used.tokens > updated.config.limits.tokenBudget ||
        (updated.config.limits.maxCostCny !== null &&
          used.costCny !== null &&
          used.costCny > updated.config.limits.maxCostCny)
      ) {
        await this.pauseForError(id, epoch, "上游报告用量超过预留／总预算，已停止后续请求，请核对网关计费")
      }
    } catch (error) {
      const receipt = response ?? (error instanceof GatewayError ? error.response : undefined)
      await this.store.update(id, run => {
        const call = run.calls.find(item => item.id === callId)!
        settle(call, model, receipt?.usage)
        call.returnedModel = receipt?.returnedModel
        call.status = signal.aborted || run.epoch !== epoch ? "interrupted" : "failed"
        call.error = safeError(error)
        event(run, "call_failed", `${phase} · ${seatId}：${call.error}`)
      })
      await this.pauseForError(id, epoch, safeError(error))
    }
  }
  private async seats(id: string, epoch: number, phase: Phase, controller: AbortController): Promise<void> {
    const snapshot = this.store.get(id)
    const seats = snapshot.config.seats.filter(
      seat => phase !== "discuss" || assignedIssues(snapshot, seat.id).length > 0,
    )
    let cursor = 0
    const workers = Array.from({ length: Math.min(seats.length, snapshot.config.limits.concurrency) }, async () => {
      while (cursor < seats.length && !controller.signal.aborted) {
        const seat = seats[cursor++]!
        try {
          await this.call(id, epoch, phase, seat.id, seat.modelKey, controller)
        } catch (error) {
          await this.pauseForError(id, epoch, safeError(error))
        }
      }
    })
    await Promise.all(workers)
  }
  private async advance(id: string, epoch: number, change: (run: Run) => void): Promise<void> {
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) {
        return
      }
      change(run)
      event(run, "phase", `进入 ${run.phase}，讨论轮次 ${run.round}`)
    })
  }
  private async drive(id: string, epoch: number, controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      const run = this.store.get(id)
      if (run.status !== "running" || run.epoch !== epoch) {
        return
      }
      if (activeElapsed(run) >= run.config.limits.maxDurationMinutes * 60000) {
        await this.pauseForError(id, epoch, "已到讨论时间上限，检查点已保存")
        return
      }
      if (run.phase === "independent") {
        await this.seats(id, epoch, "independent", controller)
        await this.advance(id, epoch, draft => {
          const reviews = draft.calls.filter(call => call.phase === "independent" && call.status === "succeeded")
          if (reviews.length !== draft.config.seats.length) {
            throw new DecisionError("BARRIER", "独立评审尚未全部提交")
          }
          draft.issues = reviews.flatMap(call =>
            reviewSchema.parse(call.result).issues.map((issue, index) => ({
              ...issue,
              id: `I-${call.seatId}-${index + 1}`,
              sourceCallId: call.id,
              seatId: call.seatId,
              status: "open" as const,
            })),
          )
          draft.phase = draft.issues.length ? "organize" : "revise"
          event(draft, "revealed", "首轮独立评审全部提交，统一公开；原始记录不再改写")
        })
      } else if (run.phase === "organize") {
        await this.call(id, epoch, "organize", "moderator", run.config.moderatorKey, controller)
        await this.advance(id, epoch, draft => {
          const result = organizeSchema.parse(
            draft.calls.find(call => call.phase === "organize" && call.status === "succeeded")?.result,
          )
          const order = result.priorityIssueIds
          draft.issues.sort(
            (a, b) =>
              (order.indexOf(a.id) < 0 ? 999 : order.indexOf(a.id)) -
              (order.indexOf(b.id) < 0 ? 999 : order.indexOf(b.id)),
          )
          draft.round = 1
          draft.phase = draft.finishRequested ? "revise" : "discuss"
        })
      } else if (run.phase === "discuss") {
        if (run.finishRequested || run.calls.length + run.config.seats.length + 2 > run.config.limits.maxCalls) {
          await this.advance(id, epoch, draft => {
            draft.phase = "revise"
            event(
              draft,
              "discussion_closed",
              draft.finishRequested ? "按人工指令进入修订" : "剩余调用优先用于完整修订与独立复核",
            )
          })
          continue
        }
        await this.seats(id, epoch, "discuss", controller)
        await this.advance(id, epoch, draft => {
          const current = draft.calls
            .filter(call => call.phase === "discuss" && call.round === draft.round && call.status === "succeeded")
            .map(call => debateSchema.parse(call.result))
          const previous = draft.calls
            .filter(call => call.phase === "discuss" && call.round === draft.round - 1 && call.status === "succeeded")
            .map(call => debateSchema.parse(call.result))
          const allNeedEvidence = current.every(item =>
            item.responses.every(response => response.position === "needs_evidence"),
          )
          const noFurther = current.every(item => !item.continueDiscussion)
          const repeated = previous.length > 0 && hash(JSON.stringify(current)) === hash(JSON.stringify(previous))
          const closingCalls = draft.calls.length + draft.config.seats.length + 2 > draft.config.limits.maxCalls
          if (
            draft.finishRequested ||
            noFurther ||
            allNeedEvidence ||
            repeated ||
            closingCalls ||
            draft.round >= draft.config.limits.maxRounds
          ) {
            draft.phase = "revise"
            event(
              draft,
              "discussion_closed",
              allNeedEvidence
                ? "继续讨论需要新证据；保留缺口并生成修订稿"
                : closingCalls
                  ? "预留最后两次调用用于修订与复核"
                  : "已达到讨论终止条件，转入修订；不以多数投票宣布事实成立",
            )
          } else {
            draft.round += 1
          }
        })
      } else if (run.phase === "revise") {
        await this.call(id, epoch, "revise", "editor", run.config.moderatorKey, controller)
        await this.advance(id, epoch, draft => {
          draft.revisionResult = revisionSchema.parse(
            draft.calls.find(call => call.phase === "revise" && call.status === "succeeded")?.result,
          )
          draft.phase = "verify"
        })
      } else if (run.phase === "verify") {
        await this.call(id, epoch, "verify", "verifier", run.config.verifierKey, controller)
        await this.advance(id, epoch, draft => {
          draft.verification = verificationSchema.parse(
            draft.calls.find(call => call.phase === "verify" && call.status === "succeeded")?.result,
          )
          for (const issue of draft.issues) {
            const verdict = draft.verification.issues.find(item => item.issueId === issue.id)!
            // A language-model review cannot establish an external fact by itself.
            issue.status =
              (issue.kind === "fact" || issue.kind === "missing_evidence") && verdict.verdict === "addressed"
                ? "needs_evidence"
                : verdict.verdict
            issue.resolution = verdict.reason
          }
          stopClock(draft)
          draft.phase = "finished"
          draft.status = "completed"
          event(draft, "completed", "修订方案及独立复核已生成，等待人工取舍；未解决异议由 Host 附在报告中")
        })
        return
      } else {
        return
      }
    }
  }
}

/** Preserve the first-pass barrier even when a browser polls the persistent record. */
export function publicRun(run: Run): Run {
  const result = structuredClone(run)
  if (result.phase === "independent") {
    for (const call of result.calls) {
      delete call.result
    }
  }
  return result
}
