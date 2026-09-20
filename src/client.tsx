import { useState } from "react"
import type { BetterSidebarService, TabComponentProps } from "dsh-better-sidebar/client/service"

export const inject = ["slots", "sessions", "workspaces"] as const
const TAB = "dsh-decision-room:workbench"
type Workspace = { workspaceId: string; path?: string; sessionIds?: string[] }
export type ClientContext = {
  slots: {
    inject(name: string, setup: () => void | (() => void)): unknown
    register<Props extends object>(
      descriptor: { name: string; id: string; order?: number; inject?: (sessionId: string) => Record<string, unknown> },
      component: (props: Props) => JSX.Element | null,
    ): () => void
  }
  sessions: {
    list: { getSnapshot(): { current?: string } }
    create(options: { workspaceId: string; sessionId: string }): Promise<string>
    open(id: string): void
  }
  workspaces: { list: { getSnapshot(): { items?: Workspace[]; recentWorkspaceId?: string } } }
  betterSidebar?: BetterSidebarService
  inject(deps: string[], setup: (context: ClientContext) => void): unknown
  effect(setup: () => void | (() => void)): unknown
}
function workspaceFor(ctx: ClientContext, sessionId?: string): Workspace {
  const snapshot = ctx.workspaces.list.getSnapshot()
  const workspace =
    snapshot.items?.find(item => sessionId && item.sessionIds?.includes(sessionId)) ??
    snapshot.items?.find(item => item.workspaceId === snapshot.recentWorkspaceId)
  if (!workspace?.path) {
    throw new Error("请先选择有本地路径的工作空间，再打开决策室")
  }
  return workspace
}
function workbenchUrl(sessionId: string, workspace: Workspace): string {
  return `/decision-room/?${new URLSearchParams({ sessionId, workspaceId: workspace.path! })}`
}
function Launcher({
  launch,
  wide = true,
  dock = false,
}: {
  launch?: () => Promise<void>
  wide?: boolean
  dock?: boolean
}): JSX.Element {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <div style={{ padding: dock ? "6px 0" : "4px 8px" }}>
      <button
        type="button"
        disabled={busy}
        title={error || "多模型决策室"}
        aria-label="打开决策室"
        onClick={() => {
          if (!launch || busy) {
            return
          }
          setBusy(true)
          setError("")
          void launch()
            .catch(reason => setError(reason instanceof Error ? reason.message : "工作台未能打开"))
            .finally(() => setBusy(false))
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "#4777cd",
          background: "transparent",
          border: "1px solid #dce6f5",
          borderRadius: 8,
          padding: "9px 12px",
          cursor: "pointer",
          font: "inherit",
          fontSize: 13,
          width: dock ? "auto" : "100%",
        }}
      >
        <span aria-hidden="true">◈</span>
        {wide ? (busy ? "正在打开…" : dock ? "打开决策室" : "决策室") : null}
      </button>
      {error && (
        <p role="alert" style={{ fontSize: 12, color: "#ad5c4a" }}>
          {error}
        </p>
      )}
    </div>
  )
}
export function apply(ctx: ClientContext): void {
  let sidebar: BetterSidebarService | undefined
  const dialogs = new Set<HTMLDialogElement>()
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    for (const dialog of dialogs) {
      dialog.remove()
    }
    dialogs.clear()
  })
  ctx.inject(["betterSidebar"], child => {
    child.effect(() => {
      const service = child.betterSidebar
      if (!service || typeof service.registerTab !== "function" || typeof service.openTab !== "function") {
        return
      }
      const dispose = service.registerTab({
        id: TAB,
        title: "决策室",
        order: 35,
        single: true,
        hidden: true,
        component: (props: TabComponentProps) => {
          try {
            const workspace = workspaceFor(ctx, props.scope.sessionId)
            return (
              <iframe
                title="多模型决策室工作台"
                src={workbenchUrl(props.scope.sessionId, workspace)}
                style={{ width: "100%", height: "100%", minHeight: 650, border: 0 }}
              />
            )
          } catch {
            return <p>当前会话的工作空间路径不可用，请重新选择工作空间。</p>
          }
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
  const open = async (sessionId?: string, dedicated = false) => {
    const workspace = workspaceFor(ctx, sessionId ?? ctx.sessions.list.getSnapshot().current)
    let target = sessionId ?? ctx.sessions.list.getSnapshot().current
    if (!target || (dedicated && !target.startsWith("session-dsh-decision-room-"))) {
      const requested = `session-dsh-decision-room-${crypto.randomUUID()}`
      target = await ctx.sessions.create({ workspaceId: workspace.workspaceId, sessionId: requested })
      if (target !== requested) {
        throw new Error("宿主返回的会话标识不一致")
      }
      ctx.sessions.open(target)
    }
    if (disposed) {
      return
    }
    if (sidebar && sidebar.isTabEnabled(TAB)) {
      sidebar.openTab({ type: TAB }, { sessionId: target })
      return
    }
    // Native dialog is an in-DSH fallback when Better Sidebar is not installed. Closing it never stops the Host job.
    const dialog = document.createElement("dialog")
    dialog.style.cssText =
      "width:94vw;max-width:1500px;height:92vh;padding:0;border:1px solid #dae2ef;border-radius:12px;overflow:hidden"
    const bar = document.createElement("div")
    bar.style.cssText = "display:flex;justify-content:flex-end;padding:8px;background:#f7f9fc"
    const close = document.createElement("button")
    close.textContent = "收起工作台（任务继续）"
    close.style.cssText = "background:white;border:1px solid #dce3ed;border-radius:6px;padding:6px 10px;cursor:pointer"
    close.onclick = () => dialog.close()
    bar.append(close)
    const frame = document.createElement("iframe")
    frame.title = "多模型决策室工作台"
    frame.src = workbenchUrl(target, workspace)
    frame.style.cssText = "width:100%;height:calc(100% - 46px);border:0"
    dialog.append(bar, frame)
    dialog.addEventListener(
      "close",
      () => {
        dialogs.delete(dialog)
        dialog.remove()
      },
      { once: true },
    )
    dialogs.add(dialog)
    document.body.append(dialog)
    dialog.showModal()
  }
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "dsh-decision-room:launcher",
        order: 35,
        inject: () => ({ launch: () => open(undefined, true) }),
      },
      Launcher,
    ),
  )
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "dsh-decision-room:dock",
        order: 115,
        inject: sessionId => ({ launch: () => open(sessionId), dock: true }),
      },
      Launcher,
    ),
  )
}
