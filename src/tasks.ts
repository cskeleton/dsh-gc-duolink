/**
 * The Session Link task service (`ctx.sessionLinkTasks`; MODEL_ROUTING_PLAN
 * Task 3): durable tracked-task intents, state transitions, attempt history,
 * execution projections, outbox events, and decision idempotency, with
 * write-ahead binding and replay reconciliation.
 *
 * Write-ahead binding sequence (Task 4 executes it; this service provides the
 * primitives in order):
 *
 *  1. `saveTaskIntent`      — the durable intent row in `preparing` (or in
 *                             `waiting_decision`/`not_started` on a synchronous
 *                             model precheck failure — with NO Session and NO
 *                             mailbox message).
 *  2. create/adopt Session  — Task 4's own ledger domain writes.
 *  3. `attachBinding`       — CAS commit of target sessionId/linkId/messageId
 *                             (the notification root minted at step 1 since
 *                             R18; this step only back-fills legacy rows).
 *  4. `recordTurnIntent`    — CAS commit after host `recordTurnIntent`
 *                             succeeds; only now is the model binding durable.
 *
 * A task whose model binding is not durable NEVER wakes and is NEVER claimed:
 * `assertBindingDurable` guards Task 4's admission path. Any half-written
 * state is classified by `reconcile()` into resumable intents, binding
 * repairs (reported to the caller once via outbox, NEVER auto-executed), or
 * orphan checks. Recovery never creates a Session, never wakes one, and never
 * fabricates a mailbox message. Parameter and permission failures leave NO
 * task row.
 *
 * Per-task mutation is serialized through expected-revision CAS on the
 * domain's per-table atomic update; conflicting concurrent writers throw
 * `TASK_STALE_REVISION`. Every state change commits in the same row write as
 * the outbox events it obligates. The service runs no timers, no network
 * I/O, and the model catalog is runtime-only (never persisted).
 * @module dsh-session-link/tasks
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-llm'
import {
  sessionLinkTaskDomainSpec,
  TASK_DIGEST_MAX_TEXT,
} from './task-spec.ts'
import type {
  SessionLinkTaskAttempt,
  SessionLinkTaskDecisionRecord,
  SessionLinkTaskExecutionProjection,
  SessionLinkTaskOutboxEvent,
  SessionLinkTaskRecordData,
} from './task-spec.ts'
import { MAX_CANDIDATE_ATTEMPTS } from './model-policy.ts'
import type { ModelRouteCandidate, ModelRouteSelection, ModelRoutingPolicy } from './model-policy.ts'
import { TASK_STALE_REVISION } from './host-capability.ts'
import type { HostTaskHostCapability, HostTurnIntentRecord } from './host-capability.ts'
import { SessionLinkError, SessionLinkMessageId, SessionLinkTaskId } from './types.ts'
import type { SessionLinkId } from './types.ts'
import type { SessionLinkMessageRecordData } from './spec.ts'

/* --------------------------------------------------------------------------
 * Vocabulary
 * ------------------------------------------------------------------------ */

/** Task lifecycle states; the mailbox `delivered` status stays independent of these. */
export type TaskState = SessionLinkTaskRecordData['taskState']

/** How far execution got before a wait/interrupt (`not_started` alone permits retry). */
export type TaskExecutionState = NonNullable<SessionLinkTaskRecordData['executionState']>

/** Outbox notification kinds (plan §3). */
export type TaskOutboxKind = SessionLinkTaskOutboxEvent['kind']

/** Stable decision/tool classification codes (plan §3 `reason` vocabulary). */
export type TaskErrorCode =
  | 'TASK_RUNNING'
  | 'TASK_TERMINAL'
  | 'TASK_NOT_RETRYABLE'
  | 'TASK_NOT_CONTINUABLE'
  | 'TASK_BINDING_INCOMPLETE'
  | 'TASK_WRITE_FAILED'

export const TASK_RUNNING: TaskErrorCode = 'TASK_RUNNING'
export const TASK_TERMINAL: TaskErrorCode = 'TASK_TERMINAL'
export const TASK_NOT_RETRYABLE: TaskErrorCode = 'TASK_NOT_RETRYABLE'
export const TASK_NOT_CONTINUABLE: TaskErrorCode = 'TASK_NOT_CONTINUABLE'
export const TASK_BINDING_INCOMPLETE: TaskErrorCode = 'TASK_BINDING_INCOMPLETE'
export const TASK_WRITE_FAILED: TaskErrorCode = 'TASK_WRITE_FAILED'

/**
 * Structured task-protocol failure; a typed `code` (never a mapped tool
 * string) distinguishes CAS conflicts, illegal transitions, decision
 * refusals, and durability failures at every write boundary.
 */
export class SessionLinkTaskError extends Error {
  constructor(
    readonly code: TaskErrorCode | typeof TASK_STALE_REVISION | 'TASK_ROW_EXISTS',
    message: string,
  ) {
    super(message)
    this.name = 'SessionLinkTaskError'
  }
}

/**
 * R15 (MODEL_ROUTING_FIX_PLAN Task 3): a first-create `saveTaskIntent` raced
 * an existing row for the same task identity inside the atomic
 * insert-if-absent (the fast-path read missed it, two first-creates queued).
 * Never silently overwritten — the caller re-reads the stored row and
 * adopts-or-conflicts on the digest instead.
 */
export class TaskRowExistsError extends SessionLinkTaskError {
  constructor(readonly stored: SessionLinkTaskRecordData) {
    super('TASK_ROW_EXISTS', `task row "${taskIdFor(stored.callerId, stored.callId)}" already exists`)
    this.name = 'TaskRowExistsError'
  }
}

/* --------------------------------------------------------------------------
 * Interfaces the wire layers consume
 * ------------------------------------------------------------------------ */

/** Spawn parameters carried by the original request (send-created tasks omit them). */
export interface TaskSpawnIntentInput {
  readonly cwd: string
  readonly title?: string
  readonly autoAwake: boolean
  readonly wakeCaller?: boolean
  /** The Session id derived from the ORIGINAL spawn callKey; stable across replay. */
  readonly targetSessionId: SessionId
}

/** The original spawn/send call as the task row records it. */
export interface OriginalRequestInput {
  readonly kind: 'spawn' | 'send'
  /** Caller tool callId; the task identity is derived from caller + this id. */
  readonly callId: string
  /** Sender's original task text; reduced into the bounded digest. */
  readonly text: string
  readonly spawn?: TaskSpawnIntentInput
  /** For `send` kind: the existing linked target Session. */
  readonly targetSessionId?: SessionId
  readonly title?: string
}

/**
 * Durable task-intent creation (write-ahead step 1). Parameter and permission
 * validation happened in the caller BEFORE this point; a rejected call leaves
 * no row.
 */
export interface CreateTaskIntentInput {
  readonly callerId: SessionId
  readonly request: OriginalRequestInput
  /** The normalized policy snapshot; raw snake_case params are never persisted. */
  readonly policy: ModelRoutingPolicy
  /**
   * True when the caller supplied model-routing params. Untracked legacy
   * calls MAY record a preparing intent on the identity-neutral policy so
   * restart replay can detect a half-written admission; nothing about their
   * routing is decided here.
   */
  readonly tracked: boolean
  /**
   * Synchronous model precheck failure, when one happened: the intent is
   * saved in `waiting_decision`/`not_started` with the `model_unavailable`
   * outbox event committed in the same write — WITHOUT creating a Session or
   * fabricating a mailbox message.
   */
  readonly precheckFailure?: {
    /** ModelRoutingError/TaskHostError `reason` code. */
    readonly reason: string
    /** Per-candidate precheck outcomes, appended immutably onto attempt 1. */
    readonly results: readonly { route: ModelRouteSelection; code: string; message?: string }[]
  }
  /**
   * R10 (MODEL_ROUTING_FIX_PLAN Task 3): when the sync precheck PASSED, the
   * index within `policy.candidates` it selected, fixed durably onto the new
   * attempt 1. Absent on a precheck failure (no candidate was selected) and
   * on pre-R10 rows.
   */
  readonly selectedCandidateIndex?: number
}

/** Outcome of saving an intent. */
export interface SavedTaskIntent {
  readonly taskId: SessionLinkTaskId
  readonly row: SessionLinkTaskRecordData
}

/** Binding commit input (write-ahead step 3), applied under CAS. */
export interface AttachBindingInput {
  readonly messageId: SessionLinkMessageId
  readonly sessionId: SessionId
  readonly linkId?: SessionLinkId
  /**
   * Admission lifecycle: `queued` (mailbox accepted the message without a
   * target receipt) moves the task `preparing → queued`; `accepted` (the
   * target durably recorded the message) requires the host turn intent to be
   * recorded FIRST and then lands `running` with `currentlyExecuting` set.
   */
  readonly admittedAs: 'queued' | 'accepted'
}

/** Caller-performed state-change request executed under CAS. */
export interface TaskChange {
  readonly toState: TaskState
  /** Only meaningful while entering `waiting_decision`/`interrupted`. */
  readonly executionState?: TaskExecutionState
  readonly reason?: string
  readonly currentRoute?: ModelRouteSelection
  readonly routeUsed?: ModelRouteSelection
  /** Outbox events this state change obligates, committed in the same row write. */
  readonly events?: readonly TaskEventInput[]
}

/* Entering `running` always marks the claim (`currentlyExecuting`), and leaving
 * it always clears the claim; no caller-controlled escape hatch exists. */

/** One outbox event to commit; `eventId` derives deterministically from task+revision+kind. */
export interface TaskEventInput {
  readonly kind: TaskOutboxKind
  readonly executionState?: TaskExecutionState
  readonly reason?: string
  readonly requestedModel?: ModelRouteSelection
  readonly actualModel?: ModelRouteSelection
  readonly attempts?: number
  readonly decisionRequired?: boolean
  readonly resumable?: boolean
}

