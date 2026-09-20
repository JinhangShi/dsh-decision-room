import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Button } from "@deepseek-ai/dsh-client-ui-primitives"
import type { BetterSidebarService, TabComponentProps } from "dsh-better-sidebar/client/service"
import {
  DecisionChatMessage,
  DecisionProgressCard,
  decisionNodeDefinition,
  progressNodeDefinition,
  type ConversationEvents,
} from "./chat-messages.js"
import { fillDecisionDraft, type ComposerInput } from "./composer.js"

export const inject = ["slots", "sessions", "workspaces", "conversationEvents"] as const
const PREFIX = "session-dsh-decision-room-"
const TAB = "dsh-decision-room:workbench"
type Workspace = { workspaceId: string; path?: string; sessionIds?: string[] }
export type ClientContext = {
  slots: {
    inject(name: string, setup: () => void | (() => void)): unknown
    register<Props extends object>(
      descriptor: {
        name: string
        id: string
        key?: string
        order?: number
        inject?: (sessionId: string) => Record<string, unknown>
      },
      component: (props: Props) => JSX.Element | null,
    ): () => void
  }
  sessions: {
    list: {
      getSnapshot(): { current?: string; ids?: string[]; byId?: Record<string, { blank?: boolean; cwd?: string }> }
    }
    create(options: { workspaceId: string; sessionId: string }): Promise<string>
    open(id: string): void
    scope?(id: string): { get(name: string): unknown } | undefined
  }
  workspaces: {
    list: { getSnapshot(): { items?: Workspace[]; recentWorkspaceId?: string; archivedSessionIds?: string[] } }
  }
  betterSidebar?: BetterSidebarService
  conversationEvents: ConversationEvents
  inject(deps: string[], setup: (context: ClientContext) => void): unknown
  effect(setup: () => void | (() => void)): unknown
}
function workspaceFor(ctx: ClientContext, sessionId?: string): Workspace {
  const snapshot = ctx.workspaces.list.getSnapshot()
  const workspace =
    snapshot.items?.find(item => sessionId && item.sessionIds?.includes(sessionId)) ??
    snapshot.items?.find(item => item.workspaceId === snapshot.recentWorkspaceId)
  if (!workspace?.path) {
    throw new Error("请先选择有本地路径的工作空间，再进入决策室")
  }
  return workspace
}
function inputFor(ctx: ClientContext, sessionId: string): ComposerInput {
  const scope = ctx.sessions.scope?.(sessionId)
  const conversation = scope?.get("conversation") as { input?: { for(scope: unknown): ComposerInput } } | undefined
  const input = scope && conversation?.input?.for(scope)
  if (!input) {
    throw new Error("当前会话输入框尚未就绪，请稍后重试")
  }
  return input
}
function Icon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 4h14v11H9l-4 4z" />
      <path d="M9 8h6M9 11h4" />
    </svg>
  )
}
function Launcher({ launch, wide = true }: { launch?: () => Promise<void>; wide?: boolean }): JSX.Element {
  const [mount, setMount] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    const owned = new Set<HTMLElement>()
    const sync = () => {
      const workspace = document.querySelector('[data-slot="sidebar.workspaces"]')
      const parent = workspace?.parentElement
      if (!workspace || !parent) {
        return
      }
      let container = parent.querySelector<HTMLElement>("[data-decision-launcher-mount]")
      if (!container) {
        container = document.createElement("div")
        container.dataset.decisionLauncherMount = "true"
        // Insert once; MCP connector maintains its own position, so do not reorder siblings in observers.
        parent.insertBefore(container, workspace)
        owned.add(container)
      }
      setMount(current => (current === container ? current : container))
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const element of owned) {
        element.remove()
      }
    }
  }, [])
  const content = (
    <div style={{ width: wide ? "100%" : 36, paddingRight: wide ? 12 : 0, boxSizing: "border-box" }}>
      <Button
        variant="ghost"
        type="button"
        aria-label="决策室"
        title={error || "打开决策室"}
        aria-busy={busy}
        disabled={busy}
        style={{
          boxSizing: "border-box",
          width: wide ? "100%" : 36,
          height: wide ? 40 : 36,
          justifyContent: wide ? "flex-start" : "center",
          borderRadius: wide ? 10 : "50%",
          paddingInline: wide ? 10 : 0,
          whiteSpace: "nowrap",
        }}
        onClick={() => {
          if (!launch || busy) {
            return
          }
          setBusy(true)
          setError("")
          void launch()
            .catch(cause => setError(cause instanceof Error ? cause.message : "打开失败"))
            .finally(() => setBusy(false))
        }}
      >
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <Icon />
          {wide ? <span>决策室</span> : null}
        </span>
      </Button>
      {error && wide && (
        <p role="alert" style={{ fontSize: 12 }}>
          {error}
        </p>
      )}
    </div>
  )
  return mount ? createPortal(content, mount) : content
}

