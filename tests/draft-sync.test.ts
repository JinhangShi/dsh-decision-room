import { describe, expect, it, vi } from "vitest"
import { createDraftSync, draftCacheKeys, editableDecisionSession } from "../src/draft-sync.js"

function fixture(draft = "旧草稿") {
  const scope = { workspaceId: "/workspace", sessionId: "session-a" }
  const keys = draftCacheKeys(scope)
  const other = draftCacheKeys({ ...scope, sessionId: "session-b" })
  const values = new Map([
    [keys.generated, "旧草稿"],
    [keys.setup, "旧表单"],
    [other.setup, "另一会话"],
  ])
  const listeners = new Set<() => void>()
  let phase = "plain"
  let session = { blank: true, running: false, pendingSubmissions: [] as unknown[], awaitingFirstTurn: false }
  const setDraft = vi.fn((text: string) => {
    draft = text
    listeners.forEach(listener => listener())
  })
  const resetFrame = vi.fn()
  const options = {
    input: {
      state: {
        getSnapshot: () => ({ draft, phase }),
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      },
      setDraft,
    },
    scope,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    },
    editable: () => editableDecisionSession(session),
    resetFrame,
  }
  return {
    options,
    values,
    keys,
    other,
    setDraft,
    resetFrame,
    listeners,
    draft: () => draft,
    phase: (value: string) => {
      phase = value
    },
    session: (value: Partial<typeof session>) => {
      session = { ...session, ...value }
    },
  }
}

describe("主聊天清空与右侧表单缓存", () => {
  it("手动清空只重置本会话缓存，并拒绝旧 iframe 的延迟回填", () => {
    const f = fixture(),
      sync = createDraftSync(f.options)
    f.setDraft("")
    expect(f.resetFrame).toHaveBeenCalledOnce()
    expect(f.values.has(f.keys.setup)).toBe(false)
    expect(f.values.has(f.keys.generated)).toBe(false)
    expect(f.values.get(f.other.setup)).toBe("另一会话")
    expect(sync.compose("延迟旧内容")).toBe(false)
    expect(f.draft()).toBe("")
    sync.frameReady()
    expect(sync.compose("新的材料")).toBe(true)
    expect(f.draft()).toBe("新的材料")
    sync.dispose()
    expect(f.listeners.size).toBe(0)
  })

  it("侧栏关闭期间清空，重开时丢弃缓存；正常重开保留草稿", () => {
    for (const draft of ["", "旧草稿"]) {
      const f = fixture(draft),
        sync = createDraftSync(f.options)
      expect(sync.reconcile()).toBe(draft === "")
      expect(f.values.has(f.keys.setup)).toBe(draft !== "")
      expect(sync.compose("旧草稿")).toBe(draft !== "")
      expect(f.draft()).toBe(draft)
      sync.dispose()
    }
  })

  it("保留人工修改，表单自己的清空不会触发重复重置", () => {
    const f = fixture(),
      sync = createDraftSync(f.options)
    f.setDraft("手工补充")
    expect(() => sync.compose("表单更新")).toThrow("没有覆盖")
    expect(f.values.get(f.keys.setup)).toBe("旧表单")
    f.setDraft("旧草稿")
    expect(sync.compose("")).toBe(true)
    expect(f.resetFrame).not.toHaveBeenCalled()
    sync.dispose()
  })

  it("普通消息发送保持 plain 时，不把待提交回显清空当成人工删除", () => {
    const f = fixture(),
      sync = createDraftSync(f.options)
    f.session({ pendingSubmissions: [{}] })
    f.setDraft("")
    expect(f.resetFrame).not.toHaveBeenCalled()
    expect(() => sync.compose("旧草稿")).toThrow("正在提交")
    f.session({ pendingSubmissions: [], awaitingFirstTurn: true })
    expect(sync.reconcile()).toBe(false)
    f.session({ blank: false, awaitingFirstTurn: false })
    expect(sync.reconcile()).toBe(false)
    expect(f.values.get(f.keys.setup)).toBe("旧表单")
    sync.dispose()
  })

  it.each(["submitting", "adjudicating", "claimed"])("%s 期间保留材料，失败后恢复的草稿不重置", phase => {
    const f = fixture(),
      sync = createDraftSync(f.options)
    f.phase(phase)
    f.setDraft("")
    expect(sync.reconcile()).toBe(false)
    f.setDraft("旧草稿")
    f.phase("plain")
    expect(sync.reconcile()).toBe(false)
    expect(f.resetFrame).not.toHaveBeenCalled()
    sync.dispose()
  })
})
