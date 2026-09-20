import { z } from "zod"

const short = z.string().trim().min(1).max(2000)
const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/)
export const scopeSchema = z.object({ sessionId: id, workspaceId: z.string().min(1).max(500) }).strict()
export const sourceSchema = z
  .object({
    id,
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(30000),
    url: z.string().url().optional(),
  })
  .strict()
export const briefSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    question: short,
    objective: short,
    constraints: z.string().trim().min(1).max(8000),
    plan: z.string().trim().min(20).max(80000),
    sources: z.array(sourceSchema).max(16).default([]),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (
      new Set(brief.sources.map(source => source.id)).size !== brief.sources.length ||
      brief.sources.some(source => source.id === "proposal")
    ) {
      ctx.addIssue({ code: "custom", message: "材料 ID 不得重复，也不能使用保留 ID proposal" })
    }
    if (brief.sources.reduce((size, source) => size + source.text.length, brief.plan.length) > 120000) {
      ctx.addIssue({ code: "custom", message: "提交材料合计不能超过 12 万字符" })
    }
  })
export const seatSchema = z
  .object({ id, name: z.string().min(1).max(60), mandate: z.string().min(1).max(3000), modelKey: id })
  .strict()
export const limitsSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(80),
    maxCalls: z.number().int().min(8).max(400),
    maxDurationMinutes: z.number().int().min(1).max(480),
    concurrency: z.number().int().min(1).max(4),
    tokenBudget: z.number().int().min(2000).max(20000000),
    maxCostCny: z.number().positive().max(100000).nullable(),
    outputTokens: z.number().int().min(512).max(16000),
    callTimeoutSeconds: z.number().int().min(5).max(300),
  })
  .strict()
export const runConfigSchema = z
  .object({ seats: z.array(seatSchema).min(2).max(6), moderatorKey: id, verifierKey: id, limits: limitsSchema })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.seats.map(seat => seat.id)).size !== config.seats.length) {
      ctx.addIssue({ code: "custom", message: "评审席位 ID 不得重复" })
    }
  })
export const createSchema = z
  .object({
    scope: scopeSchema,
    brief: briefSchema,
    config: runConfigSchema,
    parentId: id.optional(),
    feedback: z.string().min(1).max(10000).optional(),
  })
  .strict()

export const issueInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    kind: z.enum(["fact", "design", "tradeoff", "missing_evidence"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    rationale: short,
    evidenceIds: z.array(id).max(16),
    suggestedChange: short,
    whatWouldChangeMind: short,
  })
  .strict()
export const reviewSchema = z
  .object({ summary: short, strengths: z.array(short).max(8), issues: z.array(issueInputSchema).max(8) })
  .strict()
export const organizeSchema = z.object({ summary: short, priorityIssueIds: z.array(id).max(48) }).strict()
export const debateSchema = z
  .object({
    summary: short,
    continueDiscussion: z.boolean(),
    responses: z
      .array(
        z
          .object({
            issueId: id,
            position: z.enum(["maintain", "revise", "needs_evidence"]),
            reasoning: short,
            evidenceIds: z.array(id).max(16),
            proposedChange: short,
          })
          .strict(),
      )
      .max(48),
  })
  .strict()
export const revisionSchema = z
  .object({
    summary: short,
    recommendation: z.enum(["pilot", "need_evidence", "hold"]),
    fullPlan: z.string().min(80).max(60000),
    changes: z
      .array(
        z
          .object({
            issueId: id,
            disposition: z.enum(["accepted", "partial", "rejected"]),
            change: short,
            reason: short,
          })
          .strict(),
      )
      .max(48),
    experiments: z
      .array(
        z.object({ hypothesis: short, method: short, metric: short, ownerRole: short, stopCondition: short }).strict(),
      )
      .max(12),
  })
  .strict()
export const verificationSchema = z
  .object({
    summary: short,
    constraintViolations: z.array(short).max(16),
    issues: z
      .array(
        z
          .object({
            issueId: id,
            verdict: z.enum(["addressed", "open", "needs_evidence"]),
            reason: short,
            evidenceIds: z.array(id).max(16),
          })
          .strict(),
      )
      .max(48),
  })
  .strict()
