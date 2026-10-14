import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  createSessionFormatCatalogWithChildren,
  historicalSessionFormatCatalog,
} from "@deepseek-ai/dsh-session-format-catalog"
import type {
  SessionFormatArtifact,
  SessionFormatCatalog,
  SessionFormatEvent,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from "@deepseek-ai/dsh-session-format"
import { SessionFormatEventCollector } from "@deepseek-ai/dsh-session-format"
import { releasedV0SessionFormatCodec } from "@deepseek-ai/dsh-session-format-v0-to-v1"
import { historicalChildCatalogSource } from "@deepseek-ai/dsh-session-format-v3-to-v4"

const record = z.record(z.string(), z.unknown())
const envelope = z
  .object({
    type: z.enum(["decision-room/message", "decision-room/progress"]),
    seq: z.number().int().nonnegative(),
    time: z.number().int().nonnegative(),
    data: record,
    ignorable: z.literal(true).optional(),
  })
  .strict()
const message = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    version: z.number().int().positive(),
    role: z.string(),
    model: z.string(),
    phase: z.string(),
    text: z.string(),
    at: z.number(),
    kind: z.enum(["brief", "review", "ballot", "report", "notice"]),
  })
  .passthrough()
const progress = z
  .object({
    initial: z.boolean(),
    progress: z
      .object({
        id: z.string().min(1),
        runId: z.string().min(1),
        version: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        status: z.enum(["draft", "running", "paused", "completed", "cancelled", "failed"]),
      })
      .passthrough(),
  })
  .passthrough()
const oldDescriptor = z
  .object({
    version: z.literal(2),
    mode: z.literal("one-shot"),
    provider: z.literal("dsh-decision-room"),
    label: z.string().optional(),
  })
  .strict()
const historicalForeignDescriptor = z
  .object({
    version: z.literal(2),
    mode: z.literal("continuable"),
    provider: z.string(),
    label: z.string(),
    agentProvider: z.string().optional(),
    agentModel: z.string().optional(),
  })
  .strict()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function needsDecisionHistoryMigration(rows: readonly unknown[]): boolean {
  const header = rows[0]
  return (
    isRecord(header) &&
    header.version === 0 &&
    rows
      .slice(1)
      .some(
        row =>
          isRecord(row) &&
          (row.type === "decision-room/message" ||
            row.type === "decision-room/progress" ||
            (row.type === "subagent/descriptor" &&
              isRecord(row.data) &&
              row.data.version === 2 &&
              row.data.provider === "dsh-decision-room")),
      )
  )
}

/**
 * This plugin's display events are carried across the frozen upstream vocabulary.
 * A recognized scalar-only foreign v2 descriptor is preserved as historical data, never upgraded.
 * Temporary log-only markers retain their positions while upstream rewrites sequence references.
 * No marker is persisted: exact owner payloads are restored before current-format validation.
 * Unknown foreign events still fail the upstream migration. Original artifacts are never edited.
 */
