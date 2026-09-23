import { useState } from "react"
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives"
import type { DecisionMessage } from "./dsh/messages.js"

export function DecisionChatMessage(props: {
  node?: { data: DecisionMessage }
  data?: DecisionMessage
}): JSX.Element | null {
  const message = props.node?.data ?? props.data
  const [expanded, setExpanded] = useState(false)
  if (!message) {
    return null
  }
  const preview =
    message.preview ??
    (message.kind === "review" && message.phase.startsWith("交叉讨论")
      ? `${message.text.split("\n\n")[0]!.slice(0, 400)}\n\n以上为模型判断与建议；完整意见和证据引用可展开查看。`
      : undefined)
  const long = Boolean(preview) || message.text.length > 2500
  return (
    <article
      className="decision-message"
      data-decision-message={message.id}
      style={{
        margin: "18px 0",
        padding: "18px 22px",
        border: "1px solid #dce4ef",
        borderRadius: 8,
        background: "var(--color-bg, #fff)",
        color: "var(--color-text, #263449)",
        maxWidth: "100%",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <strong>{message.role}</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {message.model ? `${message.model} · ` : ""}
          {message.phase} · V{message.version}
        </span>
      </div>
      <div className="decision-message-markdown" data-collapsed={long && !expanded ? "true" : undefined}>
        <MarkdownText text={!expanded && preview ? preview : message.text} />
      </div>
      {long && (
        <button
          aria-expanded={expanded}
          className="decision-message-toggle"
          type="button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : "展开完整内容"}
        </button>
      )}
    </article>
  )
}
