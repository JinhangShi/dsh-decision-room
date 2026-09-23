import type { Run } from "./schema.js"

/** Server names, not model-supplied company names, define the circuit-breaker scope. */
export function mcpServer(name: string): string {
  return name.split("__").slice(0, 2).join("__")
}

export function mcpFailureKind(error = ""): "authentication" | "unknown_tool" | "other" {
  if (/invalid_token|expired.token|unauthorized|\b401\b|身份凭证|凭证.*过期/i.test(error)) return "authentication"
  if (/unknown tool|tool.*not found|工具不存在/i.test(error)) return "unknown_tool"
  return "other"
}

export function mcpBlockedReason(run: Run, name: string): string | undefined {
  // An explicit user resume permits a fresh attempt after repairing the connection.
  const resumedAt = Math.max(0, ...run.events.filter(event => event.type === "resume").map(event => event.at))
  const failure = run.mcpCalls.find(
    call =>
      call.status === "failed" &&
      call.startedAt >= resumedAt &&
      ((mcpFailureKind(call.error) === "authentication" && mcpServer(call.toolName) === mcpServer(name)) ||
        (mcpFailureKind(call.error) === "unknown_tool" && call.toolName === name)),
  )
  if (!failure) return undefined
  return mcpFailureKind(failure.error) === "authentication"
    ? "该 MCP 连接器认证失败；修复连接并明确继续前不再重试，缺失证据将保留在报告中"
    : "该 MCP 工具不存在；本次评审不再重试此工具"
}

export function mcpStatus(run: Run) {
  return {
    attempts: run.mcpCalls.length,
    successfulSources: run.mcpEvidence.length,
    remainingCalls: Math.max(0, run.config.limits.maxMcpCalls - run.mcpCalls.length),
    calls: run.mcpCalls.slice(-20).map(call => ({
      toolName: call.toolName,
      round: call.round,
      seatId: call.seatId,
      status: call.status,
      failureKind: call.error ? mcpFailureKind(call.error) : undefined,
      // Do not inject arbitrary remote error text into the review prompt.
      blockedReason: mcpBlockedReason(run, call.toolName),
      evidenceId: call.evidenceId,
    })),
    instruction:
      "调用失败不等于未调用。仅使用当前请求实际提供的 MCP 工具；技能名称不是工具。缺少查询主体时列为待补信息，不猜测主体、不反复请求授权。失败或无证据不妨碍形成保留缺口的修订稿。",
  }
}
