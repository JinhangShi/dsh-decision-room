import { useEffect, useMemo, useState, type FormEvent } from "react"
import { activeElapsed, spent } from "../core/budget.js"
import { assessDeliberation } from "../core/deliberation.js"
import type { Model } from "../core/models.js"
import {
  DEFAULT_LIMITS,
  DEFAULT_SEATS,
  REVIEW_MODES,
  SEAT_TEMPLATES,
  reviewModeForLimits,
  type Brief,
  type Call,
  type Run,
  type RunConfig,
  type Scope,
} from "../core/schema.js"
import { Api, type Bootstrap } from "./api.js"
import "./style.css"

const PHASES = ["independent", "organize", "discuss", "interpret", "revise", "verify", "finished"] as const
const PHASE_LABEL = {
  independent: "独立评审",
  organize: "整理问题",
  discuss: "交叉讨论",
  interpret: "主持解读",
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
  seats: structuredClone(DEFAULT_SEATS),
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
function durationLimit(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `最多 ${minutes / 60} 小时`
  if (minutes >= 60) return `最多 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
  return `最多 ${minutes} 分钟`
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
        {models
          .filter(model => model.enabled)
          .map(model => (
            <option key={model.key} value={model.key}>
              {model.label}
            </option>
          ))}
      </select>
    </label>
  )
}
export function BriefForm({
  models,
  initialBrief,
  initialConfig,
  parent,
  onSubmit,
  composeOnly = false,
  onDraftChange,
}: {
  models: Model[]
  initialBrief: Brief
  initialConfig: RunConfig
  parent: Run | null
  composeOnly?: boolean
  onDraftChange?(brief: Brief, config: RunConfig): void
  onSubmit(brief: Brief, config: RunConfig, feedback?: string): Promise<void>
}): JSX.Element {
  const [brief, setBrief] = useState(initialBrief)
  const [config, setConfig] = useState(initialConfig)
  const [reviewModeId, setReviewModeId] = useState(
    reviewModeForLimits(initialConfig.limits)?.id ??
      REVIEW_MODES.find(mode => mode.limits.maxDurationMinutes === initialConfig.limits.maxDurationMinutes)?.id ??
      "standard",
  )
  const [templateId, setTemplateId] = useState(
    SEAT_TEMPLATES.find(
      template =>
        template.seats.length === initialConfig.seats.length &&
        template.seats.every((seat, index) => seat.id === initialConfig.seats[index]?.id),
    )?.id ?? "custom",
  )
  useEffect(() => {
    onDraftChange?.(brief, config)
  }, [brief, config, onDraftChange])
  const [feedback, setFeedback] = useState("")
  const [tab, setTab] = useState("brief")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const applyTemplate = (id: string) => {
    const template = SEAT_TEMPLATES.find(item => item.id === id)
    if (!template) return
    const enabled = models.filter(model => model.enabled)
    setTemplateId(id)
    setConfig(value => ({
      ...value,
      seats: template.seats.map((seat, index) => ({
        ...seat,
        modelKey:
          enabled.find(model => model.key === seat.modelKey)?.key ??
          enabled[index % Math.max(enabled.length, 1)]?.key ??
          seat.modelKey,
      })),
    }))
  }
  const addSeat = () => {
    if (config.seats.length >= 6) return
    const modelKey = models.find(model => model.enabled)?.key ?? "qwen"
    setTemplateId("custom")
    setConfig(value => ({
      ...value,
      seats: [
        ...value.seats,
        {
          id: `custom-${crypto.randomUUID().slice(0, 8)}`,
          name: "领域专家",
          mandate: "审查与本议题相关的专业假设、约束、证据缺口和可执行修改。",
          modelKey,
          perspective: "domain",
        },
      ],
    }))
  }
  const perspectives = new Set(config.seats.map(seat => seat.perspective))
  const missingPerspectives = [
    ["delivery", "交付视角"],
    ["risk", "风险视角"],
    ["challenge", "独立反方"],
  ].filter(([key]) => !perspectives.has(key as NonNullable<(typeof config.seats)[number]["perspective"]>))
  const selectedFamilies = new Set(
    config.seats.map(seat => models.find(model => model.key === seat.modelKey)?.family ?? seat.modelKey),
  )
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
    if (onDraftChange) {
      return
    }
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
        <span className="badge neutral">{parent ? "保留旧版" : `${config.seats.length} 席评审`}</span>
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
          <div className="template-picker">
            <label className="field">
              <span>评审模板</span>
              <select value={templateId} onChange={event => applyTemplate(event.target.value)}>
                {SEAT_TEMPLATES.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {template.seats.length} 席
                  </option>
                ))}
                {templateId === "custom" && <option value="custom">自定义</option>}
              </select>
            </label>
            <p className="hint">
              {SEAT_TEMPLATES.find(template => template.id === templateId)?.description ??
                "已自定义席位。模板不会限制后续编辑。"}
            </p>
          </div>
          <details className="advanced-members" open={templateId === "custom"}>
            <summary>高级设置 · 自定义席位</summary>
            <div className="role-grid">
              {config.seats.map((seat, index) => (
                <section key={seat.id} className="role-card">
                  <div className={`avatar color-${index}`}>{String(index + 1).padStart(2, "0")}</div>
                  <div className="inline-between">
                    <span className="hint">席位 {seat.id}</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={config.seats.length <= 2}
                      onClick={() => {
                        setTemplateId("custom")
                        setConfig({ ...config, seats: config.seats.filter(item => item.id !== seat.id) })
                      }}
                    >
                      移除
                    </button>
                  </div>
                  <label className="field">
                    <span>角色名称</span>
                    <input
                      value={seat.name}
                      onChange={event => {
                        setTemplateId("custom")
                        setConfig({
                          ...config,
                          seats: config.seats.map(item =>
                            item.id === seat.id ? { ...item, name: event.target.value } : item,
                          ),
                        })
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>评审视角</span>
                    <select
                      value={seat.perspective ?? "domain"}
                      onChange={event => {
                        setTemplateId("custom")
                        setConfig({
                          ...config,
                          seats: config.seats.map(item =>
                            item.id === seat.id
                              ? { ...item, perspective: event.target.value as NonNullable<typeof item.perspective> }
                              : item,
                          ),
                        })
                      }}
                    >
                      <option value="business">商业/用户价值</option>
                      <option value="delivery">产品与交付</option>
                      <option value="risk">财务/风险/合规</option>
                      <option value="challenge">独立反方</option>
                      <option value="domain">领域专家</option>
                    </select>
                  </label>
                  <ModelSelect
                    label="评审模型"
                    models={models}
                    value={seat.modelKey}
                    onChange={modelKey => {
                      setTemplateId("custom")
                      setConfig({
                        ...config,
                        seats: config.seats.map(item => (item.id === seat.id ? { ...item, modelKey } : item)),
                      })
                    }}
                  />
                  <label className="field">
                    <span>职责与评价尺度</span>
                    <textarea
                      rows={3}
                      value={seat.mandate}
                      onChange={event => {
                        setTemplateId("custom")
                        setConfig({
                          ...config,
                          seats: config.seats.map(item =>
                            item.id === seat.id ? { ...item, mandate: event.target.value } : item,
                          ),
                        })
                      }}
                    />
                  </label>
                </section>
              ))}
            </div>
            <button type="button" className="secondary" disabled={config.seats.length >= 6} onClick={addSeat}>
              ＋ 添加领域席位（最多 6 席）
            </button>
          </details>
          {missingPerspectives.length > 0 && (
            <div className="notice error">
              缺少{missingPerspectives.map(([, label]) => label).join("、")}。可以继续编辑，但不建议启动高风险评审。
            </div>
          )}
          {selectedFamilies.size < 2 && (
            <div className="notice error">当前只有一个模型族，无法形成跨模型族的独立覆盖。</div>
          )}
          {selectedFamilies.size < config.seats.length && (
            <div className="notice">部分角色使用相同模型族。多角色可切换视角，但不会被 Host 算作多个独立模型族。</div>
          )}
          <h3>评审模式</h3>
          <div className="review-mode-picker" role="radiogroup" aria-label="评审模式">
            {REVIEW_MODES.map(mode => (
              <button
                type="button"
                role="radio"
                aria-checked={reviewModeId === mode.id}
                className={reviewModeId === mode.id ? "selected" : ""}
                key={mode.id}
                onClick={() => {
                  setReviewModeId(mode.id)
                  setConfig({
                    ...config,
                    limits: structuredClone(mode.limits),
                  })
                }}
              >
                <strong>{mode.label}</strong>
                <span>{mode.duration}</span>
              </button>
            ))}
          </div>
          <p className="mode-description">
            {REVIEW_MODES.find(mode => mode.id === reviewModeId)?.description}
            任务满足结束条件时会提前完成。
          </p>
          <div className="form-footer">
            <button type="button" className="secondary" onClick={() => setTab("brief")}>
              ← 返回材料
            </button>
            {!onDraftChange && (
              <button type="submit" className="primary" disabled={busy}>
                {busy ? (composeOnly ? "正在回填…" : "正在创建…") : composeOnly ? "放入主聊天输入框" : "创建并开始评审"}
              </button>
            )}
          </div>
          <p className="hint">
            {onDraftChange
              ? "材料、角色和预算已实时同步为主聊天草稿。请在主聊天核对并发送后开始评审。"
              : composeOnly
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
        responses?: Array<{
          issueId: string
          position?: string
          evidenceStatus?: string
          blocking?: boolean
          reasoning: string
          proposedChange: string
        }>
        headline?: string
        changesSincePrevious?: string
        nextStep?: string
        caveat?: string
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
      {result.headline && <div className="strengths">主持解读：{result.headline}</div>}
      {result.changesSincePrevious && <p className="hint">相比上一轮：{result.changesSincePrevious}</p>}
      {result.nextStep && <p className="hint">下一步：{result.nextStep}</p>}
      {result.caveat && <p className="hint">{result.caveat}</p>}
      {result.strengths?.length ? <div className="strengths">应保留：{result.strengths.join("；")}</div> : null}
      {result.issues?.map((issue, index) => (
        <p className="finding" key={index}>
          <strong>{issue.title ?? issue.verdict}</strong> {issue.rationale ?? issue.reason}
        </p>
      ))}
      {result.responses?.map(response => (
        <div key={response.issueId} className="finding">
          <span className="issue-ref">{response.issueId}</span>
          <span className={`badge ${response.blocking ? "warning" : "neutral"}`}>
            {response.position ?? "历史意见"} · {response.evidenceStatus ?? "未记录证据状态"}
          </span>
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
    setError("")
  }
  const metrics = run ? spent(run) : null
  const selectRun = async (item: Run) => {
    setRun(await api.request<Run>(`/runs/${item.id}`))
    setDecisionReason("")
    setParent(null)
  }
  const unresolved = run?.issues.filter(issue => issue.status !== "addressed").length ?? 0
  const hasInterruptedCalls = run?.calls.some(call => call.status === "interrupted") ?? false
  const deliberation = useMemo(() => (run ? assessDeliberation(run) : null), [run])
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
                  <span>{durationLimit(run.config.limits.maxDurationMinutes)}</span>
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
                <div>
                  <small>MCP 补证</small>
                  <strong>
                    {run.mcpEvidence.length} <em>条材料</em>
                  </strong>
                  <span>
                    调用 {run.mcpCalls.length} / {run.config.limits.maxMcpCalls}
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
              {deliberation && run.phase !== "independent" && (
                <section className="ballot-overview" aria-labelledby="ballot-overview-title">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">Host 确定性聚合</span>
                      <h2 id="ballot-overview-title">表决总览</h2>
                      <p>逐问题显示覆盖、票型、证据状态和阻断票。多数意见不能把待核验判断变成事实。</p>
                    </div>
                    <span className={`badge ${deliberation.coverageSatisfied ? "good" : "warning"}`}>
                      {deliberation.coverageSatisfied ? "覆盖达标" : "覆盖进行中"} · 无新增 {deliberation.stagnantRounds}/3
                    </span>
                  </div>
                  <div className="ballot-legend">
                    <span>
                      <strong>独立覆盖</strong>：已投票席位／模型族与最低要求
                    </span>
                    <span>
                      <strong>阻断票</strong>：认为问题未解决就不应推进
                    </span>
                    <span>
                      <strong>立场</strong>：维持判断、修改方案、否决、弃权或待补证
                    </span>
                    <span>
                      <strong>证据</strong>：材料支持、冲突或缺失，不代表外部核验
                    </span>
                    <span>
                      <strong>连续无新增</strong>：达到 3 轮后 Host 强制收敛，席位继续意愿仅作参考
                    </span>
                  </div>
                  {deliberation.issues.length === 0 ? (
                    <div className="empty-state">主持整理问题后开始显示表决。</div>
                  ) : (
                    <div className="ballot-grid">
                      {deliberation.issues.map(ballot => {
                        const issue = run.issues.find(item => item.id === ballot.issueId)!
                        return (
                          <article className="ballot-row" key={ballot.issueId} data-blocking={ballot.blockingVotes > 0}>
                            <div className="ballot-title">
                              <span className="issue-ref">{issue.id}</span>
                              <strong>{issue.title}</strong>
                              <span className="badge neutral">{issue.severity}</span>
                              {(issue.sourceIssueIds?.length ?? 1) > 1 && (
                                <span className="badge neutral">合并 {issue.sourceIssueIds!.length} 条首评</span>
                              )}
                            </div>
                            <div className="ballot-coverage">
                              <span>
                                {ballot.reviewerCount} 席 · 最低 {ballot.requiredReviewers}
                              </span>
                              <span>
                                {ballot.modelFamilyCount} 模型族 · 最低 {ballot.requiredModelFamilies}
                              </span>
                              <span className={ballot.blockingVotes ? "blocking" : ""}>
                                阻断票 {ballot.blockingVotes}
                              </span>
                            </div>
                            <div className="ballot-votes" aria-label={`${issue.title}的表决票型`}>
                              <span>
                                维持 <strong>{ballot.positions.maintain}</strong>
                              </span>
                              <span>
                                修改 <strong>{ballot.positions.revise}</strong>
                              </span>
                              <span>
                                否决 <strong>{ballot.positions.reject}</strong>
                              </span>
                              <span>
                                弃权 <strong>{ballot.positions.abstain}</strong>
                              </span>
                              <span>
                                待补证 <strong>{ballot.positions.needs_evidence}</strong>
                              </span>
                            </div>
                            <div className="ballot-evidence">
                              证据：支持 {ballot.evidence.supported} · 冲突 {ballot.evidence.conflicting} · 缺失{" "}
                              {ballot.evidence.missing}
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}
                </section>
              )}
              {run.stopReason && <div className="notice">{run.stopReason}</div>}
              {run.status === "paused" && hasInterruptedCalls && (
                <div className="notice recovery-notice" role="note">
                  <strong>需要你确认后重试</strong>
                  <p>为避免上游重复计费，中断或超时不会自动重试。点击“从检查点继续”后，只重试未完成步骤。</p>
                </div>
              )}
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
                            {(() => {
                              const ballot = deliberation?.issues.find(item => item.issueId === issue.id)
                              return ballot ? (
                                <>
                                  <dt>独立覆盖</dt>
                                  <dd>
                                    席位 {ballot.reviewerCount}/{ballot.requiredReviewers} · 模型族{" "}
                                    {ballot.modelFamilyCount}/{ballot.requiredModelFamilies} · 阻断票{" "}
                                    {ballot.blockingVotes}
                                  </dd>
                                  <dt>票型</dt>
                                  <dd>
                                    维持 {ballot.positions.maintain} · 修改 {ballot.positions.revise} · 否决{" "}
                                    {ballot.positions.reject} · 弃权 {ballot.positions.abstain} · 待补证{" "}
                                    {ballot.positions.needs_evidence}
                                  </dd>
                                  <dt>证据状态</dt>
                                  <dd>
                                    支持 {ballot.evidence.supported} · 冲突 {ballot.evidence.conflicting} · 缺失{" "}
                                    {ballot.evidence.missing}
                                  </dd>
                                </>
                              ) : null
                            })()}
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
