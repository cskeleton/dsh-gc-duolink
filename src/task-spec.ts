/**
 * The Session Link TASK PROTOCOL domain declaration (MODEL_ROUTING_PLAN Task
 * 3): durable schemas for tracked task rows, carried in an independent
 * `session_link_tasks` v1 storage domain. The `session_link` v1 domain and its
 * tables are untouched; task rows only REFERENCE link/message identities.
 *
 * One task row is the intent/projection side of the protocol: originalRequest
 * digest, spawn intent, normalized ModelRoutingPolicy, append-only attempt
 * history, CAS revision, task state, execution projection (bound identities +
 * host turnIntentId), outbox events, and decision idempotency records. Task
 * state and its pending outbox events ALWAYS commit in the same row write —
 * no state update may precede its notification intent without the event(s)
 * riding that write. All durable value types live here, separate from the
 * hostile-input boundary in `model-policy.ts`.
 *
 * `@persistenceSecurity` Row digests exist to detect replay-with-different-
 * params conflicts, never to store secrets: texts arrive already framed by
 * the mailbox or are reduced to a bounded digest when no message exists.
 * @module dsh-session-link/task-spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionLinkId, SessionLinkMessageId, SessionLinkTaskId } from './types.ts'
import { IF_EXHAUSTED_NOTIFY_SENDER, MAX_CANDIDATE_ATTEMPTS } from './model-policy.ts'

const sessionId = z.string().transform(value => brandString<SessionId>(value))
const linkId = z.string().transform(value => SessionLinkId(value))
const messageId = z.string().transform(value => SessionLinkMessageId(value))
const taskId = z.string().transform(value => SessionLinkTaskId(value))

/** Durable shape of one concrete model route (normalized camelCase policy form). */
export const taskModelRouteSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})

/** Durable shape of one normalized candidate: a concrete route or the session-default sentinel. */
export const taskModelCandidateSchema = z.union([
  taskModelRouteSchema,
  z.strictObject({ use: z.literal('session_default') }),
])

/** Durable shape of the normalized `ModelRoutingPolicy` (raw snake_case params are never persisted). */
export const taskModelRoutingPolicySchema = z.strictObject({
  scope: z.union([z.literal('task'), z.literal('session')]),
  candidates: z.array(taskModelCandidateSchema).min(1).max(MAX_CANDIDATE_ATTEMPTS),
  ifExhausted: z.literal(IF_EXHAUSTED_NOTIFY_SENDER),
  usesSessionDefault: z.boolean(),
})

/** Task lifecycle states; mailbox `delivered` status stays independent of these. */
export const taskStateSchema = z.union([
  z.literal('preparing'),
  z.literal('queued'),
  z.literal('running'),
  z.literal('turn_finished'),
  z.literal('waiting_decision'),
  z.literal('interrupted'),
  z.literal('cancelled'),
  z.literal('failed'),
])

/** How far execution got before a wait/interrupt; `not_started` alone permits retry. */
export const taskExecutionStateSchema = z.union([
  z.literal('not_started'),
  z.literal('partial'),
  z.literal('unknown'),
])

/** Immutable per-candidate outcome, appended as checks complete; never rewritten. */
export const taskCandidateResultSchema = z.strictObject({
  route: taskModelRouteSchema,
  outcome: z.union([z.literal('selected'), z.literal('unavailable'), z.literal('failed')]),
  /** ModelRoutingError / TaskHostError code when not selected. */
  code: z.string().min(1).optional(),
  message: z.string().optional(),
})

/**
 * One decision attempt (attempt 1 = original params; each explicit
 * retry/continue decision opens a new one). The candidates snapshot is the
 * normalized policy as decided; `defaultFrozenRoute` is the concrete route a
 * `session_default` candidate bound to at first activation — replay NEVER
 * re-samples it. `results` is append-only; the candidate budget (max 5) is
 * per attempt and is reset ONLY by an explicit new decision.
 */
export const taskAttemptSchema = z.strictObject({
  attemptId: z.string().min(1),
  /** 1 + the prior attempt count; opens at 1 for the original request. */
  ordinal: z.number().int().positive(),
  /** Which explicit decision opened this attempt; `original` for attempt 1. */
  kind: z.union([z.literal('original'), z.literal('retry'), z.literal('continue')]),
  decisionIdemKey: z.string().min(1).optional(),
  candidates: z.array(taskModelCandidateSchema).min(1).max(MAX_CANDIDATE_ATTEMPTS),
  defaultFrozenRoute: taskModelRouteSchema.optional(),
  results: z.array(taskCandidateResultSchema),
  openedAt: z.string(),
})

/** The spawn intent for a spawn-created task; a send-created task omits it entirely. */
export const taskSpawnIntentSchema = z.strictObject({
  cwd: z.string(),
  title: z.string().optional(),
  autoAwake: z.boolean(),
  wakeCaller: z.boolean().optional(),
  /** ORIGINAL spawn call idempotency key; replay reuses it to derive the same Session. */
  callKey: z.string().min(1),
  /** The Session id derived from the original spawn call; stable across replay. */
  targetSessionId: sessionId,
})

/**
 * Execution projection: what the binding sequence has committed so far.
 * A task may wake/deliver only when BOTH its message binding and its host
 * turnIntentId are recorded here — `turnIntentAttachedAt` set is the durable
 * execution-binding marker.
 */
export const taskExecutionProjectionSchema = z.strictObject({
  messageId: messageId.optional(),
  sessionId: sessionId.optional(),
  linkId: linkId.optional(),
  turnIntentId: z.string().min(1).optional(),
  /** Set when `recordTurnIntent` succeeded: model binding is durable. */
  turnIntentAttachedAt: z.string().optional(),
  currentlyExecuting: z.boolean().optional(),
  currentRoute: taskModelRouteSchema.optional(),
  routeUsed: taskModelRouteSchema.optional(),
})

