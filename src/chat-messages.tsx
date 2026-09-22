import { useEffect, useState } from "react"
import type { DecisionMessage, DecisionProgress } from "./dsh/messages.js"

type Event = { type: string; seq: number; data: unknown }
type NodeContext = {
  key: string
  id: string
  start?: { event: Event }
  state?: unknown
  matches?: Array<{ event: Event }>
}
export type ConversationEvents = {
  register(definition: {
    kind: string
    target: string
    match(event: Event): { id: string; role: "start" | "update" } | null
    start(context: unknown, match: { event: Event }): unknown
    update(context: NodeContext, match: { event: Event }): unknown
    buildViewNode(context: NodeContext): unknown
  }): () => void
}
export const progressNodeDefinition = {
  kind: "decision-room-progress",
  target: "chat",
  match(event: Event) {
    if (event.type !== "decision-room/progress") {
      return null
    }
    const data = event.data as { initial: boolean; progress: DecisionProgress }
    return { id: data.progress.id, role: data.initial ? ("start" as const) : ("update" as const) }
  },
  start(_context: unknown, match: { event: Event }) {
    return (match.event.data as { progress: DecisionProgress }).progress
  },
  update(_context: NodeContext, match: { event: Event }) {
    return (match.event.data as { progress: DecisionProgress }).progress
  },
  buildViewNode(context: NodeContext) {
    const latest = context.matches?.at(-1)?.event
    const data = context.state ?? (latest?.data as { progress?: DecisionProgress } | undefined)?.progress
    const anchor = context.start?.event ?? context.matches?.[0]?.event
    if (!data || !anchor) {
      return null
    }
    return {
      key: context.key,
      id: context.id,
      kind: "decision-room-progress",
      target: "chat",
      anchorSeq: anchor.seq,
      location: { kind: "session" },
      visibility: "visible",
      data,
    }
  },
}

