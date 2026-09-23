import type { Model } from "./models.js"
import { DecisionError, type Call, type Phase, type Run, type Usage } from "./schema.js"

export function estimateTokens(system: string, prompt: string, output: number): number {
  // UTF-8 byte count is a deliberately conservative input estimate, not a tokenizer claim.
  return Buffer.byteLength(system + prompt, "utf8") + 512 + output
}
export function cost(model: Model, input: number, output: number): number | null {
  if (model.inputCnyPerMillion === null || model.outputCnyPerMillion === null) {
    return null
  }
  return (input * model.inputCnyPerMillion + output * model.outputCnyPerMillion) / 1000000
}
export function spent(run: Run): { tokens: number; costCny: number | null; calls: number; uncertain: number } {
  return {
    tokens: run.calls.reduce((total, call) => total + call.accountedTokens, 0),
    costCny: run.calls.some(call => call.accountedCost === null)
      ? null
      : run.calls.reduce((total, call) => total + (call.accountedCost ?? 0), 0),
    calls: run.calls.filter(call => call.dispatchState !== "not_sent").length,
    uncertain: run.calls.filter(call => call.accounting === "uncertain").length,
  }
}
export function activeElapsed(run: Run, now = Date.now()): number {
  return run.elapsedMs + (run.activeSince === undefined ? 0 : Math.max(0, now - run.activeSince))
}
export function closingHold(run: Run, phase: Phase) {
  const allocations =
    !run.closingReserve || phase === "finished" || phase === "verify"
      ? []
      : phase === "revise"
        ? [run.closingReserve.verify]
        : Object.values(run.closingReserve)
  return {
    tokens: allocations.reduce((sum, item) => sum + item.tokens, 0),
    calls: allocations.reduce((sum, item) => sum + item.calls, 0),
    durationMs: allocations.reduce((sum, item) => sum + item.durationMs, 0),
    costCny: allocations.some(item => item.costCny === null)
      ? null
      : allocations.reduce((sum, item) => sum + (item.costCny ?? 0), 0),
  }
}

export function reserveCheck(run: Run, tokens: number, cny: number | null, phase?: Phase, calls = 1): void {
  const limits = run.config.limits
  const used = spent(run)
  if (activeElapsed(run) >= limits.maxDurationMinutes * 60000) {
    throw new DecisionError("TIME_LIMIT", "已到本轮讨论时间上限，任务已暂停并保留检查点")
  }
  if (used.calls + calls > limits.maxCalls || run.calls.length + calls > 400) {
    throw new DecisionError("CALL_LIMIT", "已达到模型调用次数上限")
  }
  if (used.tokens + tokens > limits.tokenBudget) {
    throw new DecisionError("TOKEN_LIMIT", "剩余额度不足以预留下一次调用的 Token 预算")
  }
  if (limits.maxCostCny !== null && (cny === null || used.costCny === null || used.costCny + cny > limits.maxCostCny)) {
    throw new DecisionError("COST_LIMIT", "金额预算不足或模型价格未知，未发起新的模型请求")
  }
  if (phase) {
    const hold = closingHold(run, phase)
    if (
      used.calls + calls + hold.calls > limits.maxCalls ||
      used.tokens + tokens + hold.tokens > limits.tokenBudget ||
      activeElapsed(run) + hold.durationMs >= limits.maxDurationMinutes * 60000 ||
      (limits.maxCostCny !== null &&
        (hold.costCny === null || (used.costCny ?? 0) + (cny ?? 0) + hold.costCny > limits.maxCostCny))
    )
      throw new DecisionError("CLOSING_RESERVE", "剩余预算已留给完整修订与独立复核，停止派发当前阶段的新请求")
  }
}

export function budgetBlocked(run: Run): boolean {
  const used = spent(run)
  return (
    ["TOKEN_LIMIT", "CALL_LIMIT", "TIME_LIMIT", "COST_LIMIT", "BUDGET_EXCEEDED", "CLOSING_RESERVE"].includes(
      run.stopCode ?? "",
    ) ||
    used.tokens >= run.config.limits.tokenBudget ||
    used.calls >= run.config.limits.maxCalls ||
    activeElapsed(run) >= run.config.limits.maxDurationMinutes * 60000 ||
    (run.config.limits.maxCostCny !== null && (used.costCny === null || used.costCny >= run.config.limits.maxCostCny))
  )
}
export function settle(call: Call, model: Model, usage?: Usage): void {
  call.endedAt = Date.now()
  if (!usage) {
    if (call.usage) return
    if (releaseUnsent(call)) return
    call.accounting = "uncertain"
    return
  }
  call.dispatchState = "sending"
  call.usage = usage
  call.accounting = "reported"
  call.accountedTokens = usage.totalTokens
  // If the gateway reports a total beyond its input/output split, charge the unclassified part at the higher rate.
  const extra = Math.max(0, usage.totalTokens - usage.inputTokens - usage.outputTokens)
  const known = cost(model, usage.inputTokens, usage.outputTokens)
  call.accountedCost =
    known === null
      ? null
      : known + (extra * Math.max(model.inputCnyPerMillion ?? 0, model.outputCnyPerMillion ?? 0)) / 1000000
}

/** Only a durable pre-dispatch state proves no upstream request could have begun. */
export function releaseUnsent(call: Call): boolean {
  if (call.dispatchState !== "reserved" && call.dispatchState !== "not_sent") return false
  call.dispatchState = "not_sent"
  call.accounting = "not_sent"
  call.accountedTokens = 0
  call.accountedCost = 0
  return true
}
