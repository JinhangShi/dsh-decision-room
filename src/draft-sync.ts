import { fillDecisionDraft, type ComposerInput } from "./composer.js"
import type { Scope } from "./core/schema.js"

export function draftCacheKeys(scope: Scope): { generated: string; setup: string } {
  const suffix = JSON.stringify([scope.workspaceId, scope.sessionId])
  return { generated: `decision-room:generated:${suffix}`, setup: `decision-room:setup:${suffix}` }
}

export function editableDecisionSession(
  state:
    | {
        blank: boolean
        running: boolean
        pendingSubmissions: readonly unknown[]
        awaitingFirstTurn: boolean
      }
    | undefined,
): boolean {
  return !!state?.blank && !state.running && !state.pendingSubmissions.length && !state.awaitingFirstTurn
}

/** A cleared native draft invalidates its cached form, including messages from the old frame. */
export function createDraftSync(options: {
  input: ComposerInput
  scope: Scope
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  editable(): boolean
  resetFrame(): void
}) {
  const { input, storage } = options
  const keys = draftCacheKeys(options.scope)
  let generated = ""
  let writing = false
  let invalidated = false
  try {
    generated = storage.getItem(keys.generated) ?? ""
  } catch {
    /* Storage is optional. */
  }
  const reconcile = () => {
    const state = input.state.getSnapshot()
    if (writing || invalidated || !options.editable() || (state.phase && state.phase !== "plain")) return false
    if (!generated.trim() || state.draft.trim()) return false
    generated = ""
    invalidated = true
    for (const key of Object.values(keys)) {
      try {
        storage.removeItem(key)
      } catch {
        /* The mounted form is still reset. */
      }
    }
    options.resetFrame()
    return true
  }
  const unsubscribe = input.state.subscribe?.(reconcile)
  return {
    reconcile,
    frameReady() {
      invalidated = false
      reconcile()
    },
    compose(text: string): boolean {
      if (invalidated || reconcile()) return false
      if (!options.editable()) throw new Error("材料正在提交或已经发送，请在主聊天继续操作")
      writing = true
      try {
        fillDecisionDraft(input, text, generated)
        generated = text
        try {
          storage.setItem(keys.generated, generated)
        } catch {
          /* Storage is optional. */
        }
      } finally {
        writing = false
      }
      return true
    },
    dispose() {
      unsubscribe?.()
    },
  }
}
