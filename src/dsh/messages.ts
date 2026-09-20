import type {} from "@deepseek-ai/dsh-session"
import type { Model } from "../core/models.js"
import { reportMarkdown } from "../core/report.js"
import { spent } from "../core/budget.js"
import {
  debateSchema,
  organizeSchema,
  reviewSchema,
  revisionSchema,
  verificationSchema,
  type Run,
} from "../core/schema.js"

export type DecisionMessage = {
  id: string
  runId: string
  version: number
  role: string
  model: string
  phase: string
  text: string
  at: number
  kind: "brief" | "review" | "report" | "notice"
}
export type DecisionProgress = {
  id: string
  runId: string
  revision: number
  version: number
  title: string
  status: Run["status"]
  phase: string
  round: number
  tokens: number
  tokenBudget: number
  maxCalls: number
  stopReason?: string
  seats: Array<{ id: string; name: string; model: string }>
  calls: Array<{
    id: string
    seatId: string
    role: string
    model: string
    phase: string
    round: number
    status: string
    purpose?: string
    tokens: number
    error?: string
  }>
}
declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "decision-room/message": DecisionMessage
    "decision-room/progress": { initial: boolean; progress: DecisionProgress }
  }
}
const PHASE = {
  independent: "独立评审",
  organize: "整理问题",
  discuss: "交叉讨论",
  revise: "修订方案",
  verify: "独立复核",
  finished: "已完成",
}

export function decisionProgress(run: Run, models: Model[]): DecisionProgress {
  const modelLabel = (key: string) => models.find(model => model.key === key)?.label ?? key
  const role = (id: string) =>
    run.config.seats.find(seat => seat.id === id)?.name ?? (id === "verifier" ? "独立复核" : "主持与编辑")
  return {
    id: `${run.id}:progress`,
    runId: run.id,
    revision: run.revision,
    version: run.version,
    title: run.brief.title,
    status: run.status,
    phase: PHASE[run.phase],
    round: run.round,
    tokens: spent(run).tokens,
    tokenBudget: run.config.limits.tokenBudget,
    maxCalls: run.config.limits.maxCalls,
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    seats: run.config.seats.map(seat => ({ id: seat.id, name: seat.name, model: modelLabel(seat.modelKey) })),
    calls: run.calls.map(call => ({
      id: call.id,
      seatId: call.seatId,
      role: role(call.seatId),
      model: modelLabel(call.modelKey),
      phase: PHASE[call.phase],
      round: call.round,
      status: call.status,
      ...(call.purpose ? { purpose: call.purpose } : {}),
      tokens: call.accountedTokens,
      ...(call.error ? { error: call.error } : {}),
    })),
  }
}

export function decisionMessages(run: Run, models: Model[]): DecisionMessage[] {
  const make = (
    id: string,
    role: string,
    phase: string,
    text: string,
    kind: DecisionMessage["kind"],
    at: number,
    model = "",
  ): DecisionMessage => ({
    id: `${run.id}:${id}`,
    runId: run.id,
    version: run.version,
    role,
    phase,
    text,
    kind,
    at,
    model,
  })
  const result = [
    make(
      "brief",
      "提交方案",
      "评审议题",
      `# ${run.brief.title}\n\n决策问题：${run.brief.question}\n\n目标：${run.brief.objective}\n\n硬约束：${run.brief.constraints}\n\n${run.brief.plan}${run.feedback ? `\n\n本轮人工反馈：${run.feedback}` : ""}`,
      "brief",
      run.createdAt,
    ),
  ]
  if (run.phase !== "independent") {
    for (const call of run.calls.filter(
      call => call.purpose !== "compaction" && call.status === "succeeded" && call.result,
    )) {
      let text = ""
      if (call.phase === "independent") {
        const value = reviewSchema.parse(call.result)
        text = `${value.summary}\n\n值得保留：\n${value.strengths.map(item => `- ${item}`).join("\n")}\n\n${value.issues.map((issue, index) => `### I-${call.seatId}-${index + 1} · ${issue.title}\n\n${issue.rationale}\n\n建议：${issue.suggestedChange}\n\n改变意见所需证据：${issue.whatWouldChangeMind}\n\n材料引用：${issue.evidenceIds.join("、") || "待补证"}`).join("\n\n")}`
      } else if (call.phase === "organize") {
        const value = organizeSchema.parse(call.result)
        text = `${value.summary}\n\n优先讨论：${value.priorityIssueIds.join("、")}`
      } else if (call.phase === "discuss") {
        const value = debateSchema.parse(call.result)
        text = `${value.summary}\n\n${value.responses.map(response => `### ${response.issueId} · ${{ maintain: "维持判断", revise: "调整判断", needs_evidence: "需要补证" }[response.position]}\n\n${response.reasoning}\n\n修改建议：${response.proposedChange}\n\n材料引用：${response.evidenceIds.join("、") || "待补证"}`).join("\n\n")}`
      } else if (call.phase === "revise") {
        const value = revisionSchema.parse(call.result)
        text = `${value.summary}\n\n${value.fullPlan}\n\n修改对应：\n${value.changes.map(change => `- ${change.issueId}：${change.change}；理由：${change.reason}`).join("\n")}`
      } else if (call.phase === "verify") {
        const value = verificationSchema.parse(call.result)
        text = `${value.summary}\n\n约束问题：\n${value.constraintViolations.map(item => `- ${item}`).join("\n") || "未报告违反项，仍需人工判断。"}\n\n${value.issues.map(issue => `- ${issue.issueId} · ${issue.verdict}：${issue.reason}`).join("\n")}`
      }
      const role =
        run.config.seats.find(seat => seat.id === call.seatId)?.name ??
        (call.seatId === "verifier" ? "独立复核" : "主持与编辑")
      result.push(
        make(
          call.id,
          role,
          `${PHASE[call.phase]}${call.round ? ` · 第 ${call.round} 轮` : ""}`,
          text,
          "review",
          call.endedAt ?? call.startedAt,
          call.returnedModel ?? models.find(model => model.key === call.modelKey)?.label ?? call.modelKey,
        ),
      )
    }
  }
  for (const event of run.events.filter(event =>
    ["paused", "pause", "cancel", "recovered", "human_decision"].includes(event.type),
  )) {
    result.push(make(event.id, "决策室", "任务状态", event.text, "notice", event.at))
  }
  if (run.status === "completed") {
    result.push(make("report", "决策报告", "等待人工取舍", reportMarkdown(run, models), "report", run.updatedAt))
  }
  return result
}
