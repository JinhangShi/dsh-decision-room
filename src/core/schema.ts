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
  .object({
    id,
    name: z.string().min(1).max(60),
    mandate: z.string().min(1).max(3000),
    modelKey: id,
    perspective: z.enum(["business", "delivery", "risk", "challenge", "domain"]).optional(),
    // Canonicalized by the Host at creation time. Optional for durable pre-0.5 records.
    modelFamily: z.string().min(1).max(80).optional(),
  })
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
    maxMcpCalls: z.number().int().min(0).max(100).default(12),
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
    submissionMessageId: z.string().min(1).max(200).optional(),
  })
  .strict()

export const issueInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    kind: z.enum(["fact", "design", "tradeoff", "missing_evidence"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    rationale: short,
    evidenceIds: z.array(id).max(18),
    suggestedChange: short,
    whatWouldChangeMind: short,
  })
  .strip()
export const reviewSchema = z
  .object({ summary: short, strengths: z.array(short).max(8), issues: z.array(issueInputSchema).max(8) })
  .strip()
export const organizeSchema = z
  .object({
    summary: short,
    priorityIssueIds: z.array(id).max(48),
    issueGroups: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            memberIssueIds: z.array(id).min(1).max(48),
          })
          .strip(),
      )
      .max(48),
  })
  .strip()
const legacyDebateSchema = z
  .object({
    summary: short,
    continueDiscussion: z.boolean(),
    responses: z
      .array(
        z
          .object({
            issueId: id,
            position: z.enum(["maintain", "revise", "reject", "abstain", "needs_evidence"]),
            reasoning: short,
            evidenceIds: z.array(id).max(16),
            proposedChange: short,
          })
          .strip(),
      )
      .max(48),
  })
  .strip()
export const debateSchema = z
  .object({
    summary: short,
    continueDiscussion: z.boolean(),
    responses: z
      .array(
        z
          .object({
            issueId: id,
            position: z.enum(["maintain", "revise", "reject", "abstain", "needs_evidence"]),
            evidenceStatus: z.enum(["supported", "conflicting", "missing"]),
            blocking: z.boolean(),
            newInformation: z.boolean(),
            reasoning: short,
            evidenceIds: z.array(id).max(16),
            proposedChange: short,
            whatWouldChangeMind: short,
          })
          .strip(),
      )
      .max(48),
  })
  .strip()
export const ballotInterpretationSchema = z
  .object({
    headline: z.string().trim().min(1).max(200),
    decisionSignal: z.enum(["proceed", "conditional", "hold", "mixed"]),
    summary: short,
    keyIssueIds: z.array(id).max(8),
    changesSincePrevious: short,
    nextStep: short,
    caveat: short,
  })
  .strip()
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
          .strip(),
      )
      .max(48),
    experiments: z
      .array(
        z
          .object({
            hypothesis: short,
            method: short,
            metric: short,
            ownerRole: short,
            stopCondition: short.describe("必须明确填写触发停止、回退或暂缓试点的可判断条件"),
          })
          .strip(),
      )
      .describe("可逆验证实验；每项必须完整填写 hypothesis、method、metric、ownerRole、stopCondition")
      .max(12),
  })
  .strip()
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
          .strip(),
      )
      .max(48),
  })
  .strip()
