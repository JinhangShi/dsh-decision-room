import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { runConfigSchema, sourceSchema, type Brief, type Run, type RunConfig, type Scope } from "../core/schema.js"
import { composeDecisionRequest } from "../composer.js"
import { decisionProgress } from "../dsh/messages.js"
import { DecisionProgressCard } from "../chat-messages.js"
import { BriefForm, EMPTY_BRIEF } from "./app.js"
import { Api, type Bootstrap } from "./api.js"

// Drafts may be incomplete while typing; full validation still happens before a review starts.
const draftSchema = z.object({
  brief: z.object({
    title: z.string(),
    question: z.string(),
    objective: z.string(),
    constraints: z.string(),
    plan: z.string(),
    sources: z.array(sourceSchema),
  }),
  config: runConfigSchema,
})

export function ChatSetup({ scope, progressOnly = false }: { scope: Scope; progressOnly?: boolean }): JSX.Element {
  const api = useMemo(() => new Api(scope), [scope.sessionId, scope.workspaceId])
  const key = `decision-room:setup:${JSON.stringify([scope.workspaceId, scope.sessionId])}`
  const [boot, setBoot] = useState<Bootstrap>()
  const [run, setRun] = useState<Run>()
  const [error, setError] = useState("")
  const pending = useRef("")
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const saved = useMemo(() => {
    try {
      return draftSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? "null")).data
    } catch {
      return undefined
    }
  }, [key])
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const result = await api.bootstrap()
        const runs = progressOnly ? await api.request<Run[]>("/runs") : []
        if (active) {
          setBoot(result)
          setRun(runs[0])
          setError("")
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "连接失败")
        }
      }
    }
    void refresh()
    const interval = progressOnly
      ? setInterval(() => {
          void refresh()
        }, 1500)
      : undefined
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [api, progressOnly])
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== window.parent ||
        event.data?.sessionId !== scope.sessionId ||
        event.data.requestId !== pending.current
      ) {
        return
      }
      if (event.data.type === "decision-room:composed") {
        clearTimeout(timer.current)
        setError("")
      }
      if (event.data.type === "decision-room:compose-error") {
        clearTimeout(timer.current)
        setError(event.data.message)
      }
    }
    window.addEventListener("message", message)
    return () => {
      window.removeEventListener("message", message)
      clearTimeout(timer.current)
    }
  }, [scope.sessionId])
  const updateDraft = useCallback(
    (brief: Brief, config: RunConfig) => {
      if (!boot) {
        return
      }
      config = { ...config, limits: { ...config.limits, ...boot.reviewLimits } }
      try {
        sessionStorage.setItem(key, JSON.stringify({ brief, config }))
      } catch {
        // Editing and live synchronization do not depend on browser persistence.
      }
      const changed =
        JSON.stringify(brief) !== JSON.stringify(EMPTY_BRIEF) ||
        JSON.stringify(config) !== JSON.stringify(boot.defaults)
      if (window.parent === window) {
        setError("请从 DSH 左侧决策室入口打开卡片")
        return
      }
      pending.current = crypto.randomUUID()
      clearTimeout(timer.current)
      window.parent.postMessage(
        {
          type: "decision-room:compose",
          sessionId: scope.sessionId,
          requestId: pending.current,
          text: changed ? composeDecisionRequest(brief, config) : "",
        },
        location.origin,
      )
      timer.current = setTimeout(() => setError("主聊天未响应，材料已保留，请重新打开决策室卡片"), 8000)
    },
    [boot, key, scope.sessionId],
  )
  const savedConfig =
    boot &&
    saved?.config &&
    [saved.config.moderatorKey, saved.config.verifierKey, ...saved.config.seats.map(seat => seat.modelKey)].every(key =>
      boot.models.some(model => model.key === key),
    )
      ? saved.config
      : undefined
  return (
    <main className="decision-app chat-setup-mode sidebar-setup-mode">
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!boot ? (
        <p>正在读取角色与预算配置…</p>
      ) : progressOnly ? (
        <>
          <p className="notice">材料已发送。补充意见、暂停、继续及二次修订，请直接在主聊天完成。</p>
          {run ? (
            <DecisionProgressCard compact node={{ data: decisionProgress(run, boot.models) }} />
          ) : (
            <p>等待 DSH 主持处理，调用过程将显示在主聊天。</p>
          )}
        </>
      ) : boot.models.length === 0 ? (
        <div className="notice">
          <strong>没有可用于评审的 DSH 模型。</strong>
          <p>请在 DSH「设置 → 模型」配置提供方和文本模型，并为模型设置上下文容量。</p>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void api
                .bootstrap()
                .then(setBoot)
                .catch(cause => setError(String(cause)))
            }
          >
            重新读取模型
          </button>
        </div>
      ) : (
        <>
          <BriefForm
            models={boot.models}
            reviewLimits={boot.reviewLimits}
            initialBrief={saved?.brief ?? EMPTY_BRIEF}
            initialConfig={{
              ...(savedConfig ?? boot.defaults),
              limits: { ...(savedConfig ?? boot.defaults).limits, ...boot.reviewLimits },
            }}
            parent={null}
            composeOnly
            onDraftChange={updateDraft}
            onSubmit={async () => {}}
          />
        </>
      )}
    </main>
  )
}
