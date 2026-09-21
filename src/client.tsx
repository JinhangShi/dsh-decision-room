import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { Button } from "@deepseek-ai/dsh-client-ui-primitives"
import type { BetterSidebarService, TabComponentProps } from "dsh-better-sidebar/client/service"
import {
  DecisionProgressCard,
  decisionNodeDefinition,
  progressNodeDefinition,
  type ConversationEvents,
} from "./chat-messages.js"
import { DecisionChatMessage } from "./decision-chat-message.js"
import { fillDecisionDraft, type ComposerInput } from "./composer.js"
import { createSidebarAutoOpen, createSidebarReveal } from "./sidebar-reveal.js"

export const inject = ["slots", "sessions", "workspaces", "conversationEvents"] as const
const PREFIX = "session-dsh-decision-room-"
const TAB = "dsh-decision-room:workbench"
const SETTINGS_TAB = "dsh-decision-room:settings"
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
function Launcher({
  launch,
  openSettings,
  wide = true,
}: {
  launch?: () => Promise<void>
  openSettings?: () => void
  wide?: boolean
}): JSX.Element {
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
      <Button
        variant="ghost"
        type="button"
        aria-label="决策室设置"
        title="决策室设置"
        style={{
          width: wide ? "100%" : 36,
          height: wide ? 36 : 36,
          justifyContent: wide ? "flex-start" : "center",
          marginTop: 4,
        }}
        onClick={() => openSettings?.()}
      >
        {wide ? "设置" : "⚙"}
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
.decision-message-markdown { min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
.decision-message-markdown[data-collapsed="true"] { max-height: 520px; overflow: hidden; }
.decision-message-markdown>:first-child { margin-top: 0; }
.decision-message-markdown>:last-child { margin-bottom: 0; }
.decision-message-toggle { margin-top: 12px; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 12px; }
.decision-message-toggle:hover { background: var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04)); }
.decision-progress { padding: 18px; margin: 18px 0; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-radius: 8px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; }
.decision-progress header { display: flex; justify-content: space-between; gap: 12px; }
.decision-progress header span { color: var(--dsw-alias-state-business-primary,#4777cd); }
.decision-seats { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.decision-seats>div { border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-radius: 8px; padding: 10px; }
.decision-seats small,.decision-seats span { display: block; }
.decision-caption,.decision-progress small { opacity: .72; font-size: 12px; }
.decision-ballot { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l2,#dce4ef); }
.decision-ballot>summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 2px; cursor: pointer; font-weight: 600; }
.decision-ballot>summary small { font-weight: 400; text-align: right; }
.decision-ballot-legend { padding: 2px 0 8px; color: var(--dsw-alias-label-secondary,#586273); font-size: 11px; line-height: 1.55; }
.decision-ballot-legend p { margin: 3px 0; }
.decision-limit-summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:10px 0; }
.decision-limit-summary span { padding:8px 10px; border:1px solid var(--dsw-alias-border-subtle,#d9dee7); background:var(--dsw-alias-bg-subtle,#f7f8fa); font-size:12px; }
.decision-ballot-history { margin-top:14px; }
.decision-ballot-history>h3 { margin:0 0 8px; font-size:14px; }
.decision-ballot-history>details { border-top:1px solid var(--dsw-alias-border-subtle,#d9dee7); }
.decision-ballot-history>details>summary { display:flex; justify-content:space-between; gap:8px; padding:10px 0; cursor:pointer; }
.decision-ballot-interpretation { margin-bottom:10px; padding:10px; border-left:3px solid #24745d; background:#f1f8f5; color:#193f35; font-size:12px; line-height:1.55; }
.decision-ballot-interpretation p { margin:5px 0; }
.decision-ballot-interpretation small { color:#526b64; }
.decision-recovery { display:grid; gap:4px; margin:10px 0; padding:10px 12px; border-left:3px solid #b7791f; background:#fff8e6; color:#5f430f; font-size:12px; line-height:1.55; }
.decision-ballot-list { display: grid; gap: 8px; padding: 2px 0 8px; }
.decision-ballot-list article { min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-left: 3px solid #7b8798; border-radius: 6px; }
.decision-ballot-list article[data-blocking="true"] { border-left-color: #b83a3a; background: color-mix(in srgb,#b83a3a 5%,transparent); }
.decision-ballot-heading { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: baseline; gap: 8px; }
.decision-ballot-heading>span { color: var(--dsw-alias-state-business-primary,#4777cd); font-weight: 700; }
.decision-ballot-heading>strong { min-width: 0; overflow-wrap: anywhere; }
.decision-ballot-coverage,.decision-ballot-votes { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }
.decision-ballot-coverage span { font-weight: 600; }
.decision-ballot-votes span { padding: 2px 6px; border: 1px solid var(--dsw-alias-border-l2,#dce4ef); border-radius: 4px; background: var(--dsw-alias-bg-layer-1,rgba(0,0,0,.025)); }
.decision-ballot-evidence { margin-top: 7px; color: var(--dsw-alias-label-secondary,#586273); font-size: 12px; overflow-wrap: anywhere; }
.decision-call-history { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l2,#dce4ef); }
.decision-call-history>summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 2px; cursor: pointer; font-weight: 600; }
.decision-call-history>summary small { font-weight: 400; }
.decision-call-list { list-style: none; margin: 0; padding: 0; max-height: 460px; overflow: auto; border-top: 1px solid var(--dsw-alias-border-l2,#dce4ef); }
.decision-call-list li { display: grid; grid-template-columns: 24px 24px minmax(0,1fr) minmax(72px,auto); align-items: start; gap: 10px; padding: 12px 4px; border-bottom: 1px solid var(--dsw-alias-border-l2,#dce4ef); }
.decision-call-index { padding-top: 2px; color: var(--dsw-alias-label-tertiary,#7a8494); font-variant-numeric: tabular-nums; text-align: right; }
.decision-call-mark { display: grid; place-items: center; width: 20px; height: 20px; margin-top: 1px; border: 1px solid currentColor; border-radius: 50%; font-size: 11px; font-weight: 700; line-height: 1; }
.decision-call-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.decision-call-title>span { color: var(--dsw-alias-label-secondary,#586273); font-size: 12px; }
.decision-call-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 2px; color: var(--dsw-alias-label-tertiary,#7a8494); font-size: 12px; }
.decision-call-main p { margin: 7px 0 0; padding: 7px 9px; border-left: 2px solid #c74444; background: color-mix(in srgb,#c74444 8%,transparent); color: var(--dsw-alias-label-primary); line-height: 1.5; }
.decision-call-result { min-width: 72px; text-align: right; font-variant-numeric: tabular-nums; }
.decision-call-result>* { display: block; }
.decision-call-result strong { margin-top: 3px; line-height: 1.2; }
.decision-call-status { font-size: 12px; font-weight: 600; }
.decision-call-list [data-call-status="succeeded"] .decision-call-mark,.decision-call-list [data-call-status="succeeded"] .decision-call-status { color: #2f7d4a; }
.decision-call-list [data-call-status="running"] .decision-call-mark,.decision-call-list [data-call-status="running"] .decision-call-status { color: var(--dsw-alias-state-business-primary,#4777cd); }
.decision-call-list [data-call-status="failed"] .decision-call-mark,.decision-call-list [data-call-status="failed"] .decision-call-status { color: #b83a3a; }
.decision-call-list [data-call-status="interrupted"] .decision-call-mark,.decision-call-list [data-call-status="interrupted"] .decision-call-status { color: #a76519; }
@media (max-width:640px) { .decision-seats { grid-template-columns: 1fr; } .decision-ballot>summary { align-items: flex-start; } .decision-ballot-heading { grid-template-columns: auto minmax(0,1fr); } .decision-ballot-heading>small { grid-column: 2; } .decision-call-list li { grid-template-columns: 20px 20px minmax(0,1fr); gap: 8px; } .decision-call-result { grid-column: 3; display: flex; align-items: baseline; gap: 5px; min-width: 0; text-align: left; } .decision-call-result>* { display: inline; } }
`
export function apply(ctx: ClientContext): void {
  let active = true
  let sidebar: BetterSidebarService | undefined
  const reveal = createSidebarReveal()
  const autoOpen = createSidebarAutoOpen(
    TAB,
    sessionId => {
      try {
        return { sessionId, cwd: workspaceFor(ctx, sessionId).path }
      } catch {
        return undefined
      }
    },
    sessionId => reveal.request(sessionId),
  )
  ctx.effect(() => {
    const style = document.createElement("style")
    style.textContent = CSS
    document.head.append(style)
    return () => {
      active = false
      reveal.dispose()
      autoOpen.dispose()
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
        inject: sessionId => ({
          request: (text: string) => fillDecisionDraft(inputFor(ctx, sessionId), text),
          onRunning: (runId: string) => autoOpen.request(sessionId, runId),
        }),
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
      const disposeSettings = service.registerTab({
        id: SETTINGS_TAB,
        title: "决策室设置",
        order: 34,
        single: true,
        component: (props: TabComponentProps) => {
          const query = new URLSearchParams({
            sessionId: props.scope.sessionId,
            workspaceId: props.scope.cwd ?? "local",
            layout: "settings",
          })
          return (
            <iframe
              title="决策室设置"
              src={`/decision-room/?${query}`}
              style={{ width: "100%", height: "100%", border: 0 }}
            />
          )
        },
      })
      sidebar = service
      const detachAutoOpen = autoOpen.attach(service)
      return () => {
        detachAutoOpen()
        if (sidebar === service) {
          sidebar = undefined
        }
        dispose()
        disposeSettings()
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
      autoOpen.request(target, `launcher:${target}`)
    }
  }
  const openSettings = () => {
    if (!sidebar?.isTabEnabled(SETTINGS_TAB)) {
      return
    }
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId) {
      sidebar.openTab({ type: SETTINGS_TAB }, { sessionId })
    } else {
      sidebar.openTab({ type: SETTINGS_TAB })
    }
  }
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "dsh-decision-room:launcher",
        order: 25,
        inject: () => ({ launch, openSettings }),
      },
      Launcher,
    ),
  )
}
