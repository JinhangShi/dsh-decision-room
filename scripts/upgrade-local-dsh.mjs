import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Explicit local upgrade; requires write access to the CLI installation and DSH Home.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const prefix = resolve(process.env.DSH_UPGRADE_PREFIX ?? join(homedir(), ".local"))
const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"))
const profile = join(dshHome, "profiles", "web")
const manifestPath = join(profile, "package.json")
const launcher = join(prefix, "bin", "dsh")
const archive = join(repository, "dist", "dsh-decision-room-0.10.2.tgz")
const disabled = ["dsh-pre-duediligence", "qcc-dsh-mcp-oauth"]
const target = "0.2.0-rc.2"
const env = { ...process.env, DSH_HOME: dshHome }
const quote = text => `'${text.replaceAll("'", "'\\''")}'`
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, { env, stdio: capture ? "pipe" : "inherit", encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status ?? result.signal}）`)
  return result.stdout?.trim()
}
let backup
try {
  process.umask(0o077)
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error("Web Profile 缺少 bundles 配置，停止升级")
  const previous = run(launcher, ["--version"], true)
  const packaged = JSON.parse(run("tar", ["-xOf", archive, "package/package.json"], true))
  if (packaged.name !== "dsh-decision-room" || packaged.version !== "0.10.2" || packaged.engines?.dsh !== target) {
    throw new Error("本地安装包与目标版本不一致，请重新构建并打包")
  }
  console.log(`DSH ${previous} → ${target}；Better Sidebar → 0.26.0；MCP Connector → 0.2.70；决策室 → 0.10.2`)
  console.log(`安装目录：${prefix}\nProfile：${profile}\n停用但保留安装和数据：${disabled.join("、")}`)
  if (process.argv.includes("--plan")) process.exit(0)
  if (process.argv.slice(2).length) throw new Error("只支持可选参数 --plan")
  const listener = spawnSync("lsof", ["-nP", "-iTCP:3080", "-sTCP:LISTEN"], { encoding: "utf8" })
  if (listener.error) throw listener.error
  if (listener.status === 0) throw new Error("3080 端口仍在监听。请先完整退出 DSH Web，再执行升级")
  // Refuse non-default-port Web processes too; never stop an active review automatically.
  const processes = run("ps", ["-axo", "command="], true).split("\n")
  if (processes.some(line => /(?:\/dsh(?:\/lib\/bin\.js)?|\/bin\.js)\s+(?:web\b|--profile\s+web\b)/.test(line))) {
    throw new Error("检测到 DSH Web 进程，请先完整退出后再升级")
  }
  run("pnpm", ["--version"], true)
  await mkdir(join(dshHome, "backups"), { recursive: true, mode: 0o700 })
  backup = await mkdtemp(join(dshHome, "backups", "upgrade-0.2.0-rc.2-"))
  await chmod(backup, 0o700)
  const snapshot = join(backup, "dsh-home.tgz")
  console.log(`备份配置、插件、凭据及会话到私有目录：${backup}`)
  run("tar", ["--exclude=./backups", "--exclude=./logs", "-czf", snapshot, "-C", dshHome, "."])
  await writeFile(
    join(backup, "RESTORE.txt"),
    [
      "恢复前完整退出 DSH。恢复会覆盖备份中同名的配置和记录；升级后新产生的记录请先另行保存。",
      `npm install --global --prefix ${quote(prefix)} ${quote(`@deepseek-ai/dsh@${previous}`)}`,
      `tar -xzf ${quote(snapshot)} -C ${quote(dshHome)}`,
      `DSH_HOME=${quote(dshHome)} ${quote(launcher)} --version`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  )
  // A unique archive path avoids reusing cached contents when rebuilding the same local version.
  const installArchive = join(backup, "dsh-decision-room-0.10.2.tgz")
  await copyFile(archive, installArchive)
  run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", `@deepseek-ai/dsh@${target}`])
  if (run(launcher, ["--version"], true) !== target) throw new Error("安装后的 DSH 版本不符合预期")
  const disableBundles = async () => {
    const current = JSON.parse(await readFile(manifestPath, "utf8"))
    current.dsh.profile.bundles = current.dsh.profile.bundles.filter(name => !disabled.includes(name))
    const temporary = `${manifestPath}.decision-room-upgrade-${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, manifestPath)
  }
  await disableBundles()
  if (manifest.dependencies?.["dsh-decision-room"]) {
    run(launcher, ["plugin", "--profile", "web", "remove", "dsh-decision-room"])
  }
  run(launcher, [
    "plugin",
    "--profile",
    "web",
    "add",
    "dsh-better-sidebar@0.26.0",
    "dsh-mcp-connector@0.2.70",
    installArchive,
  ])
  await disableBundles()
  for (const [name, version] of [
    ["dsh-better-sidebar", "0.26.0"],
    ["dsh-mcp-connector", "0.2.70"],
    ["dsh-decision-room", "0.10.2"],
  ]) {
    const installed = JSON.parse(await readFile(join(profile, "node_modules", name, "package.json"), "utf8"))
    if (installed.version !== version) throw new Error(`${name} 安装后的版本不符合预期`)
  }
  for (const entry of ["lib/client.js", "lib/index.js"]) {
    const expected = run("tar", ["-xOf", installArchive, `package/${entry}`], true)
    const actual = await readFile(join(profile, "node_modules", "dsh-decision-room", entry), "utf8")
    if (actual.trim() !== expected) throw new Error(`安装后的 ${entry} 与本地包不一致`)
  }
  run(process.execPath, [join(repository, "lib", "migrate-history.js"), "--root", join(dshHome, "sessions"), "--apply"])
  console.log(`升级安装完成。备份与恢复说明：${backup}`)
  console.log(`启动：DSH_HOME=${quote(dshHome)} ${quote(launcher)} web --host 127.0.0.1 --port 3080 --no-open`)
  console.log("把 DSH 启动日志中带 token 的完整本地链接复制到 Safari，点击左侧“决策室”测试。")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (backup) console.error(`升级中止；尚未自动回滚。完整备份及恢复命令：${backup}`)
  process.exitCode = 1
}