function restoreOwnedHistory(
  rows: readonly unknown[],
  catalog: SessionFormatCatalog,
): {
  artifact: SessionFormatArtifact
  preservedEvents: number
  upgradedDescriptors: number
} {
  const owned = new Map<string, SessionFormatEvent>()
  const nonce = randomUUID()
  let upgradedDescriptors = 0
  const restore = catalog.createRestore(rows[0], { recovery: "strict", validation: "current" })
  for (const value of rows.slice(1)) {
    let row = value
    if (isRecord(row) && (row.type === "decision-room/message" || row.type === "decision-room/progress")) {
      const event = envelope.parse(row)
      if (event.type === "decision-room/message") message.parse(event.data)
      else progress.parse(event.data)
      const key = `decision-room-migration:${nonce}:${event.seq}`
      if (owned.has(key)) throw new Error("Duplicate decision event sequence")
      owned.set(key, structuredClone(row) as SessionFormatEvent)
      row = { type: "feedback/record", seq: event.seq, time: event.time, data: { text: key } }
    } else if (
      isRecord(row) &&
      row.type === "subagent/descriptor" &&
      isRecord(row.data) &&
      row.data.provider === "dsh-decision-room" &&
      row.data.version === 2
    ) {
      // The plugin's released one-shot v2 shape has the same fields and meaning in v3.
      oldDescriptor.parse(row.data)
      row = { ...row, data: { ...row.data, version: 3 } }
      upgradedDescriptors++
    } else if (isRecord(row) && row.type === "subagent/descriptor" && isRecord(row.data) && row.data.version === 2) {
      const event = envelope.extend({ type: z.literal("subagent/descriptor") }).parse(row)
      historicalForeignDescriptor.parse(event.data)
      const key = `decision-room-migration:${nonce}:${event.seq}`
      if (owned.has(key)) throw new Error("Duplicate historical descriptor sequence")
      owned.set(key, structuredClone(row) as SessionFormatEvent)
      row = { type: "feedback/record", seq: event.seq, time: event.time, data: { text: key } }
    }
    restore.decodeRow(row)
  }
  const migrated = restore.finish()
  const consumed = new Set<string>()
  const events = migrated.events.map(event => {
    const text = isRecord(event.data) ? event.data.text : undefined
    const original = event.type === "feedback/record" && typeof text === "string" ? owned.get(text) : undefined
    if (!original || typeof text !== "string") return event
    if (consumed.has(text)) throw new Error("Migration duplicated an owned event")
    consumed.add(text)
    return { ...original, seq: event.seq, ...(original.type.startsWith("decision-room/") ? { ignorable: true } : {}) }
  })
  if (consumed.size !== owned.size) throw new Error("Migration lost an owned event")
  return {
    artifact: { ...migrated, events },
    preservedEvents: [...owned.values()].filter(event => event.type.startsWith("decision-room/")).length,
    upgradedDescriptors,
  }
}

/** Collect a child's own descriptor with the official historical decoder and inherited cut. */
export function decisionHistoryChildFact(rows: readonly unknown[]): SessionFormatJsonObject {
  const version = isRecord(rows[0]) ? rows[0].version : undefined
  if (version === 0) {
    // Catalog discovery needs only the child's identity, own descriptor and inherited cut.
    // Decode the released physical layout without trying to upgrade unrelated child providers.
    const decoder = releasedV0SessionFormatCodec.createDecoder(rows[0], "strict")
    const context = new SessionFormatEventCollector()
    for (const row of rows.slice(1)) decoder.decodeRow(row, context)
    const inheritedEventCount = decoder.finish(context)
    return historicalChildCatalogSource({ header: decoder.header, events: context.values, inheritedEventCount })
  }
  const catalog = version === 4 ? createSessionFormatCatalogWithChildren([]) : historicalSessionFormatCatalog
  const { artifact } = restoreOwnedHistory(rows, catalog)
  if (artifact.header.origin !== "subagent" || !artifact.header.parentSession) {
    throw new Error("Catalog source is not a direct subagent child")
  }
  const descriptors = artifact.events.filter(
    event => event.type === "subagent/descriptor" && event.seq >= artifact.inheritedEventCount,
  )
  return {
    childId: artifact.header.id,
    childCreatedAt: artifact.header.createdAt,
    descriptorCount: descriptors.length,
    descriptor: descriptors[0]?.data ?? null,
  }
}

export function migrateDecisionHistory(
  rows: readonly unknown[],
  children: readonly SessionFormatJsonValue[],
): { artifact: SessionFormatArtifact; text: string; preservedEvents: number; upgradedDescriptors: number } {
  if (!needsDecisionHistoryMigration(rows)) throw new Error("Not a supported legacy decision-room artifact")
  const catalog = createSessionFormatCatalogWithChildren(children)
  const result = restoreOwnedHistory(rows, catalog)
  const output = [
    catalog.encodeCurrentHeader(result.artifact.header, result.artifact.inheritedEventCount),
    ...result.artifact.events.map(event => catalog.encodeCurrentEvent(event)),
  ]
  // Re-read the actual current physical representation. Ignorable owner events remain intact.
  const check = catalog.createRestore(output[0], { recovery: "strict", validation: "current" })
  output.slice(1).forEach(row => check.decodeRow(row))
  const artifact = check.finish()
  if (JSON.stringify(artifact.events) !== JSON.stringify(result.artifact.events)) {
    throw new Error("Current-format validation changed migrated events")
  }
  return { ...result, artifact, text: output.map(row => JSON.stringify(row)).join("\n") + "\n" }
}