/** The `session_get_task` projection. */
export interface TaskView {
  readonly taskId: SessionLinkTaskId
  readonly taskState: TaskState
  readonly revision: number
  /** CAS token `session_resolve_task` requires. */
  readonly expectedRevision: number
  readonly executionState?: TaskExecutionState
  readonly reason?: string
  readonly callerId: SessionId
  readonly targetSessionId?: SessionId
  readonly boundMessageId?: SessionLinkMessageId
  readonly boundLinkId?: SessionLinkId
  readonly currentAttemptId: string
  readonly policy: ModelRoutingPolicy
  readonly attempts: readonly SessionLinkTaskAttempt[]
  readonly currentRoute?: ModelRouteSelection
  readonly routeUsed?: ModelRouteSelection
  readonly latestIssue?: { code?: string; message?: string }
  readonly createdAt: string
  readonly updatedAt: string
}

/** The repair buckets of half-written task state after a restart. */
export interface ReconcileReport {
  /** Intent rows with no message binding; Task 4 spawn replay MUST consult these BEFORE creating anything. */
  readonly resumableIntents: readonly SessionLinkTaskRecordData[]
  /** Bound message without a durable host turn intent: reported to the caller via outbox; NEVER executed. */
  readonly needsBindingRepair: readonly SessionLinkTaskRecordData[]
  /** Turn intent recorded: host orphan facts to align the plugin projection with. */
  readonly orphanChecks: readonly {
    readonly taskId: SessionLinkTaskId
    readonly turnIntentId: string
    readonly orphans: readonly HostTurnIntentRecord[]
  }[]
}

/** What one non-autoExecuting reconcile run did. */
export interface ReconcileResult {
  readonly report: ReconcileReport
  /** Tasks whose caller received the one-shot binding-repair notification intent in this run. */
  readonly notifiedRepairs: readonly SessionLinkTaskId[]
}

/* --------------------------------------------------------------------------
 * Read-side probes injected by the wire layer (no I/O added by this service)
 * ------------------------------------------------------------------------ */

/** Read-side probe into the `session_link` domain for link/mailbox facts. */
export interface TaskLinksProbe {
  /** The mailbox message, when it exists in `session_link`. */
  message(messageId: SessionLinkMessageId): SessionLinkMessageRecordData | undefined
  /** Whether one link group currently contains both Sessions (re-validated before notifications/decisions). */
  pairLinked(linkId: SessionLinkId, first: SessionId, second: SessionId): boolean
}

/**
 * R08(1): wire-layer hook the service calls while opening a task's retry
 * attempt — mark the PREVIOUS attempt's consumed/absent mailbox delivery so
 * the NEW attempt's admission can never adopt it as the task's own delivery.
 * Best-effort as far as the decision itself is concerned: a throw is logged
 * by the caller and the decision still commits (the new messageId path no
 * longer needs the marker).
 */
export type MarkLegacyDeliveryFn = (messageId: SessionLinkMessageId, taskId: SessionLinkTaskId) => void

/**
 * R03 (MODEL_ROUTING_FIX_PLAN Task 3): the wire layer revokes a cancelled
 * task's un-consumed mailbox delivery (pending → cancelled) and cancels its
 * durable host turn intent. Wired from the tools row because only it can
 * reach the link service and the lazy host capability; invoked fire-and-
 * forget from the cancel decision — the decision itself NEVER blocks on the
 * revocation, because the activation gates read the terminal row and hard-
 * refuse regardless. The row handed over is the PRE-DECISION snapshot (its
 * execution binding still names the delivery/intent to revoke).
 */
export type RevokeDeliveryFn = (taskId: SessionLinkTaskId, row: SessionLinkTaskRecordData) => void

/** Service construction options; none of them add I/O or timers. */
export interface SessionLinkTaskServiceOptions {
  /** Mailbox/link facts; required for `reconcile` consistency checks and notification recipient guards. */
  readonly links?: TaskLinksProbe
  /** R08(1): marks a retry's previous-attempt legacy delivery (see {@link MarkLegacyDeliveryFn}). */
  readonly markLegacyDelivery?: MarkLegacyDeliveryFn
  /** R03: revoke a task's un-consumed pending delivery + host intent on a cancel decision. */
  readonly revokeDelivery?: RevokeDeliveryFn
  /** Host turn-intent facts per target Session, for orphan checks. */
  readonly hostFor?: (sessionId: SessionId) => HostTaskHostCapability | undefined
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
}

/* --------------------------------------------------------------------------
 * Small module-level helpers
 * ------------------------------------------------------------------------ */

/** The stable task identity of one caller + first call id. */
export function taskIdFor(callerId: SessionId, callId: string): SessionLinkTaskId {
  return SessionLinkTaskId(`task:${callerId}:${callId}`)
}

/**
 * Derive the mailbox message identity one tracked ADMISSION will use
 * (R08(1)): deterministic per (attempt-scope, attempt idempotency key). The
 * original attempt passes its taskId + raw callId and mints the SAME value
 * every replay of that call answers; each retry attempt passes
 * `<callKey>/attempt-<N>` and mints a FRESH identity — the re-admission of
 * a delivered-task retry never reuses the consumed mailbox delivery its
 * predecessor owned.
 *
 * R18 (MODEL_ROUTING_FIX_PLAN Task 4): the SAME derivation mints the task's
 * `notificationRoot.rootMessageId` at FIRST intent admission
 * (`saveTaskIntent`), so the budget-chain authority is durable before any
 * binding exists and never moves across retries: it equals the attempt-1
 * delivery identity exactly.
 */
export function mintTaskMessageId(
  taskScope: string,
  callKey: string,
): SessionLinkMessageId {
  const hex = createHash('sha256').update(`task-msg\0${taskScope}\0${callKey}`).digest('hex')
  return SessionLinkMessageId(`session-link-message-${hex.slice(0, 32)}`)
}

/** The attempt-scoped idempotency key: original = callId, retry = callId/attempt-N. */
export function attemptCallKey(callId: string, ordinal: number): string {
  return ordinal === 1 ? callId : `${callId}/attempt-${ordinal}`
}

/** The deterministic outbox identity of one event (task + revision + kind). */
function eventIdFor(taskId: SessionLinkTaskId, revision: number, kind: TaskOutboxKind): string {
  return `${taskId}/${revision}/${kind}`
}

/** Attempt id minted for one decision outcome. */
function attemptIdFor(taskId: SessionLinkTaskId, ordinal: number): string {
  return `${taskId}/attempt-${ordinal}`
}

/**
 * Deterministic digest of the original request: kind + spawn/target identity
 * + the normalized policy + the FULL task text. Replay of the same call
 * compares digests; different params demand `session_resolve_task`, never a
 * replay replacement. Not a secret store — the digest is a 64-bit fingerprint
 * and the full body itself lives durably on the row (`payloadText`) and in
 * the bound mailbox message.
 *
 * R16 (MODEL_ROUTING_FIX_PLAN Task 3): the digest version bumped `v:1 → v:2`
 * and now hashes the complete `text` instead of the bounded
 * `TASK_DIGEST_MAX_TEXT` slice — the pre-R16 truncation silently accepted a
 * replay whose tail diverged past 2048 UTF-16 units as the SAME call. The
 * legacy digest remains available through {@link legacyRequestDigest} so a
 * pre-R16 durable row still recognizes its own replays exactly (digest
 * equality stays byte-for-byte identity, never cross-version forgiveness).
 */
export function requestDigest(input: OriginalRequestInput, policy: ModelRoutingPolicy): string {
  return `fnv1a-64:${hexHash(digestMaterial(input, policy, 2))}`
}

/** The PRE-R16 digest: the bounded 2048-unit text slice under format v1. */
export function legacyRequestDigest(input: OriginalRequestInput, policy: ModelRoutingPolicy): string {
  return `fnv1a-64:${hexHash(digestMaterial(input, policy, 1))}`
}

/** The JSON material one digest version fingerprints (pure identity mapping). */
function digestMaterial(input: OriginalRequestInput, policy: ModelRoutingPolicy, version: 1 | 2): string {
  return JSON.stringify({
    v: version,
    kind: input.kind,
    spawnCwd: input.spawn?.cwd,
    spawnTitle: input.spawn?.title,
    autoAwake: input.spawn?.autoAwake,
    wakeCaller: input.spawn?.wakeCaller,
    target: input.kind === 'send' ? input.targetSessionId : input.spawn?.targetSessionId,
    policy,
    title: input.title,
    text: version === 1 ? input.text.slice(0, TASK_DIGEST_MAX_TEXT) : input.text,
  })
}

/** FNV-1a 64-bit over UTF-8, hex-encoded: deterministic across processes, needs no crypto module. */
function hexHash(material: string): string {
  const bytes = new TextEncoder().encode(material)
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** Route equality for frozen-default consistency checks. */
function routesEqual(left: ModelRouteSelection, right: ModelRouteSelection): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Candidate-list equality (policy snapshots are plain JSON values). */
export function candidatesEqual(left: readonly ModelRouteCandidate[], right: readonly ModelRouteCandidate[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The first concrete route of a policy, for `requestedModel` projections. */
function defaultRequestedRoute(policy: ModelRoutingPolicy): ModelRouteSelection | undefined {
  for (const candidate of policy.candidates) {
    if (!('use' in candidate)) return candidate
  }
  return undefined
}

/** Read the current attempt (throws an internal invariant error when absent — the schema guarantees ≥1). */
function currentAttempt(row: SessionLinkTaskRecordData): SessionLinkTaskAttempt {
  const attempt = row.attempts.find(candidate => candidate.attemptId === row.currentAttemptId)
  if (attempt === undefined) throw new SessionLinkTaskError(TASK_BINDING_INCOMPLETE, `task "${taskIdFor(row.callerId, row.callId)}" lost its current attempt record`)
  return attempt
}

/** Task state machine transitions; terminal states have no exits, entry states have no re-entry. */
const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  preparing: ['queued', 'waiting_decision'],
  queued: ['running', 'cancelled', 'waiting_decision', 'interrupted'],
  running: ['turn_finished', 'waiting_decision', 'interrupted', 'cancelled', 'failed'],
  turn_finished: [],
  waiting_decision: ['queued', 'cancelled', 'failed'],
  interrupted: ['cancelled', 'failed'],
  cancelled: [],
  failed: [],
}

/** Internal invariant violation: a caller built an impossible argument shape. */
export class TaskInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskInvariantError'
  }
}

