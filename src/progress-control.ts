import type { Scope } from "./core/schema.js"
import { Api } from "./ui/api.js"

export type ProgressControl = (runId: string, revision: number, action: "pause" | "cancel") => Promise<void>

/** Bind controls to the card's session, without reading or submitting its composer. */
export function createProgressControl(scope: () => Scope): ProgressControl {
  return async (runId, revision, action) => {
    const api = new Api(scope())
    await api.bootstrap()
    await api.request(`/runs/${encodeURIComponent(runId)}/control`, "POST", { scope: api.scope, revision, action })
  }
}
