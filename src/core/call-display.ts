import type { CallProgress } from "./schema.js"

export function progressSummary(progress: CallProgress): string {
  const response =
    progress.firstResponseAt === undefined
      ? "尚未收到上游流数据"
      : `首次响应 ${Math.max(0, (progress.firstResponseAt - progress.requestStartedAt) / 1000).toFixed(1)} 秒`
  return `${response} · 思考 ${progress.reasoningChars.toLocaleString()} 字符 · 正文 ${progress.textChars.toLocaleString()} 字符${progress.finishReason ? ` · 结束：${progress.finishReason}` : ""}`
}

export function accountingLabel(accounting?: string): string {
  return accounting === "reported"
    ? "已报告用量"
    : accounting === "reserved"
      ? "预留额度"
      : accounting === "uncertain"
        ? "用量未知，暂占额度"
        : accounting === "not_sent"
          ? "未发送"
          : "已计入／预留额度"
}
