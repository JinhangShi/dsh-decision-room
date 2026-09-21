/**
 * Explicit response-name compatibility for the existing gateway.
 * A response identifier is a gateway declaration, not proof of upstream identity.
 * Keep request IDs unchanged: a returned snapshot name may not be a callable route.
 */
const RESPONSE_MODEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // Also recognized by mcp_web/apps/web/lib/online-experience-models.ts.
  "deepseek-v4.1-flash": ["deepseek-v4-1-flash-260910"],
}

export function acceptsReturnedModel(requested: string, returned: string): boolean {
  return returned === requested || RESPONSE_MODEL_ALIASES[requested]?.includes(returned) === true
}
