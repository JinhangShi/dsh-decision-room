import { useEffect, useMemo, useRef, useState } from "react"
import type { Run, Scope } from "../core/schema.js"
import { composeDecisionRequest } from "../composer.js"
import { decisionProgress } from "../dsh/messages.js"
import { DecisionProgressCard } from "../chat-messages.js"
import { BriefForm, EMPTY_BRIEF } from "./app.js"
import { Api, type Bootstrap } from "./api.js"

export function ChatSetup({ scope, progressOnly = false }: { scope: Scope; progressOnly?: boolean }): JSX.Element {
  const api = useMemo(() => new Api(scope), [scope.sessionId, scope.workspaceId])
  const [boot, setBoot] = useState<Bootstrap>()
  const [run, setRun] = useState<Run>()
  const [error, setError] = useState("")
  const pending = useRef<{ resolve(): void; reject(error: Error): void }>()
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
    const timer = progressOnly
      ? setInterval(() => {
          void refresh()
        }, 1500)
      : undefined
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, progressOnly])
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== window.parent ||
        event.data?.sessionId !== scope.sessionId
      ) {
        return
      }
      if (event.data.type === "decision-room:composed") {
        pending.current?.resolve()
        pending.current = undefined
      }
      if (event.data.type === "decision-room:compose-error") {
        pending.current?.reject(new Error(event.data.message))
        pending.current = undefined
      }
    }
    window.addEventListener("message", message)
    const resize = new ResizeObserver(() =>
      window.parent.postMessage(
        {
          type: "decision-room:height",
          sessionId: scope.sessionId,
          height: document.getElementById("root")!.scrollHeight + 2,
        },
        location.origin,
      ),
    )
    resize.observe(document.getElementById("root")!)
    return () => {
      window.removeEventListener("message", message)
      resize.disconnect()
      pending.current?.reject(new Error("会话已关闭，材料没有发送"))
    }
  }, [scope.sessionId])
  return (
    <main className="decision-app chat-setup-mode">
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!boot ? (
        <p>正在读取角色与预算配置…</p>
      ) : progressOnly ? (
        <>
          <p className="notice">这里只显示进度。提交材料、暂停、继续及二次修订，请直接在主聊天完成。</p>
          {run ? (
            <DecisionProgressCard node={{ data: decisionProgress(run, boot.models) }} />
          ) : (
            <p>尚未开始评审，请在主聊天填写材料并发送。</p>
          )}
        </>
      ) : (
        <BriefForm
          models={boot.models}
          initialBrief={EMPTY_BRIEF}
          initialConfig={boot.defaults}
          parent={null}
          composeOnly
          onSubmit={async (brief, config) => {
            if (window.parent === window) {
              throw new Error("请从 DSH 左侧决策室入口进入，再回填主聊天")
            }
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                pending.current = undefined
                reject(new Error("主聊天未响应，材料已保留，请重试"))
              }, 8000)
              pending.current = {
                resolve: () => {
                  clearTimeout(timer)
                  resolve()
                },
                reject: error => {
                  clearTimeout(timer)
                  reject(error)
                },
              }
              window.parent.postMessage(
                {
                  type: "decision-room:compose",
                  sessionId: scope.sessionId,
                  text: composeDecisionRequest(brief, config),
                },
                location.origin,
              )
            })
          }}
        />
      )}
    </main>
  )
}