/* --------------------------------------------------------------------------
 * The service
 * ------------------------------------------------------------------------ */

/**
 * Durable tracked-task registry. Opens its own `session_link_tasks` domain
 * and serializes each task's mutations through expected-revision CAS on the
 * domain's per-table atomic update; conflicting concurrent updates throw
 * `TASK_STALE_REVISION`. Recovery classification runs through the explicit
 * `reconcile()` call (Task 4/5 wire repairs) — the service owns no timers.
 */
export class SessionLinkTaskService extends Service {
  static inject = ['storageDomain']

  private tasks!: KvTable<SessionLinkTaskId, SessionLinkTaskRecordData>
  private readonly probe?: TaskLinksProbe
  private readonly markLegacyDelivery?: MarkLegacyDeliveryFn
  private readonly revokeDelivery?: RevokeDeliveryFn
  private readonly hostFor?: (sessionId: SessionId) => HostTaskHostCapability | undefined
  private readonly now: () => Date
  private disposed = false

  constructor(ctx: Context, options: SessionLinkTaskServiceOptions = {}) {
    super(ctx, 'sessionLinkTasks')
    this.probe = options.links
    this.markLegacyDelivery = options.markLegacyDelivery
    this.revokeDelivery = options.revokeDelivery
    this.hostFor = options.hostFor
    this.now = options.now ?? (() => new Date())
  }

  /** Open the task domain; replay reconciliation is an explicit call, never a mount-time side effect. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sessionLinkTaskDomainSpec)
    this.tasks = domain.table('tasks')
    this.ctx.effect(() => async () => {
      this.disposed = true
      await domain.close()
    }, 'sessionLinkTasks.close')
  }

  private assertLive(): void {
    if (this.disposed) throw new SessionLinkTaskError(TASK_WRITE_FAILED, 'Session Link task service is disposing')
  }

  /** Current time as the ISO-8601 string durable rows carry. */
  private clock(): string {
    return this.now().toISOString()
  }

  /* ----------------------------------------------------------------------
   * Reads (synchronous, off the authoritative in-memory domain state)
   * -------------------------------------------------------------------- */

  /** Read one stored task row (wire-layer helper; access rules live in `getTask`). */
  getRow(taskId: SessionLinkTaskId): SessionLinkTaskRecordData | undefined {
    return this.tasks.get(taskId)
  }

  /** List all stored rows (reconciliation/reporting helper). */
  listRows(): SessionLinkTaskRecordData[] {
    return [...this.tasks.entries()].map(([, row]) => row)
  }

  /**
   * Whether the execution binding is durable: BOTH the message binding and
   * the host turn intent are recorded, and the task is in an execution-path
   * state. Only such a task may wake or be claimed.
   */
  isExecutionBound(taskId: SessionLinkTaskId): boolean {
    const row = this.tasks.get(taskId)
    if (row === undefined) return false
    if (!['queued', 'running', 'turn_finished'].includes(row.taskState)) return false
    return row.execution.messageId !== undefined && row.execution.turnIntentId !== undefined
  }

  /**
   * The admission-path guard Task 4 calls before waking or claiming: the
   * task must exist, be claimable, and carry the full durable binding.
   * Violations throw typed codes so no caller can quietly route an unbound
   * task onto the default model.
   */
  assertBindingDurable(taskId: SessionLinkTaskId): SessionLinkTaskRecordData {
    const row = this.tasks.get(taskId)
    if (row === undefined) {
      throw new SessionLinkError(`task "${taskId}" not found`, 'MESSAGE_NOT_FOUND')
    }
    if (!['queued', 'running'].includes(row.taskState)) {
      throw new SessionLinkTaskError(TASK_TERMINAL, `task "${taskId}" is ${row.taskState} and cannot be claimed or woken`)
    }
    if (row.execution.messageId === undefined || row.execution.turnIntentId === undefined) {
      // Never deliver/wake an unbound or half-bound task; reconcile() reports it for repair.
      throw new SessionLinkTaskError(
        TASK_BINDING_INCOMPLETE,
        `task "${taskId}" model binding is not durable (message=${row.execution.messageId ?? 'absent'}, `
        + `turnIntent=${row.execution.turnIntentId ?? 'absent'}); reconcile() reports it instead of executing`,
      )
    }
    return row
  }

  /**
   * The `session_get_task` projection. Readable by the original sender or the
   * target Session ONLY — both keep read access after unlink — and every
   * other Session receives the same not-found refusal as an absent task.
   */
  getTask(callerId: SessionId, taskId: SessionLinkTaskId): TaskView {
    const row = this.tasks.get(taskId)
    if (row === undefined || !this.canRead(callerId, row)) {
      throw new SessionLinkError(`task "${taskId}" not found`, 'MESSAGE_NOT_FOUND')
    }
    return this.project(row)
  }

  private canRead(callerId: SessionId, row: SessionLinkTaskRecordData): boolean {
    return row.callerId === callerId || row.targetSessionId === callerId
  }