type HomeProps = {
  sessionId: string
  useSession<T>(
    selector: (state: {
      composerPhase?: string
      blank?: boolean
      awaitingFirstTurn?: boolean
      running?: boolean
      promptAttempted?: boolean
    }) => T,
  ): T
  context?: ClientContext
}
function DecisionHome({ sessionId, useSession, context }: HomeProps): JSX.Element | null {
  const blank = useSession(
    state =>
      state.composerPhase === "blank" ||
      (state.composerPhase === undefined &&
        (state.blank === true || state.awaitingFirstTurn === true) &&
        !state.running &&
        !state.promptAttempted),
  )
  const frame = useRef<HTMLIFrameElement>(null)
  const marker = useRef<HTMLDivElement>(null)
  const generated = useRef("")
  const [prepared, setPrepared] = useState(false)
  const [height, setHeight] = useState(850)
  const [error, setError] = useState("")
  const enabled = sessionId.startsWith(PREFIX)
  useEffect(() => {
    setPrepared(false)
    setError("")
  }, [sessionId])
  useEffect(() => {
    if (!enabled || !context) {
      return
    }
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.sessionId !== sessionId
      ) {
        return
      }
      if (event.data.type === "decision-room:height" && Number.isFinite(event.data.height)) {
        setHeight(Math.max(200, Math.min(2600, event.data.height)))
        return
      }
      if (
        event.data.type !== "decision-room:compose" ||
        typeof event.data.text !== "string" ||
        event.data.text.length > 150000
      ) {
        return
      }
      try {
        if (context.sessions.list.getSnapshot().current !== sessionId) {
          throw new Error("当前会话已经切换，请回到原会话继续")
        }
        fillDecisionDraft(inputFor(context, sessionId), event.data.text, generated.current)
        generated.current = event.data.text
        setPrepared(true)
        setError("")
        frame.current?.contentWindow?.postMessage({ type: "decision-room:composed", sessionId }, location.origin)
        requestAnimationFrame(() =>
          marker.current
            ?.closest("[data-composer-seat]")
            ?.querySelector<HTMLElement>('[contenteditable="true"], textarea')
            ?.focus(),
        )
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "无法回填主聊天"
        setError(message)
        frame.current?.contentWindow?.postMessage(
          { type: "decision-room:compose-error", sessionId, message },
          location.origin,
        )
      }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [sessionId, context, enabled])
  useEffect(() => {
    if (!enabled || !blank || !marker.current) {
      return
    }
    const root = marker.current.closest<HTMLElement>('[data-phase="hero"]')
    if (!root) {
      return
    }
    root.dataset.decisionHome = "true"
    return () => {
      delete root.dataset.decisionHome
    }
  }, [enabled, blank, sessionId])
  if (!enabled || !blank || !context) {
    return null
  }
  let workspace: Workspace
  try {
    workspace = workspaceFor(context, sessionId)
  } catch {
    return <p>请先选择工作空间。</p>
  }
  return (
    <div ref={marker} className="decision-chat-home" data-decision-home-session={sessionId}>
      {prepared && (
        <p className="decision-draft-ready">
          材料已放入下方主聊天输入框。可继续修改，点击发送后由 DSH 开始调度四个模型。
          <button onClick={() => setPrepared(false)}>返回编辑材料</button>
        </p>
      )}
      <iframe
        ref={frame}
        title="决策室议题与材料"
        src={`/decision-room/?${new URLSearchParams({ sessionId, workspaceId: workspace.path!, layout: "chat" })}`}
        style={{ width: "100%", height, border: 0, display: prepared ? "none" : "block" }}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
const CSS = `
[data-decision-home="true"] { --dsh-chat-content-width: 860px; }
.decision-chat-home { width: 100%; min-width: 0; }
.decision-draft-ready { padding: 14px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-l1, #f5f7fb); border-radius: 10px; line-height: 1.7; }
.decision-draft-ready button,.decision-chat-actions button { margin: 4px; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); color: inherit; background: transparent; padding: 6px 10px; border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; }
.decision-progress { padding: 18px; margin: 18px 0; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-radius: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.7; }
.decision-progress header { display: flex; justify-content: space-between; gap: 12px; }
.decision-progress header span { color: var(--dsw-alias-state-business-primary,#4777cd); }
.decision-seats { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.decision-seats>div { border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-radius: 8px; padding: 10px; }
.decision-seats small,.decision-seats span,.decision-call-list small { display: block; }
.decision-caption,.decision-progress small { opacity: .72; font-size: 12px; }
.decision-call-list { list-style: none; padding: 0; max-height: 340px; overflow: auto; }
.decision-call-list li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2,#dce4ef); }
.decision-call-list li>p { flex-basis: 100%; }
.decision-call-list [data-call-status="running"] { color: var(--dsw-alias-state-business-primary,#4777cd); }
`
export function apply(ctx: ClientContext): void {
  let active = true
  ctx.effect(() => {
    const style = document.createElement("style")
    style.textContent = CSS
    document.head.append(style)
    return () => {
      active = false
      style.remove()
    }
  })
  ctx.effect(() => ctx.conversationEvents.register(decisionNodeDefinition))
  ctx.effect(() => ctx.conversationEvents.register(progressNodeDefinition))
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register(
      { name: "conversation.chat.node", id: "decision-room:message", key: "decision-room" },
      DecisionChatMessage,
    ),
  )
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register(
      {
        name: "conversation.chat.node",
        id: "decision-room:progress",
        key: "decision-room-progress",
        inject: sessionId => ({ request: (text: string) => fillDecisionDraft(inputFor(ctx, sessionId), text) }),
      },
      DecisionProgressCard,
    ),
  )
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      { name: "conversation.input.dock", id: "decision-room:home", order: 115, inject: () => ({ context: ctx }) },
      DecisionHome,
    ),
  )
  // Compatibility for an already-open 0.2 sidebar tab: keep only a read-only progress view, never open it from the entry.
  ctx.inject(["betterSidebar"], child =>
    child.effect(() =>
      child.betterSidebar?.registerTab({
        id: TAB,
        title: "决策进度",
        order: 35,
        single: true,
        hidden: true,
        component: (props: TabComponentProps) => {
          try {
            const workspace = workspaceFor(ctx, props.scope.sessionId)
            return (
              <iframe
                title="决策室只读进度"
                src={`/decision-room/?${new URLSearchParams({ sessionId: props.scope.sessionId, workspaceId: workspace.path!, layout: "progress" })}`}
                style={{ width: "100%", height: "100%", border: 0 }}
              />
            )
          } catch {
            return <p>请在主聊天查看决策进度。</p>
          }
        },
      }),
    ),
  )
  const launch = async () => {
    const before = ctx.sessions.list.getSnapshot().current
    const workspace = workspaceFor(ctx, before)
    const list = ctx.sessions.list.getSnapshot()
    const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds ?? []
    const reusable = list.ids?.find(
      id =>
        id.startsWith(PREFIX) &&
        list.byId?.[id]?.blank &&
        list.byId[id]?.cwd === workspace.path &&
        !archived.includes(id),
    )
    const target =
      reusable ??
      (await ctx.sessions.create({ workspaceId: workspace.workspaceId, sessionId: `${PREFIX}${crypto.randomUUID()}` }))
    if (active && ctx.sessions.list.getSnapshot().current === before) {
      ctx.sessions.open(target)
    }
  }
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      { name: "sidebar.footer.action", id: "dsh-decision-room:launcher", order: 25, inject: () => ({ launch }) },
      Launcher,
    ),
  )
}