export function DecisionProgressCard({
  node,
  request,
  onRunning,
  compact = false,
}: {
  node: { data: DecisionProgress }
  request?(text: string): void
  onRunning?(runId: string): void
  compact?: boolean
}): JSX.Element {
  const value = node.data
  const mcp = value.mcp ?? { calls: 0, limit: 0, sources: 0, failed: 0 }
  const [error, setError] = useState("")
  useEffect(() => {
    if (value.status === "running") {
      onRunning?.(value.runId)
    }
  }, [onRunning, value.runId, value.status])
  const state = {
    draft: "待开始",
    running: "正在评审",
    paused: "已暂停",
    completed: "评审完成",
    cancelled: "已取消",
    failed: "需处理",
  }[value.status]
  const failedCalls = value.calls.filter(call => call.status === "failed" || call.status === "interrupted").length
  const interruptedCalls = value.calls.filter(call => call.status === "interrupted").length
  const submittedSeats = value.seats.filter(seat =>
    value.calls.some(call => call.seatId === seat.id && call.status === "succeeded"),
  ).length
  const callStatus = {
    running: { label: "调用中", mark: "..." },
    succeeded: { label: "已完成", mark: "✓" },
    failed: { label: "失败", mark: "!" },
    interrupted: { label: "已中断", mark: "×" },
  } as Record<string, { label: string; mark: string }>
  const action = (text: string) => {
    try {
      request?.(`${text}（决策任务 ${value.runId}，V${value.version}）。`)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请直接在输入框发送指令")
    }
  }
  return (
    <section className="decision-progress" data-decision-progress={value.id} data-compact={compact || undefined}>
      <header>
        <strong>DSH 多模型决策 · V{value.version}</strong>
        <span role="status">{state}</span>
      </header>
      <p>
        {value.title} · {value.phase}
        {value.round ? ` · 第 ${value.round} 轮` : ""}
      </p>
      {compact ? (
        <p className="decision-seat-summary">
          {submittedSeats}/{value.seats.length} 个席位已提交 · {value.calls.length} 次调用
          {failedCalls ? ` · ${failedCalls} 次需关注` : ""}
          {mcp.sources ? ` · ${mcp.sources} 条 MCP 材料` : ""}
        </p>
      ) : (
        <div className="decision-seats">
          {value.seats.map(seat => {
            const call = value.calls.filter(call => call.seatId === seat.id).at(-1)
            return (
              <div key={seat.id}>
                <strong>{seat.name}</strong>
                <small>{seat.model}</small>
                <span>
                  {call?.status === "running"
                    ? "◌ 调用中"
                    : call?.status === "succeeded"
                      ? "✓ 已提交"
                      : call?.status === "failed" || call?.status === "interrupted"
                        ? "待处理"
                        : "等待调度"}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <p className="decision-caption">
        {compact
          ? "完整发言和报告保留在主聊天。"
          : `调用 ${value.calls.length} / ${value.maxCalls} · MCP 调用 ${mcp.calls} / ${mcp.limit} · 已计入 / 预留 ${value.tokens.toLocaleString()} / ${value.tokenBudget.toLocaleString()} Token`}
      </p>
      {compact && (
        <div className="decision-limit-summary" aria-label="任务执行上限">
          <span>
            讨论轮次 <strong>{value.round}</strong> / {value.maxRounds}
          </span>
          <span>
            模型调用 <strong>{value.calls.length}</strong> / {value.maxCalls}
          </span>
          <span>
            MCP 调用 <strong>{mcp.calls}</strong> / {mcp.limit}
          </span>
        </div>
      )}
      {compact && value.ballotHistory.length > 0 && (
        <section className="decision-ballot-history" aria-label="逐轮表决快照">
          <h3>逐轮表决</h3>
          {value.ballotHistory.map((snapshot, index) => (
            <details key={snapshot.round} open={index === value.ballotHistory.length - 1}>
              <summary>
                <span>第 {snapshot.round} 轮</span>
                <small>
                  {snapshot.ballot.issues.length} 项 · {snapshot.ballot.coverageSatisfied ? "覆盖达标" : "覆盖进行中"}
                  {snapshot.ballot.stagnantRounds ? ` · 连续无新增 ${snapshot.ballot.stagnantRounds}/3 轮` : ""}
                </small>
              </summary>
              {snapshot.interpretation ? (
                <div className="decision-ballot-interpretation">
                  <strong>{snapshot.interpretation.headline}</strong>
                  <p>{snapshot.interpretation.summary}</p>
                  <p>
                    <b>相比上一轮：</b>
                    {snapshot.interpretation.changesSincePrevious}
                  </p>
                  <p>
                    <b>下一步：</b>
                    {snapshot.interpretation.nextStep}
                  </p>
                  <small>{snapshot.interpretation.caveat}</small>
                </div>
              ) : (
                <p className="decision-caption">该轮来自旧版本任务，只有 Host 统计，没有主持模型解读。</p>
              )}
              <div className="decision-ballot-list">
                {snapshot.ballot.issues.map(issue => (
                  <article key={issue.id} data-blocking={issue.blockingVotes > 0}>
                    <div className="decision-ballot-heading">
                      <strong>{issue.title}</strong>
                      <small>{issue.severity}</small>
                    </div>
                    <div className="decision-ballot-coverage">
                      <span>
                        {issue.reviewerCount} 席（最低 {issue.requiredReviewers}）
                      </span>
                      <span>
                        {issue.modelFamilyCount} 模型族（最低 {issue.requiredModelFamilies}）
                      </span>
                      <span>阻断票 {issue.blockingVotes}</span>
                    </div>
                    <div className="decision-ballot-votes">
                      <span>维持 {issue.positions.maintain}</span>
                      <span>修改 {issue.positions.revise}</span>
                      <span>否决 {issue.positions.reject}</span>
                      <span>弃权 {issue.positions.abstain}</span>
                      <span>待补证 {issue.positions.needs_evidence}</span>
                    </div>
                    <div className="decision-ballot-evidence">
                      证据：支持 {issue.evidence.supported} · 冲突 {issue.evidence.conflicting} · 缺失{" "}
                      {issue.evidence.missing}
                    </div>
                  </article>
                ))}
              </div>
            </details>
          ))}
        </section>
      )}
      {!compact && value.ballot && (
        <details
          className="decision-ballot"
          open={!compact && (value.phase === "交叉讨论" || value.status === "completed")}
        >
          <summary>
            <span>表决总览</span>
            <small>
              {value.ballot.issues.length} 项 · {value.ballot.coverageSatisfied ? "覆盖达标" : "覆盖进行中"}
              {value.ballot.stagnantRounds ? ` · 连续无新增 ${value.ballot.stagnantRounds}/3 轮` : ""}
            </small>
          </summary>
          <div className="decision-ballot-legend">
            <p>
              <strong>独立覆盖</strong>：已投票席位数与最低要求；模型族表示独立模型来源及最低要求。
            </p>
            <p>
              <strong>阻断票</strong>：认为该问题不解决就不应推进的席位数。
            </p>
            <p>
              <strong>立场</strong>：维持当前判断、修改方案、否决方案、弃权或等待补证。
            </p>
            <p>
              <strong>证据</strong>：评审认为材料支持、相互冲突或缺失；不代表外部核验。
            </p>
            <p>
              <strong>连续无新增</strong>：票型、证据和问题均未变化的连续轮数；达到 3 轮后由 Host
              强制进入修订，席位要求继续仅作参考。
            </p>
          </div>
          {value.ballot.issues.length === 0 ? (
            <p className="decision-caption">主持整理问题后显示逐问题表决。</p>
          ) : (
            <div className="decision-ballot-list">
              {value.ballot.issues.map(issue => (
                <article key={issue.id} data-blocking={issue.blockingVotes > 0}>
                  <div className="decision-ballot-heading">
                    <span>{issue.id}</span>
                    <strong>{issue.title}</strong>
                    <small>
                      {issue.severity}
                      {issue.sourceIssueCount > 1 ? ` · 合并 ${issue.sourceIssueCount} 条首评` : ""}
                    </small>
                  </div>
                  <div className="decision-ballot-coverage">
                    <span>
                      {issue.reviewerCount} 席 · 最低 {issue.requiredReviewers}
                    </span>
                    <span>
                      {issue.modelFamilyCount} 模型族 · 最低 {issue.requiredModelFamilies}
                    </span>
                    <span>阻断票 {issue.blockingVotes}</span>
                  </div>
                  <div className="decision-ballot-votes" aria-label={issue.title + "的表决票型"}>
                    <span>维持 {issue.positions.maintain}</span>
                    <span>修改 {issue.positions.revise}</span>
                    <span>否决 {issue.positions.reject}</span>
                    <span>弃权 {issue.positions.abstain}</span>
                    <span>待补证 {issue.positions.needs_evidence}</span>
                  </div>
                  <div className="decision-ballot-evidence">
                    证据：支持 {issue.evidence.supported} · 冲突 {issue.evidence.conflicting} · 缺失{" "}
                    {issue.evidence.missing}
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="decision-caption">票数呈现分歧，不把多数意见当作事实。事实是否成立仍取决于材料证据。</p>
        </details>
      )}
      {value.stopReason && <p role="status">{value.stopReason}</p>}
      {value.status === "paused" && interruptedCalls > 0 && (
        <div className="decision-recovery" role="note">
          <strong>需要你确认后重试</strong>
          <span>
            为避免上游重复计费，中断或超时不会自动重试。
            {request ? "点击下方“继续”即可从检查点恢复；" : "请在主聊天发送“继续评审”；"}
            已完成席位不会重复调用。
          </span>
        </div>
      )}
      {!compact && (
        <details className="decision-call-history" open={value.status === "running" || value.status === "completed"}>
          <summary>
            <span>模型调用过程</span>
            <small>
              {value.calls.length} 次调用{failedCalls ? ` · ${failedCalls} 次需关注` : ""}
            </small>
          </summary>
          <ol className="decision-call-list">
            {value.calls.map((call, index) => (
              <li key={call.id} data-call-status={call.status}>
                <span className="decision-call-index">{index + 1}</span>
                <span className="decision-call-mark" aria-hidden="true">
                  {callStatus[call.status]?.mark ?? "-"}
                </span>
                <div className="decision-call-main">
                  <div className="decision-call-title">
                    <strong>{call.role}</strong>
                    <span>{call.model}</span>
                  </div>
                  <div className="decision-call-meta">
                    <span>{call.purpose === "compaction" ? "DSH 上下文压缩" : call.phase}</span>
                    {call.round > 0 && <span>第 {call.round} 轮</span>}
                    {(call.attempt ?? 1) > 1 && <span>第 {call.attempt} 次尝试</span>}
                  </div>
                  {call.error && <p>{call.error}</p>}
                </div>
                <div className="decision-call-result">
                  <span className="decision-call-status">{callStatus[call.status]?.label ?? call.status}</span>
                  <strong>{call.tokens.toLocaleString()}</strong>
                  <small>Token</small>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
      <p className="decision-caption">独立首评全部提交后统一公开。补充材料、提异议和再次修订，直接在主聊天发送。</p>
      {request && (
        <div className="decision-chat-actions">
          {value.status === "running" && (
            <>
              <button onClick={() => action("请暂停当前评审")}>暂停</button>
              <button onClick={() => action("请结束当前讨论并生成修订与复核")}>进入修订</button>
            </>
          )}
          {value.status === "paused" && <button onClick={() => action("请在原预算内从检查点继续评审")}>继续</button>}
          {value.status === "completed" && (
            <button onClick={() => action("请根据以下新增意见进行第二次评审；先等我补充具体意见")}>补充修订意见</button>
          )}
          {value.status !== "completed" && value.status !== "cancelled" && (
            <button onClick={() => action("请取消当前评审")}>取消</button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
export const decisionNodeDefinition = {
  kind: "decision-room-message",
  target: "chat",
  match(event: Event) {
    return event.type === "decision-room/message"
      ? { id: (event.data as DecisionMessage).id, role: "start" as const }
      : null
  },
  start(_context: unknown, match: { event: Event }) {
    return match.event.data
  },
  update(context: NodeContext) {
    return context.state
  },
  buildViewNode(context: NodeContext) {
    if (!context.start || !context.state) {
      return null
    }
    return {
      key: context.key,
      id: context.id,
      kind: "decision-room",
      target: "chat",
      anchorSeq: context.start.event.seq,
      location: { kind: "session" },
      visibility: "visible",
      data: context.state,
    }
  },
}