  private project(row: SessionLinkTaskRecordData): TaskView {
    const attempt = currentAttempt(row)
    const latest = attempt.results.at(-1)
    return {
      taskId: taskIdFor(row.callerId, row.callId),
      taskState: row.taskState,
      revision: row.revision,
      expectedRevision: row.revision,
      ...(row.executionState === undefined ? {} : { executionState: row.executionState }),
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      callerId: row.callerId,
      ...(row.targetSessionId === undefined ? {} : { targetSessionId: row.targetSessionId }),
      ...(row.execution.messageId === undefined ? {} : { boundMessageId: row.execution.messageId }),
      ...(row.execution.linkId === undefined ? {} : { boundLinkId: row.execution.linkId }),
      currentAttemptId: row.currentAttemptId,
      policy: row.policy,
      attempts: row.attempts,
      ...(row.execution.currentRoute === undefined ? {} : { currentRoute: row.execution.currentRoute }),
      ...(row.execution.routeUsed === undefined ? {} : { routeUsed: row.execution.routeUsed }),
      ...(latest === undefined ? {} : {
        latestIssue: {
          ...(latest.code === undefined ? {} : { code: latest.code }),
          ...(latest.message === undefined ? {} : { message: latest.message }),
        },
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  /** Pending outbox events across stored tasks, in commit order (createdAt, then array order). */
  pendingOutbox(): readonly { taskId: SessionLinkTaskId; event: SessionLinkTaskOutboxEvent }[] {
    const found: { taskId: SessionLinkTaskId; event: SessionLinkTaskOutboxEvent }[] = []
    for (const [taskId, row] of this.tasks.entries()) {
      for (const event of row.outbox) {
        if (event.status === 'pending') found.push({ taskId, event })
      }
    }
    found.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt))
    return found
  }

  /* ----------------------------------------------------------------------
   * Write-ahead step 1: intent
   * -------------------------------------------------------------------- */

  /**
   * Save the durable task intent. The SAME caller+callId replay returns the
   * EXISTING row unchanged when the params digest matches; a differing digest
   * throws `TASK_PARAMS_CONFLICT` (as SessionLinkError LINK_ALREADY_LINKED
   * with task wording) — replay never retargets, never rewrites policy, and
   * never creates a second Session. A precheck failure stores the intent in
   * `waiting_decision`/`not_started` with the `model_unavailable` event in
   * the same write; no Session and no mailbox message exist yet.
   */
  async saveTaskIntent(input: CreateTaskIntentInput): Promise<SavedTaskIntent> {
    this.assertLive()
    if (input.request.kind === 'spawn' && input.request.spawn === undefined) {
      throw new TaskInvariantError('a spawn-kind task intent must carry its spawn parameters')
    }
    if (input.request.kind === 'send' && input.request.targetSessionId === undefined) {
      throw new TaskInvariantError('a send-kind task intent must name its target Session')
    }
    const taskId = taskIdFor(input.callerId, input.request.callId)
    const existing = this.tasks.get(taskId)
    if (existing !== undefined) return { taskId, row: this.adoptOrConflict(taskId, existing, input) }
    /* R10: a first-create intent carries the SYNC-precheck's selected index
     * ONLY when the precheck truly ran. A `waiting_decision` save (precheck
     * failure) selects nothing; an R13 default-resolvable pass may carry the
     * default sentinel's index. */
    if (input.selectedCandidateIndex !== undefined) {
      const index = input.selectedCandidateIndex
      if (input.precheckFailure !== undefined || !Number.isInteger(index) || index < 0 || index >= input.policy.candidates.length) {
        throw new TaskInvariantError(
          `selectedCandidateIndex ${index} is not valid for task "${taskId}" (precheck=${input.precheckFailure === undefined ? 'passed' : 'failed'}, candidates=${input.policy.candidates.length})`,
        )
      }
    }
    const digest = requestDigest(input.request, input.policy)
    const now = this.clock()
    const attempt: SessionLinkTaskAttempt = {
      attemptId: attemptIdFor(taskId, 1),
      ordinal: 1,
      kind: 'original',
      candidates: cloneCandidates(input.policy.candidates),
      results: (input.precheckFailure?.results ?? []).map(result => ({
        route: { ...result.route },
        outcome: 'unavailable' as const,
        code: result.code,
        ...(result.message === undefined ? {} : { message: result.message }),
      })),
      openedAt: now,
      ...(input.selectedCandidateIndex === undefined ? {} : { selectedCandidateIndex: input.selectedCandidateIndex }),
    }
    const precheck = input.precheckFailure
    const outbox: SessionLinkTaskOutboxEvent[] = []
    if (precheck !== undefined) {
      outbox.push(this.buildEvent(taskId, 1, {
        kind: 'model_unavailable',
        executionState: 'not_started',
        reason: precheck.reason,
        requestedModel: defaultRequestedRoute(input.policy),
        attempts: attempt.results.length,
        decisionRequired: true,
        resumable: true,
      }, now))
    }
    const row: SessionLinkTaskRecordData = {
      callerId: input.callerId,
      ...(input.request.kind === 'send' ? { targetSessionId: input.request.targetSessionId } : {}),
      callId: input.request.callId,
      kind: input.request.kind,
      originalRequest: {
        digest,
        summary: {
          ...(input.request.kind === 'send' && input.request.targetSessionId !== undefined
            ? { targetSessionId: input.request.targetSessionId }
            : {}),
          ...(input.request.spawn?.cwd === undefined ? {} : { spawnCwd: input.request.spawn.cwd }),
          ...(input.request.title !== undefined
            ? { title: input.request.title }
            : input.request.spawn?.title === undefined ? {} : { title: input.request.spawn.title }),
          ...(input.request.text === '' ? {} : { textExcerpt: input.request.text.slice(0, 160) }),
        },
        // R09: the full payload is durable on the intent row from creation.
        payloadText: input.request.text,
      },
      tracked: input.tracked,
      policy: clonePolicy(input.policy),
      ...(input.request.spawn === undefined ? {} : {
        spawn: {
          cwd: input.request.spawn.cwd,
          ...(input.request.spawn.title === undefined ? {} : { title: input.request.spawn.title }),
          autoAwake: input.request.spawn.autoAwake,
          ...(input.request.spawn.wakeCaller === undefined ? {} : { wakeCaller: input.request.spawn.wakeCaller }),
          callKey: input.request.callId,
          targetSessionId: input.request.spawn.targetSessionId,
        },
      }),
      attempts: [attempt],
      currentAttemptId: attempt.attemptId,
      revision: 1,
      taskState: precheck === undefined ? 'preparing' : 'waiting_decision',
      ...(precheck === undefined ? {} : { executionState: 'not_started' as const, reason: precheck.reason }),
      execution: {},
      /* R18: the notification root mints at FIRST intent admission — the
       * deterministic attempt-1 delivery identity ({@link mintTaskMessageId}
       * of the raw callId). It is stable per task, survives retry/re-attempt
       * (applyDecision's execution clear never touches it), and every
       * task-status notification threads it, so ONE wake-budget chain covers
       * the task's whole notification/decision lifecycle — precheck-failed
       * tasks (never `attachBinding`) included. */
      notificationRoot: { rootMessageId: mintTaskMessageId(taskId, attemptCallKey(input.request.callId, 1)) },
      outbox,
      decisions: [],
      createdAt: now,
      updatedAt: now,
    }
    try {
      /* R15: the first-create is ATOMIC against concurrent same-taskId first
       * saves. `put` is a blind insert-or-overwrite — two racing first
       * creates (the fast-path read above missed both) would last-writer-wins
       * silently. The domain table's atomic read-modify-write chain cannot
       * create a missing key, so the write happens as a SAME-CHAIN queued put
       * whose slot check re-reads the authoritative state AT ITS TURN, not at
       * call time: `chainedInsert` throws the exist-before sentinel when a
       * row landed first, and that error maps to adopt-or-conflict — never
       * an overwrite. */
      await this.atomicInsert(taskId, row as SessionLinkTaskRecordData)
    } catch (error: unknown) {
      if (error instanceof TaskRowExistsError) {
        return { taskId, row: this.adoptOrConflict(taskId, error.stored, input) }
      }
      // Write-ahead failure: NO intent is durable and nothing may proceed —
      // the task-table write failing must never dispatch any model.
      throw new SessionLinkTaskError(
        TASK_WRITE_FAILED,
        `task intent for "${taskId}" could not be persisted; nothing was dispatched: ${String(error)}`,
      )
    }
    return { taskId, row }
  }

  /**
   * The digest-driven replay rule for an EXISTING row: identical parameters
   * adopt the stored row verbatim; ANY difference refuses with the
   * resolve_task conflict — a replay never retargets, never rewrites policy,
   * and never silently overwrites. R16 migration: a row written before the
   * full-body digest carries the legacy (bounded-slice) digest; its genuine
   * replays recompute THAT same legacy digest and adopt, while the conflict
   * frontier moved to the (still correct, only coarser) legacy comparison —
   * new rows hash the full body.
   */
  private adoptOrConflict(
    taskId: SessionLinkTaskId,
    existing: SessionLinkTaskRecordData,
    input: CreateTaskIntentInput,
  ): SessionLinkTaskRecordData {
    const digest = requestDigest(input.request, input.policy)
    if (digest === existing.originalRequest.digest) return existing
    if (legacyRequestDigest(input.request, input.policy) === existing.originalRequest.digest) return existing
    throw new SessionLinkError(
      `task "${taskId}" already exists with different parameters; use session_resolve_task — `
      + 'the original call must not be replayed with changed parameters',
      'LINK_ALREADY_LINKED',
    )
  }

  /**
   * Insert-if-absent on the task table: the existence decision happens at a
   * serialized point every competing first-create observes. A storage layer
   * exposing {@link KvTable.insertIfAbsent} decides AT the domain write
   * chain's queue slot; an older one (no native primitive) falls back to
   * this service's own single-flight insert chain: every fallback job runs
   * strictly after the previous one's domain write settled, at which point
   * the authoritative in-memory table reflects it, and the check never
   * trusts a caller-time read. Either way a row that landed ahead throws
   * {@link TaskRowExistsError} — NEVER a silent overwrite.
   */
  private insertChain: Promise<unknown> = Promise.resolve()

  private async atomicInsert(taskId: SessionLinkTaskId, row: SessionLinkTaskRecordData): Promise<void> {
    const table = this.tasks as KvTable<SessionLinkTaskId, SessionLinkTaskRecordData> & {
      insertIfAbsent?: (key: SessionLinkTaskId, value: SessionLinkTaskRecordData) => Promise<{ existing: boolean }>
    }
    if (typeof table.insertIfAbsent === 'function') {
      const outcome = await table.insertIfAbsent(taskId, row)
      if (outcome.existing) throw new TaskRowExistsError(this.tasks.get(taskId) ?? row)
      return
    }
    const run = this.insertChain.then(async () => {
      const existing = this.tasks.get(taskId)
      if (existing !== undefined) throw new TaskRowExistsError(existing)
      await this.tasks.put(taskId, row)
    })
    // The chain never jams on one insert's failure: later inserts run after
    // the rejecting job SETTLED (its own caller still receives the throw).
    this.insertChain = run.then(() => undefined, () => undefined)
    await run
  }

  /* ----------------------------------------------------------------------
   * CAS primitive
   * -------------------------------------------------------------------- */

  /**
   * Serialized per-task mutation guarded by the expected revision, on the
   * domain table's atomic read-modify-write: the mutator receives the row
   * current at the write chain's queue slot. A revision that moved past
   * `expectedRevision` throws `TASK_STALE_REVISION` and changes nothing; a
   * durability failure throws `TASK_WRITE_FAILED` and also changes nothing
   * (the domain does not mutate memory on failed writes).
   */
  async update(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    mutator: (row: SessionLinkTaskRecordData) => SessionLinkTaskRecordData,
  ): Promise<SessionLinkTaskRecordData> {
    this.assertLive()
    if (this.tasks.get(taskId) === undefined) {
      throw new SessionLinkError(`task "${taskId}" not found`, 'MESSAGE_NOT_FOUND')
    }
    let stale = false
    let thrown: unknown
    let stored: SessionLinkTaskRecordData | undefined
    try {
      stored = await this.tasks.update(taskId, current => {
        if (current.revision !== expectedRevision) {
          stale = true
          return current
        }
        try {
          return mutator(current)
        } catch (error: unknown) {
          thrown = error
          return current
        }
      })
    } catch (error: unknown) {
      throw new SessionLinkTaskError(
        TASK_WRITE_FAILED,
        `task "${taskId}" update failed to persist; its durable state is unchanged: ${String(error)}`,
      )
    }
    // Mutator rejections surface with their own typed codes; the row stayed
    // unchanged because the domain never saw a returned value to commit.
    if (thrown !== undefined) throw thrown
    if (stale) {
      throw new SessionLinkTaskError(
        TASK_STALE_REVISION,
        `task "${taskId}" revision moved past ${expectedRevision} (now ${stored!.revision}); `
        + 're-read the task and retry with its current revision',
      )
    }
    return stored!
  }

  /* ----------------------------------------------------------------------
   * Write-ahead step 3: binding commit
   * -------------------------------------------------------------------- */

  /**
   * Attach the target binding under CAS after Session/link/mailbox committed
   * (write-ahead step 3). The notification ROOT normally minted earlier at
   * FIRST intent admission (R18); this method only fills it in for a row
   * that predates that mint — notification and decision chains keep it
   * across every later binding, so retries never reset the chain wake
   * budget. `admittedAs: 'accepted'` requires the host turn intent to be
   * recorded FIRST — otherwise the message would already be model-visible
   * without a durable model binding; that call throws
   * `TASK_BINDING_INCOMPLETE` and changes nothing.
   */
  async attachBinding(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    binding: AttachBindingInput,
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      if (row.execution.messageId !== undefined) {
        throw new SessionLinkTaskError(
          TASK_BINDING_INCOMPLETE,
          `task "${taskId}" already carries message binding ${row.execution.messageId}; a task has exactly one active message`,
        )
      }
      if (!['preparing', 'waiting_decision', 'queued'].includes(row.taskState)) {
        throw new SessionLinkTaskError(
          TASK_TERMINAL,
          `task "${taskId}" is ${row.taskState}; only preparing/waiting_decision/queued may gain a message binding`,
        )
      }
      if (binding.admittedAs === 'accepted' && row.execution.turnIntentId === undefined) {
        throw new SessionLinkTaskError(
          TASK_BINDING_INCOMPLETE,
          `task "${taskId}" cannot register an accepted admission before its host turn intent is recorded; `
          + 'record the turn intent first, then attach the binding',
        )
      }
      const nextState: TaskState =
        row.taskState === 'preparing' ? 'queued'
        : binding.admittedAs === 'accepted' && row.execution.turnIntentId !== undefined ? 'running'
        : row.taskState
      const execution: SessionLinkTaskExecutionProjection = {
        ...row.execution,
        messageId: binding.messageId,
        sessionId: binding.sessionId,
        ...(binding.linkId === undefined ? {} : { linkId: binding.linkId }),
        ...(nextState === 'running' ? { currentlyExecuting: true } : {}),
      }
      return {
        ...row,
        ...(row.targetSessionId === undefined ? { targetSessionId: binding.sessionId } : {}),
        taskState: nextState,
        ...(nextState === 'waiting_decision' ? {} : { executionState: undefined as never, reason: undefined as never }),
        execution,
        notificationRoot: row.notificationRoot.rootMessageId === undefined
          ? { rootMessageId: binding.messageId }
          : row.notificationRoot,
        revision: row.revision + 1,
        updatedAt: this.clock(),
      }
    })
  }

