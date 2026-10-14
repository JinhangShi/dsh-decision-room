import type {} from "@deepseek-ai/dsh-llm"

/** DSH 0.2 requires each context producer to own its source kind. */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "dsh-decision-room": { kind: "dsh-decision-room" }
  }
}
