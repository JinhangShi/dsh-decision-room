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

export function discussionDelta(run: Run, round: number) {
  const prior = successfulRounds(run).filter(item => item.call.round < round)
  const current = successfulRounds(run).filter(item => item.call.round === round)
  const responses = current.flatMap(item => item.result.responses)
  const complete = run.issues.every(issue => responses.some(response => response.issueId === issue.id))
  const changedBallots: Array<{ issueId: string; seatId: string }> = []
  const signature = (response: (typeof responses)[number]) =>
    JSON.stringify([response.position, response.evidenceStatus, response.blocking, [...response.evidenceIds].sort()])
  for (const { call, result } of current) {
    for (const response of result.responses) {
      const sameSeat = prior
        .filter(item => item.call.seatId === call.seatId)
        .flatMap(item => item.result.responses)
        .findLast(item => item.issueId === response.issueId)
      const others = prior.flatMap(item => item.result.responses).filter(item => item.issueId === response.issueId)
      // A rotated assignment is not a changed vote. Compare a returning seat to its own ballot.
      if (
        sameSeat
          ? signature(sameSeat) !== signature(response)
          : !others.some(item => signature(item) === signature(response))
      ) {
        changedBallots.push({ issueId: response.issueId, seatId: call.seatId })
      }
    }
  }
  const priorEvidence = new Set(
    run.mcpCalls.filter(call => call.round < round && call.status === "succeeded").map(call => call.evidenceId),
  )
  const newEvidenceIds = run.mcpCalls
    .filter(
      call =>
        call.round === round && call.status === "succeeded" && call.evidenceId && !priorEvidence.has(call.evidenceId),
    )
    .map(call => call.evidenceId!)
  return {
    complete,
    changedBallots,
    newEvidenceIds: [...new Set(newEvidenceIds)],
    // This remains visible for audit, but cannot grant the model control of the loop.
    reportedNewInformation: responses.filter(response => response.newInformation).length,
  }
}

function roundHasNewInformation(run: Run, round: number): boolean {
  const delta = discussionDelta(run, round)
  return !delta.complete || delta.changedBallots.length > 0 || delta.newEvidenceIds.length > 0
}

function stagnantRoundCount(run: Run, round: number): number {
  let count = 0
  for (let current = round; current > 1 && !roundHasNewInformation(run, current); current -= 1) count += 1
  return count
}

/** Deterministic Host-owned aggregation. It reports votes; it never converts agreement into factual truth. */
export function assessDeliberation(run: Run, round = run.round): DeliberationAssessment {
  const discussion = successfulRounds(run).filter(item => item.call.round <= round)
  const latestBallots = latestBallotsBySeat(run, round)
  const availableModelFamilies = new Set(run.config.seats.map(seat => seat.modelFamily ?? seat.modelKey)).size
  const current = discussion.filter(item => item.call.round === round)
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
  return {
    round,
    coverageSatisfied,
    stableBallots:
      round > 1 && discussionDelta(run, round).complete && discussionDelta(run, round).changedBallots.length === 0,
    noNewInformation: !roundHasNewInformation(run, round),
    noFurtherDiscussion:
      discussionDelta(run, round).complete &&
      current.length > 0 &&
      current.every(item => !item.result.continueDiscussion),
    stagnantRounds: stagnantRoundCount(run, round),
    allNeedEvidence:
      currentResponses.length > 0 && currentResponses.every(response => response.position === "needs_evidence"),
    unreviewedCriticalBlockerIds,
    issues,
  }
}