  /* ----------------------------------------------------------------------
   * Write-ahead step 4: durable host binding
   * -------------------------------------------------------------------- */

  /**
   * Record the host turn intent under CAS once host `recordTurnIntent`
   * succeeded (write-ahead step 4). The intent's message identity must equal
   * this task's bound message: a mismatched intent belongs to another
   * task/message and must never make this task wakeable.
   */
  async recordTurnIntent(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    intent: { turnIntentId: string; messageId: SessionLinkMessageId },
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      if (row.execution.turnIntentId !== undefined) {
        throw new SessionLinkTaskError(
          TASK_BINDING_INCOMPLETE,
          `task "${taskId}" already recorded turn intent ${row.execution.turnIntentId}`,
        )
      }
      if (row.execution.messageId === undefined) {
        throw new SessionLinkTaskError(
          TASK_BINDING_INCOMPLETE,
          `task "${taskId}" has no message binding yet; turn intents attach only after the binding commits`,
        )
      }
      if (row.execution.messageId !== intent.messageId) {
        throw new SessionLinkTaskError(
          TASK_BINDING_INCOMPLETE,
          `turn intent ${intent.turnIntentId} names message ${intent.messageId}, but task "${taskId}" is bound to ${row.execution.messageId}`,
        )
      }
      const now = this.clock()
      return {
        ...row,
        execution: {
          ...row.execution,
          turnIntentId: intent.turnIntentId,
          turnIntentAttachedAt: now,
        },
        revision: row.revision + 1,
        updatedAt: now,
      }
    })
  }

  /**
   * Rebind the task's durable host turn intent after a fallback switch
   * (IMPORTANT-4): the runtime cancels the OLD intent and records a fresh one
   * on the same bound message; this primitive swaps
   * `execution.turnIntentId` to the live intent in ONE atomic row write so a
   * post-restart fold never references the cancelled intent. The write is
   * guarded on the intent being replaced (`from`): a row that already points
   * elsewhere (a concurrent projection) is left untouched and surfaces as
   * `TASK_STALE_REVISION`-class refusal, never a silent overwrite.
   */
  async rebindTurnIntent(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    rebind: { from: string; to: string },
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      if (row.execution.messageId === undefined) {
        throw new SessionLinkTaskError(
          TASK_BINDING_INCOMPLETE,
          `task "${taskId}" has no message binding; a turn-intent rebind attaches only after the binding commits`,
        )
      }
      if (row.execution.turnIntentId !== rebind.from) {
        throw new SessionLinkTaskError(
          TASK_STALE_REVISION,
          `task "${taskId}" turn intent moved past "${rebind.from}" (now ${row.execution.turnIntentId ?? 'absent'}); `
          + 're-read the task and rebind against its current intent',
        )
      }
      const now = this.clock()
      return {
        ...row,
        execution: {
          ...row.execution,
          turnIntentId: rebind.to,
          turnIntentAttachedAt: now,
        },
        revision: row.revision + 1,
        updatedAt: now,
      }
    })
  }

  /* ----------------------------------------------------------------------
   * R11: missing-delivery herald
   * -------------------------------------------------------------------- */

  /**
   * Herald a half-written delivery the caller's own replay RECOGNIZED as
   * missing (R11): a bound-or-bound-again identity the mailbox does NOT
   * contain marks the task durably (`missingDelivery: messageId` as the
   * reason) so the resolve path — and any operator reading the row — sees
   * the repair need instead of a phantom `queued` admission. The state
   * itself is NOT moved (the caller decides retry/cancel with full facts);
   * reconcile independently classifies the same gap from the links probe.
   * Idempotent: an already-heralded task absorbs the marker without a write.
   */
  async markDeliveryMissing(
    taskId: SessionLinkTaskId,
    messageId: SessionLinkMessageId,
  ): Promise<SessionLinkTaskRecordData | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const live = this.tasks.get(taskId)
      if (live === undefined) return undefined
      if (['turn_finished', 'cancelled', 'failed', 'running'].includes(live.taskState)) return live
      if (live.reason === `missingDelivery:${messageId}`) return live
      try {
        return await this.requestStateChange(taskId, live.revision, {
          toState: 'waiting_decision',
          executionState: 'not_started',
          reason: `missingDelivery:${messageId}`,
          events: [{
            kind: 'model_unavailable',
            executionState: 'not_started',
            reason: 'repair_delivery_missing',
            requestedModel: defaultRequestedRoute(live.policy),
            decisionRequired: true,
            resumable: true,
          }],
        })
      } catch (error: unknown) {
        if (error instanceof SessionLinkTaskError && error.code === TASK_STALE_REVISION) continue
        return live
      }
    }
    return this.tasks.get(taskId)
  }

  /* ----------------------------------------------------------------------
   * Outbox lifecycle (Task 5 sends; this service stores)
   * -------------------------------------------------------------------- */

  /**
   * Mark a pending event admitted-to-mailbox under CAS. The notification
   * message MUST ride the same sender→target pair as the task (verified
   * through the links probe against real mailbox facts — foreign or fabricated
   * message ids throw). Re-admitting an event under its recorded message id
   * is idempotent; admitting it under a different id throws.
   */
  async markOutboxAdmitted(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    eventId: string,
    notifiedMessageId: SessionLinkMessageId,
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      const index = row.outbox.findIndex(event => event.eventId === eventId)
      if (index === -1) throw new SessionLinkError(`outbox event "${eventId}" not found on task "${taskId}"`, 'MESSAGE_NOT_FOUND')
      const event = row.outbox[index]!
      if (event.status !== 'pending') {
        if (event.notifiedMessageId === notifiedMessageId) return row
        throw new SessionLinkError(
          `outbox event "${eventId}" is ${event.status} and cannot be admitted again`,
          'MESSAGE_UNDELIVERABLE',
        )
      }
      this.assertNotificationRecipient(row, notifiedMessageId)
      const outbox = row.outbox.slice()
      outbox[index] = { ...event, status: 'admitted', notifiedMessageId }
      return { ...row, outbox, revision: row.revision + 1, updatedAt: this.clock() }
    })
  }

  /** Mark an admitted event delivered once its mailbox message reached `delivered`. */
  async markOutboxDelivered(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    eventId: string,
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      const index = row.outbox.findIndex(event => event.eventId === eventId)
      if (index === -1) throw new SessionLinkError(`outbox event "${eventId}" not found on task "${taskId}"`, 'MESSAGE_NOT_FOUND')
      const event = row.outbox[index]!
      if (event.status === 'delivered') return row
      if (event.status !== 'admitted') {
        throw new SessionLinkError(
          `outbox event "${eventId}" is ${event.status}; only admitted events can be delivered`,
          'MESSAGE_UNDELIVERABLE',
        )
      }
      const outbox = row.outbox.slice()
      outbox[index] = { ...event, status: 'delivered' }
      return { ...row, outbox, revision: row.revision + 1, updatedAt: this.clock() }
    })
  }

  /** Record why an event could not be sent (link gone, budget denied, sender archived…) and keep it queryable. */
  async blockOutboxEvent(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    eventId: string,
    blockedReason: string,
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      const index = row.outbox.findIndex(event => event.eventId === eventId)
      if (index === -1) throw new SessionLinkError(`outbox event "${eventId}" not found on task "${taskId}"`, 'MESSAGE_NOT_FOUND')
      const event = row.outbox[index]!
      if (event.status === 'blocked' && event.blockedReason === blockedReason) return row
      const outbox = row.outbox.slice()
      outbox[index] = { ...event, status: 'blocked', blockedReason }
      return { ...row, outbox, revision: row.revision + 1, updatedAt: this.clock() }
    })
  }

  /** Guard: the notification message must ride the same sender→target pair as the task. */
  private assertNotificationRecipient(row: SessionLinkTaskRecordData, notifiedMessageId: SessionLinkMessageId): void {
    if (this.probe === undefined) return
    const message = this.probe.message(notifiedMessageId)
    if (message === undefined) {
      throw new SessionLinkError(
        `notification message "${notifiedMessageId}" is not in the mailbox; outbox events ride real deliveries only`,
        'MESSAGE_NOT_FOUND',
      )
    }
    if (message.senderId !== row.callerId && message.targetId !== row.callerId) {
      throw new SessionLinkError(
        `notification message "${notifiedMessageId}" does not name task caller "${row.callerId}"`,
        'LINK_CALLER_NOT_MEMBER',
      )
    }
    const other = message.senderId === row.callerId ? message.targetId : message.senderId
    if (row.targetSessionId !== undefined && other !== row.targetSessionId) {
      throw new SessionLinkError(
        `notification message "${notifiedMessageId}" addresses "${other}", not task target "${row.targetSessionId}"`,
        'LINK_TARGET_NOT_MEMBER',
      )
    }
  }

  /* ----------------------------------------------------------------------
   * Caller-performed transitions
   * -------------------------------------------------------------------- */

  /**
   * Request a task-state change under CAS. Transitions are validated against
   * the task state machine (an illegal transition throws); events the change
   * obligates are committed ATOMICALLY in the same row write — the row never
   * carries a state whose notification intent is not yet durable. Leaving
   * `running` clears the claim flag; leaving `waiting_decision` clears the
   * executionState/reason pair.
   */
  async requestStateChange(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    change: TaskChange,
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      if (change.toState === row.taskState) {
        throw new SessionLinkTaskError(TASK_TERMINAL, `task "${taskId}" is already ${row.taskState}`)
      }
      const legal = TASK_TRANSITIONS[row.taskState]
      if (!legal.includes(change.toState)) {
        throw new SessionLinkTaskError(
          TASK_TERMINAL,
          `task state ${row.taskState} → ${change.toState} is not a legal transition`,
        )
      }
      const now = this.clock()
      const nextRevision = row.revision + 1
      const events = (change.events ?? []).map(input => this.buildEvent(taskId, nextRevision, input, now))
      return applyChange(row, taskId, change, events, nextRevision, now)
    })
  }

  /* ----------------------------------------------------------------------
   * Decisions (the session_resolve_task core; idempotent by resolver callId)
   * -------------------------------------------------------------------- */

  /**
   * Apply one explicit decision. ONLY the original sender Session may decide.
   * The resolver's tool callId is the idempotency key: replaying a recorded
   * call returns its original outcome without mutating the task; a stale
   * expected revision performs nothing, durably records the `stale` outcome
   * against the call id (so the replay is itself idempotent), and reports the
   * current row for the caller to re-read.
   *
   *  - retry: only `waiting_decision`/`not_started`; opens a NEW attempt with
   *    the decided policy (or a snapshot of the prior attempt's candidates
   *    when omitted) and moves the task to `preparing` with NO Session and NO
   *    message — Task 4 replays the ORIGINAL spawn callKey/send admission so
   *    the SAME derived Session and a fresh binding attach. Nothing here
   *    creates a Session or a mailbox message.
   *  - continue: only `waiting_decision`/`partial`, and only when the host
   *    confirmed a resumable checkpoint (`hostResumable`); opens a continue
   *    attempt and returns the task to `queued` binding-free — Task 4 will
   *    admit a continuation message on the TARGET side (the host continues
   *    from its checkpoint; the plugin never rolls transcripts back and never
   *    replays completed tools).
   *  - cancel: not_started/partial intents plus preparing/queued/interrupted
   *    tasks close durably with a `cancelled` event; `unknown` progress and
   *    running tasks refuse (running tasks use the target's own human/host
   *    path — `TASK_RUNNING`).
   *
   * Retry/continue revalidate the link grant when a binding exists (cancel
   * stays permitted after unlink so a caller can close its own paused
   * intent), and refuse archived targets.
   */
  async resolveTask(input: {
    callerId: SessionId
    taskId: SessionLinkTaskId
    /** The resolver tool call's own callId: the decision idempotency key. */
    decisionCallId: string
    /** CAS guard; a mismatch performs nothing (a `stale` outcome is recorded). */
    expectedRevision: number
    action: 'retry' | 'continue' | 'cancel'
    /** Optional replacement policy for retry/continue; omitted reuses the prior attempt's candidates. */
    policy?: ModelRoutingPolicy
    /** True only when the host confirmed a resumable checkpoint for continue. */
    hostResumable?: boolean
    /** Live archived flag of the target, resolved by the tool layer. */
    targetArchived?: boolean
  }): Promise<{ row: SessionLinkTaskRecordData; decision: SessionLinkTaskDecisionRecord; outcome: 'applied' | 'stale' | 'rejected' }> {
    this.assertLive()
    const row = this.tasks.get(input.taskId)
    if (row === undefined) {
      throw new SessionLinkError(`task "${input.taskId}" not found`, 'MESSAGE_NOT_FOUND')
    }
    if (row.callerId !== input.callerId) {
      throw new SessionLinkError('only the original sender Session may resolve a task', 'LINK_CALLER_NOT_MEMBER')
    }
    const recorded = row.decisions.find(decision => decision.callId === input.decisionCallId)
    if (recorded !== undefined) {
      // Same decision call replayed: the recorded outcome stands; nothing re-applies.
      return { row, decision: recorded, outcome: recorded.outcome }
    }
    if (input.expectedRevision !== row.revision) {
      // Stale revision performs nothing; the durable record makes the replay idempotent.
      const decision: SessionLinkTaskDecisionRecord = {
        callId: input.decisionCallId,
        action: input.action,
        attemptId: row.currentAttemptId,
        outcome: 'stale',
        appliedRevision: row.revision,
        emittedEventIds: [],
        appliedAt: this.clock(),
      }
      const updated = await this.update(input.taskId, row.revision, current => ({
        ...current,
        decisions: [...current.decisions, decision],
        revision: current.revision + 1,
        updatedAt: this.clock(),
      }))
      return { row: updated, decision, outcome: 'stale' }
    }
    this.assertDecisionAuthorization(row, input)
    return await this.applyDecision(row, input)
  }

  /** Access + grant revalidation for retry/continue; cancel survives an unlink. */
  private assertDecisionAuthorization(row: SessionLinkTaskRecordData, input: {
    action: 'retry' | 'continue' | 'cancel'
    targetArchived?: boolean
  }): void {
    if (input.action === 'cancel') return
    if (input.targetArchived === true) {
      throw new SessionLinkError(`session "${row.targetSessionId ?? 'unknown'}" is archived`, 'TARGET_ARCHIVED')
    }
    if (this.probe !== undefined && row.execution.linkId !== undefined && row.targetSessionId !== undefined
      && !this.probe.pairLinked(row.execution.linkId, row.callerId, row.targetSessionId)) {
      throw new SessionLinkError(
        `link "${row.execution.linkId}" no longer pairs caller and target; retry/continue require a live grant`,
        'LINK_REVOKED',
      )
    }
  }

  /** Validate + commit one non-stale decision under CAS. */
  private async applyDecision(
    row: SessionLinkTaskRecordData,
    input: {
      taskId: SessionLinkTaskId
      decisionCallId: string
      action: 'retry' | 'continue' | 'cancel'
      policy?: ModelRoutingPolicy
      hostResumable?: boolean
    },
  ): Promise<{ row: SessionLinkTaskRecordData; decision: SessionLinkTaskDecisionRecord; outcome: 'applied' }> {
    const taskId = input.taskId
    const now = this.clock()
    /** The canonical identity (never caller-supplied raw strings) for hooks. */
    let resolvedTaskId: SessionLinkTaskId = taskId
    /** R08(1): the previous attempt's delivery identity, captured pre-clear. */
    const legacyMessageId = input.action === 'retry' ? row.execution.messageId : undefined

    // Validate against the current authoritative row BEFORE building the write.
    if (input.action === 'cancel') {
      if (row.execution.currentlyExecuting === true || row.taskState === 'running') {
        throw new SessionLinkTaskError(
          TASK_RUNNING,
          `task "${taskId}" is running; cancel through the target Session's own controls`,
        )
      }
      if (!['preparing', 'queued', 'waiting_decision', 'interrupted'].includes(row.taskState)) {
        throw new SessionLinkTaskError(TASK_TERMINAL, `task "${taskId}" is ${row.taskState} and cannot be cancelled`)
      }
      if (row.taskState === 'waiting_decision' && row.executionState === 'unknown') {
        throw new SessionLinkTaskError(
          TASK_NOT_CONTINUABLE,
          `task "${taskId}" execution progress is unknown and may hold external effects; `
          + 'it must not be cancelled or auto-resumed by this tool — inspect it with session_get_task',
        )
      }
    } else {
      if (row.taskState !== 'waiting_decision') {
        throw new SessionLinkTaskError(
          row.taskState === 'running' ? TASK_RUNNING : TASK_TERMINAL,
          `task "${taskId}" is ${row.taskState}; only waiting_decision accepts retry/continue`,
        )
      }
      if (input.action === 'retry' && row.executionState !== 'not_started') {
        throw new SessionLinkTaskError(
          TASK_NOT_RETRYABLE,
          `task "${taskId}" executionState is ${row.executionState ?? 'unset'}; retry requires not_started `
          + '(no successful model response, no tool dispatch) — continue covers resumable partial state',
        )
      }
      if (input.action === 'continue' && (row.executionState !== 'partial' || input.hostResumable !== true)) {
        throw new SessionLinkTaskError(
          TASK_NOT_CONTINUABLE,
          `task "${taskId}" has ${row.executionState ?? 'no'} execution progress the host confirmed resumable; `
          + 'continue requires waiting_decision + partial + a host-confirmed checkpoint. '
          + 'Start a new remediation task instead of replaying unknown effects.',
        )
      }
    }

    // Build the attempt + events + decision record outside the mutator; the
    // mutator stays a pure transform of the current row.
    const events: TaskEventInput[] = []
    let toState: TaskState
    let attempts = row.attempts
    let currentAttemptId = row.currentAttemptId
    let newAttempt: SessionLinkTaskAttempt | undefined
    if (input.action === 'cancel') {
      toState = 'cancelled'
      events.push({ kind: 'cancelled', decisionRequired: false, resumable: false })
    } else {
      toState = input.action === 'retry' ? 'preparing' : 'queued'
      const policy = input.policy ?? row.policy
      newAttempt = {
        attemptId: attemptIdFor(taskId, row.attempts.length + 1),
        ordinal: row.attempts.length + 1,
        kind: input.action,
        decisionIdemKey: input.decisionCallId,
        candidates: cloneCandidates(policy.candidates),
        results: [],
        openedAt: now,
      }
      attempts = [...row.attempts, newAttempt]
      currentAttemptId = newAttempt.attemptId
      /* A new attempt's precheck re-selects honestly (the retry admission
       * runs the full rule again); never inherit attempt 1's fixed index —
       * the catalog snapshot that produced it is not this attempt's. */
      events.push({
        kind: input.action === 'retry' ? 'model_unavailable' : 'interrupted',
        reason: input.action === 'retry' ? 'retry_decision_applied' : 'continue_decision_applied',
        decisionRequired: false,
        resumable: true,
      })
    }

    let built: SessionLinkTaskDecisionRecord | undefined
    const updated = await this.update(taskId, row.revision, current => {
      const nextRevision = current.revision + 1
      const builtEvents = events.map(event => this.buildEvent(taskId, nextRevision, event, now))
      const decision: SessionLinkTaskDecisionRecord = {
        callId: input.decisionCallId,
        action: input.action,
        attemptId: currentAttemptId,
        outcome: 'applied',
        appliedRevision: nextRevision,
        emittedEventIds: builtEvents.map(event => event.eventId),
        appliedAt: now,
      }
      built = decision
      const change: TaskChange = { toState, events: [] }
      const base = applyChange(current, taskId, change, builtEvents, nextRevision, now)
      if (input.action === 'cancel') {
        resolvedTaskId = taskIdFor(current.callerId, current.callId)
        return { ...base, decisions: [...current.decisions, decision] }
      }
      // retry/continue: clear the execution binding for the new attempt; the
      // ORIGINAL spawn callKey/send admission replays and attaches a fresh
      // binding (notificationRoot survives — the chain never resets).
      resolvedTaskId = taskIdFor(current.callerId, current.callId)
      /* Restart-window closure (Task-4 handoff): the predecessor delivery the
       * post-commit marking hook re-keys is recorded DURABLY in the same CAS
       * that clears the binding. A restart between this commit and the hook's
       * settle leaves the original key adoptable — reconcile's classification
       * re-drives marking from this ledger and drops it once the mailbox fact
       * is observed. `current.attempts.length` is the PREDECESSOR's ordinal
       * (the new attempt only lands in `attempts` below). */
      const retired = input.action === 'retry' && legacyMessageId !== undefined
        ? {
          retiredDeliveries: [
            ...(current.retiredDeliveries ?? []),
            { messageId: legacyMessageId, callKey: attemptCallKey(current.callId, current.attempts.length) },
          ],
        }
        : {}
      return {
        ...base,
        ...retired,
        attempts,
        currentAttemptId,
        ...(input.policy === undefined ? {} : { policy: clonePolicy(input.policy) }),
        execution: {},
        decisions: [...current.decisions, decision],
      }
    })
    /* Post-commit side facts, best-effort and strictly AFTER the durable
     * decision: R03's cancel revocation (mailbox pending → cancelled + host
     * intent cancel) and R08(1)'s legacy-delivery marker ride the injected
     * wire-layer hooks; a hook failure can never un-commit the decision,
     * and the activation gates read the terminal row independently. The
     * cancel hook receives the PRE-decision snapshot — the applied row no
     * longer names the delivery it must revoke. */
    if (input.action === 'cancel' && this.revokeDelivery !== undefined) {
      try { this.revokeDelivery(resolvedTaskId, row) } catch { /* gates are the authority */ }
    }
    if (input.action === 'retry' && legacyMessageId !== undefined && this.markLegacyDelivery !== undefined) {
      try { this.markLegacyDelivery(legacyMessageId, resolvedTaskId) } catch { /* marker is advisory */ }
    }
    return { row: updated, decision: built!, outcome: 'applied' }
  }

  /* ----------------------------------------------------------------------
   * Candidate-result journal (attempt-scoped, append-only)
   * -------------------------------------------------------------------- */

  /**
   * Append one immutable per-candidate outcome to the CURRENT attempt under
   * CAS. History is never rewritten; the per-attempt candidate budget
   * (MAX_CANDIDATE_ATTEMPTS = 5, counting the original request) is enforced
   * here and is reset ONLY when an explicit decision opens a new attempt —
   * never by a restart.
   *
   * `events` (optional) rides the SAME row write when the runtime wants the
   * journal entry to obligate a notification — used for the automatic
   * model_fallback_selected outbox event the switch decision commits.
   */
  async appendCandidateResult(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    result: { route: ModelRouteSelection; outcome: 'selected' | 'unavailable' | 'failed'; code?: string; message?: string },
    events?: readonly TaskEventInput[],
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      const index = row.attempts.findIndex(candidate => candidate.attemptId === row.currentAttemptId)
      const attempt = row.attempts[index]!
      if (attempt.results.length >= MAX_CANDIDATE_ATTEMPTS) {
        throw new SessionLinkTaskError(
          TASK_NOT_RETRYABLE,
          `task "${taskId}" attempt ${attempt.attemptId} already spent its ${MAX_CANDIDATE_ATTEMPTS}-record `
          + 'candidate budget; the budget resets only through an explicit resolve_task decision',
        )
      }
      const now = this.clock()
      const attempts = row.attempts.slice()
      attempts[index] = {
        ...attempt,
        results: [...attempt.results, {
          route: { ...result.route },
          outcome: result.outcome,
          ...(result.code === undefined ? {} : { code: result.code }),
          ...(result.message === undefined ? {} : { message: result.message }),
        }],
      }
      const nextRevision = row.revision + 1
      const outbox = (events ?? []).map(input => this.buildEvent(taskId, nextRevision, input, now))
      return {
        ...row,
        attempts,
        outbox: [...row.outbox, ...outbox],
        revision: nextRevision,
        updatedAt: now,
      }
    })
  }

  /**
   * Freeze a `session_default` candidate's concrete binding onto the current
   * attempt at first activation. Replay NEVER re-samples: once frozen, the
   * route is immutable; re-freezing the same route is idempotent and
   * re-freezing a different route throws.
   */
  async freezeDefaultRoute(
    taskId: SessionLinkTaskId,
    expectedRevision: number,
    route: ModelRouteSelection,
  ): Promise<SessionLinkTaskRecordData> {
    return await this.update(taskId, expectedRevision, row => {
      const index = row.attempts.findIndex(candidate => candidate.attemptId === row.currentAttemptId)
      const attempt = row.attempts[index]!
      if (attempt.defaultFrozenRoute !== undefined) {
        if (routesEqual(attempt.defaultFrozenRoute, route)) return row
        throw new SessionLinkTaskError(
          TASK_NOT_RETRYABLE,
          `task "${taskId}" attempt ${attempt.attemptId} already froze session_default to `
          + `${attempt.defaultFrozenRoute.provider}/${attempt.defaultFrozenRoute.model}; replay must not re-sample`,
        )
      }
      const attempts = row.attempts.slice()
      attempts[index] = { ...attempt, defaultFrozenRoute: { ...route } }
      return { ...row, attempts, revision: row.revision + 1, updatedAt: this.clock() }
    })
  }

  /* ----------------------------------------------------------------------
   * Replay reconciliation (mount/restart)
   * -------------------------------------------------------------------- */

  /**
   * Scan task rows and classify half-written state into repair buckets.
   * Recovery NEVER creates a Session, NEVER wakes one, and NEVER fabricates
   * a mailbox message:
   *
   *  (i)   resumableIntents   — intent with no message binding; Task 4 spawn
   *        replay MUST consult these BEFORE creating anything (same taskId
   *        returned, no second Session).
   *  (ii)  needsBindingRepair — bound message without a durable host turn
   *        intent (or a cross-domain inconsistency); the task drops to
   *        `waiting_decision`/`not_started` and exactly ONE
   *        `repair_binding_missing` outbox event is committed across
   *        restarts so the caller can resolve. It is NEVER auto-executed.
   *  (iii) orphanChecks       — turn intent recorded; host
   *        `listOrphanedTurnIntents` facts pair with the task so Task 4/5
   *        align the plugin projection with host reality.
   *
   * Bucket rows are the pre-repair snapshots the scan read; returned tasks
   * are identified by taskId/caller+callId so callers re-read live state.
   */
  async reconcile(): Promise<ReconcileResult> {
    this.assertLive()
    /* Restart-window closure (Task-4 handoff, phase 0): re-drive the retired
     * -delivery marking every retiredDeliveries ledger entry still owes, then
     * drop entries whose mailbox fact is observed (message absent, cancelled,
     * or already aliased to `<callKey>/consumed`). The decision-time hook is
     * fire-and-forget; this phase is its restart-safe completion driver, so
     * the original call key can never stay adoptable across a restart that
     * landed between the retry commit and the marking. */
    await this.settleRetiredDeliveries()
    const resumableIntents: SessionLinkTaskRecordData[] = []
    const needsBindingRepair: SessionLinkTaskRecordData[] = []
    const orphanChecks: ReconcileReport['orphanChecks'][number][] = []
    const notifiedRepairs: SessionLinkTaskId[] = []

    for (const [taskId, row] of this.tasks.entries()) {
      if (['turn_finished', 'cancelled', 'failed'].includes(row.taskState)) continue
      const hasMessage = row.execution.messageId !== undefined
      const hasIntent = row.execution.turnIntentId !== undefined
      if (!hasMessage) {
        resumableIntents.push(row)
        continue
      }
      if (!hasIntent) {
        needsBindingRepair.push(row)
        continue
      }
      // Cross-domain consistency: the bound mailbox message must exist for a
      // task that is not yet terminal-in-execution (R11), AND must agree on
      // the pair. An ABSENT message while the task projects any interest in
      // the delivery (claimable/admitted states) is a half-written binding;
      // repair it honestly instead of reporting a phantom `queued`.
      if (this.probe !== undefined) {
        const message = this.probe.message(row.execution.messageId!)
        if (message !== undefined
          && (message.senderId !== row.callerId
            || (row.targetSessionId !== undefined && message.targetId !== row.targetSessionId))) {
          needsBindingRepair.push(row)
          continue
        }
        if (message === undefined && ['queued', 'running'].includes(row.taskState)) {
          needsBindingRepair.push(row)
          continue
        }
      }
      const orphans = row.targetSessionId === undefined || this.hostFor === undefined
        ? []
        : (this.hostFor(row.targetSessionId)?.listOrphanedTurnIntents() ?? [])
      orphanChecks.push({ taskId, turnIntentId: row.execution.turnIntentId!, orphans })
    }

    // Report each binding-repair task to the caller: exactly one pending
    // repair intent per task (regardless of its restart history). Per-row
    // resilience (final review): one racing row (TASK_STALE_REVISION) is
    // re-read and retried once, then skipped — it can never abort the whole
    // reconcile and leave every later row unclassified.
    for (const row of needsBindingRepair) {
      if (row.outbox.some(isRepairNoticePending)) continue
      if (row.taskState === 'waiting_decision' && row.executionState !== undefined) continue
      const taskId = taskIdFor(row.callerId, row.callId)
      if (await this.repairOne(taskId, row)) notifiedRepairs.push(taskId)
    }

    return {
      report: { resumableIntents, needsBindingRepair, orphanChecks },
      notifiedRepairs,
    }
  }

  /**
   * Commit the one-shot binding-repair projection for ONE row, tolerating a
   * concurrent writer: a `TASK_STALE_REVISION` re-reads the live row and
   * retries once; any later failure (still racing, or a durability fault)
   * skips THIS row so `reconcile()` still classifies the rest. Returns the
   * taskId-reporting flag (true only when THIS run committed the notice).
   */
  private async repairOne(
    taskId: SessionLinkTaskId,
    row: SessionLinkTaskRecordData,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = attempt === 0 ? row : this.tasks.get(taskId)
      if (current === undefined) return false
      if (current.outbox.some(isRepairNoticePending)) return false
      if (current.taskState === 'waiting_decision') return false
      /* R11: distinguish the missing-DELIVERY repair (the row binds a
       * messageId the mailbox does not contain) from the missing-BINDING
       * repair; the reasons stay separate so the caller can tell a phantom
       * delivery from a host-side half-write. */
      const deliveryMissing = row.execution.messageId !== undefined && row.execution.turnIntentId !== undefined
      const reasonCode = deliveryMissing ? 'repair_delivery_missing' : 'repair_binding_missing'
      try {
        const updated = await this.update(taskId, current.revision, mutating => {
          if (mutating.outbox.some(isRepairNoticePending)) return mutating
          if (mutating.taskState === 'waiting_decision') return mutating
          const nextRevision = mutating.revision + 1
          const event = this.buildEvent(taskId, nextRevision, {
            kind: 'model_unavailable',
            executionState: 'not_started',
            reason: reasonCode,
            requestedModel: defaultRequestedRoute(mutating.policy),
            attempts: 0,
            decisionRequired: true,
            resumable: true,
          }, this.clock())
          return {
            ...mutating,
            taskState: 'waiting_decision',
            executionState: 'not_started',
            reason: reasonCode,
            outbox: [...mutating.outbox, event],
            revision: nextRevision,
            updatedAt: this.clock(),
          }
        })
        return updated.revision !== current.revision && updated.outbox.some(event =>
          (event.reason === 'repair_binding_missing' || event.reason === 'repair_delivery_missing')
          && event.revision === updated.revision)
      } catch (error: unknown) {
        if (error instanceof SessionLinkTaskError && error.code === TASK_STALE_REVISION) continue
        // A durability failure on THIS row skips it; the next reconcile pass
        // retries it honestly. Never abort the whole scan.
        return false
      }
    }
    return false
  }

  /**
   * Re-drive and complete the durable retired-delivery ledger. For every
   * entry: read the mailbox fact through the probe; an entry whose delivery
   * is gone, cancelled, or already re-keyed to `<callKey>/consumed` is
   * COMPLETE and drops in one CAS per row; an incomplete entry re-invokes
   * the wire-layer marking hook (same vocabulary as the decision-time call —
   * intentId-or-messageId identity, never a third form). Per-row failures
   * skip just that row, exactly like {@link repairOne}.
   */
  private async settleRetiredDeliveries(): Promise<void> {
    if (this.probe === undefined) return
    for (const [taskId, row] of this.tasks.entries()) {
      const entries = row.retiredDeliveries ?? []
      if (entries.length === 0) continue
      let dirty = false
      const kept: typeof entries = []
      for (const entry of entries) {
        const message = this.probe.message(entry.messageId)
        const observed = message === undefined
          || message.status === 'cancelled'
          || message.idempotencyKey === `${entry.callKey}/consumed`
        if (!observed) {
          kept.push(entry)
          if (this.markLegacyDelivery !== undefined) {
            try { this.markLegacyDelivery(entry.messageId, taskId) } catch { /* re-classified next pass */ }
          }
          continue
        }
        dirty = true
      }
      if (!dirty || kept.length === entries.length) continue
      try {
        await this.update(taskId, row.revision, current => {
          if ((current.retiredDeliveries ?? []).length !== entries.length) return current
          return { ...current, retiredDeliveries: kept, revision: current.revision + 1, updatedAt: this.clock() }
        })
      } catch { /* a racing writer re-classifies on the next pass */ }
    }
  }

  /** Build one outbox event with its deterministic id inside a CAS mutator. */
  private buildEvent(
    taskId: SessionLinkTaskId,
    revision: number,
    input: TaskEventInput,
    now: string,
  ): SessionLinkTaskOutboxEvent {
    const decision = input
    return {
      eventId: eventIdFor(taskId, revision, decision.kind),
      kind: decision.kind,
      revision,
      ...(decision.executionState === undefined ? {} : { executionState: decision.executionState }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.requestedModel === undefined ? {} : { requestedModel: decision.requestedModel }),
      ...(decision.actualModel === undefined ? {} : { actualModel: decision.actualModel }),
      ...(decision.attempts === undefined ? {} : { attempts: decision.attempts }),
      decisionRequired: decision.decisionRequired ?? false,
      resumable: decision.resumable ?? false,
      status: 'pending',
      createdAt: now,
    }
  }
}

