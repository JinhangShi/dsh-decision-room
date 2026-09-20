import type { Brief, RunConfig } from "./core/schema.js"

export function composeDecisionRequest(brief: Brief, config: RunConfig): string {
  return `请开始一次多模型决策评审，按照以下材料、角色和预算执行，在本主聊天中展示调用进度、各方意见、完整修订稿和独立复核。不得自行扩大预算；缺少证据时保留分歧。\n\n议题：${brief.title}\n决策问题：${brief.question}\n目标与成功标准：${brief.objective}\n硬约束：${brief.constraints}\n\n方案正文：\n${brief.plan}\n${brief.sources.map(source => `\n补充材料 ${source.id} · ${source.title}（待核验）：\n${source.text}\n`).join("")}\n评审成员：\n${config.seats.map(seat => `- ${seat.name}（席位 ${seat.id}，模型 ${seat.modelKey}）：${seat.mandate}`).join("\n")}\n主持与编辑模型：${config.moderatorKey}\n独立复核模型：${config.verifierKey}\n\n执行上限：${config.limits.maxDurationMinutes} 分钟，最多 ${config.limits.maxRounds} 轮交叉讨论、${config.limits.maxCalls} 次模型调用、${config.limits.tokenBudget} Token；并发 ${config.limits.concurrency}，单次输出 ${config.limits.outputTokens} Token，单次超时 ${config.limits.callTimeoutSeconds} 秒。${config.limits.maxCostCny === null ? "价格尚未核定，按 Token、次数和时间限制执行。" : `金额上限 ${config.limits.maxCostCny} 元。`}\n\n请使用 decision_room_start 启动；不要只口头模拟四个角色。`
}

export type ComposerInput = {
  state: { getSnapshot(): { draft: string; phase?: string } }
  setDraft(text: string): void
}
export function fillDecisionDraft(input: ComposerInput, text: string, previousGenerated?: string): void {
  const { draft, phase } = input.state.getSnapshot()
  if (phase === "submitting" || phase === "adjudicating") {
    throw new Error("当前聊天正在提交，请稍后回填，材料已保留")
  }
  if (draft.trim() && draft.trim() !== text.trim() && draft !== previousGenerated) {
    throw new Error("主聊天已有未发送的文字，请先发送或清空；材料已保留，没有覆盖你的草稿")
  }
  input.setDraft(text)
}
