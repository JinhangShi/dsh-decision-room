import type { BetterSidebarService } from "dsh-better-sidebar/client/service"

type SidebarScope = { sessionId: string; cwd?: string }

/** Opens the progress tab once per run, including when progress arrives before Better Sidebar is ready. */
export function createSidebarAutoOpen(tabType: string, scopeFor: (sessionId: string) => SidebarScope | undefined) {
  let service: Pick<BetterSidebarService, "isTabEnabled" | "openTab"> | undefined
  let disposed = false
  const openedRuns = new Set<string>()
  const pendingRuns = new Map<string, string>()
  const open = (sessionId: string): boolean => {
    if (disposed || !service || !service.isTabEnabled(tabType)) return false
    const scope = scopeFor(sessionId)
    if (!scope) return false
    service.openTab({ type: tabType, target: "right", reveal: true }, scope)
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