export const phaseSchema = z.enum(["independent", "organize", "discuss", "interpret", "revise", "verify", "finished"])
export type Phase = z.infer<typeof phaseSchema>
export type Brief = z.infer<typeof briefSchema>
export type Scope = z.infer<typeof scopeSchema>
export type RunConfig = z.infer<typeof runConfigSchema>
export function configurationWarnings(config: RunConfig): string[] {
  const perspectives = new Set(config.seats.map(seat => seat.perspective))
  const labels = [
    ["delivery", "交付视角"],
    ["risk", "风险视角"],
    ["challenge", "独立反方"],
  ] as const
  const missing = labels.filter(([key]) => !perspectives.has(key)).map(([, label]) => label)
  const families = new Set(config.seats.map(seat => seat.modelFamily ?? seat.modelKey))
  return [
    ...(missing.length ? [`席位配置缺少${missing.join("、")}；高风险评审可能存在盲区`] : []),
    ...(families.size < 2 ? ["席位仅覆盖一个模型族，无法形成跨模型族独立复核"] : []),
    ...(families.size < config.seats.length ? ["部分席位使用同一模型族；不同角色不会被 Host 算作多个独立模型族"] : []),
  ]
}
export type CreateInput = z.infer<typeof createSchema>
export type Review = z.infer<typeof reviewSchema>
export type Debate = z.infer<typeof debateSchema>
export type BallotInterpretation = z.infer<typeof ballotInterpretationSchema>
export type Revision = z.infer<typeof revisionSchema>
export type Verification = z.infer<typeof verificationSchema>
export type CallResult =
  | Review
  | z.infer<typeof organizeSchema>
  | Debate
  | BallotInterpretation
  | Revision
  | Verification

/** Read pre-0.6.1 organizer records without weakening validation for new model output. */
export function readOrganizeResult(value: unknown): z.infer<typeof organizeSchema> {
  const current = organizeSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = z
    .object({ summary: short, priorityIssueIds: z.array(id).max(48) })
    .strip()
    .parse(value)
  return {
    ...legacy,
    issueGroups: legacy.priorityIssueIds.map(issueId => ({ title: issueId, memberIssueIds: [issueId] })),
  }
}

/** Read durable pre-ballot discussion records without weakening validation for new model output. */
export function readDebateResult(value: unknown): Debate {
  const current = debateSchema.safeParse(value)
  if (current.success) {
    return current.data
  }
  const legacy = legacyDebateSchema.parse(value)
  return {
    ...legacy,
    responses: legacy.responses.map(response => ({
      ...response,
      evidenceStatus: response.position === "needs_evidence" ? ("missing" as const) : ("conflicting" as const),
      blocking: false,
      // Legacy records did not distinguish repetition from new information; keep the conservative interpretation.
      newInformation: true,
      whatWouldChangeMind: "历史记录未单独填写改变意见条件，请参考原始问题台账。",
    })),
  }
}

