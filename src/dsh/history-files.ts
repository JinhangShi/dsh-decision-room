import { createHash, randomUUID } from "node:crypto"
import { copyFile, link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { decisionHistoryChildFact, migrateDecisionHistory, needsDecisionHistoryMigration } from "./history-migration.js"

const headerSchema = z
  .object({
    type: z.literal("session"),
    version: z.number().int().nonnegative(),
    id: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    cwd: z.string().optional(),
    parentSession: z.string().optional(),
    origin: z.string().optional(),
  })
  .passthrough()
export type HistorySource = {
  path: string
  bytes: Buffer
  sha256: string
  header: z.infer<typeof headerSchema>
}
export type HistoryPlan = {
  source: HistorySource
  dependencies: HistorySource[]
  target: string
  bytes: Buffer
  eventCount: number
  preservedEvents: number
  upgradedDescriptors: number
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** Node's sync decoder stops after one frame; DSH appends multiple complete frames. */
export function decodeHistoryBytes(bytes: Buffer, compressed: boolean): string {
  if (!compressed) return bytes.toString("utf8")
  const parts: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    // @types/node does not express the documented info=true result overload.
    const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer
      engine: { bytesWritten: number }
    }
    if (!Number.isSafeInteger(decoded.engine.bytesWritten) || decoded.engine.bytesWritten <= 0) {
      throw new Error("Zstandard decoder made no progress")
    }
    offset += decoded.engine.bytesWritten
    parts.push(decoded.buffer)
  }
  return Buffer.concat(parts).toString("utf8")
}
export function historyRows(source: HistorySource): unknown[] {
  const text = decodeHistoryBytes(source.bytes, source.path.endsWith(".zstd"))
  if (!text.endsWith("\n")) throw new Error(`Incomplete JSONL tail: ${source.path}`)
  return text
    .slice(0, -1)
    .split("\n")
    .map(line => JSON.parse(line) as unknown)
}

/** Select the highest immutable generation; never follow a directory symlink. */
export async function discoverHistory(root: string): Promise<HistorySource[]> {
  const result: HistorySource[] = []
  const ids = new Set<string>()
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const directory = join(projectPath, session.name)
      const generations = (await readdir(directory, { withFileTypes: true }))
        .flatMap(file => {
          const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(file.name)
          return file.isFile() && match ? [{ name: file.name, version: Number(match[1] ?? 0) }] : []
        })
        .sort((a, b) => b.version - a.version)
      const selected = generations[0]
      if (!selected) continue
      if (generations[1]?.version === selected.version) throw new Error(`Ambiguous session encoding: ${directory}`)
      const path = join(directory, selected.name)
      const bytes = await readFile(path)
      const first = path.endsWith(".zstd") ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8")
      const header = headerSchema.parse(JSON.parse(first.split("\n")[0]!))
      if (header.id !== session.name || header.version !== selected.version || ids.has(header.id)) {
        throw new Error(`Session identity or generation mismatch: ${path}`)
      }
      ids.add(header.id)
      result.push({ path, bytes, sha256: digest(bytes), header })
    }
  }
  return result
}

export function planHistoryMigration(sources: HistorySource[], sessionId?: string): HistoryPlan[] {
  const plans: HistoryPlan[] = []
  for (const source of sources) {
    if (
      source.header.version !== 0 ||
      (sessionId && source.header.id !== sessionId && source.header.parentSession !== sessionId)
    )
      continue
    const rows = historyRows(source)
    if (!needsDecisionHistoryMigration(rows)) continue
    const dependencies = sources.filter(
      child => child.header.parentSession === source.header.id && child.header.origin === "subagent",
    )
    for (const child of dependencies) {
      if (child.header.cwd !== source.header.cwd) throw new Error(`Child workspace mismatch: ${child.path}`)
    }
    const facts = dependencies.map(child => decisionHistoryChildFact(historyRows(child)))
    const converted = migrateDecisionHistory(rows, facts)
    const compressed = source.path.endsWith(".zstd")
    const headerEnd = converted.text.indexOf("\n") + 1
    plans.push({
      source,
      dependencies,
      target: join(
        dirname(source.path),
        `session.v${converted.artifact.header.version}.jsonl${compressed ? ".zstd" : ""}`,
      ),
      bytes: compressed
        ? Buffer.concat([
            zstdCompressSync(converted.text.slice(0, headerEnd)),
            zstdCompressSync(converted.text.slice(headerEnd)),
          ])
        : Buffer.from(converted.text),
      eventCount: converted.artifact.events.length,
      preservedEvents: converted.preservedEvents,
      upgradedDescriptors: converted.upgradedDescriptors,
    })
  }
  return plans
}

async function assertUnchanged(source: HistorySource): Promise<void> {
  if (digest(await readFile(source.path)) !== source.sha256)
    throw new Error(`Historical source changed: ${source.path}`)
}

/** Caller must stop DSH first. Backup and validate all inputs before publishing any successor. */
export async function publishHistoryMigration(plans: HistoryPlan[], backup: string): Promise<void> {
  await mkdir(backup, { recursive: false, mode: 0o700 })
  const inputs = [...new Map(plans.flatMap(plan => [plan.source, ...plan.dependencies]).map(s => [s.path, s])).values()]
  for (const source of inputs) {
    await assertUnchanged(source)
    const directory = join(backup, source.header.id)
    await mkdir(directory, { mode: 0o700 })
    await copyFile(source.path, join(directory, basename(source.path)))
  }
  const manifest = await open(join(backup, "migration.json"), "wx", 0o600)
  try {
    await manifest.writeFile(
      JSON.stringify(
        {
          inputs: inputs.map(source => ({ path: source.path, sha256: source.sha256 })),
          outputs: plans.map(plan => ({
            path: plan.target,
            sha256: digest(plan.bytes),
            eventCount: plan.eventCount,
            preservedEvents: plan.preservedEvents,
            upgradedDescriptors: plan.upgradedDescriptors,
          })),
        },
        null,
        2,
      ) + "\n",
    )
    await manifest.sync()
  } finally {
    await manifest.close()
  }
  for (const source of inputs) await assertUnchanged(source)
  for (const plan of plans) {
    if (resolve(plan.target) === resolve(plan.source.path)) throw new Error("Refusing to replace historical source")
    const staged = join(dirname(plan.target), `.decision-room-migration-${randomUUID()}.tmp`)
    const file = await open(staged, "wx", 0o600)
    try {
      await file.writeFile(plan.bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await assertUnchanged(plan.source)
      // Exclusive publication: an existing current generation is never replaced.
      await link(staged, plan.target)
      const directory = await open(dirname(plan.target), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await unlink(staged)
    }
  }
}
