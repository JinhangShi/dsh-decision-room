import { createHash, randomUUID } from "node:crypto"
import {
  activeElapsed,
  closingHold,
  cost,
  estimateTokens,
  releaseUnsent,
  reserveCheck,
  settle,
  spent,
} from "./budget.js"
import { mcpBlockedReason, mcpFailureKind } from "./mcp-status.js"
import { GatewayError, type ModelGateway, type ModelResponse, type ContextDispatch } from "./gateway.js"
import { getModel, type Model } from "./models.js"
import { assignedIssues, makePrompt, parseResult, SYSTEM } from "./prompts.js"
import { assessDeliberation } from "./deliberation.js"
import {
  assertScope,
  configurationWarnings,
  createSchema,
  DecisionError,
  isReviewCall,
  limitsSchema,
  organizeSchema,
  reviewSchema,
  revisionSchema,
  verificationSchema,
  type Call,
  type CreateInput,
  type Phase,
  type Run,
  type RunConfig,
  type ReviewCountLimits,
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
function cancelActiveMcpCalls(run: Run, reason: string, primaryCallId?: string): void {
  let cancelled = 0
  for (const call of run.mcpCalls) {
    if (
      ["requested", "awaiting_approval", "running"].includes(call.status) &&
      (!primaryCallId || call.primaryCallId === primaryCallId)
    ) {
      call.status = "cancelled"
      call.endedAt = Date.now()
      call.error = reason.slice(0, 2000)
      cancelled += 1
    }
  }
  if (cancelled) event(run, "mcp_cancelled", `${cancelled} 个在途 MCP 调用已取消：${reason}`)
}
function safeError(error: unknown): string {
  return error instanceof DecisionError ? error.message : "处理失败；检查点已保留。请检查 Host 日志和存储可用性"
}
function retryableOutputError(error: unknown): boolean {
  return error instanceof DecisionError && ["OUTPUT_JSON", "OUTPUT_SCHEMA", "REFERENCES"].includes(error.code)
}
function canDeferSeatFailure(phase: Phase, error?: unknown): boolean {
  return (phase === "independent" || phase === "discuss") && !retryableOutputError(error)
}
function wasOutputFailure(error?: string): boolean {
  return Boolean(error && (error.includes("结构化评审") || error.includes("问题／材料引用")))
}
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const
function mergedIssueText(
  members: Run["issues"],
  field: "rationale" | "suggestedChange" | "whatWouldChangeMind",
): string {
  const value = members.map(issue => `[${issue.id}] ${issue[field]}`).join("\n")
  return value.length <= 2000 ? value : `${value.slice(0, 1999)}…`
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        new DecisionError(
          "ABORTED",
          "调用已停止或超时；保留预留额度等待对账。为避免重复计费，系统不会自动重试；请从检查点继续，已完成席位不会重复调用",
        ),
      )
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
    readonly reviewLimits?: ReviewCountLimits,
  ) {}
  effectiveLimits(limits: RunConfig["limits"]): RunConfig["limits"] {
    return { ...limits, ...this.reviewLimits }
  }
  get contextOwner(): "dsh" | "standalone" {
    return this.gateway.managedContext ? "dsh" : "standalone"
  }

  private reserveClosing(run: Run): void {
    const limits = run.config.limits
    const calls = Math.max(1, Math.min(3, Math.floor((limits.maxCalls - run.config.seats.length - 1) / 2)))
    const allocation = (phase: "revise" | "verify") => {
      const model = getModel(this.models, phase === "revise" ? run.config.moderatorKey : run.config.verifierKey)
      const prompt = makePrompt(run, phase, phase === "revise" ? "editor" : "verifier")
      const estimate =
        this.gateway.estimate?.(SYSTEM, prompt, limits.outputTokens) ??
        estimateTokens(SYSTEM, prompt, limits.outputTokens)
      const tokens = Math.max(
        Math.ceil(limits.tokenBudget * 0.1),
        estimate + (phase === "verify" && !run.revisionResult ? limits.outputTokens * 4 : 0),
      )
      return {
        tokens,
        calls,
        durationMs: Math.min(calls * limits.callTimeoutSeconds * 1000, limits.maxDurationMinutes * 6000),
        costCny: cost(model, tokens, tokens),
      }
    }
    run.closingReserve = { revise: allocation("revise"), verify: allocation("verify") }
  }

  private async closeForBudget(id: string, epoch: number, phase: Phase, error: unknown): Promise<boolean> {
    if (
      !["discuss", "interpret"].includes(phase) ||
      !(error instanceof DecisionError) ||
      !["CLOSING_RESERVE", "TOKEN_LIMIT", "CALL_LIMIT", "TIME_LIMIT", "COST_LIMIT"].includes(error.code)
    )
      return false
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch || run.finishRequested) return
      run.finishRequested = true
      event(run, "discussion_closed", "讨论额度不足，保留当前结果；剩余额度只用于修订与独立复核")
    })
    return true
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    if (this.reviewLimits) {
      for (const record of this.store.list()) {
        const limits = this.effectiveLimits(record.config.limits)
        if (JSON.stringify(limits) === JSON.stringify(record.config.limits)) continue
        await this.store.update(
          record.id,
          run => {
            event(
              run,
              "profile_limits_applied",
              `按用户配置统一 Profile 次数上限；原限制 ${JSON.stringify(run.config.limits)} → ${JSON.stringify(limits)}；原始调用、报告和评审结论保留`,
            )
            run.config.limits = limits
            if (["draft", "paused", "running"].includes(run.status)) this.reserveClosing(run)
            if (run.stopCode === "CALL_LIMIT") delete run.stopCode
          },
          undefined,
          { preserveUpdatedAt: true },
        )
      }
    }
    const unattended = new Set<string>()
    for (const record of this.store.list()) {
      if (record.status === "running" || record.calls.some(call => call.status === "running")) {
        await this.store.update(record.id, run => {
          stopClock(run)
          run.status = "paused"
          run.epoch += 1
          run.stopReason =
            run.config.limits.maxDurationMinutes >= 480
              ? "宿主重启：已恢复检查点，持续评审将自动续跑；中断调用按预留额度保守计入，不重复发送"
              : "宿主重启：已恢复检查点，待你继续。中断调用按预留额度保守计入，不自动重发"
          for (const call of run.calls.filter(item => item.status === "running")) {
            call.status = "interrupted"
            if (!releaseUnsent(call)) call.accounting = "uncertain"
            call.endedAt = Date.now()
          }
          cancelActiveMcpCalls(run, "宿主重启，无法确认原 MCP 调用是否继续；记录已保留且不会自动重发")
          event(run, "recovered", run.stopReason)
        })
        if (record.config.limits.maxDurationMinutes >= 480) unattended.add(record.id)
      }
    }
    for (const id of unattended) {
      const run = this.store.get(id)
      if (run.status === "paused") {
        await this.store.update(id, current => {
          current.status = "running"
          current.epoch += 1
          current.activeSince = Date.now()
          this.reserveClosing(current)
          delete current.stopReason
          event(current, "auto_resume", "持续评审已从检查点自动续跑")
        })
        this.launch(id)
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
    const config = {
      ...input.config,
      limits: this.effectiveLimits(input.config.limits),
      seats: input.config.seats.map(seat => ({
        ...seat,
        modelFamily: getModel(this.models, seat.modelKey).family,
      })),
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
      submissionMessageId: input.submissionMessageId,
      briefHash: hash(JSON.stringify(input.brief)),
      configurationHash: hash(JSON.stringify(this.models)),
      config,
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
      mcpCalls: [],
      mcpEvidence: [],
      mode: this.mode,
    }
    this.reserveClosing(run)
    if (JSON.stringify(config.limits) !== JSON.stringify(input.config.limits)) {
      event(
        run,
        "profile_limits_applied",
        `Host 按用户配置统一次数上限：请求 ${JSON.stringify(input.config.limits)} → ${JSON.stringify(config.limits)}`,
      )
    }
    event(
      run,
      "created",
      input.parentId ? "已创建人工反馈后的新版本；旧版本保持不变，重新进行独立评审" : "已冻结共同材料，等待开始评审",
    )
    for (const warning of configurationWarnings(config)) {
      event(run, "configuration_warning", warning)
    }
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
          this.reserveClosing(run)
          run.status = "running"
          run.epoch += 1
          run.activeSince = Date.now()
          delete run.stopReason
          delete run.stopCode
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
          cancelActiveMcpCalls(run, run.stopReason)
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
    const requested = limitsSchema.parse(value)
    const limits = this.effectiveLimits(requested)
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
        if (JSON.stringify(requested) !== JSON.stringify(limits)) {
          event(
            run,
            "profile_limits_applied",
            `次数上限受用户设置的 Profile 配置约束；请求 ${JSON.stringify(requested)} → ${JSON.stringify(limits)}`,
          )
        }
        run.config.limits = limits
        this.reserveClosing(run)
        delete run.stopCode
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
        await this.pauseForError(
          id,
          epoch,
          safeError(error),
          error instanceof DecisionError ? error.code : undefined,
        ).catch(() => {})
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
    await this.gateway.dispose?.()
  }
  private async pauseForError(id: string, epoch: number, reason: string, code?: string): Promise<void> {
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) {
        return
      }
      stopClock(run)
      run.epoch += 1
      run.status = "paused"
      run.stopReason = reason
      run.stopCode = code
      cancelActiveMcpCalls(run, reason)
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
    if (snapshot.calls.some(call => isReviewCall(call) && call.key === key && call.status === "succeeded")) {
      return
    }
    if (snapshot.status !== "running" || snapshot.epoch !== epoch) {
      return
    }
    if (phase === "discuss" && snapshot.finishRequested) return
    const model = getModel(this.models, modelKey)
    const prompt = makePrompt(snapshot, phase, seatId)
    const tokens =
      this.gateway.estimate?.(SYSTEM, prompt, snapshot.config.limits.outputTokens) ??
      estimateTokens(SYSTEM, prompt, snapshot.config.limits.outputTokens)
    if (
      !this.gateway.managedContext &&
      (tokens > model.contextTokens ||
        tokens - snapshot.config.limits.outputTokens > (model.maxInputTokens ?? Infinity))
    ) {
      throw new DecisionError("CONTEXT", "材料和评审上下文超过所选模型的保守容量，请缩小范围后创建新版本")
    }
    const reservedCost = cost(model, tokens - snapshot.config.limits.outputTokens, snapshot.config.limits.outputTokens)
    const callId = randomUUID()
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) {
        throw new DecisionError("STALE", "任务状态已改变")
      }
      if (phase === "discuss" && run.finishRequested) return
      reserveCheck(run, tokens, reservedCost, phase)
      const attempts = run.calls.filter(call => call.key === key).length
      if (attempts >= 3) {
        const last = run.calls.filter(call => call.key === key).at(-1)
        if (canDeferSeatFailure(phase) && !wasOutputFailure(last?.error)) {
          event(run, "call_deferred", `${phase} · ${seatId} 已连续失败三次，本轮标记缺席，后续轮次继续补偿重试`)
          return
        }
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
        dispatchState: this.gateway.managedContext ? "reserved" : "sending",
        promptHash: hash(SYSTEM + prompt),
      })
      event(run, "call_started", `${phase} · ${seatId} · ${model.label}`)
    })
    if (!this.store.get(id).calls.some(call => call.id === callId)) return
    const remainingMs = Math.max(
      1,
      snapshot.config.limits.maxDurationMinutes * 60000 -
        activeElapsed(snapshot) -
        closingHold(snapshot, phase).durationMs,
    )
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
          context: {
            run: snapshot,
            callId,
            currentRun: () => this.store.get(id),
            phase,
            seatId,
            authorize: dispatch => this.authorizeDispatch(id, epoch, callId, model, dispatch),
            preflight: dispatch =>
              this.store
                .update(id, run => {
                  const call = run.calls.find(item => item.id === callId)!
                  if (run.status !== "running" || run.epoch !== epoch) throw new DecisionError("STALE", "任务已停止")
                  if (call.dispatchState === "reserved") {
                    call.contextEstimate = dispatch.contextEstimate
                    call.contextSessionId = dispatch.sessionId
                    call.promptHash = dispatch.hash
                  }
                })
                .then(() => {}),
            receipt: (receiptId, value, error) =>
              this.contextReceipt(id, epoch, callId, receiptId, model, value, error),
            authorizeTool: (toolCallId, name, args) => this.authorizeTool(id, epoch, callId, toolCallId, name, args),
            toolDecision: (toolCallId, decision, reason) => this.toolDecision(id, epoch, toolCallId, decision, reason),
            toolReceipt: (toolCallId, name, content, error) =>
              this.toolReceipt(id, epoch, callId, toolCallId, name, content, error),
          },
        }),
        signal,
      )
      const result = parseResult(response.text, this.store.get(id), phase, seatId)
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
        await this.pauseForError(
          id,
          epoch,
          "上游报告用量超过总预算；已停止后续请求，可导出尚未完成复核的阶段报告",
          "BUDGET_EXCEEDED",
        )
      }
    } catch (error) {
      const receipt = response ?? (error instanceof GatewayError ? error.response : undefined)
      await this.store.update(id, run => {
        const call = run.calls.find(item => item.id === callId)!
        settle(call, model, receipt?.usage)
        call.returnedModel = receipt?.returnedModel
        call.status = signal.aborted || run.epoch !== epoch ? "interrupted" : "failed"
        call.error = safeError(error)
        if (call.dispatchState === "not_sent")
          event(run, "reservation_released", `${phase} · ${seatId} 尚未发送，已释放预留；失败尝试留档`)
        cancelActiveMcpCalls(run, call.error, callId)
        event(run, "call_failed", `${phase} · ${seatId}：${call.error}`)
      })
      const failed = this.store.get(id)
      if (await this.closeForBudget(id, epoch, phase, error)) return
      if (
        error instanceof DecisionError &&
        ["CONTEXT", "CLOSING_RESERVE", "TOKEN_LIMIT", "CALL_LIMIT", "COST_LIMIT", "TIME_LIMIT"].includes(error.code)
      ) {
        await this.pauseForError(id, epoch, error.message, error.code)
        return
      }
      const attempts = failed.calls.filter(call => call.key === key).length
      if (
        (retryableOutputError(error) || !(error instanceof GatewayError)) &&
        !controller.signal.aborted &&
        failed.status === "running" &&
        failed.epoch === epoch &&
        attempts < 3
      ) {
        await this.store.update(id, run => {
          event(
            run,
            "call_retry",
            `${phase} · ${seatId} ${retryableOutputError(error) ? "输出校验失败" : "调用失败"}，自动进行第 ${attempts + 1} 次尝试`,
          )
        })
        await this.callReserved(id, epoch, phase, seatId, modelKey, controller)
        return
      }
      if (
        canDeferSeatFailure(phase, error) &&
        !controller.signal.aborted &&
        failed.status === "running" &&
        failed.epoch === epoch
      ) {
        await this.store.update(id, run => {
          event(run, "call_deferred", `${phase} · ${seatId} 本轮缺席，Host 将使用已返回席位结果并在后续轮次补偿`)
        })
        return
      }
      await this.pauseForError(id, epoch, safeError(error), error instanceof DecisionError ? error.code : undefined)
    }
  }
  private async authorizeDispatch(
    id: string,
    epoch: number,
    primaryId: string,
    model: Model,
    dispatch: ContextDispatch,
  ): Promise<string> {
    const receiptId = dispatch.purpose === "review" ? primaryId : randomUUID()
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) {
        throw new DecisionError("STALE", "任务已停止，未发起上下文请求")
      }
      const primary = run.calls.find(call => call.id === primaryId)!
      if (primary.phase === "discuss" && run.finishRequested)
        throw new DecisionError("CLOSING_RESERVE", "已安排收尾，停止后续讨论、工具续答和压缩请求")
      const tokens = dispatch.inputTokens + dispatch.outputTokens
      const cny = cost(model, dispatch.inputTokens, dispatch.outputTokens)
      const check =
        dispatch.purpose === "review" ? { ...run, calls: run.calls.filter(call => call.id !== primaryId) } : run
      reserveCheck(check, tokens, cny, primary.phase)
      if (dispatch.purpose === "review") {
        Object.assign(primary, {
          reservedTokens: tokens,
          inputEstimate: dispatch.inputEstimate,
          contextEstimate: dispatch.contextEstimate,
          dispatchState: "sending",
          reservedCost: cny,
          accountedTokens: tokens,
          accountedCost: cny,
          promptHash: dispatch.hash,
          contextSessionId: dispatch.sessionId,
        })
      } else {
        run.calls.push({
          ...primary,
          id: receiptId,
          key: `compaction:${receiptId}`,
          purpose: dispatch.purpose,
          result: undefined,
          attempt: 1,
          status: "running",
          startedAt: Date.now(),
          endedAt: undefined,
          usage: undefined,
          reservedTokens: tokens,
          inputEstimate: dispatch.inputEstimate,
          contextEstimate: dispatch.contextEstimate,
          dispatchState: "sending",
          reservedCost: cny,
          accountedTokens: tokens,
          accountedCost: cny,
          accounting: "reserved",
          promptHash: dispatch.hash,
          contextSessionId: dispatch.sessionId,
        })
        event(
          run,
          dispatch.purpose === "compaction" ? "context_compaction" : "tool_followup",
          dispatch.purpose === "compaction"
            ? `${primary.seatId} 的 DSH 会话正在压缩上下文，调用已预留预算`
            : `${primary.seatId} 已取得 MCP 结果，正在继续分析；模型调用已预留预算`,
        )
      }
    })
    return receiptId
  }
  private async contextReceipt(
    id: string,
    epoch: number,
    primaryId: string,
    receiptId: string,
    model: Model,
    response?: ModelResponse,
    error?: string,
  ): Promise<void> {
    if (receiptId === primaryId) {
      await this.store.update(id, run => {
        const call = run.calls.find(item => item.id === primaryId)!
        settle(call, model, response?.usage)
        call.returnedModel = response?.returnedModel
      })
      return
    }
    await this.store.update(id, run => {
      const call = run.calls.find(item => item.id === receiptId)!
      settle(call, model, response?.usage)
      call.returnedModel = response?.returnedModel
      call.status = run.epoch !== epoch || run.status !== "running" ? "interrupted" : error ? "failed" : "succeeded"
      call.error = error
      event(
        run,
        call.purpose === "compaction" ? "context_compacted" : "tool_followup_completed",
        error ?? (call.purpose === "compaction" ? "DSH 上下文压缩完成，原始会话记录保留" : "MCP 结果分析完成"),
      )
    })
    const run = this.store.get(id)
    const used = spent(run)
    if (
      used.tokens > run.config.limits.tokenBudget ||
      (run.config.limits.maxCostCny !== null && (used.costCny === null || used.costCny > run.config.limits.maxCostCny))
    ) {
      await this.pauseForError(
        id,
        epoch,
        "上下文处理用量超过预算，已暂停后续请求；可导出尚未完成复核的阶段报告",
        "BUDGET_EXCEEDED",
      )
    }
  }
  private async authorizeTool(
    id: string,
    epoch: number,
    primaryId: string,
    toolCallId: string,
    name: string,
    args: unknown,
  ): Promise<void> {
    await this.store.update(id, run => {
      if (run.status !== "running" || run.epoch !== epoch) throw new DecisionError("STALE", "任务已停止")
      if (!name.startsWith("mcp__")) throw new DecisionError("TOOL_DENIED", "决策席只能调用当前 DSH 已注册的 MCP 工具")
      if (run.mcpCalls.some(call => call.id === toolCallId)) return
      const blocked = mcpBlockedReason(run, name)
      if (blocked) throw new DecisionError("MCP_UNAVAILABLE", blocked)
      const primary = run.calls.find(call => call.id === primaryId)
      if (!primary || primary.phase !== "discuss") {
        throw new DecisionError("TOOL_DENIED", "首轮独立评审公开前不允许调用 MCP 工具")
      }
      if (run.finishRequested) throw new DecisionError("MCP_UNAVAILABLE", "已安排收尾，停止新的外部补证请求")
      if (run.mcpCalls.length >= run.config.limits.maxMcpCalls) {
        throw new DecisionError("MCP_LIMIT", "已达到本任务 MCP 调用次数上限")
      }
      run.mcpCalls.push({
        id: toolCallId,
        primaryCallId: primaryId,
        toolName: name,
        phase: primary.phase,
        round: primary.round,
        seatId: primary.seatId,
        arguments: args,
        status: "requested",
        startedAt: Date.now(),
      })
      event(run, "mcp_requested", `${primary.seatId} 请求调用 MCP：${name}`)
    })
  }
  private async toolDecision(
    id: string,
    epoch: number,
    toolCallId: string,
    decision: "awaiting_approval" | "running" | "denied" | "failed",
    reason?: string,
  ): Promise<void> {
    await this.store.update(id, run => {
      const call = run.mcpCalls.find(item => item.id === toolCallId)
      if (
        !call ||
        call.status === "succeeded" ||
        call.status === "failed" ||
        call.status === "denied" ||
        call.status === "cancelled"
      )
        return
      if (run.epoch !== epoch || run.status !== "running") {
        call.status = "cancelled"
        call.endedAt = Date.now()
        call.error = "任务状态已改变，MCP 调用未继续"
        event(run, "mcp_cancelled", `MCP 调用已取消：${call.toolName}`)
        return
      }
      call.status = decision
      call.error = reason?.slice(0, 2000)
      if (decision === "denied" || decision === "failed") call.endedAt = Date.now()
      event(
        run,
        `mcp_${decision}`,
        decision === "awaiting_approval"
          ? `MCP 调用等待 DSH 授权：${call.toolName}`
          : decision === "running"
            ? `MCP 调用已获授权并开始执行：${call.toolName}`
            : decision === "denied"
              ? `MCP 调用被 DSH 拒绝：${call.toolName}${reason ? `；${reason}` : ""}`
              : `MCP 调用未能执行：${call.toolName}${reason ? `；${reason}` : ""}`,
      )
    })
  }
  private async toolReceipt(
    id: string,
    epoch: number,
    primaryId: string,
    toolCallId: string,
    name: string,
    content: string,
    error?: string,
  ): Promise<void> {
    await this.store.update(id, run => {
      const call = run.mcpCalls.find(item => item.id === toolCallId)
      if (!call || call.status === "denied" || call.status === "cancelled") return
      call.endedAt = Date.now()
      call.status = error ? "failed" : "succeeded"
      call.error = error?.slice(0, 2000)
      if (!error && content.trim()) {
        const primary = run.calls.find(item => item.id === primaryId)
        const evidenceId = `mcp-${hash(`${run.id}:${toolCallId}`).slice(0, 20)}`
        call.evidenceId = evidenceId
        const existing = run.mcpEvidence.find(
          item => item.toolName === name && item.text === content.trim().slice(0, 30000),
        )
        if (existing) {
          call.evidenceId = existing.id
          const issueIds = primary ? assignedIssues(run, primary.seatId) : []
          existing.issueIds = [...new Set([...existing.issueIds, ...issueIds])]
        } else {
          run.mcpEvidence.push({
            id: evidenceId,
            callId: toolCallId,
            toolName: name,
            issueIds: primary ? assignedIssues(run, primary.seatId) : [],
            text: content.trim().slice(0, 30000),
            retrievedAt: Date.now(),
            verificationStatus: "unverified_mcp",
          })
        }
      }
      event(
        run,
        error ? "mcp_failed" : "mcp_completed",
        error
          ? `MCP 调用失败：${name}；${mcpFailureKind(error) === "authentication" ? "认证失效，已停止该连接器的重复尝试；修复后可明确继续" : mcpFailureKind(error) === "unknown_tool" ? "工具不存在，本次评审不再重试该工具" : "调用未成功，保留证据缺口"}`
          : `MCP 结果已加入证据账本：${name}`,
      )
    })
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
          if (!(await this.closeForBudget(id, epoch, phase, error))) {
            await this.pauseForError(
              id,
              epoch,
              safeError(error),
              error instanceof DecisionError ? error.code : undefined,
            )
          }
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
        await this.pauseForError(id, epoch, "已到时间上限；检查点与阶段报告已保留，尚未完成复核", "TIME_LIMIT")
        return
      }
      if (run.phase === "independent") {
        await this.seats(id, epoch, "independent", controller)
        await this.advance(id, epoch, draft => {
          const reviews = draft.calls.filter(
            call => isReviewCall(call) && call.phase === "independent" && call.status === "succeeded",
          )
          if (reviews.length === 0) throw new DecisionError("BARRIER", "独立评审尚未提交任何结果")
          if (reviews.length !== draft.config.seats.length) {
            event(
              draft,
              "partial_phase",
              `独立评审有 ${draft.config.seats.length - reviews.length} 个席位缺席；先公开已有结果，缺席席位将在后续讨论轮次补偿`,
            )
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
            draft.calls.find(call => isReviewCall(call) && call.phase === "organize" && call.status === "succeeded")
              ?.result,
          )
          const order = result.priorityIssueIds
          const sourceIssues = new Map(draft.issues.map(issue => [issue.id, issue]))
          draft.issues = result.issueGroups
            .map(group => {
              const members = group.memberIssueIds.map(issueId => sourceIssues.get(issueId)!)
              const canonical = [...members].sort(
                (a, b) =>
                  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || order.indexOf(a.id) - order.indexOf(b.id),
              )[0]!
              return {
                ...canonical,
                title: group.title,
                severity: members.reduce(
                  (severity, issue) =>
                    SEVERITY_RANK[issue.severity] > SEVERITY_RANK[severity] ? issue.severity : severity,
                  canonical.severity,
                ),
                rationale: mergedIssueText(members, "rationale"),
                evidenceIds: [...new Set(members.flatMap(issue => issue.evidenceIds))],
                suggestedChange: mergedIssueText(members, "suggestedChange"),
                whatWouldChangeMind: mergedIssueText(members, "whatWouldChangeMind"),
                sourceIssueIds: group.memberIssueIds,
              }
            })
            .sort(
              (a, b) =>
                Math.min(...a.sourceIssueIds.map(issueId => order.indexOf(issueId))) -
                Math.min(...b.sourceIssueIds.map(issueId => order.indexOf(issueId))),
            )
          event(
            draft,
            "issues_grouped",
            `Host 将 ${sourceIssues.size} 条独立首评问题归并为 ${draft.issues.length} 个议题簇；原始首评保持不变`,
          )
          draft.round = 1
          draft.phase = draft.finishRequested ? "revise" : "discuss"
          this.reserveClosing(draft)
        })
      } else if (run.phase === "discuss") {
        let closing = run.finishRequested
        if (!closing) {
          try {
            const pendingSeats = run.config.seats.filter(
              seat =>
                assignedIssues(run, seat.id).length > 0 &&
                !run.calls.some(
                  call =>
                    isReviewCall(call) &&
                    call.phase === "discuss" &&
                    call.round === run.round &&
                    call.seatId === seat.id &&
                    call.status === "succeeded",
                ),
            )
            const requests = [
              ...pendingSeats.map(seat => ({ phase: "discuss" as const, seatId: seat.id, modelKey: seat.modelKey })),
              { phase: "interpret" as const, seatId: "moderator", modelKey: run.config.moderatorKey },
            ]
            let tokens = 0
            let cny: number | null = 0
            for (const request of requests) {
              const prompt = makePrompt(run, request.phase, request.seatId)
              const estimate =
                this.gateway.estimate?.(SYSTEM, prompt, run.config.limits.outputTokens) ??
                estimateTokens(SYSTEM, prompt, run.config.limits.outputTokens)
              tokens += estimate
              const price = cost(getModel(this.models, request.modelKey), estimate, run.config.limits.outputTokens)
              cny = price === null || cny === null ? null : cny + price
            }
            reserveCheck(run, tokens, cny, "discuss", requests.length)
          } catch (error) {
            if (!(error instanceof DecisionError)) throw error
            closing = true
          }
        }
        if (closing) {
          await this.advance(id, epoch, draft => {
            draft.phase = "revise"
            event(
              draft,
              "discussion_closed",
              draft.finishRequested ? "按已记录的收尾安排进入修订" : "剩余调用优先用于完整修订与独立复核",
            )
          })
          continue
        }
        await this.seats(id, epoch, "discuss", controller)
        await this.advance(id, epoch, draft => {
          draft.phase = draft.finishRequested ? "revise" : "interpret"
          if (!draft.finishRequested) event(draft, "ballot_ready", `第 ${draft.round} 轮表决已聚合，等待主持解读`)
        })
      } else if (run.phase === "interpret") {
        try {
          await this.call(id, epoch, "interpret", "moderator", run.config.moderatorKey, controller)
        } catch (error) {
          if (!(await this.closeForBudget(id, epoch, "interpret", error))) throw error
        }
        await this.advance(id, epoch, draft => {
          const assessment = assessDeliberation(draft)
          const softClosed =
            assessment.coverageSatisfied &&
            assessment.unreviewedCriticalBlockerIds.length === 0 &&
            (assessment.allNeedEvidence ||
              assessment.stagnantRounds >= 3 ||
              (assessment.stableBallots && assessment.noNewInformation && assessment.noFurtherDiscussion))
          const closingCalls = spent(draft).calls + draft.config.seats.length + 3 > draft.config.limits.maxCalls
          if (draft.finishRequested || softClosed || closingCalls || draft.round >= draft.config.limits.maxRounds) {
            draft.phase = "revise"
            event(
              draft,
              "discussion_closed",
              assessment.allNeedEvidence && assessment.coverageSatisfied
                ? "各问题已达到所需独立覆盖，继续讨论需要新证据；保留缺口并生成修订稿"
                : closingCalls
                  ? "预留最后两次调用用于修订与复核"
                  : softClosed
                    ? assessment.stagnantRounds >= 3
                      ? "问题覆盖充分且连续三轮无新增证据或改票，Host 强制收敛并转入修订；模型自报的新信息保留为待评估意见"
                      : "问题覆盖充分，当前无新增证据或改票且本轮席位均建议停止；Host 转入修订并保留异议"
                    : draft.round >= draft.config.limits.maxRounds
                      ? "已达到讨论轮数上限，保留票型与异议并转入修订"
                      : "按人工指令进入修订",
            )
          } else {
            draft.round += 1
            draft.phase = "discuss"
          }
        })
      } else if (run.phase === "revise") {
        await this.call(id, epoch, "revise", "editor", run.config.moderatorKey, controller)
        await this.advance(id, epoch, draft => {
          draft.revisionResult = revisionSchema.parse(
            draft.calls.find(call => isReviewCall(call) && call.phase === "revise" && call.status === "succeeded")
              ?.result,
          )
          draft.phase = "verify"
        })
      } else if (run.phase === "verify") {
        await this.call(id, epoch, "verify", "verifier", run.config.verifierKey, controller)
        await this.advance(id, epoch, draft => {
          draft.verification = verificationSchema.parse(
            draft.calls.find(call => isReviewCall(call) && call.phase === "verify" && call.status === "succeeded")
              ?.result,
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
