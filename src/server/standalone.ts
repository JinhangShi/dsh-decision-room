import { createServer } from "node:http"
import { resolve } from "node:path"
import { DemoGateway } from "../core/demo-gateway.js"
import { DecisionEngine } from "../core/engine.js"
import { HttpGateway } from "../core/gateway.js"
import { FilePersistence, RunStore } from "../core/store.js"
import { loadConfiguration } from "./config.js"
import { createRoutes } from "./routes.js"

const configuration = await loadConfiguration()
const demo = process.argv.includes("--demo")
const store = new RunStore(
  new FilePersistence(
    resolve(process.env.DSH_DECISION_DATA_DIR ?? (demo ? ".decision-room/demo" : ".decision-room/live")),
  ),
)
const engine = new DecisionEngine(
  store,
  configuration.models,
  demo ? new DemoGateway(450) : new HttpGateway(configuration.env),
  demo ? "demo" : "live",
)
await engine.initialize()
const routes = createRoutes(engine, new URL("./web/", import.meta.url))
const server = createServer((req, res) => {
  void routes(req, res)
})
const port = Number(process.env.DSH_DECISION_PORT ?? 4318)
server.listen(port, "127.0.0.1", () => {
  console.log(`决策室 ${demo ? "演示预览（无外部调用）" : "真实网关模式"}：http://127.0.0.1:${port}/decision-room/`)
})
const shutdown = () => {
  server.close()
  void engine.dispose().finally(() => process.exit(0))
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
