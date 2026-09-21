import { describe, expect, it } from "vitest"
import type { SidebarState } from "dsh-better-sidebar/client/service"
import { createSidebarAutoOpen, createSidebarReveal } from "./sidebar-reveal.js"

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
})
