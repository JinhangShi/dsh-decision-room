import type { Model } from "../core/models.js"
import type { ReviewCountLimits, RunConfig, Scope } from "../core/schema.js"

export type Bootstrap = {
  token: string
  models: Model[]
  mode: "live" | "demo"
  defaults: RunConfig
  reviewLimits?: ReviewCountLimits
  contextOwner?: "dsh" | "standalone"
  gateway?: { configured: boolean; baseUrl: string }
}
export class Api {
  token = ""
  constructor(readonly scope: Scope) {}
  async bootstrap(): Promise<Bootstrap> {
    const response = await fetch("/decision-room/api/bootstrap", { credentials: "same-origin", cache: "no-store" })
    const value = (await response.json()) as Bootstrap & { error?: string }
    if (!response.ok) {
      throw new Error(value.error ?? "工作台连接失败")
    }
    this.token = value.token
    return value
  }
  async request<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
    const query = new URLSearchParams(this.scope)
    const response = await fetch(`/decision-room/api${path}${path.includes("?") ? "&" : "?"}${query}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "x-decision-token": this.token,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const value = (await response.json()) as T & { error?: string }
    if (!response.ok) {
      throw new Error(value.error ?? `请求失败（${response.status}）`)
    }
    return value
  }
  async download(id: string, format: "md" | "html"): Promise<void> {
    const query = new URLSearchParams({ ...this.scope, format })
    const response = await fetch(`/decision-room/api/runs/${id}/export?${query}`, {
      credentials: "same-origin",
      headers: { "x-decision-token": this.token },
    })
    if (!response.ok) {
      throw new Error("导出失败，请刷新后重试")
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `决策报告-${id}.${format}`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
