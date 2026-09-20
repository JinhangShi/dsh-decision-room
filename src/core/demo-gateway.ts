import type { ModelGateway, ModelRequest, ModelResponse } from "./gateway.js"

/** Explicit opt-in development fixture. Never used as an automatic fallback. */
export class DemoGateway implements ModelGateway {
  constructor(private delayMs = 150) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(new Error("aborted"))
      }
      const timer = setTimeout(() => {
        request.signal.removeEventListener("abort", abort)
        resolve()
      }, this.delayMs)
      if (request.signal.aborted) {
        abort()
      } else {
        request.signal.addEventListener("abort", abort, { once: true })
      }
    })
    const input = JSON.parse(request.prompt) as {
      phase: string
      brief: { title: string; plan: string; constraints: string }
      role?: { id: string }
      issues?: Array<{ id: string }>
      assignedIssueIds?: string[]
    }
    let result: unknown
    if (input.phase === "independent") {
      const titles: Record<string, string> = {
        growth: "增长假设缺少试点数据",
        delivery: "实施依赖尚未排序",
        risk: "风险触发条件需要明确",
        challenge: "需要比较维持现状的替代方案",
      }
      result = {
        summary: "[演示] 方案方向有探索价值，建议先用可逆试点验证。",
        strengths: ["[演示] 明确了业务目标和资源边界。"],
        issues: [
          {
            title: titles[input.role?.id ?? ""] ?? "需要验证关键假设",
            kind: input.role?.id === "growth" ? "missing_evidence" : "design",
            severity: "high",
            rationale: "[演示] 材料中的关键前提尚不足以支持扩大投入。",
            evidenceIds: ["proposal"],
            suggestedChange: "限定试点范围，明确数据口径、负责人和停止条件。",
            whatWouldChangeMind: "获得按同一口径采集的试点结果，并验证不触及硬约束。",
          },
        ],
      }
    } else if (input.phase === "organize") {
      result = {
        summary: "[演示] 将增长证据、交付依赖和停止条件作为本轮重点。",
        priorityIssueIds: (input.issues ?? []).map(issue => issue.id),
      }
    } else if (input.phase === "discuss") {
      result = {
        summary: "[演示] 已提出具体修改，继续讨论需要新证据。",
        continueDiscussion: false,
        responses: (input.assignedIssueIds ?? []).map(issueId => ({
          issueId,
          position: "needs_evidence",
          reasoning: "现有材料不能证明业务假设，建议保留异议并试点取证。",
          evidenceIds: ["proposal"],
          proposedChange: "增加试点数据收集与停止机制。",
        })),
      }
    } else if (input.phase === "revise") {
      result = {
        summary: "[演示] 建议进入有限试点，暂不扩大投入。",
        recommendation: "need_evidence",
        fullPlan: `[演示修订方案]\n\n${input.brief.title}\n\n一、原始方案与目标\n${input.brief.plan}\n\n二、必须遵守的边界\n${input.brief.constraints}\n\n三、实施步骤\n先确认客户问题和指标口径，再开展小范围可逆试点。产品负责交付清单，经营负责人核对资源，风险负责人检查数据使用范围。每个阶段保留记录。\n\n四、验证和扩大条件\n采集试点指标，比较维持现状与新增投入的表现。缺少有效样本时保留未知项，不编造收益。满足事先设定的指标和全部约束后，由人决定是否扩大。\n\n五、停止和回退\n触及硬约束、资源上限或数据质量不足时停止试点，恢复原流程并复盘。`,
        changes: (input.issues ?? []).map(issue => ({
          issueId: issue.id,
          disposition: "partial",
          change: "增加可逆试点、证据收集及停止条件。",
          reason: "设计可以补充，业务事实仍需后续验证。",
        })),
        experiments: [
          {
            hypothesis: "目标客户的问题值得解决",
            method: "有限样本试点，与现有方式对照",
            metric: "由业务负责人预先确定，不虚构数值",
            ownerRole: "产品负责人",
            stopCondition: "触及硬约束或投入上限立即停止",
          },
        ],
      }
    } else {
      result = {
        summary: "[演示] 修订稿包含边界与回退步骤；业务效果仍需证据。",
        constraintViolations: [],
        issues: (input.issues ?? []).map(issue => ({
          issueId: issue.id,
          verdict: "needs_evidence",
          reason: "设计已回应，但尚无试点事实支持。",
          evidenceIds: ["proposal"],
        })),
      }
    }
    return {
      text: JSON.stringify(result),
      returnedModel: request.model.model,
      usage: { inputTokens: 240, outputTokens: 300, totalTokens: 540 },
    }
  }
}
