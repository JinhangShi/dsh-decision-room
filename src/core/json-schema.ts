import { z } from "zod"

/** Export the JSON document, excluding Zod's non-enumerable Standard Schema callbacks. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as Record<string, unknown>
}
