import { activeElapsed, spent } from "./budget.js"
import { assessDeliberation } from "./deliberation.js"
import type { Model } from "./models.js"
import {
  ballotInterpretationSchema,
  configurationWarnings,
  isReviewCall,
  readDebateResult,
  type Run,
} from "./schema.js"

export function formatChinaTime(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00")
}

export function reportMarkdown(run: Run, models: Model[]): string {
  const usage = spent(run)
  const complete = run.status === "completed" && run.revisionResult && run.verification
  const unresolved = run.issues.filter(issue => issue.status !== "addressed")
  const deliberation = assessDeliberation(run)
  const configWarnings = configurationWarnings(run.config)
  const lines = [
    `# ${run.brief.title} · V${run.version}`,
    "",
    run.mode === "demo"
      ? "> 演示数据：本报告使用确定性模拟模型，未执行外部调用。"
      : "> AI 辅助评审。仅依据提交材料；未执行外部事实核验。返回的模型名称是网关声明，不是独立身份认证。",
    "",
    complete ? "状态：修订与复核完成，等待或已记录人工取舍。" : "状态：阶段性记录，尚未完成完整修订与复核。",
    `任务 ID：${run.id} · 材料摘要：${run.briefHash}`,
    "",
    "## 目标与边界",
    "",
    run.brief.question,
    "",
    run.brief.objective,
    "",
    run.brief.constraints,
    "",
    "## 决策摘要",
    "",
    run.revisionResult?.summary ?? "尚未生成。请查看阶段记录与停止原因。",
    `编辑建议：${({ pilot: "可在限定条件下试点", need_evidence: "需补证", hold: "暂缓" } as const)[run.revisionResult?.recommendation ?? "need_evidence"]}`,
    unresolved.length > 0
      ? `Host 覆盖提示：仍有 ${unresolved.length} 项未解决或待补证问题，不能视为无条件通过。`
      : "Host 覆盖提示：没有登记的未解决问题不等于方案无风险。",
    "",
    "## 修改后的完整方案",
    "",
    run.revisionResult?.fullPlan ?? "尚未生成完整修订方案。原始方案保存在本报告末尾。",
    "",
    "## 修改对照",
    "",
  ]
  const interpretations = run.calls
    .filter(call => isReviewCall(call) && call.phase === "interpret" && call.status === "succeeded")
    .sort((a, b) => a.round - b.round)
  if (interpretations.length) {
    lines.push("## 逐轮表决解读", "")
    for (const call of interpretations) {
      const value = ballotInterpretationSchema.parse(call.result)
      lines.push(
        `### 第 ${call.round} 轮 · ${value.headline}`,
        "",
        value.summary,
        "",
        `- 关键信号：${value.decisionSignal}`,
        `- 重点问题：${value.keyIssueIds.join("、") || "无"}`,
        `- 相比上一轮：${value.changesSincePrevious}`,
        `- 建议下一步：${value.nextStep}`,
        `- 注意：${value.caveat}`,
        "",
      )
    }
  }
  for (const change of run.revisionResult?.changes ?? []) {
    lines.push(
      `### ${change.issueId} · ${{ accepted: "采纳", partial: "部分采纳", rejected: "未采纳" }[change.disposition]}`,
      "",
      change.change,
      "",
      `理由：${change.reason}`,
      "",
    )
  }
  lines.push("## 未解决问题与异议（Host 自动附录）", "")
  if (!unresolved.length) {
    lines.push("当前问题台账没有未解决项；仍需人判断证据和业务适用性。", "")
  }
  for (const issue of unresolved) {
    const ballot = deliberation.issues.find(item => item.issueId === issue.id)
    lines.push(
      `### ${issue.id} · ${issue.title}`,
      "",
      `严重度：${issue.severity}；状态：${issue.status}`,
      "",
      issue.rationale,
      "",
      `建议：${issue.suggestedChange}`,
      "",
      `改变意见所需证据：${issue.whatWouldChangeMind}`,
      "",
      `材料引用：${issue.evidenceIds.join("、") || "无，属于待验证判断"}`,
      "",
      `复核说明：${issue.resolution ?? "尚未复核"}`,
      "",
      ballot
        ? `独立覆盖：席位 ${ballot.reviewerCount}/${ballot.requiredReviewers}，模型族 ${ballot.modelFamilyCount}/${ballot.requiredModelFamilies}；票型：维持 ${ballot.positions.maintain}、修改 ${ballot.positions.revise}、否决 ${ballot.positions.reject}、弃权 ${ballot.positions.abstain}、待补证 ${ballot.positions.needs_evidence}；阻断票 ${ballot.blockingVotes}`
        : "独立覆盖：尚无讨论票据",
      "",
    )
  }
  const latestResponses = new Map<
    string,
    { seatId: string; round: number; response: ReturnType<typeof readDebateResult>["responses"][number] }
  >()
  if (run.phase !== "independent") {
    for (const call of run.calls.filter(
      call => isReviewCall(call) && call.phase === "discuss" && call.status === "succeeded",
    )) {
      for (const response of readDebateResult(call.result).responses) {
        latestResponses.set(`${call.seatId}:${response.issueId}`, { seatId: call.seatId, round: call.round, response })
      }
    }
  }
  if (latestResponses.size) lines.push("## 各席最新意见与异议（模型判断，不作为已核验事实）", "")
  for (const { seatId, round, response } of latestResponses.values()) {
    lines.push(
      `### ${seatId} · ${response.issueId} · 第 ${round} 轮`,
      "",
      response.reasoning,
      "",
      `修改建议：${response.proposedChange}`,
      "",
      `改变意见的条件：${response.whatWouldChangeMind}`,
      "",
      `立场：${response.position}；证据状态：${response.evidenceStatus}；阻断：${response.blocking ? "是" : "否"}；引用：${response.evidenceIds.join("、") || "待补证"}`,
      "",
    )
  }
  lines.push("## 试点与验证计划", "")
  for (const experiment of run.revisionResult?.experiments ?? []) {
    lines.push(
      `- 假设：${experiment.hypothesis}\n  - 方法：${experiment.method}\n  - 指标：${experiment.metric}\n  - 责任角色：${experiment.ownerRole}\n  - 停止条件：${experiment.stopCondition}`,
      "",
    )
  }
  lines.push("## 独立复核", "", run.verification?.summary ?? "尚未完成复核。", "")
  for (const violation of run.verification?.constraintViolations ?? []) {
    lines.push(`- 约束问题：${violation}`)
  }
  lines.push(
    "",
    "## 人工取舍",
    "",
    run.humanDecision
      ? `${{ adopt: "采纳", reject: "不采纳", defer: "暂缓决策" }[run.humanDecision.decision]}：${run.humanDecision.reason}`
      : "尚未记录。模型建议不能替代人工采纳。",
    "",
    "## 覆盖与用量",
    "",
  )
  for (const seat of run.config.seats) {
    const model = models.find(item => item.key === seat.modelKey)
    const returned = [
      ...new Set(
        run.calls.filter(call => call.seatId === seat.id && call.returnedModel).map(call => call.returnedModel),
      ),
    ]
    lines.push(
      `- ${seat.name}：${model?.model ?? seat.modelKey}；返回声明：${returned.join("、") || "尚无／宿主未提供上游身份"}`,
    )
  }
  const families = new Set(
    run.config.seats.map(seat => models.find(model => model.key === seat.modelKey)?.family ?? seat.modelKey),
  )
  lines.push(
    `- 模型族数量：${families.size}。同模型多角色不构成多个独立模型；不同模型也可能共享训练偏差。`,
    ...configWarnings.map(warning => `- 配置警告：${warning}`),
    `- 讨论聚合：${deliberation.coverageSatisfied ? "所需独立覆盖已达到" : "独立覆盖尚未达到"}；连续无新增轮次 ${deliberation.stagnantRounds}/3。席位的继续讨论意愿只作参考，票型不把多数意见变成事实。`,
    `- 调用：${usage.calls}/${run.config.limits.maxCalls}；已计入及预留 Token：${usage.tokens}；其中 ${usage.uncertain} 次用量未确定。`,
    `- MCP 补证：调用 ${run.mcpCalls.length}/${run.config.limits.maxMcpCalls} 次；取得 ${run.mcpEvidence.length} 条材料；失败、拒绝或取消 ${run.mcpCalls.filter(item => ["failed", "denied", "cancelled"].includes(item.status)).length} 项。模型可自行选择当前 DSH 已安装的 MCP 工具，调用仍受 DSH 权限策略约束。`,
    `- 费用：${usage.costCny === null ? "价格未配置，金额未核定" : `按配置价格估算 ¥${usage.costCny.toFixed(6)}，最终以供应商账单为准`}`,
    `- 活跃时间：${Math.ceil(activeElapsed(run) / 60000)} 分钟；最长 ${
      run.config.limits.maxDurationMinutes >= 60 && run.config.limits.maxDurationMinutes % 60 === 0
        ? `${run.config.limits.maxDurationMinutes / 60} 小时`
        : `${run.config.limits.maxDurationMinutes} 分钟`
    }。`,
    `- 停止说明：${run.stopReason ?? "按阶段终止条件完成"}`,
    "",
    "## 材料目录",
    "",
    "- proposal：原始方案（用户提交，未经独立事实核验）",
  )
  for (const source of run.brief.sources) {
    lines.push(
      `- ${source.id}：${source.title}${source.url ? `；出处 ${source.url}` : ""}（用户提交，未经独立事实核验）`,
    )
  }
  for (const source of run.mcpEvidence) {
    lines.push(
      `- ${source.id}：${source.toolName} 返回材料（于 ${formatChinaTime(source.retrievedAt)} 取得，属于未经独立核验的 MCP 输出）`,
    )
  }
  if (run.feedback) {
    lines.push("- humanFeedback：本轮人工反馈（用户提交，未经独立事实核验）")
  }
  lines.push("", "## 原始方案", "", run.brief.plan, "", "## 操作与阶段记录", "")
  for (const item of run.events) {
    lines.push(`- ${formatChinaTime(item.at)} · ${item.text}`)
  }
  return lines.join("\n")
}
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
export function reportHtml(run: Run, models: Model[]): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(run.brief.title)}</title><style>body{margin:0;background:#f4f7fb;color:#17263a;font:16px/1.8 system-ui,sans-serif}main{max-width:980px;margin:40px auto;padding:48px;background:white;border-radius:16px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}@media print{body,main{background:white;margin:0;padding:12px}}</style><main><pre>${escapeHtml(reportMarkdown(run, models))}</pre></main></html>`
}
