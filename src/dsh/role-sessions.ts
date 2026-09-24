import type { SessionHeader, SessionStore } from "@deepseek-ai/dsh-session"
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence"
import { snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent"
import type { Call, Run } from "../core/schema.js"

const phases = {
  independent: "独立评审",
  organize: "整理问题",
  discuss: "交叉讨论",
  interpret: "主持解读",
  revise: "修订方案",
  verify: "独立复核",
  finished: "已完成",
}

/** A role attempt is readable history, never a separately continuable budget owner. */
export function roleDescriptor(run: Run, call: Pick<Call, "seatId" | "phase" | "round">, sharedHistory = false) {
  const role =
    run.config.seats.find(seat => seat.id === call.seatId)?.name ??
    (call.seatId === "verifier" ? "独立复核" : "主持与编辑")
  return snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "dsh-decision-room",
    label: `V${run.version} · ${role} · ${sharedHistory ? "历史会话" : `${phases[call.phase]}${call.round ? ` · 第 ${call.round} 轮` : ""}`}`,
  })
}

type CatalogServices = {
  sessions: Pick<SessionStore, "get" | "enter" | "announce" | "flush">
  sessionPersistence: Pick<SessionPersistence, "list" | "inspect" | "prepare">
}

/** Repair only ledger-owned, idle, descriptor-less logs through the Host's exclusive session lifecycle. */
export async function repairRoleSessionCatalog(
  services: CatalogServices,
  runs: Run[],
  warn: (message: string) => void,
): Promise<{ repaired: number; skipped: number; failed: number }> {
  const result = { repaired: 0, skipped: 0, failed: 0 }
  let headers: Map<string, SessionHeader>
  try {
    headers = new Map((await services.sessionPersistence.list()).map(header => [String(header.id), header]))
  } catch {
    warn("决策室角色会话目录暂时不可读，已跳过登记修复，保留原始记录，未重发模型请求")
    return { ...result, failed: 1 }
  }
  const seen = new Set<string>()
  for (const run of runs) {
    for (const call of run.calls) {
      const id = call.contextSessionId
      const roleId = `session-dr-${run.id}-${call.seatId}`
      if (!id || seen.has(id) || (id !== roleId && !id.startsWith(`${roleId}-`))) continue
      seen.add(id)
      const owns = (header: SessionHeader) =>
        header.id === id &&
        header.origin === "subagent" &&
        header.parentSession === run.scope.sessionId &&
        header.cwd === run.scope.workspaceId
      const header = headers.get(id)
      if (!header || !owns(header) || services.sessions.get(header.id)) {
        result.skipped++
        continue
      }
      try {
        const inspected = await services.sessionPersistence.inspect(header.id)
        if (!owns(inspected.meta) || inspected.events.some(event => event.type === "subagent/descriptor")) {
          result.skipped++
          continue
        }
        // Reservation prevents a competing resume from publishing this same session.
        const preparation = await services.sessionPersistence.prepare(header.id)
        try {
          const session = preparation.session
          if (
            !owns(session.header) ||
            services.sessions.get(header.id) ||
            session.events.some(event => event.type === "subagent/descriptor")
          ) {
            result.skipped++
            continue
          }
          const detach = services.sessions.enter(session)
          try {
            services.sessions.announce(session)
            session.append("subagent/descriptor", roleDescriptor(run, call, id === roleId))
            await services.sessions.flush(session)
            result.repaired++
          } finally {
            detach()
          }
        } finally {
          preparation[Symbol.dispose]()
        }
      } catch (error) {
        result.failed++
        warn(
          `决策室角色会话 ${id} 登记补齐失败，保留原始记录，未重发模型请求：${error instanceof Error ? error.message : "未知错误"}`,
        )
      }
    }
  }
  return result
}
