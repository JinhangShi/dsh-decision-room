import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zstdCompressSync } from "node:zlib"
import { Context } from "@deepseek-ai/cordis"
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import { describe, expect, it } from "vitest"
import { decisionHistoryChildFact, migrateDecisionHistory } from "../src/dsh/history-migration.js"
import {
  discoverHistory,
  historyRows,
  planHistoryMigration,
  publishHistoryMigration,
} from "../src/dsh/history-files.js"
import { until } from "./fixtures.js"

const header = {
  type: "session",
  version: 0,
  id: "session-legacy",
  createdAt: 1,
  cwd: "/synthetic",
  delegationDepth: 0,
}
const message = {
  type: "decision-room/message",
  seq: 1,
  time: 2,
  data: {
    id: "report-v1",
    runId: "run-1",
    version: 1,
    role: "主持",
    model: "synthetic",
    phase: "finished",
    text: "保留证据和异议的合成历史",
    at: 2,
    kind: "report",
  },
}
const progress = {
  type: "decision-room/progress",
  seq: 0,
  time: 1,
  data: {
    initial: true,
    progress: { id: "progress-v1", runId: "run-1", version: 1, revision: 2, status: "completed" },
  },
}
const rows = [header, progress, message]

describe("旧 DSH 日志迁移", () => {
  it("保留旧插件事件和载荷，完成新版物理格式校验，输入不变", () => {
    const original = structuredClone(rows)
    const result = migrateDecisionHistory(rows, [])
    expect(result.artifact.header.version).toBe(4)
    expect(result.preservedEvents).toBe(2)
    expect(result.artifact.events).toEqual([progress, message].map(event => ({ ...event, ignorable: true })))
    expect(rows).toEqual(original)
    expect(result.text).not.toContain("decision-room-migration:")
  })

  it("迁移插件自己的旧一次性角色描述符，父目录包含完整子会话身份", () => {
    const child = [
      { ...header, id: "session-child", origin: "subagent", parentSession: header.id, delegationDepth: 1 },
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: {
          version: 2,
          mode: "one-shot",
          provider: "dsh-decision-room",
          label: "合成独立首评",
        },
      },
    ]
    const fact = decisionHistoryChildFact(child)
    const parent = migrateDecisionHistory(rows, [fact])
    expect(parent.artifact.events.find(event => event.type === "subagent/catalog")?.data).toMatchObject({
      childId: "session-child",
      mode: "one-shot",
      label: "合成独立首评",
    })
    const migratedChild = migrateDecisionHistory(child, [])
    expect(migratedChild.upgradedDescriptors).toBe(1)
    expect(migratedChild.artifact.events[0]?.data).toMatchObject({ version: 3, mode: "one-shot" })
    expect(child[1]).toMatchObject({ data: { version: 2 } })
  })

  it("拒绝未知第三方事件、无效插件载荷和描述符扩展，不将它们静默忽略", () => {
    expect(() =>
      migrateDecisionHistory([...rows, { type: "foreign/event", seq: 2, time: 3, data: {}, ignorable: true }], []),
    ).toThrow(/unknown historical/)
    expect(() => migrateDecisionHistory([header, { ...progress, data: { initial: true } }], [])).toThrow()
    expect(() =>
      migrateDecisionHistory(
        [
          header,
          {
            type: "subagent/descriptor",
            seq: 0,
            time: 1,
            data: { version: 2, provider: "dsh-decision-room", mode: "one-shot", foreign: "unhandled" },
          },
        ],
        [],
      ),
    ).toThrow()
  })

  it("父目录读取旧第三方子会话身份，不改写第三方描述符或冒充已迁移其历史", () => {
    const child = [
      { ...header, id: "session-sidechat", origin: "subagent", parentSession: header.id, delegationDepth: 1 },
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: {
          version: 2,
          mode: "continuable",
          provider: "sidechat",
          label: "合成子会话",
        },
      },
    ]
    const original = structuredClone(child)
    const result = migrateDecisionHistory(rows, [decisionHistoryChildFact(child)])
    expect(result.artifact.events.find(event => event.type === "subagent/catalog")?.data).toMatchObject({
      childId: "session-sidechat",
      mode: "continuable",
      label: "合成子会话",
    })
    expect(child).toEqual(original)
    expect(() => migrateDecisionHistory(child, [])).toThrow(/Not a supported/)
    const inherited = [child[0], progress, message, { ...child[1], seq: 2 }]
    const migrated = migrateDecisionHistory(inherited, [])
    expect(migrated.artifact.events[2]).toEqual({ ...child[1], seq: 2 })
    expect(migrated.upgradedDescriptors).toBe(0)
  })

  it("压缩多帧历史生成独立后继，真实 DSH 冷读取保留消息，重跑无重复迁移", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-history-test-"))
    const root = join(directory, "sessions")
    const sessionDir = join(root, "--synthetic--", header.id)
    const ctx = new Context()
    try {
      await mkdir(sessionDir, { recursive: true })
      const original = Buffer.concat(rows.map(row => zstdCompressSync(JSON.stringify(row) + "\n")))
      const source = join(sessionDir, "session.jsonl.zstd")
      await writeFile(source, original)
      const sources = await discoverHistory(root)
      expect(historyRows(sources[0]!)).toEqual(rows)
      const plans = planHistoryMigration(sources)
      await publishHistoryMigration(plans, join(directory, "backup"))
      expect(await readFile(source)).toEqual(original)
      expect(planHistoryMigration(await discoverHistory(root))).toEqual([])
      ctx.plugin(SessionStore)
      ctx.plugin(JsonlSessionPersistence, { root, compression: "zstd" })
      await until(() => Boolean(ctx.get("sessionPersistence")))
      await using handle = await ctx.sessionPersistence.open(SessionId(header.id), "read")
      const restored = await handle.read()
      expect(restored.events.filter(event => event.type.startsWith("decision-room/"))).toEqual(
        [progress, message].map(event => ({ ...event, ignorable: true })),
      )
      expect(await readFile(join(directory, "backup", header.id, "session.jsonl.zstd"))).toEqual(original)
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("拒绝过期预览和已有目标，不覆盖源日志或竞争者的新版日志", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-history-conflict-"))
    try {
      const root = join(directory, "sessions")
      const sessionDir = join(root, "--synthetic--", header.id)
      await mkdir(sessionDir, { recursive: true })
      const source = join(sessionDir, "session.jsonl")
      const original = rows.map(row => JSON.stringify(row)).join("\n") + "\n"
      await writeFile(source, original)
      const plans = planHistoryMigration(await discoverHistory(root))
      await writeFile(source, original + "\n")
      await expect(publishHistoryMigration(plans, join(directory, "stale"))).rejects.toThrow(/source changed/)
      await writeFile(source, original)
      await writeFile(plans[0]!.target, "existing successor")
      await expect(publishHistoryMigration(plans, join(directory, "conflict"))).rejects.toThrow(/EEXIST/)
      expect(await readFile(plans[0]!.target, "utf8")).toBe("existing successor")
      expect(await readFile(source, "utf8")).toBe(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
