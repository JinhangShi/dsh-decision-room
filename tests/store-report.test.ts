import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { DecisionEngine } from "../src/core/engine.js"
import { DemoGateway } from "../src/core/demo-gateway.js"
import { DEFAULT_MODELS } from "../src/core/models.js"
import { formatChinaTime, reportHtml } from "../src/core/report.js"
import { FilePersistence, MemoryPersistence, RunStore } from "../src/core/store.js"
import { complete, input, setup } from "./fixtures.js"

describe("持久存储与导出", () => {
  it("报告时间使用明确的北京时间偏移，不受运行机器时区影响", () => {
    expect(formatChinaTime(Date.parse("2026-09-20T09:32:33.986Z"))).toBe("2026-09-20T17:32:33.986+08:00")
  })
  it("并发修改不丢更新，并在新实例中恢复全部记录", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-store-test-"))
    const store = new RunStore(new FilePersistence(directory))
    const engine = new DecisionEngine(store, DEFAULT_MODELS, new DemoGateway(0), "demo")
    await engine.initialize()
    const run = await engine.create(input())
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update(run.id, draft => {
          draft.events.push({ id: `event-${index}`, at: Date.now(), type: "test", text: String(index) })
        }),
      ),
    )
    const restored = new RunStore(new FilePersistence(directory))
    await restored.initialize()
    expect(restored.get(run.id).events).toHaveLength(11)
    expect(restored.get(run.id).revision).toBe(10)
    expect(JSON.parse(await readFile(join(directory, "runs.json"), "utf8"))).toHaveLength(1)
  })
  it("损坏存储不会静默清空并重建", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-bad-store-"))
    await writeFile(join(directory, "runs.json"), "{broken")
    await expect(new FilePersistence(directory).load()).rejects.toThrow("存储损坏")
    expect(await readFile(join(directory, "runs.json"), "utf8")).toBe("{broken")
  })
  it("预留额度无法持久化时，绝不调用上游", async () => {
    let dispatched = 0
    const persistence = new MemoryPersistence()
    const save = persistence.save.bind(persistence)
    persistence.save = async run => {
      if (run.calls.length) {
        throw new Error("disk full")
      }
      await save(run)
    }
    const { engine } = await setup(
      {
        async generate() {
          dispatched += 1
          return { text: "{}" }
        },
      },
      persistence,
    )
    const run = await complete(engine)
    expect(dispatched).toBe(0)
    expect(run.status).toBe("paused")
    expect(run.calls).toHaveLength(0)
  })
  it("HTML 导出只呈现文本，不执行用户和模型注入的脚本", async () => {
    const { engine } = await setup()
    const run = await complete(engine)
    run.brief.title = '<img src=x onerror="alert(1)">'
    run.revisionResult!.fullPlan = '<script>alert("test")</script>'
    const html = reportHtml(run, DEFAULT_MODELS)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("default-src 'none'")
  })
})
