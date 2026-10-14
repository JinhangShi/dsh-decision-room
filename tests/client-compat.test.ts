import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProgressControl } from "../src/progress-control.js"
import { apply, type ClientContext } from "../src/client.js"

afterEach(() => vi.unstubAllGlobals())

function client() {
  const disposers: Array<() => void> = []
  vi.stubGlobal("document", {
    createElement: () => ({ textContent: "", remove() {} }),
    head: { append() {} },
  })
  let current = "main"
  let launch!: () => Promise<void>
  let progress!: (sessionId: string) => { control: ProgressControl }
  const byId: Record<string, { cwd: string; retainedBy: { mainView: number } }> = {
    main: { cwd: "/workspace", retainedBy: { mainView: 1 } },
  }
  const select = (id: string) => {
    byId[current]!.retainedBy.mainView = 0
    current = id
    byId[id] = { cwd: "/workspace", retainedBy: { mainView: 1 } }
  }
  const create = vi.fn(async ({ sessionId }: { sessionId: string }) => {
    byId[sessionId] = { cwd: "/workspace", retainedBy: { mainView: 0 } }
    return sessionId
  })
  const openSession = vi.fn(select)
  const openTab = vi.fn()
  const ctx = {
    effect(setup: () => void | (() => void)) {
      const dispose = setup()
      if (dispose) disposers.push(dispose)
    },
    inject(_deps: string[], setup: (context: unknown) => void) {
      setup(ctx)
    },
    slots: {
      inject(_name: string, setup: () => void) {
        setup()
      },
      register(meta: {
        name: string
        key?: string
        inject?: (...args: string[]) => { launch: () => Promise<void>; control: ProgressControl }
      }) {
        if (meta.key === "decision-room-progress") progress = meta.inject!
        if (meta.name === "sidebar.footer.action") launch = meta.inject!().launch
        return () => {}
      },
    },
    sessions: { list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) }, create },
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: "workspace-id", path: "/workspace", sessionIds: [] }],
          archivedSessionIds: [],
        }),
      },
    },
    uiWorkspace: { openSession },
    uiConversation: { events: { register: () => () => {} } },
    betterSidebar: { isTabEnabled: () => true, registerTab: () => () => {}, openTab },
  }
  // Only services exercised by registration and navigation are provided. There is no legacy sessions.open/current.
  apply(ctx as unknown as ClientContext)
  return {
    create,
    progress: (id: string) => progress(id),
    openSession,
    openTab,
    select,
    launch: () => launch(),
    dispose: () => disposers.reverse().forEach(dispose => dispose()),
  }
}

describe("DSH 0.2 客户端导航", () => {
  it("进度控制绑定卡片会话，不随主视图切换，也不访问聊天输入框", async () => {
    const runtime = client()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ token: "test-token" })))
    vi.stubGlobal("fetch", fetcher)
    try {
      const card = runtime.progress("main")
      runtime.select("another-session")
      await card.control("run-test", 12, "pause")
      const [url, options] = fetcher.mock.calls[1] as unknown as [string, RequestInit]
      expect(url).toContain("/runs/run-test/control?")
      expect(JSON.parse(String(options.body))).toEqual({
        scope: { sessionId: "main", workspaceId: "/workspace" },
        revision: 12,
        action: "pause",
      })
      expect(options.headers).toMatchObject({ "x-decision-token": "test-token" })
      await expect(runtime.progress("missing").control("run-test", 12, "cancel")).rejects.toThrow("无法确认")
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      runtime.dispose()
    }
  })

  it("通过新版工作空间导航创建决策会话并展开 Sidebar 0.26", async () => {
    const runtime = client()
    try {
      await runtime.launch()
      const target = runtime.create.mock.calls[0]![0].sessionId
      expect(target).toMatch(/^session-dsh-decision-room-/)
      expect(runtime.create).toHaveBeenCalledWith({ workspaceId: "workspace-id", sessionId: target })
      expect(runtime.openSession).toHaveBeenCalledWith(target)
      expect(runtime.openTab).toHaveBeenCalledWith(
        { type: "dsh-decision-room:workbench", target: "right", reveal: true },
        { sessionId: target, cwd: "/workspace" },
      )
    } finally {
      runtime.dispose()
    }
  })

  it("只复用主视图当前保留的决策会话", async () => {
    const runtime = client()
    try {
      runtime.select("session-dsh-decision-room-existing")
      await runtime.launch()
      expect(runtime.create).not.toHaveBeenCalled()
      expect(runtime.openSession).toHaveBeenCalledWith("session-dsh-decision-room-existing")
      expect(runtime.openTab).toHaveBeenCalledOnce()
    } finally {
      runtime.dispose()
    }
  })

  it("创建期间切换主会话或卸载插件，不抢回新视图", async () => {
    for (const unload of [false, true]) {
      const runtime = client()
      let resolve!: (id: string) => void
      runtime.create.mockImplementation(
        () =>
          new Promise<string>(done => {
            resolve = done
          }),
      )
      const launching = runtime.launch()
      if (unload) runtime.dispose()
      else runtime.select("another-session")
      resolve("session-dsh-decision-room-new")
      await launching
      expect(runtime.openSession).not.toHaveBeenCalled()
      expect(runtime.openTab).not.toHaveBeenCalled()
      if (!unload) runtime.dispose()
    }
  })
})