/** Outbox notification kinds (plan §3); `model_unavailable` covers the candidates-exhausted case. */
export const taskOutboxKindSchema = z.union([
  z.literal('model_fallback_selected'),
  z.literal('model_unavailable'),
  z.literal('turn_finished'),
  z.literal('interrupted'),
  z.literal('cancelled'),
])

/** One TASK-STATUS outbox entry; lifecycle pending → admitted → delivered/blocked. */
export const taskOutboxEventSchema = z.strictObject({
  /** Deterministic identity `task:<caller>:<callId>/<revision>/<kind>`: dedup survives restarts. */
  eventId: z.string().min(1),
  kind: taskOutboxKindSchema,
  /** Row revision this event was committed with; T5 re-validates against the live row. */
  revision: z.number().int().nonnegative(),
  attemptId: z.string().min(1).optional(),
  executionState: taskExecutionStateSchema.optional(),
  reason: z.string().optional(),
  requestedModel: taskModelRouteSchema.optional(),
  actualModel: taskModelRouteSchema.optional(),
  attempts: z.number().int().nonnegative().optional(),
  decisionRequired: z.boolean(),
  resumable: z.boolean(),
  status: z.union([
    z.literal('pending'),
    z.literal('admitted'),
    z.literal('delivered'),
    z.literal('blocked'),
  ]),
  /** Mailbox identity once T5's notification send admits the event. */
  notifiedMessageId: messageId.optional(),
  blockedReason: z.string().optional(),
  createdAt: z.string(),
})

/** Idempotent record of one resolve_task decision, keyed by the original resolver callId. */
export const taskDecisionRecordSchema = z.strictObject({
  callId: z.string().min(1),
  action: z.union([z.literal('retry'), z.literal('continue'), z.literal('cancel')]),
  attemptId: z.string().min(1).optional(),
  outcome: z.union([
    z.literal('applied'),
    z.literal('stale'),
    z.literal('rejected'),
  ]),
  appliedRevision: z.number().int().nonnegative(),
  /** Task-state-change events the decision itself committed, for replay-safe result reconstruction. */
  emittedEventIds: z.array(z.string().min(1)),
  appliedAt: z.string(),
})

/** A digest persists at most this many UTF-16 code units of material. */
export const TASK_DIGEST_MAX_TEXT = 2048

/**
 * Durable shape of one tracked task row. Everything the spawn/send admission,
 * runtime projection, reconciliation, and outbox delivery need lives on this
 * single record; every mutation goes through CAS-guarded whole-row writes.
 */
export const sessionLinkTaskSchema = z.object({
  // Identity and access: owner may read and decide; target may read only.
  callerId: sessionId,
  targetSessionId: sessionId.optional(),
  /** The FIRST call's id; `taskId` is `task:<callerId>:<callId>`. */
  callId: z.string().min(1),
  kind: z.union([z.literal('spawn'), z.literal('send')]),
  originalRequest: z.object({
    digest: z.string().min(1),
    summary: z.object({
      targetSessionId: sessionId.optional(),
      spawnCwd: z.string().optional(),
      title: z.string().optional(),
      /** Mailbox message id carrying the original body once the binding commits. */
      messageId: messageId.optional(),
      textExcerpt: z.string().optional(),
    }),
  }),
  /** True when the caller supplied model-routing params on the original call. */
  tracked: z.boolean(),
  policy: taskModelRoutingPolicySchema,
  spawn: taskSpawnIntentSchema.optional(),
  attempts: z.array(taskAttemptSchema).min(1),
  currentAttemptId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  taskState: taskStateSchema,
  executionState: taskExecutionStateSchema.optional(),
  reason: z.string().optional(),
  execution: taskExecutionProjectionSchema,
  /**
   * Notification-chain identity: the ORIGINAL task is the root of its
   * notification/decision chain. Retry/continue notifications keep this root
   * message id; the chain wake budget is never reset by minting new roots.
   */
  notificationRoot: z.object({
    rootMessageId: messageId.optional(),
  }),
  outbox: z.array(taskOutboxEventSchema),
  decisions: z.array(taskDecisionRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Inferred attempt type, shared with the runtime module. */
export type SessionLinkTaskAttempt = z.infer<typeof taskAttemptSchema>

/** Inferred outbox event type, shared with the runtime module. */
export type SessionLinkTaskOutboxEvent = z.infer<typeof taskOutboxEventSchema>

/** Inferred decision record type, shared with the runtime module. */
export type SessionLinkTaskDecisionRecord = z.infer<typeof taskDecisionRecordSchema>

/** Inferred execution projection type, shared with the runtime module. */
export type SessionLinkTaskExecutionProjection = z.infer<typeof taskExecutionProjectionSchema>

/** Inferred task row type, shared with the runtime module. */
export type SessionLinkTaskRecordData = z.infer<typeof sessionLinkTaskSchema>

/**
 * The Session Link task domain spec: one per-record table of task rows. The
 * spec object is the single source of the domain's identity, version, and
 * schemas; `session_link` v1 is untouched.
 */
export const sessionLinkTaskDomainSpec = defineDomain({
  name: 'session_link_tasks',
  version: 1,
  global: {
    schema: z.object({ initialized: z.boolean() }),
    initial: { initialized: true },
  },
  tables: {
    tasks: domainTable<SessionLinkTaskId, SessionLinkTaskRecordData>(sessionLinkTaskSchema),
  },
})
