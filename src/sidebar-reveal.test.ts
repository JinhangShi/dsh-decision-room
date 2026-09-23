import { describe, expect, it } from "vitest"
import type { SidebarState } from "dsh-better-sidebar/client/service"
import { createSidebarAutoOpen, createSidebarReveal } from "./sidebar-reveal.js"
import { selectDecisionSession, selectWorkspace } from "./client.js"

function fixture(placement: "right" | "bottom" | "float" = "right") {
  const tab = { id: "decision", type: "dsh-decision-room:workbench", title: "决策室" }
  let state: SidebarState = {
    panelOpen: false,
    width: 400,
    activePane: "right",
    nextTerminal: 1,
    nextBrowser: 1,
    expanded: [],
    revealed: [],
    splits: { kind: "leaf", id: "right", tabs: placement === "right" ? [tab] : [], active: tab.id },
    bottomSplits: { kind: "leaf", id: "bottom", tabs: placement === "bottom" ? [tab] : [], active: tab.id },
    bottomOpen: false,
    bottomHeight: 220,
    bottomOpenedOnce: false,
    floats: placement === "float" ? [{ id: "floating", tab, x: 10, y: 10, w: 390, h: 780 }] : [],
  }
  return {
    tabId: tab.id,
    store: {
      reduce(reducer: (value: SidebarState) => SidebarState) {
        state = reducer(state)
      },
    },
    current: () => state,
  }
}

describe("DSH collapsed sidebar compatibility", () => {
  it("刷新恢复时通过会话 cwd 找回尚未写入 sessionIds 的工作空间", () => {
    expect(
      selectWorkspace(
        [
          { workspaceId: "other", path: "/other", sessionIds: ["main"] },
          { workspaceId: "review", path: "/workspace", sessionIds: [] },
        ],
        "other",
        "session-dsh-decision-room-running",
        "/workspace",
      ),
    ).toMatchObject({ workspaceId: "review", path: "/workspace" })
  })

  it("重新打开入口时只复用当前正在查看的决策会话", () => {
    const snapshot = {
      current: "session-dsh-decision-room-running",
      ids: ["session-dsh-decision-room-old", "session-dsh-decision-room-running", "main"],
      byId: {
        "session-dsh-decision-room-old": { blank: false, cwd: "/workspace" },
        "session-dsh-decision-room-running": { blank: false, cwd: "/workspace" },
        main: { blank: false, cwd: "/workspace" },
      },
    }
    expect(selectDecisionSession(snapshot, "/workspace", [])).toBe("session-dsh-decision-room-running")
  })

  it("从普通新对话进入时不跳回同工作空间的旧决策会话", () => {
    const snapshot = {
      current: "main",
      ids: ["session-dsh-decision-room-used", "session-dsh-decision-room-empty"],
      byId: {
        "session-dsh-decision-room-used": { blank: false, cwd: "/workspace" },
        "session-dsh-decision-room-empty": { blank: true, cwd: "/workspace" },
        main: { blank: true, cwd: "/workspace" },
      },
    }
    expect(selectDecisionSession(snapshot, "/workspace", [])).toBeUndefined()
  })

  it("queues a reveal until the target session mounts without opening another session", () => {
    const controller = createSidebarReveal()
    const foreground = fixture()
    const target = fixture()
    controller.attach("foreground", foreground)
    controller.request("target")
    expect(foreground.current().panelOpen).toBe(false)
    controller.attach("target", target)
    expect(target.current().panelOpen).toBe(true)
    expect(foreground.current().panelOpen).toBe(false)
  })

  it("reveals the owning panel and preserves floating geometry", () => {
    for (const placement of ["right", "bottom", "float"] as const) {
      const controller = createSidebarReveal()
      const target = fixture(placement)
      controller.attach("session", target)
      controller.request("session")
      expect(target.current().panelOpen).toBe(placement === "right")
      expect(target.current().bottomOpen).toBe(placement === "bottom")
      const state = target.current()
      controller.request("session")
      expect(target.current()).toBe(state)
    }
  })

  it("detaches stale views and ignores opens after plugin disposal", () => {
    const controller = createSidebarReveal()
    const oldView = fixture()
    const detach = controller.attach("session", oldView)
    detach()
    controller.request("session")
    expect(oldView.current().panelOpen).toBe(false)
    controller.dispose()
    const nextView = fixture()
    controller.attach("session", nextView)
    controller.request("session")
    expect(nextView.current().panelOpen).toBe(false)
  })
})

describe("决策进度自动打开侧栏", () => {
  it("在 Sidebar 服务就绪前排队，并且每个任务只打开一次", () => {
    const opened: Array<{ seed: { type: string }; scope?: { sessionId: string; cwd?: string } }> = []
    const revealed: string[] = []
    const controller = createSidebarAutoOpen(
      "decision-room",
      sessionId => ({ sessionId, cwd: "/workspace" }),
      sessionId => revealed.push(sessionId),
    )
    controller.request("session-1", "run-1")
    controller.attach({
      isTabEnabled: () => true,
      openTab: (seed, scope) => opened.push({ seed, scope }),
    })
    controller.request("session-1", "run-1")
    expect(opened).toEqual([{ seed: { type: "decision-room" }, scope: { sessionId: "session-1", cwd: "/workspace" } }])
    expect(revealed).toEqual(["session-1"])
  })

  it("尊重用户禁用状态，且销毁后不再打开", () => {
    let opens = 0
    const controller = createSidebarAutoOpen(
      "decision-room",
      sessionId => ({ sessionId }),
      () => {},
    )
    controller.attach({ isTabEnabled: () => false, openTab: () => (opens += 1) })
    controller.request("session-1", "run-1")
    controller.dispose()
    controller.request("session-1", "run-2")
    expect(opens).toBe(0)
  })

  it("用户关闭标签后再次点击入口仍会重新打开", () => {
    let opens = 0
    const controller = createSidebarAutoOpen(
      "decision-room",
      sessionId => ({ sessionId }),
      () => {},
    )
    controller.attach({ isTabEnabled: () => true, openTab: () => (opens += 1) })
    controller.open("session-1")
    controller.open("session-1")
    expect(opens).toBe(2)
  })
})
