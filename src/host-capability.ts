/**
 * Plugin-side view of the host task-execution capability. The tools layer
 * resolves it per target Agent context; absence on an older host yields the
 * `HOST_CAPABILITY_UNAVAILABLE` error the plan mandates. This module is the
 * single place that binds the plugin to the host contract, so a host-contract
 * revision touches only these types plus {@link resolveTaskHost}.
 * @module dsh-session-link/host-capability
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Minimum host task-host contract the plugin understands. */
export const HOST_TASK_HOST_VERSION = 1

/** Stable machine-routing error codes the host capability rejects with. */
export type TaskHostErrorCode =
  | 'HOST_CAPABILITY_UNAVAILABLE'
  | 'TASK_UNKNOWN'
  | 'TASK_CLAIM_LOST'
  | 'TASK_STALE_REVISION'
  | 'TASK_NOT_CLAIMABLE'
  | 'TASK_RETRY_NOT_POSSIBLE'
  | 'TASK_BASELINE_CHANGED'
  | 'TASK_NOT_CANCELLABLE'
  | 'TASK_ROUTE_UNAVAILABLE'
  | 'TASK_MANAGED_ORPHAN'

/** Error string the tools layer returns on a host without the capability. */
export const HOST_CAPABILITY_UNAVAILABLE: TaskHostErrorCode = 'HOST_CAPABILITY_UNAVAILABLE'

/** One model route the host understands (provider/model/optional effort). */
export interface HostModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The effective Session baseline plus its CAS revision token. */
export interface HostBaselineSnapshot {
  readonly effective: HostModelSelection | null
  readonly revision: HostModelSelection | null
}

/** Route policy handed to the host for one claim. */
export interface HostTaskRoute {
  readonly selection?: HostModelSelection
  readonly candidateCycle?: HostModelSelection[]
}

/** One durable turn intent as read back from host facts. */
export interface HostTurnIntentRecord {
  readonly intentId: string
  readonly messageId: MessageId
  readonly taskId: string
  readonly attemptId: string
  readonly route: HostTaskRoute
  readonly persistOnSuccess: boolean
  readonly status: 'claimed' | 'started' | 'response_committed' | 'finished' | 'cancelled'
  readonly baselineAtClaim: HostBaselineSnapshot
  readonly turn?: number
  readonly routeUsed?: HostModelSelection
}

/** Result of committing or finishing a turn. */
export interface HostFinishOutcome {
  readonly routeUsed?: HostModelSelection
  readonly persist?: {
    readonly attempted: boolean
    readonly committed: boolean
    readonly reason?: 'human_selection_changed'
  }
  readonly failure?: LlmFailure
}

/** Lease a claim hands the caller; binds the route to one turn. */
export interface HostTurnLease {
  readonly intent: HostTurnIntentRecord
  readonly route: HostModelSelection | undefined
  release(): void
}

/**
 * The narrow agent-context-scoped capability the host exposes. Method and
 * failure-code semantics match the host contract; the plugin records intent,
 * claims the route lease, and reconciles orphans through it.
 */
export interface HostTaskHostCapability {
  readonly taskHostVersion: number

  readBaseline(): HostBaselineSnapshot
  snapshotBaselineForSpawn(): HostBaselineSnapshot

  recordTurnIntent(options: {
    taskId: string
    attemptId: string
    messageId: MessageId
    route?: HostTaskRoute
    persistOnSuccess?: boolean
  }): HostTurnIntentRecord

  claimTurnIntent(intentId: string, options?: {
    expectedBaseline?: HostModelSelection | null
  }): Promise<HostTurnLease>

  commitTurn(intentId: string): Promise<HostFinishOutcome>
  finishTurn(intentId: string, outcome?: HostFinishOutcome): Promise<HostFinishOutcome>
  cancelTurnIntent(intentId: string, reason?: string): Promise<void>

  pauseTurnIntent(intentId: string): Promise<never>
  resumeTurnIntent(intentId: string): Promise<never>

  isManaged(messageId: MessageId): boolean
  getTurnIntentByMessageId(messageId: MessageId): HostTurnIntentRecord | undefined
  getTurnIntent(intentId: string): HostTurnIntentRecord | undefined
  listOrphanedTurnIntents(): HostTurnIntentRecord[]

  subscribe(listener: (record: HostTurnIntentRecord) => void): { unsubscribe(): void }

  evaluateRetry(intentId: string): { retryable: boolean; failure?: LlmFailure }
}

interface TaskHostCarrier {
  taskHost?: HostTaskHostCapability
}

/**
 * Resolve the host task-execution capability bound to one Agent context.
 * Returns undefined on hosts older than the minimum; the tools layer turns
 * that absence into the `HOST_CAPABILITY_UNAVAILABLE` error. The capability is
 * agent-context scoped, so plugin-adopted live Agents resolve through their
 * own context without a controller-owned selection cache.
 * @param ctx - Cordis context for one live Agent (or one carrying its services).
 * @returns the host capability, or undefined when the host is too old.
 */
export function resolveTaskHost(ctx: Context): HostTaskHostCapability | undefined {
  const carrier = ctx as unknown as TaskHostCarrier
  try {
    // A plain Cordis context gates unknown service keys ("cannot get property
    // without inject"); an agent context on a capability host answers.
    return carrier.taskHost
  } catch {
    return undefined
  }
}
