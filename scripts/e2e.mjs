import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const directory = await mkdtemp(join(tmpdir(), "decision-e2e-"))
const port = Number(process.env.DSH_DECISION_E2E_PORT ?? 14318)
const origin = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ["lib/server.js", "--demo"], {
  env: { ...process.env, DSH_DECISION_PORT: String(port), DSH_DECISION_DATA_DIR: directory },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", chunk => {
  serverLog += chunk
})
child.stderr.on("data", chunk => {
  serverLog += chunk
})
const executablePath =
  process.env.DSH_DECISION_CHROME ??
  [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync)
let browser
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${origin}/decision-room/api/bootstrap`)).ok) {
        break
      }
    } catch {}
    if (child.exitCode !== null) {
      throw new Error(`预览服务未启动：${serverLog}`)
    }
    if (attempt === 99) {
      throw new Error("预览启动超时")
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } })
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${origin}/decision-room/`)
  await page.getByLabel("议题名称", { exact: true }).fill("企业服务产品的付费试点")
  await page.getByLabel("需要作出的决策", { exact: true }).fill("在有限资源下，是否值得进入小范围付费试点？")
  await page
    .getByLabel("方案正文", { exact: false })
    .fill(
      "为企业服务产品建立可逆的付费试点。先访谈目标客户并确认需要解决的问题，明确交付范围和数据授权，再开展有限样本测试。记录实际客户反馈、交付投入和持续使用情况，达到预设标准后由人工决定是否扩大。所有指标暂不填虚构数字。",
    )
  await page.getByRole("button", { name: "下一步：配置成员" }).click()
  await page.getByRole("button", { name: "快速评审" }).click()
  await mkdir("test-results", { recursive: true })
  await page.screenshot({ path: "test-results/setup-desktop.png", fullPage: true })
  await page.getByRole("button", { name: "创建并开始评审" }).click()
  await page.getByRole("button", { name: "补充意见，创建下一版" }).waitFor({ timeout: 30000 })
  assert.equal(await page.getByRole("alert").count(), 0)
  assert.equal(await page.locator(".message").count(), 11)
  await page.screenshot({ path: "test-results/discussion-desktop.png", fullPage: true })
  await page.getByRole("tab", { name: "问题台账" }).click()
  assert.equal(await page.locator(".issue-card").count(), 4)
  await page.getByRole("tab", { name: "修订方案", exact: true }).click()
  await page.getByLabel("决定依据与接受的风险").fill("只采纳有限试点，证据缺口保留；获得样本数据后再次评审。")
  await page.getByRole("button", { name: "采纳方案", exact: true }).click()
  await page.getByText("已记录：采纳", { exact: false }).waitFor()
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "导出 HTML", exact: true }).click()
  const download = await downloadPromise
  await download.saveAs("test-results/report.html")
  await page.screenshot({ path: "test-results/report-desktop.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: "test-results/report-mobile.png", fullPage: true })
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "移动端不应横向溢出",
  )
  await page.getByRole("button", { name: "补充意见，创建下一版" }).click()
  await page
    .getByLabel("这次新增的事实、约束、取舍或异议")
    .fill("新增事实：产品负责人可以在下周提供试点样本，采集口径仍需确认。")
  await page.getByRole("button", { name: "下一步：配置成员" }).click()
  await page.getByRole("button", { name: "创建并开始评审" }).click()
  await page.getByRole("button", { name: "暂停讨论", exact: true }).click()
  await page.getByRole("button", { name: "从检查点继续", exact: true }).waitFor()
  await page.reload()
  await page.getByRole("button", { name: "从检查点继续", exact: true }).waitFor()
  await page.getByRole("button", { name: "从检查点继续", exact: true }).click()
  await page.getByRole("button", { name: "补充意见，创建下一版" }).waitFor({ timeout: 30000 })
  assert.equal(await page.locator(".history-item").count(), 2)
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "移动端聊天室不应横向溢出",
  )
  assert.deepEqual(errors, [])
  await writeFile(
    "test-results/e2e.json",
    JSON.stringify(
      {
        success: true,
        checked: [
          "创建四角色评审",
          "11 次完整模拟调用",
          "问题台账",
          "完整修订与复核",
          "人工采纳",
          "HTML 下载",
          "390px 无溢出",
          "反馈生成 V2",
          "暂停、刷新、恢复",
          "旧版本历史保留",
        ],
        dataDirectory: directory,
      },
      null,
      2,
    ),
  )
  console.log("浏览器验收通过：完整评审、导出、人工决策、V2 续议、暂停恢复、桌面和手机布局。")
  console.log(`截图与报告：${resolve("test-results")}`)
} finally {
  await browser?.close()
  if (child.exitCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve))
    child.kill("SIGTERM")
    await stopped
  }
}
