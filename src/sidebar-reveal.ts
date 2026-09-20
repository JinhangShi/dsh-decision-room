import type { SidebarState, SidebarStore } from "dsh-better-sidebar/client/service"

type Target = { store: Pick<SidebarStore, "reduce">; tabId: string }

function contains(node: SidebarState["splits"], tabId: string): boolean {
  return node.kind === "leaf"
    ? node.tabs.some(tab => tab.id === tabId)
    : node.children.some(child => contains(child, tabId))
}

function reveal(state: SidebarState, tabId: string): SidebarState {
  if (state.floats.some(window => window.tab.id === tabId)) {
    return state
  }
  if (contains(state.bottomSplits, tabId)) {
    return state.bottomOpen ? state : { ...state, bottomOpen: true }
  }
  if (contains(state.splits, tabId)) {
    return state.panelOpen ? state : { ...state, panelOpen: true }
  }
  return state
}

/** Sidebar 0.17 may select a tab without expanding its panel. Reveal only on an explicit open request. */
export function createSidebarReveal() {
  const targets = new Map<string, Target>()
  const pending = new Set<string>()
  let disposed = false
  return {
    attach(sessionId: string, target: Target): () => void {
      if (disposed) {
        return () => {}
      }
      targets.set(sessionId, target)
      if (pending.delete(sessionId)) {
        target.store.reduce(state => reveal(state, target.tabId))
      }
      return () => {
        if (targets.get(sessionId) === target) {
          targets.delete(sessionId)
        }
      }
    },
    request(sessionId: string): void {
      if (disposed) {
        return
      }
      const target = targets.get(sessionId)
      if (!target) {
        pending.add(sessionId)
        return
      }
      target.store.reduce(state => reveal(state, target.tabId))
    },
    dispose(): void {
      disposed = true
      targets.clear()
      pending.clear()
    },
  }
}
