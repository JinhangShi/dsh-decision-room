import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

process.chdir(fileURLToPath(new URL("../", import.meta.url)))
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local")
}
await import("./build.mjs")
const child = spawn(process.execPath, ["lib/server.js", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
})
process.on("SIGINT", () => child.kill("SIGINT"))
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("exit", code => {
  process.exitCode = code ?? 0
})
