import type { BetterSidebarService, SidebarState, SidebarStore } from "dsh-better-sidebar/client/service"

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

type SidebarScope = { sessionId: string; cwd?: string }

/** Opens the progress tab once per run, including when progress arrives before Better Sidebar is ready. */
export function createSidebarAutoOpen(
  tabType: string,
  scopeFor: (sessionId: string) => SidebarScope | undefined,
  requestReveal: (sessionId: string) => void,
) {
  let service: Pick<BetterSidebarService, "isTabEnabled" | "openTab"> | undefined
  let disposed = false
  const openedRuns = new Set<string>()
  const pendingRuns = new Map<string, string>()
  const open = (sessionId: string): boolean => {
    if (disposed || !service || !service.isTabEnabled(tabType)) return false
    const scope = scopeFor(sessionId)
    if (!scope) return false
    service.openTab({ type: tabType }, scope)
    requestReveal(sessionId)
    return true
  }
  const request = (sessionId: string, runId: string): void => {
    if (disposed || openedRuns.has(runId)) return
    if (!service) {
      pendingRuns.set(runId, sessionId)
      return
    }
    if (!open(sessionId)) return
    openedRuns.add(runId)
    pendingRuns.delete(runId)
  }
  return {
    attach(next: Pick<BetterSidebarService, "isTabEnabled" | "openTab">): () => void {
      if (disposed) return () => {}
      service = next
      for (const [runId, sessionId] of pendingRuns) request(sessionId, runId)
      return () => {
        if (service === next) service = undefined
      }
    },
    open,
    request,
    dispose(): void {
      disposed = true
      service = undefined
      openedRuns.clear()
      pendingRuns.clear()
    },
  }
}
