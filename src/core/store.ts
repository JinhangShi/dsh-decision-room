import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DecisionError, runSchema, type Run } from "./schema.js"

export interface Persistence {
  load(): Promise<Run[]>
  save(run: Run): Promise<void>
}
export class MemoryPersistence implements Persistence {
  records = new Map<string, Run>()
  async load(): Promise<Run[]> {
    return structuredClone([...this.records.values()])
  }
  async save(run: Run): Promise<void> {
    this.records.set(run.id, structuredClone(run))
  }
}
export type StorageDomain = {
  open(spec: object): Promise<{
    table(name: string): {
      entries(): Iterable<[string, unknown]>
      put(key: string, value: unknown): unknown | Promise<unknown>
    }
  }>
}
export async function domainPersistence(domain: StorageDomain): Promise<Persistence> {
  const access = await domain.open({
    name: "decision_room_v1",
    version: 1,
    tables: { runs: { valueSchema: runSchema } },
  })
  const table = access.table("runs")
  return {
    async load() {
      return [...table.entries()].map(([, value]) => runSchema.parse(value))
    },
    async save(run) {
      await table.put(run.id, runSchema.parse(run))
    },
  }
}
export class FilePersistence implements Persistence {
  private records = new Map<string, Run>()
  private tail: Promise<void> = Promise.resolve()
  constructor(private directory: string) {}
  async load(): Promise<Run[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const content: unknown = JSON.parse(await readFile(join(this.directory, "runs.json"), "utf8"))
      if (!Array.isArray(content)) {
        throw new Error("invalid storage")
      }
      const runs = content.map(item => runSchema.parse(item))
      this.records = new Map(runs.map(run => [run.id, run]))
      return structuredClone(runs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return []
      }
      throw new DecisionError("STORAGE", "任务存储损坏或版本不兼容；已停止启动，请先备份并检查 runs.json", 500)
    }
  }
  async save(run: Run): Promise<void> {
    const operation = this.tail.then(async () => {
      const candidate = new Map(this.records)
      candidate.set(run.id, structuredClone(run))
      const temporary = join(this.directory, `runs-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify([...candidate.values()]), { mode: 0o600 })
      await rename(temporary, join(this.directory, "runs.json"))
      this.records = candidate
    })
    this.tail = operation.catch(() => {})
    await operation
  }
}

/** Serializes a complete durable update before exposing it to another caller. */
export class RunStore {
  private listeners = new Set<(run: Run) => void>()
  private records = new Map<string, Run>()
  private tails = new Map<string, Promise<unknown>>()
  constructor(private persistence: Persistence) {}
  subscribe(listener: (run: Run) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private notify(run: Run): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(run))
      } catch {
        /* Presentation cannot roll back durable business state. */
      }
    }
  }
  async initialize(): Promise<void> {
    for (const record of await this.persistence.load()) {
      this.records.set(record.id, runSchema.parse(record))
    }
  }
  list(): Run[] {
    return structuredClone([...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt))
  }
  get(id: string): Run {
    const run = this.records.get(id)
    if (!run) {
      throw new DecisionError("NOT_FOUND", "决策任务不存在", 404)
    }
    return structuredClone(run)
  }
  async insert(run: Run): Promise<Run> {
    return this.lock(run.id, async () => {
      if (this.records.has(run.id)) {
        throw new DecisionError("DUPLICATE", "任务已存在", 409)
      }
      const record = runSchema.parse(run)
      await this.persistence.save(record)
      this.records.set(record.id, record)
      this.notify(record)
      return structuredClone(record)
    })
  }
  async update(
    id: string,
    change: (run: Run) => void,
    expectedRevision?: number,
    options: { preserveUpdatedAt?: boolean } = {},
  ): Promise<Run> {
    return this.lock(id, async () => {
      const draft = this.get(id)
      if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
        throw new DecisionError("CONFLICT", "任务已更新，请刷新后再操作", 409)
      }
      change(draft)
      draft.revision += 1
      if (!options.preserveUpdatedAt) draft.updatedAt = Date.now()
      const valid = runSchema.parse(draft)
      await this.persistence.save(valid)
      this.records.set(id, valid)
      this.notify(valid)
      return structuredClone(valid)
    })
  }
  private async lock<T>(id: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(execute)
    this.tails.set(id, next)
    try {
      return await next
    } finally {
      if (this.tails.get(id) === next) {
        this.tails.delete(id)
      }
    }
  }
}
