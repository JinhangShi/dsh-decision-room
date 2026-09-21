import { useEffect, useMemo, useState } from "react"
import { Api, type Bootstrap } from "./api.js"

export function Settings({ scope }: { scope: { sessionId: string; workspaceId: string } }): JSX.Element {
  const api = useMemo(() => new Api(scope), [scope.sessionId, scope.workspaceId])
  const [boot, setBoot] = useState<Bootstrap>()
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api
      .bootstrap()
      .then(value => {
        setBoot(value)
        setBaseUrl(value.gateway?.baseUrl ?? "")
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : "无法连接决策室服务"))
  }, [api])
  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true)
    setError("")
    setStatus("")
    try {
      await action()
      setStatus(message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="decision-app settings-mode">
      <section className="setup settings-panel">
        <div className="eyebrow">DSH 多模型决策 · V1</div>
        <h1>决策室设置</h1>
        <p className="muted">配置公司 AI 网关后，四个决策席位才能执行评审。</p>
        <div className="notice">
          API Key 只保存在当前 DSH 进程内存中，不会写入浏览器存储、任务报告或 npm 包。重启 DSH 后需要重新输入。
        </div>
        <label>
          公司网关地址
          <input
            type="url"
            value={baseUrl}
            placeholder="https://ai-gateway.example.com/api/v1"
            onChange={event => setBaseUrl(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            placeholder={boot?.gateway?.configured ? "已配置，输入新 Key 可替换" : "输入公司网关 API Key"}
            onChange={event => setApiKey(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <div className="form-footer">
          <button
            type="button"
            disabled={busy || !baseUrl || !apiKey}
            onClick={() =>
              void run(async () => {
                await api.request("/settings/test", "POST", { baseUrl, apiKey })
              }, "连接测试成功。")
            }
          >
            测试连接
          </button>
          <button
            type="button"
            disabled={busy || !baseUrl || !apiKey}
            onClick={() =>
              void run(async () => {
                await api.request("/settings", "PUT", { baseUrl, apiKey })
                setApiKey("")
                setBoot(value => (value ? { ...value, gateway: { configured: true, baseUrl } } : value))
              }, "已保存到当前 DSH 进程。")
            }
          >
            保存配置
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !boot?.gateway?.configured}
            onClick={() =>
              void run(async () => {
                await api.request("/settings", "DELETE")
                setApiKey("")
                setBoot(value => (value ? { ...value, gateway: { configured: false, baseUrl: "" } } : value))
                setBaseUrl("")
              }, "已清除当前进程中的网关配置。")
            }
          >
            清除
          </button>
        </div>
        {status && (
          <p className="success" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}
