import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGatewaySettingsStore } from "../src/server/config.js"

describe("网关本地配置", () => {
  it("保存后可由新进程环境读取，且清除后不再恢复", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-room-settings-"))
    const file = join(directory, "gateway.json")
    const first: NodeJS.ProcessEnv = { DSH_DECISION_SETTINGS_FILE: file }
    const store = await createGatewaySettingsStore(first)
    await store.save({ baseUrl: "https://gateway.example/api/v1/", apiKey: "secret-for-test" })
    expect(first).toMatchObject({
      AI_GATEWAY_BASE_URL: "https://gateway.example/api/v1",
      AI_GATEWAY_API_KEY: "secret-for-test",
    })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, "utf8")).toContain("secret-for-test")

    const restarted: NodeJS.ProcessEnv = { DSH_DECISION_SETTINGS_FILE: file }
    const restartedStore = await createGatewaySettingsStore(restarted)
    await expect(restartedStore.load()).resolves.toBe(true)
    expect(restarted.AI_GATEWAY_API_KEY).toBe("secret-for-test")

    await restartedStore.clear()
    const cleared: NodeJS.ProcessEnv = { DSH_DECISION_SETTINGS_FILE: file }
    await expect((await createGatewaySettingsStore(cleared)).load()).resolves.toBe(false)
    expect(cleared.AI_GATEWAY_API_KEY).toBeUndefined()
  })
})
