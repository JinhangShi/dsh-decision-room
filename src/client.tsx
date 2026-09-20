import { useEffect, useRef, useState, useSyncExternalStore } from "react"
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
import { createSidebarReveal } from "./sidebar-reveal.js"

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
    binding(id: string):
      | {
          session: {
            getSnapshot(): { composerPhase?: string; blank?: boolean; running?: boolean }
            subscribe(listener: () => void): () => void
          }
        }
      | undefined
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
      width="16"
      height="16"
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
        icon={<Icon />}
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
        {wide ? "决策室" : null}
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

function DecisionSidebar({
  sessionId,
  context,
  visible,
}: {
  sessionId: string
  context: ClientContext
  visible: boolean
}): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const session = context.sessions.binding(sessionId)?.session
  const blank = useSyncExternalStore(
    listener => session?.subscribe(listener) ?? (() => {}),
    () => {
      const state = session?.getSnapshot()
      return state?.blank === true && !state.running
    },
  )
  const workspace = workspaceFor(context, sessionId)
  const key = `decision-room:generated:${JSON.stringify([workspace.path, sessionId])}`
  const generated = useRef("")
  useEffect(() => {
    try {
      generated.current = sessionStorage.getItem(key) ?? ""
    } catch {
      generated.current = ""
    }
  }, [key])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.sessionId !== sessionId ||
        event.data?.type !== "decision-room:compose" ||
        typeof event.data.text !== "string" ||
        event.data.text.length > 150000 ||
        typeof event.data.requestId !== "string"
      ) {
        return
      }
      const reply = (type: string, message?: string) =>
        frame.current?.contentWindow?.postMessage(
          { type, sessionId, requestId: event.data.requestId, message },
          location.origin,
        )
      try {
        if (!visible || context.sessions.list.getSnapshot().current !== sessionId) {
          throw new Error("请回到此会话的决策卡片继续编辑")
        }
        if (!blank) {
          throw new Error("材料已经发送，请在主聊天补充意见或发起二次修订")
        }
        fillDecisionDraft(inputFor(context, sessionId), event.data.text, generated.current)
        generated.current = event.data.text
        try {
          sessionStorage.setItem(key, generated.current)
        } catch {
          // Synchronization still works if browser storage is unavailable.
        }
        reply("decision-room:composed")
      } catch (cause) {
        reply("decision-room:compose-error", cause instanceof Error ? cause.message : "无法同步主聊天")
      }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [sessionId, context, blank, key, visible])
  return (
    <iframe
      key={`${sessionId}:${blank}`}
      ref={frame}
      title={blank ? "决策室议题与材料" : "决策室只读进度"}
      src={`/decision-room/?${new URLSearchParams({ sessionId, workspaceId: workspace.path!, layout: blank ? "sidebar" : "progress" })}`}
      style={{ width: "100%", height: "100%", border: 0, display: "block" }}
    />
  )
}
const CSS = `
.decision-chat-actions button { margin: 4px; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); color: inherit; background: transparent; padding: 6px 10px; border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; }
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
  let sidebar: BetterSidebarService | undefined
  const reveal = createSidebarReveal()
  ctx.effect(() => {
    const style = document.createElement("style")
    style.textContent = CSS
    document.head.append(style)
    return () => {
      active = false
      reveal.dispose()
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
  ctx.inject(["betterSidebar"], child => {
    child.effect(() => {
      const service = child.betterSidebar
      if (!service) {
        return
      }
      const dispose = service.registerTab({
        id: TAB,
        title: "决策室",
        order: 35,
        single: true,
        hidden: true,
        component: (props: TabComponentProps) => {
          const { sessionId } = props.scope
          useEffect(
            () => reveal.attach(sessionId, { store: props.store, tabId: props.tab.id }),
            [sessionId, props.store, props.tab.id],
          )
          return <DecisionSidebar sessionId={sessionId} context={ctx} visible={props.visible} />
        },
      })
      sidebar = service
      return () => {
        if (sidebar === service) {
          sidebar = undefined
        }
        dispose()
      }
    })
  })
  const launch = async () => {
    if (!sidebar?.isTabEnabled(TAB)) {
      throw new Error("请先启用 Better Sidebar 和决策室标签页")
    }
    const before = ctx.sessions.list.getSnapshot().current
    const workspace = workspaceFor(ctx, before)
    const list = ctx.sessions.list.getSnapshot()
    const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds ?? []
    const reusable = [before, ...(list.ids ?? [])].find(
      id =>
        id !== undefined &&
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
      sidebar.openTab({ type: TAB }, { sessionId: target })
      reveal.request(target)
    }
  }
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      { name: "sidebar.footer.action", id: "dsh-decision-room:launcher", order: 25, inject: () => ({ launch }) },
      Launcher,
    ),
  )
}
