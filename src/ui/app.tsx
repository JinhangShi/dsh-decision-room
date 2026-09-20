import { useEffect, useMemo, useState, type FormEvent } from "react"
import { activeElapsed, spent } from "../core/budget.js"
import type { Model } from "../core/models.js"
import {
  DEFAULT_LIMITS,
  DEFAULT_SEATS,
  type Brief,
  type Call,
  type Run,
  type RunConfig,
  type Scope,
} from "../core/schema.js"
import { Api, type Bootstrap } from "./api.js"
import "./style.css"

const PHASES = ["independent", "organize", "discuss", "revise", "verify", "finished"] as const
const PHASE_LABEL = {
  independent: "独立评审",
  organize: "整理问题",
  discuss: "交叉讨论",
  revise: "修订方案",
  verify: "独立复核",
  finished: "等待人工决策",
}
const STATUS = {
  draft: "待开始",
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  failed: "需处理",
}
export const EMPTY_BRIEF: Brief = {
  title: "",
  question: "",
  objective: "在安全可控的前提下，验证有潜力的业务增长方向。",
  constraints: "不突破数据授权范围；不自动修改业务系统；投入和交付范围需事先明确；方案应包含停止条件和回退方式。",
  plan: "",
  sources: [],
}
const DEFAULT_CONFIG: RunConfig = {
  seats: DEFAULT_SEATS,
  moderatorKey: "qwen",
  verifierKey: "kimi",
  limits: DEFAULT_LIMITS,
}
type View = "discussion" | "issues" | "report" | "record"

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
    : `${minutes} 分 ${Math.floor(ms / 1000) % 60} 秒`
}
function ModelSelect({
  label,
  value,
  models,
  onChange,
}: {
  label: string
  value: string
  models: Model[]
  onChange(value: string): void
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)}>
        {models.map(model => (
          <option key={model.key} value={model.key} disabled={!model.enabled}>
            {model.label}
            {model.enabled ? "" : " · 未接通"}
          </option>
        ))}
      </select>
    </label>
  )
}
function BudgetFields({
  config,
  onChange,
}: {
  config: RunConfig["limits"]
  onChange(value: RunConfig["limits"]): void
}): JSX.Element {
  const fields = [
    ["maxDurationMinutes", "最长讨论时间（分钟）", 1, 480],
    ["maxRounds", "最多交叉讨论轮数", 1, 80],
    ["maxCalls", "模型调用上限", 8, 400],
    ["tokenBudget", "Token 总预算", 2000, 20000000],
    ["concurrency", "同时发言席位", 1, 4],
    ["outputTokens", "单次输出上限", 512, 16000],
    ["callTimeoutSeconds", "单次超时（秒）", 5, 300],
  ] as const
  return (
    <>
      <div className="form-grid">
        {fields.map(([key, label, min, max]) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              type="number"
              min={min}
              max={max}
              required
              value={config[key]}
              onChange={event => onChange({ ...config, [key]: Number(event.target.value) })}
            />
          </label>
        ))}
        <label className="field">
          <span>金额预算（元，可留空）</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="先在模型配置中填写真实价格"
            value={config.maxCostCny ?? ""}
            onChange={event =>
              onChange({ ...config, maxCostCny: event.target.value === "" ? null : Number(event.target.value) })
            }
          />
        </label>
      </div>
      <p className="hint">
        金额留空时，使用
        Token、次数和时间额度控制。缺少价格或用量时显示“未核定”，不会虚构费用。预留是保守估算，上游账单仍需核对。
      </p>
    </>
  )
}
export function BriefForm({
  models,
  initialBrief,
  initialConfig,
  parent,
  onSubmit,
  composeOnly = false,
}: {
  models: Model[]
  initialBrief: Brief
  initialConfig: RunConfig
  parent: Run | null
  composeOnly?: boolean
  onSubmit(brief: Brief, config: RunConfig, feedback?: string): Promise<void>
}): JSX.Element {
  const [brief, setBrief] = useState(initialBrief)
  const [config, setConfig] = useState(initialConfig)
  const [feedback, setFeedback] = useState("")
  const [tab, setTab] = useState("brief")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const upload = async (file?: File) => {
    if (!file) {
      return
    }
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 100000) {
      setError("请选择不超过 100 KB 的 Markdown 或 TXT 文件")
      return
    }
    const text = await file.text()
    setBrief(value => ({ ...value, plan: text }))
    setError("")
  }
  const addSource = async (file?: File) => {
    if (!file) {
      return
    }
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 30000 || brief.sources.length >= 16) {
      setError("补充材料支持最多 16 份、每份 30 KB 的 Markdown/TXT 文件")
      return
    }
    const text = await file.text()
    setBrief(value => ({
      ...value,
      sources: [...value.sources, { id: `source-${crypto.randomUUID()}`, title: file.name, text }],
    }))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!brief.title.trim() || !brief.question.trim() || brief.plan.trim().length < 20) {
      setError("请填写议题、决策问题，以及至少 20 字的方案正文")
      setTab("brief")
      return
    }
    if (parent && !feedback.trim()) {
      setError("续议需要填写本轮反馈")
      setTab("brief")
      return
    }
    setBusy(true)
    setError("")
    try {
      await onSubmit(brief, config, parent ? feedback : undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={event => {
        void submit(event)
      }}
      className="setup"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">{parent ? `从 V${parent.version} 继续` : "新的决策"}</span>
          <h2>{parent ? "加入反馈，开启下一版" : "把一个值得讨论的问题放上桌"}</h2>
          <p>先约定目标与边界，再让不同角色独立判断。</p>
        </div>
        <span className="badge neutral">{parent ? "保留旧版" : "四席评审"}</span>
      </div>
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "brief"}
          className={tab === "brief" ? "selected" : ""}
          onClick={() => setTab("brief")}
        >
          01 议题与材料
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "members"}
          className={tab === "members" ? "selected" : ""}
          onClick={() => setTab("members")}
        >
          02 成员与边界
        </button>
      </div>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {tab === "brief" ? (
        <div className="form-body">
          {parent && (
            <label className="field">
              <span>这次新增的事实、约束、取舍或异议</span>
              <textarea
                rows={4}
                value={feedback}
                onChange={event => setFeedback(event.target.value)}
                placeholder="说明什么发生了变化，以及哪些问题需要重新评估。用户补充的事实也会标记为待核验。"
              />
            </label>
          )}
          <label className="field">
            <span>议题名称</span>
            <input
              value={brief.title}
              maxLength={160}
              onChange={event => setBrief({ ...brief, title: event.target.value })}
              placeholder="例如：企业服务产品的付费试点方案"
            />
          </label>
          <label className="field">
            <span>需要作出的决策</span>
            <input
              value={brief.question}
              onChange={event => setBrief({ ...brief, question: event.target.value })}
              placeholder="是否值得进入试点？还需要满足什么条件？"
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>目标与成功标准</span>
              <textarea
                rows={4}
                value={brief.objective}
                onChange={event => setBrief({ ...brief, objective: event.target.value })}
              />
            </label>
            <label className="field">
              <span>硬约束与禁止事项</span>
              <textarea
                rows={4}
                value={brief.constraints}
                onChange={event => setBrief({ ...brief, constraints: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span className="inline-between">
              方案正文 <span className="hint">{brief.plan.length.toLocaleString()} 字</span>
            </span>
            <textarea
              rows={12}
              value={brief.plan}
              maxLength={80000}
              onChange={event => setBrief({ ...brief, plan: event.target.value })}
              placeholder="粘贴方案、背景、已知事实和待验证假设。也可以导入 Markdown / TXT。"
            />
          </label>
          <div className="file-row">
            <label className="button secondary">
              导入方案 .md / .txt
              <input
                type="file"
                accept=".md,.txt"
                onChange={event => {
                  void upload(event.target.files?.[0])
                }}
              />
            </label>
            <label className="button secondary">
              添加补充材料
              <input
                type="file"
                accept=".md,.txt"
                onChange={event => {
                  void addSource(event.target.files?.[0])
                }}
              />
            </label>
            <span className="hint">仅发送你提交的材料，不读取其他会话。</span>
          </div>
          {brief.sources.map(source => (
            <div className="source-item" key={source.id}>
              <span>
                {source.title} · {source.text.length} 字 · 未核验
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => setBrief({ ...brief, sources: brief.sources.filter(item => item.id !== source.id) })}
              >
                移除
              </button>
            </div>
          ))}
          <div className="form-footer">
            <p className="hint">材料将冻结为本次评审的共同输入。</p>
            <button type="button" className="primary" onClick={() => setTab("members")}>
              下一步：配置成员 →
            </button>
          </div>
        </div>
      ) : (
        <div className="form-body">
          <div className="role-grid">
            {config.seats.map((seat, index) => (
              <section key={seat.id} className="role-card">
                <div className={`avatar color-${index}`}>{String(index + 1).padStart(2, "0")}</div>
                <label className="field">
                  <span>角色名称</span>
                  <input
                    value={seat.name}
                    onChange={event =>
                      setConfig({
                        ...config,
                        seats: config.seats.map(item =>
                          item.id === seat.id ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <ModelSelect
                  label="评审模型"
                  models={models}
                  value={seat.modelKey}
                  onChange={modelKey =>
                    setConfig({
                      ...config,
                      seats: config.seats.map(item => (item.id === seat.id ? { ...item, modelKey } : item)),
                    })
                  }
                />
                <label className="field">
                  <span>职责与评价尺度</span>
                  <textarea
                    rows={3}
                    value={seat.mandate}
                    onChange={event =>
                      setConfig({
                        ...config,
                        seats: config.seats.map(item =>
                          item.id === seat.id ? { ...item, mandate: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
              </section>
            ))}
          </div>
          {new Set(config.seats.map(seat => seat.modelKey)).size < config.seats.length && (
            <div className="notice">部分角色使用相同模型。同模型多角色有助于切换视角，但不构成多个独立模型。</div>
          )}
          <div className="form-grid">
            <ModelSelect
              label="主持与方案编辑"
              models={models}
              value={config.moderatorKey}
              onChange={moderatorKey => setConfig({ ...config, moderatorKey })}
            />
            <ModelSelect
              label="最终独立复核"
              models={models}
              value={config.verifierKey}
              onChange={verifierKey => setConfig({ ...config, verifierKey })}
            />
          </div>
          <h3>讨论时长与预算</h3>
          <div className="preset-row">
            {[
              { label: "快速评审 · 15 分钟", minutes: 15, rounds: 2, calls: 24 },
              { label: "深入讨论 · 1 小时", minutes: 60, rounds: 12, calls: 64 },
              { label: "持续推敲 · 4 小时", minutes: 240, rounds: 24, calls: 120 },
            ].map(preset => (
              <button
                type="button"
                className="secondary"
                key={preset.minutes}
                onClick={() =>
                  setConfig({
                    ...config,
                    limits: {
                      ...config.limits,
                      maxDurationMinutes: preset.minutes,
                      maxRounds: preset.rounds,
                      maxCalls: preset.calls,
                    },
                  })
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
          <BudgetFields config={config.limits} onChange={limits => setConfig({ ...config, limits })} />
          <div className="notice">
            讨论会在缺少新证据、没有后续争议或达到限制时结束。4
            小时是上限，不会为耗满时间重复发言。首轮结论统一公开；后续分歧会保留到报告。
          </div>
          <details className="model-catalog">
            <summary>模型接入状态与计价</summary>
            {models.map(model => (
              <div className="source-item" key={model.key}>
                <div>
                  <strong>{model.label}</strong>
                  <p className="hint">
                    {model.model} · {model.note}
                  </p>
                </div>
                <span className={`badge ${model.enabled ? "good" : "neutral"}`}>
                  {model.enabled ? "可配置" : "未接通"}
                </span>
              </div>
            ))}
            <p className="hint">
              新增供应商、路由及真实价格在 Host 的 models.local.json 中配置。密钥保留在 Host 环境中。
            </p>
          </details>
          <div className="form-footer">
            <button type="button" className="secondary" onClick={() => setTab("brief")}>
              ← 返回材料
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? (composeOnly ? "正在回填…" : "正在创建…") : composeOnly ? "放入主聊天输入框" : "创建并开始评审"}
            </button>
          </div>
          <p className="hint">
            {composeOnly
              ? "此步只回填草稿，不调用模型。请在主聊天核对并发送，DSH 才会按以上角色和预算启动评审。"
              : "开始即授权在以上模型、材料和额度内调用。执行范围只包含评审，不会修改业务系统。"}
          </p>
        </div>
      )}
    </form>
  )
}

function ResultContent({ call }: { call: Call }): JSX.Element | null {
  const result = call.result as
    | {
        summary?: string
        strengths?: string[]
        issues?: Array<{ title?: string; rationale?: string; reason?: string; verdict?: string }>
        responses?: Array<{ issueId: string; reasoning: string; proposedChange: string }>
      }
    | undefined
  if (!result) {
    return call.error ? (
      <p className="error-text">{call.error}</p>
    ) : (
      <p className="hint">
        {call.status === "succeeded"
          ? "已独立提交，等待其余席位后统一公开。"
          : call.status === "running"
            ? "正在分析共同材料…"
            : "调用中断，保留用量记录。"}
      </p>
    )
  }
  return (
    <>
      <p>{result.summary}</p>
      {result.strengths?.length ? <div className="strengths">应保留：{result.strengths.join("；")}</div> : null}
      {result.issues?.map((issue, index) => (
        <p className="finding" key={index}>
          <strong>{issue.title ?? issue.verdict}</strong> {issue.rationale ?? issue.reason}
        </p>
      ))}
      {result.responses?.map(response => (
        <div key={response.issueId} className="finding">
          <span className="issue-ref">{response.issueId}</span>
          <p>{response.reasoning}</p>
          <p className="hint">建议：{response.proposedChange}</p>
        </div>
      ))}
    </>
  )
}

export function App({ scope, sidebar = false }: { scope: Scope; sidebar?: boolean }): JSX.Element {
  const api = useMemo(() => new Api(scope), [scope.sessionId, scope.workspaceId])
  const [boot, setBoot] = useState<Bootstrap>()
  const [runs, setRuns] = useState<Run[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [view, setView] = useState<View>("discussion")
  const [parent, setParent] = useState<Run | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [decisionReason, setDecisionReason] = useState("")
  const [limits, setLimits] = useState<RunConfig["limits"] | null>(null)
  useEffect(() => {
    let active = true
    void api
      .bootstrap()
      .then(async result => {
        const list = await api.request<Run[]>("/runs")
        if (active) {
          setBoot(result)
          setRuns(list)
          setRun(list[0] ?? null)
        }
      })
      .catch(reason => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "连接失败")
        }
      })
    return () => {
      active = false
    }
  }, [api])
  useEffect(() => {
    if (!boot || !run) {
      return
    }
    let active = true
    let inFlight = false
    const timer = setInterval(
      () => {
        setNow(Date.now())
        if (inFlight) {
          return
        }
        inFlight = true
        void api
          .request<Run>(`/runs/${run.id}`)
          .then(updated => {
            if (active) {
              setRun(updated)
              setRuns(current => current.map(item => (item.id === updated.id ? updated : item)))
            }
          })
          .catch(reason => {
            if (active) {
              setError(reason instanceof Error ? reason.message : "同步失败")
            }
          })
          .finally(() => {
            inFlight = false
          })
      },
      run.status === "running" ? 1500 : 5000,
    )
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, boot, run?.id, run?.status])
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError("")
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }
  const refreshList = async () => {
    setRuns(await api.request<Run[]>("/runs"))
  }
  const control = async (action: string) => {
    if (!run) {
      return
    }
    const updated = await api.request<Run>(`/runs/${run.id}/control`, "POST", { scope, revision: run.revision, action })
    setRun(updated)
    await refreshList()
  }
  const fresh = (previous: Run | null = null) => {
    setParent(previous)
    setRun(null)
    setView("discussion")
    setFormKey(key => key + 1)
    setLimits(null)
    setError("")
  }
  const metrics = run ? spent(run) : null
  const selectRun = async (item: Run) => {
    setRun(await api.request<Run>(`/runs/${item.id}`))
    setLimits(null)
    setDecisionReason("")
    setParent(null)
  }
  const unresolved = run?.issues.filter(issue => issue.status !== "addressed").length ?? 0
  const phaseIndex = run ? PHASES.indexOf(run.phase) : -1
  return (
    <div className={`decision-app ${sidebar ? "sidebar-mode" : ""}`}>
      <header className="app-header">
        <a
          href="#"
          className="brand"
          onClick={event => {
            event.preventDefault()
            fresh()
          }}
        >
          <span className="brand-mark">◈</span>
          <span>
            决策室<small>让观点交锋，让依据留下</small>
          </span>
        </a>
        <div className="header-right">
          <span className="badge neutral">{boot?.mode === "demo" ? "演示模式 · 无外部调用" : "DSH 多模型评审"}</span>
          <span className="local-dot">本地会话</span>
        </div>
      </header>
      <div className="app-layout">
        <aside className="history">
          <button className="primary new-button" onClick={() => fresh()}>
            ＋ 新建决策
          </button>
          <div className="sidebar-label">
            当前会话的决策版本
            <button
              className="text-button"
              aria-label="刷新历史"
              onClick={() => {
                void perform(refreshList)
              }}
            >
              ↻
            </button>
          </div>
          {runs.length === 0 && <p className="empty-history">每一次讨论，都是一个可回溯的版本。</p>}
          {runs.map(item => (
            <button
              key={item.id}
              className={`history-item ${run?.id === item.id ? "active" : ""}`}
              onClick={() => {
                void perform(() => selectRun(item))
              }}
            >
              <span className="inline-between">
                <small>V{item.version}</small>
                <span className={`status-dot ${item.status}`} />
              </span>
              <strong>{item.brief.title}</strong>
              <small>
                {STATUS[item.status]} · {new Date(item.createdAt).toLocaleDateString("zh-CN")}
              </small>
            </button>
          ))}
          <div className="sidebar-note">
            <strong>人的角色</strong>
            <p>
              定义目标与边界
              <br />
              补充事实与取舍
              <br />
              查看结论，再次沟通
            </p>
          </div>
        </aside>
        <main className="main-content">
          {sidebar && (
            <>
              <div className="notice">评审发言、争议和修订方案显示在 DSH 主聊天。这里用于配置与进度控制。</div>
              {runs.length > 0 && (
                <div className="run-actions">
                  <label className="field">
                    <span>决策版本</span>
                    <select
                      aria-label="决策版本"
                      value={run?.id ?? ""}
                      onChange={event => {
                        const selected = runs.find(item => item.id === event.target.value)
                        if (selected) {
                          void perform(() => selectRun(selected))
                        }
                      }}
                    >
                      <option value="" disabled>
                        选择版本
                      </option>
                      {runs.map(item => (
                        <option key={item.id} value={item.id}>
                          V{item.version} · {item.brief.title} · {STATUS[item.status]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    onClick={() => {
                      void perform(refreshList)
                    }}
                  >
                    刷新版本
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button className="text-button" onClick={() => setError("")}>
                关闭提示
              </button>
            </div>
          )}
          {!boot ? (
            <div className="empty-state">
              <span className="spinner" />
              <h2>正在连接决策室</h2>
              <p>读取当前 Profile 的模型和任务配置。</p>
            </div>
          ) : !run ? (
            <BriefForm
              key={formKey}
              models={boot.models}
              initialBrief={
                parent ? { ...parent.brief, plan: parent.revisionResult?.fullPlan ?? parent.brief.plan } : EMPTY_BRIEF
              }
              initialConfig={parent?.config ?? boot.defaults ?? DEFAULT_CONFIG}
              parent={parent}
              onSubmit={async (brief, config, feedback) => {
                const created = await api.request<Run>("/runs", "POST", {
                  scope,
                  brief,
                  config,
                  ...(parent ? { parentId: parent.id, feedback } : {}),
                })
                setRun(created)
                try {
                  const started = await api.request<Run>(`/runs/${created.id}/control`, "POST", {
                    scope,
                    revision: created.revision,
                    action: "start",
                  })
                  setRun(started)
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : "任务已创建，开始失败，可重试")
                }
                await refreshList()
              }}
            />
          ) : (
            <>
              <section className="run-heading">
                <div>
                  <div className="eyebrow">
                    决策档案 / V{run.version}
                    {run.mode === "demo" ? " / 演示" : ""}
                  </div>
                  <h1>{run.brief.title}</h1>
                  <p>{run.brief.question}</p>
                </div>
                <span
                  className={`badge ${run.status === "completed" ? "good" : run.status === "running" ? "live" : "neutral"}`}
                >
                  {STATUS[run.status]}
                </span>
              </section>
              <div className="metric-grid">
                <div>
                  <small>当前阶段</small>
                  <strong>{PHASE_LABEL[run.phase]}</strong>
                  <span>第 {run.round} 轮交叉讨论</span>
                </div>
                <div>
                  <small>讨论用时</small>
                  <strong>{duration(activeElapsed(run, now))}</strong>
                  <span>最多 {run.config.limits.maxDurationMinutes} 分钟</span>
                </div>
                <div>
                  <small>模型调用</small>
                  <strong>
                    {metrics?.calls} <em>/ {run.config.limits.maxCalls}</em>
                  </strong>
                  <span>并发上限 {run.config.limits.concurrency}</span>
                </div>
                <div>
                  <small>已计入 / 预留额度</small>
                  <strong>
                    {metrics?.tokens.toLocaleString()} <em>Token</em>
                  </strong>
                  <span>
                    {metrics?.costCny === null ? "价格未配置 · 金额未核定" : `估算 ¥${metrics?.costCny.toFixed(4)}`}
                  </span>
                </div>
              </div>
              <nav className="phase-track" aria-label="执行阶段">
                {PHASES.map((phase, index) => (
                  <div className={index < phaseIndex ? "done" : index === phaseIndex ? "current" : ""} key={phase}>
                    <span>{index < phaseIndex ? "✓" : index + 1}</span>
                    {PHASE_LABEL[phase]}
                  </div>
                ))}
              </nav>
              {run.stopReason && <div className="notice">{run.stopReason}</div>}
              {metrics && metrics.uncertain > 0 && (
                <div className="notice">
                  {metrics.uncertain} 次调用的实际用量未确定，按预留额度计入；取消不保证上游停止计费。
                </div>
              )}
              <div className="run-actions">
                {run.status === "draft" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      void perform(() => control("start"))
                    }}
                  >
                    开始评审
                  </button>
                )}
                {run.status === "running" && (
                  <>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        void perform(() => control("pause"))
                      }}
                    >
                      暂停讨论
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || run.finishRequested}
                      onClick={() => {
                        void perform(() => control("finish"))
                      }}
                    >
                      {run.finishRequested ? "已安排进入修订" : "结束讨论并修订"}
                    </button>
                  </>
                )}
                {run.status === "paused" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      void perform(() => control("resume"))
                    }}
                  >
                    从检查点继续
                  </button>
                )}
                {["paused", "draft"].includes(run.status) && (
                  <button className="secondary" onClick={() => setLimits(limits ? null : run.config.limits)}>
                    调整时间与预算
                  </button>
                )}
                {["running", "paused", "draft"].includes(run.status) && (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      void perform(() => control("cancel"))
                    }}
                  >
                    取消任务
                  </button>
                )}
                {["completed", "paused", "cancelled", "failed"].includes(run.status) && (
                  <button className="primary" onClick={() => fresh(run)}>
                    补充意见，创建下一版
                  </button>
                )}
                <div className="action-spacer" />
                <button
                  className="secondary"
                  onClick={() => {
                    void perform(() => api.download(run.id, "md"))
                  }}
                >
                  导出 Markdown
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    void perform(() => api.download(run.id, "html"))
                  }}
                >
                  导出 HTML
                </button>
              </div>
              {limits && (
                <section className="panel">
                  <h3>调整本轮授权额度</h3>
                  <BudgetFields config={limits} onChange={setLimits} />
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      void perform(async () => {
                        setRun(
                          await api.request<Run>(`/runs/${run.id}/limits`, "PUT", {
                            scope,
                            revision: run.revision,
                            limits,
                          }),
                        )
                        setLimits(null)
                      })
                    }}
                  >
                    保存额度（保存后再继续）
                  </button>
                </section>
              )}
              {sidebar ? (
                <section className="panel">
                  <h3>评审成员进度</h3>
                  <p className="hint">上下文由 DSH 会话管理；压缩调用同样受本轮预算限制。</p>
                  {run.config.seats.map(seat => {
                    const calls = run.calls.filter(call => call.seatId === seat.id && call.purpose !== "compaction")
                    const last = calls.at(-1)
                    return (
                      <div className="member" key={seat.id}>
                        <div>
                          <strong>{seat.name}</strong>
                          <small>{boot.models.find(model => model.key === seat.modelKey)?.label}</small>
                        </div>
                        <span className="badge neutral">
                          {last
                            ? { running: "评审中", succeeded: "已提交", failed: "需处理", interrupted: "已中断" }[
                                last.status
                              ]
                            : "等待开始"}
                        </span>
                      </div>
                    )
                  })}
                  <p>{unresolved} 项问题尚未解决或待补证。完整内容请看主聊天。</p>
                  <p className="hint">可以直接在主聊天提出反馈，生成下一版草稿；核对后在这里开始。</p>
                  {run.status === "completed" && (
                    <div className="human-decision">
                      <h3>人工取舍</h3>
                      {run.humanDecision ? (
                        <p>已记录：{run.humanDecision.reason}</p>
                      ) : (
                        <>
                          <label className="field">
                            <span>决定依据与接受的风险</span>
                            <textarea
                              rows={3}
                              value={decisionReason}
                              onChange={event => setDecisionReason(event.target.value)}
                            />
                          </label>
                          <div className="run-actions">
                            {(
                              [
                                ["adopt", "采纳方案"],
                                ["defer", "暂缓决策"],
                                ["reject", "不采纳"],
                              ] as const
                            ).map(([decision, label]) => (
                              <button
                                key={decision}
                                className="secondary"
                                disabled={busy || !decisionReason.trim()}
                                onClick={() => {
                                  void perform(async () =>
                                    setRun(
                                      await api.request<Run>(`/runs/${run.id}/decision`, "POST", {
                                        scope,
                                        revision: run.revision,
                                        decision,
                                        reason: decisionReason,
                                      }),
                                    ),
                                  )
                                }}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </section>
              ) : (
                <>
                  <div className="tabs" role="tablist">
                    {(
                      [
                        ["discussion", "评审聊天室"],
                        ["issues", `问题台账 · ${run.issues.length}`],
                        ["report", "修订方案"],
                        ["record", "材料与记录"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        role="tab"
                        aria-selected={view === key}
                        className={view === key ? "selected" : ""}
                        key={key}
                        onClick={() => setView(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {view === "discussion" && (
                    <div className="discussion-layout">
                      <section className="conversation">
                        <div className="conversation-note">
                          <span className="small-mark">◈</span>
                          <p>
                            {run.phase === "independent"
                              ? "独立评审进行中。每个角色只看到相同材料，全部提交后统一揭示。"
                              : "按问题讨论，保留来源和异议。发言数量与赞同人数不代表结论更正确。"}
                          </p>
                        </div>
                        {run.calls.length === 0 && (
                          <div className="empty-state">
                            <h3>成员已就座</h3>
                            <p>开始后，将从各自专业视角独立评审。</p>
                          </div>
                        )}
                        {run.calls.map(call => (
                          <article className="message" key={call.id}>
                            <div
                              className={`avatar color-${Math.max(
                                0,
                                run.config.seats.findIndex(seat => seat.id === call.seatId),
                              )}`}
                            >
                              {call.seatId === "moderator" || call.seatId === "editor"
                                ? "编"
                                : call.seatId === "verifier"
                                  ? "核"
                                  : run.config.seats.find(seat => seat.id === call.seatId)?.name.slice(0, 1)}
                            </div>
                            <div className="message-body">
                              <div className="message-heading">
                                <strong>
                                  {run.config.seats.find(seat => seat.id === call.seatId)?.name ??
                                    (call.seatId === "verifier" ? "独立复核" : "主持与编辑")}
                                </strong>
                                <span>{boot.models.find(model => model.key === call.modelKey)?.label}</span>
                                <small>
                                  {PHASE_LABEL[call.phase]}
                                  {call.round > 0 ? ` · 第 ${call.round} 轮` : ""}
                                </small>
                                <span className={`badge ${call.status === "succeeded" ? "good" : "neutral"}`}>
                                  {
                                    { running: "思考中", succeeded: "已提交", failed: "失败", interrupted: "中断" }[
                                      call.status
                                    ]
                                  }
                                </span>
                              </div>
                              <ResultContent call={call} />
                              {call.returnedModel && (
                                <div className="receipt">
                                  网关返回：{call.returnedModel}
                                  {call.usage ? ` · ${call.usage.totalTokens.toLocaleString()} Token` : " · 用量未报告"}
                                </div>
                              )}
                            </div>
                          </article>
                        ))}
                      </section>
                      <aside className="members-panel">
                        <div className="sidebar-label">本轮评审成员</div>
                        {run.config.seats.map((seat, index) => (
                          <div className="member" key={seat.id}>
                            <div className={`avatar color-${index}`}>{index + 1}</div>
                            <div>
                              <strong>{seat.name}</strong>
                              <small>{boot.models.find(model => model.key === seat.modelKey)?.label}</small>
                            </div>
                          </div>
                        ))}
                        <div className="method-card">
                          <strong>允许不一致</strong>
                          <p>保留反对意见，比强行达成共识更有用。</p>
                          <strong>没有证据时停下来</strong>
                          <p>把未知变成下一步验证任务，而不是继续重复讨论。</p>
                        </div>
                      </aside>
                    </div>
                  )}
                  {view === "issues" && (
                    <section className="issue-list">
                      <div className="section-heading">
                        <div>
                          <h2>需要被回应的问题</h2>
                          <p>{unresolved} 项仍未解决或待补证。事实争议不会因为模型赞同就变成已证实。</p>
                        </div>
                      </div>
                      {run.issues.length === 0 && (
                        <div className="empty-state">首轮独立评审完成后，在这里汇总问题。</div>
                      )}
                      {run.issues.map(issue => (
                        <article className="issue-card" key={issue.id}>
                          <div className="inline-between">
                            <span className="issue-ref">{issue.id}</span>
                            <span className={`badge ${issue.status === "addressed" ? "good" : "warning"}`}>
                              {{ open: "未解决", addressed: "设计已回应", needs_evidence: "待补证" }[issue.status]}
                            </span>
                          </div>
                          <h3>{issue.title}</h3>
                          <p>{issue.rationale}</p>
                          <dl>
                            <dt>建议修改</dt>
                            <dd>{issue.suggestedChange}</dd>
                            <dt>改变意见的条件</dt>
                            <dd>{issue.whatWouldChangeMind}</dd>
                            <dt>材料引用</dt>
                            <dd>{issue.evidenceIds.join("、") || "无，待验证判断"}</dd>
                            {issue.resolution && (
                              <>
                                <dt>复核意见</dt>
                                <dd>{issue.resolution}</dd>
                              </>
                            )}
                          </dl>
                        </article>
                      ))}
                    </section>
                  )}
                  {view === "report" && (
                    <section className="report-panel">
                      {!run.revisionResult ? (
                        <div className="empty-state">
                          <span className="large-mark">◇</span>
                          <h2>完整修订稿会在这里生成</h2>
                          <p>讨论结束后，由编辑模型整合修改，再由独立上下文复核。</p>
                        </div>
                      ) : (
                        <>
                          <div className="report-summary">
                            <span className="eyebrow">决策摘要</span>
                            <h2>
                              {
                                { pilot: "建议有限试点", need_evidence: "需要补充证据", hold: "建议暂缓" }[
                                  run.revisionResult.recommendation
                                ]
                              }
                            </h2>
                            <p>{run.revisionResult.summary}</p>
                            <span className="badge warning">
                              {unresolved} 项未闭环 · {run.verification ? "已完成模型复核" : "等待复核"}
                            </span>
                          </div>
                          {run.verification?.constraintViolations.map((violation, index) => (
                            <div className="notice error" key={index}>
                              复核发现约束问题：{violation}
                            </div>
                          ))}
                          <h3>修改后的完整方案</h3>
                          <pre className="plan-text">{run.revisionResult.fullPlan}</pre>
                          <h3>修改对照</h3>
                          {run.revisionResult.changes.map(change => (
                            <div className="change-row" key={change.issueId}>
                              <span className="issue-ref">{change.issueId}</span>
                              <span className="badge neutral">
                                {{ accepted: "采纳", partial: "部分采纳", rejected: "未采纳" }[change.disposition]}
                              </span>
                              <p>{change.change}</p>
                              <p className="hint">{change.reason}</p>
                            </div>
                          ))}
                          <h3>验证与试点</h3>
                          {run.revisionResult.experiments.map((experiment, index) => (
                            <div className="issue-card" key={index}>
                              <strong>{experiment.hypothesis}</strong>
                              <p>{experiment.method}</p>
                              <p>
                                指标：{experiment.metric} · 责任角色：{experiment.ownerRole}
                              </p>
                              <p className="hint">停止条件：{experiment.stopCondition}</p>
                            </div>
                          ))}
                          <div className="notice">
                            {run.verification?.summary ?? "尚未完成独立复核"}。异议台账仍是报告的一部分。
                          </div>
                          {run.status === "completed" && (
                            <div className="human-decision">
                              <h3>由你作出最后取舍</h3>
                              {run.humanDecision ? (
                                <p>
                                  已记录：
                                  {
                                    { adopt: "采纳", reject: "不采纳", defer: "暂缓决策" }[run.humanDecision.decision]
                                  } · {run.humanDecision.reason}
                                </p>
                              ) : (
                                <>
                                  <label className="field">
                                    <span>决定依据与接受的风险</span>
                                    <textarea
                                      rows={3}
                                      value={decisionReason}
                                      onChange={event => setDecisionReason(event.target.value)}
                                      placeholder="人工取舍会绑定此报告版本，原风险不会被抹去。"
                                    />
                                  </label>
                                  <div className="run-actions">
                                    {(
                                      [
                                        ["adopt", "采纳方案"],
                                        ["defer", "暂缓决策"],
                                        ["reject", "不采纳"],
                                      ] as const
                                    ).map(([decision, label]) => (
                                      <button
                                        className={decision === "adopt" ? "primary" : "secondary"}
                                        key={decision}
                                        disabled={busy || !decisionReason.trim()}
                                        onClick={() => {
                                          void perform(async () =>
                                            setRun(
                                              await api.request<Run>(`/runs/${run.id}/decision`, "POST", {
                                                scope,
                                                revision: run.revision,
                                                decision,
                                                reason: decisionReason,
                                              }),
                                            ),
                                          )
                                        }}
                                      >
                                        {label}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </section>
                  )}
                  {view === "record" && (
                    <section className="panel">
                      <h3>冻结的目标与边界</h3>
                      <p>{run.brief.objective}</p>
                      <pre className="plan-text">{run.brief.constraints}</pre>
                      <details>
                        <summary>原始方案与补充材料</summary>
                        <pre className="plan-text">{run.brief.plan}</pre>
                        {run.brief.sources.map(source => (
                          <details key={source.id}>
                            <summary>
                              {source.title} · {source.id}
                            </summary>
                            <pre className="plan-text">{source.text}</pre>
                          </details>
                        ))}
                      </details>
                      {run.feedback && <div className="notice">本轮人工反馈：{run.feedback}</div>}
                      <h3>阶段与操作记录</h3>
                      <ol className="event-list">
                        {run.events.map(item => (
                          <li key={item.id}>
                            <time>{new Date(item.at).toLocaleTimeString("zh-CN")}</time>
                            <span>{item.text}</span>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>
      <footer className="app-footer">
        独立评审 · 可追溯依据 · 保留分歧 · 人工决策<span>仅依据提交材料，不自动执行建议</span>
      </footer>
    </div>
  )
}
