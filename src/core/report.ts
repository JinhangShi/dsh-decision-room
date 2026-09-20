import { activeElapsed, spent } from "./budget.js"
import type { Model } from "./models.js"
import type { Run } from "./schema.js"

export function reportMarkdown(run: Run, models: Model[]): string {
  const usage = spent(run)
  const complete = run.status === "completed" && run.revisionResult && run.verification
  const unresolved = run.issues.filter(issue => issue.status !== "addressed")
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
    `- 调用：${usage.calls}/${run.config.limits.maxCalls}；已计入及预留 Token：${usage.tokens}；其中 ${usage.uncertain} 次用量未确定。`,
    `- 费用：${usage.costCny === null ? "价格未配置，金额未核定" : `按配置价格估算 ¥${usage.costCny.toFixed(6)}，最终以供应商账单为准`}`,
    `- 活跃时间：${Math.ceil(activeElapsed(run) / 60000)} 分钟；最长 ${run.config.limits.maxDurationMinutes} 分钟。`,
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
  lines.push("", "## 原始方案", "", run.brief.plan, "", "## 操作与阶段记录", "")
  for (const item of run.events) {
    lines.push(`- ${new Date(item.at).toISOString()} · ${item.text}`)
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