/** Whether a repair notification intent is still owed delivery for one task row. */
function isRepairNoticePending(event: SessionLinkTaskOutboxEvent): boolean {
  return (event.reason === 'repair_binding_missing' || event.reason === 'repair_delivery_missing')
    && (event.status === 'pending' || event.status === 'admitted')
}

/** Clone the candidate snapshot so a stored attempt never shares mutable structure with caller input. */
function cloneCandidates(candidates: readonly ModelRouteCandidate[]): ModelRouteCandidate[] {
  return candidates.map(candidate => 'use' in candidate ? { use: 'session_default' as const } : { ...candidate })
}

/** Clone a full policy into the durable record shape (mutable arrays, plain JSON). */
function clonePolicy(policy: ModelRoutingPolicy): SessionLinkTaskRecordData['policy'] {
  return {
    scope: policy.scope,
    candidates: cloneCandidates(policy.candidates),
    ifExhausted: policy.ifExhausted,
    usesSessionDefault: policy.usesSessionDefault,
  }
}

/** Apply one validated change to the current row inside the CAS mutator (pure). */
function applyChange(
  row: SessionLinkTaskRecordData,
  taskId: SessionLinkTaskId,
  change: TaskChange,
  events: SessionLinkTaskOutboxEvent[],
  nextRevision: number,
  now: string,
): SessionLinkTaskRecordData {
  void taskId
  const execution: SessionLinkTaskExecutionProjection = {
    ...row.execution,
    ...(change.currentRoute === undefined ? {} : { currentRoute: change.currentRoute }),
    ...(change.routeUsed === undefined ? {} : { routeUsed: change.routeUsed }),
  }
  if (change.toState === 'running') {
    // A claim is requested by the call that moves the task into running.
    execution.currentlyExecuting = true
  } else if (execution.currentlyExecuting !== undefined) {
    // Leaving running clears the claim flag; nothing may keep a stale claim.
    delete execution.currentlyExecuting
  }
  const keepingWait = change.toState === 'waiting_decision' || change.toState === 'interrupted'
  const base: SessionLinkTaskRecordData = {
    ...row,
    taskState: change.toState,
    execution,
    outbox: [...row.outbox, ...events],
    revision: nextRevision,
    updatedAt: now,
  }
  if (keepingWait) {
    return {
      ...base,
      ...(change.executionState !== undefined ? { executionState: change.executionState } : {}),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    }
  }
  // States without an execution-progress flag drop it together with the reason.
  const { executionState: _executionState, reason: _reason, ...rest } = base
  return rest as SessionLinkTaskRecordData
}

export default SessionLinkTaskService
