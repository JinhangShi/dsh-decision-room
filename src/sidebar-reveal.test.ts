import { describe, expect, it } from "vitest"
import { createSidebarAutoOpen } from "./sidebar-reveal.js"
import { selectDecisionSession, selectWorkspace } from "./client.js"

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
        "session-dsh-decision-room-running": { blank: false, cwd: "/workspace", retainedBy: { mainView: 1 } },
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
        main: { blank: true, cwd: "/workspace", retainedBy: { mainView: 1 } },
      },
    }
    expect(selectDecisionSession(snapshot, "/workspace", [])).toBeUndefined()
  })
})

describe("决策进度自动打开侧栏", () => {
  it("在 Sidebar 服务就绪前排队，并且每个任务只打开一次", () => {
    const opened: Array<{ seed: { type: string }; scope?: { sessionId: string; cwd?: string } }> = []
    const controller = createSidebarAutoOpen("decision-room", sessionId => ({ sessionId, cwd: "/workspace" }))
    controller.request("session-1", "run-1")
    controller.attach({
      isTabEnabled: () => true,
      openTab: (seed, scope) => opened.push({ seed, scope }),
    })
    controller.request("session-1", "run-1")
    expect(opened).toEqual([
      {
        seed: { type: "decision-room", target: "right", reveal: true },
        scope: { sessionId: "session-1", cwd: "/workspace" },
      },
    ])
  })

  it("尊重用户禁用状态，且销毁后不再打开", () => {
    let opens = 0
    const controller = createSidebarAutoOpen("decision-room", sessionId => ({ sessionId }))
    controller.attach({ isTabEnabled: () => false, openTab: () => (opens += 1) })
    controller.request("session-1", "run-1")
    controller.dispose()
    controller.request("session-1", "run-2")
    expect(opens).toBe(0)
  })

  it("用户关闭标签后再次点击入口仍会重新打开", () => {
    let opens = 0
    const controller = createSidebarAutoOpen("decision-room", sessionId => ({ sessionId }))
    controller.attach({ isTabEnabled: () => true, openTab: () => (opens += 1) })
    controller.open("session-1")
    controller.open("session-1")
    expect(opens).toBe(2)
  })
})
