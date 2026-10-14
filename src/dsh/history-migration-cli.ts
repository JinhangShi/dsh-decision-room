import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { discoverHistory, planHistoryMigration, publishHistoryMigration } from "./history-files.js"

process.umask(0o077)
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    session: { type: "string" },
    apply: { type: "boolean", default: false },
  },
})
const root = resolve(values.root ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions"))
try {
  if (values.apply) {
    const processes = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" })
    if (processes.error || processes.status !== 0) throw new Error("无法确认 DSH 已退出，停止迁移")
    if (
      processes.stdout
        .split("\n")
        .some(line => /(?:\/dsh(?:\/lib\/bin\.js)?|\/bin\.js)\s+(?:web\b|--profile\s+web\b)/.test(line))
    ) {
      throw new Error("请先完整退出 DSH Web，再执行 --apply；迁移期间不能有会话写入")
    }
  }
  const plans = planHistoryMigration(await discoverHistory(root), values.session)
  console.log(
    JSON.stringify({
      sessions: plans.length,
      preservedEvents: plans.reduce((n, p) => n + p.preservedEvents, 0),
      upgradedDescriptors: plans.reduce((n, p) => n + p.upgradedDescriptors, 0),
      mode: values.apply ? "apply" : "preview",
    }),
  )
  if (values.apply && plans.length) {
    const backup = join(root, "..", "backups", `decision-history-${Date.now()}`)
    await publishHistoryMigration(plans, backup)
    console.log(`已生成新版会话日志，原始日志保留。备份与校验清单：${backup}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