export const issueSchema = issueInputSchema.extend({
  id,
  sourceCallId: id,
  seatId: id,
  sourceIssueIds: z.array(id).max(48).optional(),
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
export const contextEstimateSchema = z.object({
  systemTokens: z.number().nonnegative(),
  materialTokens: z.number().nonnegative(),
  historyTokens: z.number().nonnegative(),
  toolResultTokens: z.number().nonnegative(),
  toolDefinitionTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  contextTokens: z.number().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  availableTools: z.number().int().nonnegative(),
  toolNames: z.array(z.string()).optional(),
  messageIds: z.array(z.string()).optional(),
})
export type ContextEstimate = z.infer<typeof contextEstimateSchema>
export const callSchema = z.object({
  id,
  purpose: z.enum(["review", "compaction", "tool_followup"]).optional(),
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
  inputEstimate: z.number().nonnegative().optional(),
  contextEstimate: contextEstimateSchema.optional(),
  dispatchState: z.enum(["reserved", "sending", "not_sent"]).optional(),
  reservedCost: z.number().nullable(),
  accountedTokens: z.number(),
  accountedCost: z.number().nullable(),
  usage: usageSchema.optional(),
  accounting: z.enum(["reserved", "reported", "uncertain", "not_sent"]),
  returnedModel: z.string().optional(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  promptHash: z.string(),
})
export type Call = z.infer<typeof callSchema>
/** Tool follow-ups and compaction are receipts, not standalone structured review results. */
export function isReviewCall(call: Pick<Call, "purpose">): boolean {
  return call.purpose === undefined || call.purpose === "review"
}
export const mcpCallSchema = z.object({
  id: z.string().min(1).max(200),
  primaryCallId: z.string().min(1).max(200).optional(),
  toolName: z.string().startsWith("mcp__").max(300),
  phase: phaseSchema,
  round: z.number().int().nonnegative(),
  seatId: id,
  arguments: z.unknown(),
  status: z.enum(["requested", "awaiting_approval", "running", "succeeded", "failed", "denied", "cancelled"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  error: z.string().max(2000).optional(),
  evidenceId: id.optional(),
})
export const mcpEvidenceSchema = z.object({
  id,
  callId: z.string().min(1).max(200),
  toolName: z.string().startsWith("mcp__").max(300),
  issueIds: z.array(id).max(48),
  text: z.string().min(1).max(30000),
  retrievedAt: z.number(),
  verificationStatus: z.literal("unverified_mcp"),
})
export const eventSchema = z.object({ id, at: z.number(), type: z.string(), text: z.string() })
const closingAllocationSchema = z.object({
  tokens: z.number().nonnegative(),
  calls: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
  costCny: z.number().nonnegative().nullable(),
})
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
  submissionMessageId: z.string().optional(),
  status: z.enum(["draft", "running", "paused", "completed", "cancelled", "failed"]),
  phase: phaseSchema,
  round: z.number().int(),
  epoch: z.number().int(),
  elapsedMs: z.number(),
  activeSince: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  stopReason: z.string().optional(),
  stopCode: z.string().optional(),
  // A durable hold, separate from spent usage. Released only to its closing phase.
  closingReserve: z
    .object({
      revise: closingAllocationSchema,
      verify: closingAllocationSchema,
    })
    .optional(),
  finishRequested: z.boolean(),
  calls: z.array(callSchema).max(400),
  issues: z.array(issueSchema).max(48),
  events: z.array(eventSchema),
  mcpCalls: z.array(mcpCallSchema).max(500).default([]),
  mcpEvidence: z.array(mcpEvidenceSchema).max(500).default([]),
  revisionResult: revisionSchema.optional(),
  verification: verificationSchema.optional(),
  humanDecision: z.object({ decision: z.enum(["adopt", "reject", "defer"]), reason: short, at: z.number() }).optional(),
  mode: z.enum(["live", "demo"]),
})
export type Run = z.infer<typeof runSchema>

export const REVIEW_MODES = [
  {
    id: "quick",
    label: "快速评审",
    duration: "约 15 分钟",
    description: "聚焦主要分歧，完成最低独立覆盖后尽快形成修订方案。",
    limits: {
      maxRounds: 2,
      maxCalls: 24,
      maxDurationMinutes: 15,
      concurrency: 2,
      tokenBudget: 1000000,
      maxCostCny: null,
      outputTokens: 8000,
      callTimeoutSeconds: 90,
      maxMcpCalls: 4,
    },
  },
  {
    id: "standard",
    label: "标准评审",
    duration: "约 1 小时",
    description: "允许多轮改票和补充质询，为格式重试与上下文处理保留余量。",
    limits: {
      maxRounds: 12,
      maxCalls: 72,
      maxDurationMinutes: 60,
      concurrency: 2,
      tokenBudget: 3000000,
      maxCostCny: null,
      outputTokens: 8000,
      callTimeoutSeconds: 120,
      maxMcpCalls: 12,
    },
  },
  {
    id: "deep",
    label: "深度评审",
    duration: "约 4 小时",
    description: "适合材料复杂、争议较多且需要持续交叉质询的高风险决策。",
    limits: {
      maxRounds: 24,
      maxCalls: 144,
      maxDurationMinutes: 240,
      concurrency: 2,
      tokenBudget: 6000000,
      maxCostCny: null,
      outputTokens: 8000,
      callTimeoutSeconds: 180,
      maxMcpCalls: 24,
    },
  },
  {
    id: "overnight",
    label: "持续评审",
    duration: "最长 8 小时",
    description:
      "适合长时间无人值守运行，为持续交叉质询、格式重试和复杂材料处理预留充足额度。若观点提前收敛会提前完成。",
    limits: {
      maxRounds: 64,
      maxCalls: 360,
      maxDurationMinutes: 480,
      concurrency: 2,
      tokenBudget: 15000000,
      maxCostCny: null,
      outputTokens: 10000,
      callTimeoutSeconds: 300,
      maxMcpCalls: 60,
    },
  },
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  duration: string
  description: string
  limits: RunConfig["limits"]
}>
export type ReviewModeId = (typeof REVIEW_MODES)[number]["id"]
export function reviewModeForLimits(limits: RunConfig["limits"]): (typeof REVIEW_MODES)[number] | undefined {
  return REVIEW_MODES.find(mode => JSON.stringify(mode.limits) === JSON.stringify(limits))
}
export const DEFAULT_LIMITS: RunConfig["limits"] = structuredClone(
  REVIEW_MODES.find(mode => mode.id === "standard")!.limits,
)
export type SeatTemplate = {
  id: string
  name: string
  description: string
  seats: RunConfig["seats"]
}

export const SEAT_TEMPLATES: SeatTemplate[] = [
  {
    id: "commercial",
    name: "商业决策",
    description: "客户价值、交付、财务风险与独立反方，适合大多数业务方案。",
    seats: [
      {
        id: "business",
        name: "商业与客户价值",
        modelKey: "qwen",
        perspective: "business",
        mandate: "审查客户问题、购买意愿、替代方案、增长假设和验证指标。区分客户陈述、商业假设与已经取得的证据。",
      },
      {
        id: "delivery",
        name: "产品与交付",
        modelKey: "kimi",
        perspective: "delivery",
        mandate: "审查产品范围、资源依赖、实施顺序、交付成本和可逆性。提出最小可行且可回退的试点。",
      },
      {
        id: "risk",
        name: "财务、风险与合规",
        modelKey: "glm",
        perspective: "risk",
        mandate: "审查成本收益、现金流、数据合规、声誉和经营风险，明确控制措施、触发条件及残余风险。",
      },
      {
        id: "challenge",
        name: "独立反方与证据审计",
        modelKey: "deepseek",
        perspective: "challenge",
        mandate: "寻找最强反例、竞争解释、材料可信度问题和维持现状方案。明确什么证据会改变意见，不为反对而反对。",
      },
    ],
  },
  {
    id: "due_diligence",
    name: "企业尽调",
    description: "增加经营财务与证据审计，适合访前研究、合作或投资判断。",
    seats: [
      {
        id: "commercial",
        name: "商业价值与市场",
        modelKey: "qwen",
        perspective: "business",
        mandate: "审查客户、市场、收入来源、竞争位置和商业假设，标记需要外部核验的关键陈述。",
      },
      {
        id: "product",
        name: "产品能力与交付",
        modelKey: "kimi",
        perspective: "delivery",
        mandate: "审查产品能力、技术依赖、客户落地、服务边界和规模化交付风险。",
      },
      {
        id: "operations",
        name: "经营与财务",
        modelKey: "glm",
        perspective: "risk",
        mandate: "审查收入质量、成本结构、现金流、组织能力和关键经营依赖，不虚构未披露的财务数据。",
      },
      {
        id: "compliance",
        name: "风险与合规",
        modelKey: "deepseek",
        perspective: "risk",
        mandate: "审查法律合规、数据授权、声誉、供应链和交易风险，明确红线及待核验事项。",
      },
      {
        id: "evidence",
        name: "独立反方与证据审计",
        modelKey: "qwen",
        perspective: "challenge",
        mandate: "寻找材料来源缺口、反例、替代解释和维持现状方案，区分事实、推断与营销表达。",
      },
    ],
  },
  {
    id: "product",
    name: "产品方案",
    description: "覆盖用户价值、产品设计、技术交付、商业化和独立反方。",
    seats: [
      {
        id: "user",
        name: "用户价值",
        modelKey: "qwen",
        perspective: "business",
        mandate: "审查目标用户、使用情境、问题强度、替代行为和可验证的价值指标。",
      },
      {
        id: "design",
        name: "产品设计",
        modelKey: "kimi",
        perspective: "domain",
        mandate: "审查需求边界、交互流程、功能优先级、可用性和方案完整性。",
      },
      {
        id: "engineering",
        name: "技术与交付",
        modelKey: "glm",
        perspective: "delivery",
        mandate: "审查技术可行性、依赖、质量保障、实施顺序、运维成本和回退路径。",
      },
      {
        id: "commercialization",
        name: "商业化",
        modelKey: "deepseek",
        perspective: "risk",
        mandate: "审查定价、获客、交付成本、收入假设和投入边界。",
      },
      {
        id: "challenge",
        name: "独立反方",
        modelKey: "qwen",
        perspective: "challenge",
        mandate: "寻找失败情景、被忽略的替代方案和不可逆承诺，说明改变意见所需证据。",
      },
    ],
  },
  {
    id: "technical",
    name: "技术架构",
    description: "覆盖架构、工程交付、安全可靠性、成本运维和独立反方。",
    seats: [
      {
        id: "architecture",
        name: "架构设计",
        modelKey: "qwen",
        perspective: "domain",
        mandate: "审查系统边界、组件职责、数据流、一致性、扩展性和技术取舍。",
      },
      {
        id: "engineering",
        name: "工程交付",
        modelKey: "kimi",
        perspective: "delivery",
        mandate: "审查迁移步骤、依赖、测试、发布、回滚和团队交付能力。",
      },
      {
        id: "security",
        name: "安全与可靠性",
        modelKey: "glm",
        perspective: "risk",
        mandate: "审查权限、数据保护、故障模式、恢复目标、可观测性和合规约束。",
      },
      {
        id: "operations",
        name: "成本与运维",
        modelKey: "deepseek",
        perspective: "business",
        mandate: "审查容量、性能、基础设施成本、值守负担和长期维护成本。",
      },
      {
        id: "challenge",
        name: "独立反方",
        modelKey: "qwen",
        perspective: "challenge",
        mandate: "质疑核心假设，比较更简单的替代架构，识别锁定效应和不可逆风险。",
      },
    ],
  },
  {
    id: "procurement",
    name: "采购评估",
    description: "覆盖业务适配、技术集成、成本合同、安全合规和供应商风险。",
    seats: [
      {
        id: "fit",
        name: "业务适配",
        modelKey: "qwen",
        perspective: "business",
        mandate: "审查采购目标、真实使用场景、必要能力、替代方案和验收指标。",
      },
      {
        id: "integration",
        name: "技术集成",
        modelKey: "kimi",
        perspective: "delivery",
        mandate: "审查接口、数据迁移、系统依赖、实施周期、运维和退出方案。",
      },
      {
        id: "commercial",
        name: "成本与合同",
        modelKey: "glm",
        perspective: "risk",
        mandate: "审查总拥有成本、计价口径、合同义务、续约条件和隐性投入。",
      },
      {
        id: "security",
        name: "安全与合规",
        modelKey: "deepseek",
        perspective: "risk",
        mandate: "审查数据授权、访问控制、审计、监管要求和安全责任边界。",
      },
      {
        id: "vendor",
        name: "供应商与独立反方",
        modelKey: "qwen",
        perspective: "challenge",
        mandate: "审查供应商持续经营、锁定风险、承诺可验证性、替代供应商和退出成本。",
      },
    ],
  },
]

export const DEFAULT_SEATS: RunConfig["seats"] = structuredClone(SEAT_TEMPLATES[0]!.seats)

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
