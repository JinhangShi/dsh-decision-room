import { Session, SessionSeq, type SessionHeader, type SessionStore } from "@deepseek-ai/dsh-session"
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence"
import {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  type OneShotSubagentDescriptorData,
} from "@deepseek-ai/dsh-subagent"
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
  sessions: Pick<SessionStore, "get" | "flush">
  sessionPersistence: Pick<SessionPersistence, "list" | "open">
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
    headers = new Map(
      (await services.sessionPersistence.list()).map(header => [String(header.header.id), header.header]),
    )
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
        const handle = await services.sessionPersistence.open(header.id, "write")
        // Explicit finally also keeps failed iterations isolated when bundled for Node 22.
        try {
          const { events } = await handle.read()
          if (!owns(handle.header) || services.sessions.get(header.id)) {
            result.skipped++
            continue
          }
          const recorded = events.find(event => event.type === "subagent/descriptor")
          const descriptor = recorded ? foldSubagentDescriptor(events) : roleDescriptor(run, call, id === roleId)
          if (!recorded) {
            await handle.append([
              { type: "subagent/descriptor", seq: SessionSeq(events.length), time: Date.now(), data: descriptor! },
            ])
            await handle.flush()
          }
          const catalogued =
            descriptor?.mode === "one-shot" && descriptor.provider === "dsh-decision-room"
              ? await registerRoleCatalog(services, handle.header, descriptor)
              : false
          if (!recorded || catalogued) result.repaired++
          else result.skipped++
        } finally {
          await handle.close()
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

/** 0.2 lists children from the parent's durable catalog, not by scanning child headers. */
async function registerRoleCatalogNow(
  services: CatalogServices,
  child: SessionHeader,
  descriptor: OneShotSubagentDescriptorData,
): Promise<boolean> {
  const parentId = child.parentSession
  if (!parentId) throw new Error("角色会话缺少父会话")
  const append = (parent: Session): boolean => {
    if (parent.header.cwd !== child.cwd) throw new Error("角色与父会话工作空间不一致")
    if (parent.snapshotEvents().some(event => event.type === "subagent/catalog" && event.data.childId === child.id))
      return false
    parent.append("subagent/catalog", {
      version: 0,
      childId: child.id,
      childCreatedAt: child.createdAt,
      mode: "one-shot",
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    })
    return true
  }
  const live = services.sessions.get(parentId)
  if (live) {
    const added = append(live)
    // Re-flush even on a duplicate: an earlier barrier may have failed after append.
    await services.sessions.flush(live)
    return added
  }
  await using handle = await services.sessionPersistence.open(parentId, "write")
  const { events } = await handle.read()
  const parent = Session.create(parentId, events, handle.header, handle.inheritedEventCount)
  if (append(parent)) {
    await handle.append(parent.snapshotEvents().slice(events.length))
    await handle.flush()
    return true
  }
  return false
}

const catalogWrites = new WeakMap<object, Map<string, Promise<boolean>>>()
/** Serialize cold-parent writers; separate Profiles have separate SessionStore owners. */
export async function registerRoleCatalog(
  services: CatalogServices,
  child: SessionHeader,
  descriptor: OneShotSubagentDescriptorData,
): Promise<boolean> {
  const key = child.parentSession ?? ""
  let pending = catalogWrites.get(services.sessions)
  if (!pending) {
    pending = new Map()
    catalogWrites.set(services.sessions, pending)
  }
  const task = (pending.get(key) ?? Promise.resolve(false))
    .catch(() => false)
    .then(() => registerRoleCatalogNow(services, child, descriptor))
  pending.set(key, task)
  try {
    return await task
  } finally {
    if (pending.get(key) === task) pending.delete(key)
  }
}
