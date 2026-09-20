import { useState } from "react"
import type { DecisionMessage } from "./dsh/messages.js"

type Event = { type: string; seq: number; data: unknown }
type NodeContext = { key: string; id: string; start?: { event: Event }; state?: unknown }
export type ConversationEvents = {
  register(definition: {
    kind: string
    target: string
    match(event: Event): { id: string; role: "start" } | null
    start(context: unknown, match: { event: Event }): unknown
    update(context: NodeContext): unknown
    buildViewNode(context: NodeContext): unknown
  }): () => void
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