export const phaseSchema = z.enum(["independent", "organize", "discuss", "revise", "verify", "finished"])
export type Phase = z.infer<typeof phaseSchema>
export type Brief = z.infer<typeof briefSchema>
export type Scope = z.infer<typeof scopeSchema>
export type RunConfig = z.infer<typeof runConfigSchema>
export type CreateInput = z.infer<typeof createSchema>
export type Review = z.infer<typeof reviewSchema>
export type Debate = z.infer<typeof debateSchema>
export type Revision = z.infer<typeof revisionSchema>
export type Verification = z.infer<typeof verificationSchema>
export type CallResult = Review | z.infer<typeof organizeSchema> | Debate | Revision | Verification

export const issueSchema = issueInputSchema.extend({
  id,
  sourceCallId: id,
  seatId: id,
  status: z.enum(["open", "addressed", "needs_evidence"]),
  resolution: z.string().optional(),
})
export type Issue = z.infer<typeof issueSchema>
export const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
})
export type Usage = z.infer<typeof usageSchema>
export const callSchema = z.object({
  id,
  purpose: z.enum(["review", "compaction"]).optional(),
  contextSessionId: z.string().optional(),
  key: z.string(),
  phase: phaseSchema,
  round: z.number(),
  epoch: z.number(),
  seatId: z.string(),
  modelKey: id,
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  attempt: z.number(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  reservedTokens: z.number(),
  reservedCost: z.number().nullable(),
  accountedTokens: z.number(),
  accountedCost: z.number().nullable(),
  usage: usageSchema.optional(),
  accounting: z.enum(["reserved", "reported", "uncertain"]),
  returnedModel: z.string().optional(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  promptHash: z.string(),
})
export type Call = z.infer<typeof callSchema>
export const eventSchema = z.object({ id, at: z.number(), type: z.string(), text: z.string() })
export const runSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  revision: z.number().int().nonnegative(),
  scope: scopeSchema,
  brief: briefSchema,
  briefHash: z.string(),
  configurationHash: z.string(),
  config: runConfigSchema,
  parentId: id.optional(),
  version: z.number().int().positive(),
  feedback: z.string().optional(),
  status: z.enum(["draft", "running", "paused", "completed", "cancelled", "failed"]),
  phase: phaseSchema,
  round: z.number().int(),
  epoch: z.number().int(),
  elapsedMs: z.number(),
  activeSince: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  stopReason: z.string().optional(),
  finishRequested: z.boolean(),
  calls: z.array(callSchema).max(400),
  issues: z.array(issueSchema).max(48),
  events: z.array(eventSchema),
  revisionResult: revisionSchema.optional(),
  verification: verificationSchema.optional(),
  humanDecision: z.object({ decision: z.enum(["adopt", "reject", "defer"]), reason: short, at: z.number() }).optional(),
  mode: z.enum(["live", "demo"]),
})
export type Run = z.infer<typeof runSchema>

export const DEFAULT_LIMITS: RunConfig["limits"] = {
  maxRounds: 24,
  maxCalls: 120,
  maxDurationMinutes: 240,
  concurrency: 2,
  tokenBudget: 2000000,
  maxCostCny: null,
  outputTokens: 4000,
  callTimeoutSeconds: 120,
}
export const DEFAULT_SEATS: RunConfig["seats"] = [
  {
    id: "growth",
    name: "增长与战略",
    modelKey: "qwen",
    mandate: "审查客户价值、增长来源、商业假设、替代路径和验证指标。比较维持现状、小范围试点与扩大投入。",
  },
  {
    id: "delivery",
    name: "产品与交付",
    modelKey: "kimi",
    mandate: "审查需求、交付成本、资源依赖和实施顺序。提出最小可逆试点。",
  },
  {
    id: "risk",
    name: "风险与经营",
    modelKey: "glm",
    mandate: "审查数据、声誉、现金流和经营风险，提出控制措施、触发条件和残余风险。",
  },
  {
    id: "challenge",
    name: "独立反方",
    modelKey: "deepseek",
    mandate: "寻找最强反对理由、失败情景、未经证实的前提和替代解释。明确什么证据会改变意见，不为反对而反对。",
  },
]

export class DecisionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = "DecisionError"
  }
}
export function assertScope(run: Run, scope: Scope): void {
  if (run.scope.sessionId !== scope.sessionId || run.scope.workspaceId !== scope.workspaceId) {
    throw new DecisionError("SCOPE", "该任务不属于当前工作空间和会话", 403)
  }
}
