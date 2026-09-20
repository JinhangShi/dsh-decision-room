import { useState } from "react"
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
}: {
  node: { data: DecisionProgress }
  request?(text: string): void
}): JSX.Element {
  const value = node.data
  const [error, setError] = useState("")
  const state = {
    draft: "待开始",
    running: "正在评审",
    paused: "已暂停",
    completed: "评审完成",
    cancelled: "已取消",
    failed: "需处理",
  }[value.status]
  const action = (text: string) => {
    try {
      request?.(`${text}（决策任务 ${value.runId}，V${value.version}）。`)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请直接在输入框发送指令")
    }
  }
  return (
    <section className="decision-progress" data-decision-progress={value.id}>
      <header>
        <strong>DSH 多模型决策 · V{value.version}</strong>
        <span role="status">{state}</span>
      </header>
      <p>
        {value.title} · {value.phase}
        {value.round ? ` · 第 ${value.round} 轮` : ""}
      </p>
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
      <p className="decision-caption">
        调用 {value.calls.length} / {value.maxCalls} · 已计入 / 预留 {value.tokens.toLocaleString()} /{" "}
        {value.tokenBudget.toLocaleString()} Token
      </p>
      {value.stopReason && <p role="status">{value.stopReason}</p>}
      <details open={value.status === "running"}>
        <summary>模型调用过程</summary>
        <ol className="decision-call-list">
          {value.calls.map(call => (
            <li key={call.id} data-call-status={call.status}>
              <span>
                {call.role} · {call.model}
                <small>
                  {call.purpose === "compaction" ? "DSH 上下文压缩" : call.phase}
                  {call.round ? ` · 第 ${call.round} 轮` : ""}
                </small>
              </span>
              <span>
                {
                  (
                    { running: "调用中…", succeeded: "已完成", failed: "失败", interrupted: "已中断" } as Record<
                      string,
                      string
                    >
                  )[call.status]
                }
                <small>{call.tokens.toLocaleString()} Token</small>
              </span>
              {call.error && <p>{call.error}</p>}
            </li>
          ))}
        </ol>
      </details>
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
export function DecisionChatMessage(props: {
  node?: { data: DecisionMessage }
  data?: DecisionMessage
}): JSX.Element | null {
  const message = props.node?.data ?? props.data
  const [expanded, setExpanded] = useState(false)
  if (!message) {
    return null
  }
  const long = message.text.length > 2500
  return (
    <article
      data-decision-message={message.id}
      style={{
        margin: "18px 0",
        padding: "18px 22px",
        border: "1px solid #dce4ef",
        borderRadius: 12,
        background: "var(--color-bg, #fff)",
        color: "var(--color-text, #263449)",
        maxWidth: "100%",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <strong>{message.role}</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {message.model} · {message.phase} · V{message.version}
        </span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.8, fontSize: 14 }}>
        {long && !expanded ? `${message.text.slice(0, 2000)}\n…` : message.text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            marginTop: 12,
            padding: "6px 12px",
            border: "1px solid #dce4ef",
            borderRadius: 6,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          {expanded ? "收起" : "展开完整内容"}
        </button>
      )}
    </article>
  )
}
