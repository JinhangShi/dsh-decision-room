import { isReviewCall, readDebateResult, type Run } from "./schema.js"

const POSITIONS = ["maintain", "revise", "reject", "abstain", "needs_evidence"] as const
const EVIDENCE = ["supported", "conflicting", "missing"] as const

export type IssueBallotSummary = {
  issueId: string
  requiredReviewers: number
  reviewerCount: number
  requiredModelFamilies: number
  modelFamilyCount: number
  blockingVotes: number
  positions: Record<(typeof POSITIONS)[number], number>
  evidence: Record<(typeof EVIDENCE)[number], number>
}

export type DeliberationAssessment = {
  round: number
  coverageSatisfied: boolean
  stableBallots: boolean
  noNewInformation: boolean
  noFurtherDiscussion: boolean
  stagnantRounds: number
  allNeedEvidence: boolean
  unreviewedCriticalBlockerIds: string[]
  issues: IssueBallotSummary[]
}

function counts<const T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map(value => [value, 0])) as Record<T[number], number>
}

function successfulRounds(run: Run) {
  return run.calls
    .filter(call => isReviewCall(call) && call.phase === "discuss" && call.status === "succeeded")
    .map(call => ({ call, result: readDebateResult(call.result) }))
}

function latestBallotsBySeat(run: Run, round: number) {
  const latest = new Map<
    string,
    { seatId: string; response: ReturnType<typeof readDebateResult>["responses"][number] }
  >()
  for (const item of successfulRounds(run).filter(item => item.call.round <= round)) {
    for (const response of item.result.responses) {
      latest.set(`${response.issueId}:${item.call.seatId}`, { seatId: item.call.seatId, response })
    }
  }
  return [...latest.values()]
}

function roundSignature(run: Run, round: number): string | undefined {
  const entries = successfulRounds(run)
    .filter(item => item.call.round === round)
    .flatMap(item =>
      item.result.responses.map(response => ({
        issueId: response.issueId,
        position: response.position,
        evidenceStatus: response.evidenceStatus,
        blocking: response.blocking,
        evidenceIds: [...response.evidenceIds].sort(),
      })),
    )
    .sort((a, b) => a.issueId.localeCompare(b.issueId))
  return entries.length === run.issues.length ? JSON.stringify(entries) : undefined
}

function roundHasNewInformation(run: Run, round: number): boolean {
  const current = successfulRounds(run).filter(item => item.call.round === round)
  if (roundSignature(run, round) === undefined) return true
  if (run.mcpCalls.some(call => call.round === round && call.status === "succeeded" && call.evidenceId)) return true
  const priorEvidence = new Set(
    successfulRounds(run)
      .filter(item => item.call.round < round)
      .flatMap(item => item.result.responses.flatMap(response => response.evidenceIds)),
  )
  return current.some(
    item =>
      item.result.responses.some(response => response.newInformation) ||
      item.result.responses.some(response => response.evidenceIds.some(id => !priorEvidence.has(id))),
  )
}

function stagnantRoundCount(run: Run, round: number): number {
  let count = 0
  for (let current = round; current > 1; current -= 1) {
    const signature = roundSignature(run, current)
    if (
      signature === undefined ||
      signature !== roundSignature(run, current - 1) ||
      roundHasNewInformation(run, current)
    ) {
      break
    }
    count += 1
  }
  return count
}

/** Deterministic Host-owned aggregation. It reports votes; it never converts agreement into factual truth. */
export function assessDeliberation(run: Run, round = run.round): DeliberationAssessment {
  const discussion = successfulRounds(run).filter(item => item.call.round <= round)
  const latestBallots = latestBallotsBySeat(run, round)
  const availableModelFamilies = new Set(run.config.seats.map(seat => seat.modelFamily ?? seat.modelKey)).size
  const current = discussion.filter(item => item.call.round === round)
  const previousEvidence = new Map<string, Set<string>>()
  for (const item of discussion.filter(item => item.call.round < round)) {
    for (const response of item.result.responses) {
      const known = previousEvidence.get(response.issueId) ?? new Set<string>()
      response.evidenceIds.forEach(id => known.add(id))
      previousEvidence.set(response.issueId, known)
    }
  }
  const currentResponses = current.flatMap(item => item.result.responses)
  const issues = run.issues.map(issue => {
    const ballots = latestBallots.filter(ballot => ballot.response.issueId === issue.id)
    const positions = counts(POSITIONS)
    const evidence = counts(EVIDENCE)
    ballots.forEach(({ response }) => {
      positions[response.position] += 1
      evidence[response.evidenceStatus] += 1
    })
    const requiredReviewers = Math.min(run.config.seats.length, ["high", "critical"].includes(issue.severity) ? 2 : 1)
    const requiredModelFamilies = Math.min(availableModelFamilies, requiredReviewers)
    const modelFamilyCount = new Set(
      ballots.map(ballot => {
        const seat = run.config.seats.find(item => item.id === ballot.seatId)
        return seat?.modelFamily ?? seat?.modelKey ?? ballot.seatId
      }),
    ).size
    return {
      issueId: issue.id,
      requiredReviewers,
      reviewerCount: new Set(ballots.map(ballot => ballot.seatId)).size,
      requiredModelFamilies,
      modelFamilyCount,
      blockingVotes: ballots.filter(ballot => ballot.response.blocking).length,
      positions,
      evidence,
    }
  })
  const coverageSatisfied = issues.every(
    issue => issue.reviewerCount >= issue.requiredReviewers && issue.modelFamilyCount >= issue.requiredModelFamilies,
  )
  const unreviewedCriticalBlockerIds = run.issues
    .filter(issue => issue.severity === "critical")
    .filter(issue => {
      const summary = issues.find(item => item.issueId === issue.id)!
      return summary.blockingVotes > 0 && summary.reviewerCount < 2
    })
    .map(issue => issue.id)
  const discoveredEvidence = currentResponses.some(response =>
    response.evidenceIds.some(id => !previousEvidence.get(response.issueId)?.has(id)),
  )
  return {
    round,
    coverageSatisfied,
    stableBallots:
      round > 1 &&
      roundSignature(run, round) !== undefined &&
      roundSignature(run, round) === roundSignature(run, round - 1),
    noNewInformation:
      currentResponses.length > 0 && !discoveredEvidence && currentResponses.every(item => !item.newInformation),
    noFurtherDiscussion: current.length > 0 && current.every(item => !item.result.continueDiscussion),
    stagnantRounds: stagnantRoundCount(run, round),
    allNeedEvidence:
      currentResponses.length > 0 && currentResponses.every(response => response.position === "needs_evidence"),
    unreviewedCriticalBlockerIds,
    issues,
  }
}
