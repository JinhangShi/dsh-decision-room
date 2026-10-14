import { DecisionError, type CallProgress } from "./schema.js"

/** Idle time only covers an upstream request; tool execution keeps the total deadline. */
export class CallWatchdog {
  readonly signal: AbortSignal
  private controller = new AbortController()
  private totalTimer: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(
    parent: AbortSignal,
    totalMs: number,
    private idleMs?: number,
  ) {
    this.signal = AbortSignal.any([parent, this.controller.signal])
    this.totalTimer = setTimeout(
      () => this.stop("CALL_TIMEOUT", `调用达到总耗时上限 ${Math.ceil(totalMs / 1000)} 秒`),
      totalMs,
    )
    this.totalTimer.unref?.()
  }
  activity(progress: CallProgress): void {
    if (this.closed || this.signal.aborted) return
    clearTimeout(this.idleTimer)
    if (progress.state === "finished" || this.idleMs === undefined) return
    this.idleTimer = setTimeout(
      () => this.stop("CALL_IDLE_TIMEOUT", `模型连续 ${Math.ceil(this.idleMs! / 1000)} 秒没有返回流数据`),
      this.idleMs,
    )
    this.idleTimer.unref?.()
  }
  private stop(code: string, message: string): void {
    this.controller.abort(
      new DecisionError(code, `${message}；已暂停，未自动重试。未知用量保留预留额度，请核对后从检查点继续`),
    )
    this.dispose()
  }
  dispose(): void {
    this.closed = true
    clearTimeout(this.totalTimer)
    clearTimeout(this.idleTimer)
  }
}
