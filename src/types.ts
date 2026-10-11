/**
 * Session Link vocabulary shared by the service, its tools, and durable state.
 * @module dsh-session-link/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// Browser consumers use this module without loading host services.

/** Identifies one human-created communication group between ordinary Sessions. */
export type SessionLinkId = Branded<'SessionLinkId'>

/** Identifies one durable mailbox message. */
export type SessionLinkMessageId = Branded<'SessionLinkMessageId'>

/** Identifies one tracked task row (`task:<callerSessionId>:<firstCallId>`). */
export type SessionLinkTaskId = Branded<'SessionLinkTaskId'>

/**
 * Brand a Session Link id.
 * @param value - group identifier minted by the service.
 * @returns the same string with its compile-time brand.
 */
export function SessionLinkId(value: string): SessionLinkId {
  return value as SessionLinkId
}

/**
 * Brand a mailbox message id.
 * @param value - message identifier minted by the service.
 * @returns the same string with its compile-time brand.
 */
export function SessionLinkMessageId(value: string): SessionLinkMessageId {
  return value as SessionLinkMessageId
}

/**
 * Brand a tracked task id. The service derives the value stably from the
 * caller Session and the first call id; it never accepts one from input.
 * @param value - task identifier minted by the service.
 * @returns the same string with its compile-time brand.
 */
export function SessionLinkTaskId(value: string): SessionLinkTaskId {
  return value as SessionLinkTaskId
}

/** Stable sender attribution recorded in the target Session, never accepted from tool input. */
export interface SessionLinkMessageSource {
  readonly kind: 'session-link-message'
  /** Durable identity used for deduplication at the target Session. */
  readonly messageId: SessionLinkMessageId
  /** Group under which this message was admitted; recorded for forensics, not for live authorization. */
  readonly linkId: SessionLinkId
  readonly senderId: SessionId
  readonly senderTitle: string
  /** Message this delivery replies to when routed through the reply path. */
  readonly inReplyTo?: SessionLinkMessageId
}

/** One concrete model route a task-status report names. */
export interface SessionLinkTaskStatusRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Host-generated task-status attribution recorded in the RECEIVING (original
 * sender) Session. Distinct from {@link SessionLinkMessageSource}: the
 * delivery is a STATUS FACT the plugin/host emits about the ORIGINAL task —
 * never the target Session speaking, never an instruction. Read-side dedupe
 * keys on `session-task-status` + `messageId`; every existing
 * `session-link-message` consumer keeps reading only peer mail.
 */
export interface SessionLinkTaskStatusSource {
  readonly kind: 'session-task-status'
  /** Durable identity used for deduplication at the receiving Session. */
  readonly messageId: SessionLinkMessageId
  /** Group under which the original task pair was admitted. */
  readonly linkId: SessionLinkId
  /** The ORIGINAL task this status reports. */
  readonly taskId: SessionLinkTaskId
  /** The Session the task ran/runs on (the REPORT's subject, never its speaker). */
  readonly targetSessionId: SessionId
  /** The attempt this fact belongs to. */
  readonly attemptId: string
}

/**
 * The trusted internal admission input of one host-generated task-status
 * report (Task 5 of the model-routing plan). The plugin's task-notification
 * entry forwards strictly its own durable outbox facts; no public tool and
 * no external caller reaches this entry.
 */
export interface SessionLinkTaskStatusReport {
  /** Deterministic outbox identity `taskId/revision/kind`; the mailbox's admission key. */
  readonly eventId: string
  readonly taskId: SessionLinkTaskId
  readonly attemptId: string
  readonly revision: number
  readonly eventKind: 'model_fallback_selected' | 'model_unavailable' | 'turn_finished' | 'interrupted' | 'cancelled'
  /** The Session the report is FOR (the notification is addressed TO it). */
  readonly callerId: SessionId
  /** The Session the task ran/runs on (the report's subject). */
  readonly targetId: SessionId
  readonly executionState?: 'not_started' | 'partial' | 'unknown'
  readonly reason?: string
  readonly requestedModel: SessionLinkTaskStatusRoute
  readonly actualModel?: SessionLinkTaskStatusRoute
  readonly attempts: number
  readonly decisionRequired: boolean
  readonly resumable: boolean
  /** Chain root: the ORIGINAL task's notification root, when known. */
  readonly inReplyTo?: SessionLinkMessageId
}

/**
 * How one link grant was authorized at creation. A `session` grant comes from
 * the spawn tool and owes the spawned member one wake for its first task.
 */
export interface SessionLinkGrant {
  readonly kind: 'human' | 'session'
  /** The granting Session when `kind` is `session`. */
  readonly sessionId?: SessionId
}

/** Durable record of one link group. Membership changes replace `memberIds` whole and bump `revision`. */
export interface SessionLinkRecord {
  /** Human-facing group name. */
  readonly name: string
  /** Every member may message every other member; there is no transitive friendship. */
  readonly memberIds: readonly SessionId[]
  /** Members whose admitted messages may wake them automatically. */
  readonly autoWakeSessionIds: readonly SessionId[]
  /** Durable revision; link/revoke/membership operations bump it. */
  readonly revision: number
  /** ISO-8601 timestamps. */
  readonly createdAt: string
  readonly updatedAt: string
  /** Authenticated authority from the granting operation. */
  readonly grantedBy: SessionLinkGrant
}

/** Terminal states must never be reprocessed by recovery. */
export type SessionLinkMessageStatus =
  | 'pending'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'revoked'

/** One durable mailbox entry: the authoritative record of intent, delivery state, and throttling. */
export interface SessionLinkMessageRecord {
  readonly linkId: SessionLinkId
  readonly senderId: SessionId
  readonly senderTitle: string
  readonly targetId: SessionId
  readonly inReplyTo?: SessionLinkMessageId
  /** Framed model-facing body, sender frame included; stored once at admission. */
  readonly text: string
  readonly status: SessionLinkMessageStatus
  /** Counts each host-initiated automatic wake this message caused. */
  readonly wakesUsed: number
  /** Chain length ending at this message; replies inherit and increment. */
  readonly chainLength: number
  /** Failed attempts to resume a cold target for this message; terminal at the configured bound. Flush failures never count: the target already holds the message. */
  readonly attempts: number
  readonly createdAt: string
  /** Failure detail retained for operators when status is `failed`. */
  readonly error?: string
  /** Caller-supplied idempotency key, committed in the same write as the message. */
  readonly idempotencyKey?: string
  /** Monotonic admission sequence; absent on messages admitted before 0.4.0. */
  readonly seq?: number
  /** Set before the message is handed to the target; such a message is never made terminal. */
  readonly inserted?: boolean
  /** Present only on host-generated task-status reports; peer mail never carries it. */
  readonly statusKind?: 'task-status'
  /** Structured task facts of a task-status report. */
  readonly taskStatus?: {
    readonly taskId: string
    readonly attemptId: string
    readonly eventId: string
    readonly revision: number
    readonly kind: 'model_fallback_selected' | 'model_unavailable' | 'turn_finished' | 'interrupted' | 'cancelled'
    readonly executionState?: 'not_started' | 'partial' | 'unknown'
    readonly reason?: string
    readonly requestedModel: SessionLinkTaskStatusRoute
    readonly actualModel?: SessionLinkTaskStatusRoute
    readonly attempts: number
    readonly decisionRequired: boolean
    readonly resumable: boolean
  }
}

/** Per-day automatic-wake counter for one Session. */
export interface SessionLinkWakeLedgerEntry {
  /** UTC day key, `YYYY-MM-DD`. */
  readonly day: string
  readonly wakes: number
}

/** The summary the `session_list_links` tool and future management surfaces read. */
export interface SessionLinkSummary {
  readonly id: SessionLinkId
  readonly name: string
  readonly memberIds: readonly SessionId[]
  readonly autoWakeSessionIds: readonly SessionId[]
  readonly revision: number
}

/** Cold-safe Session catalog row used by the plugin's browser panel. */
export interface SessionLinkSessionView {
  readonly id: SessionId
  readonly title: string
  readonly running: boolean
  readonly archived: boolean
  readonly ordinary: boolean
  readonly blank: boolean
}

/** One concrete route the plugin's task projection names (camelCase wire fields). */
export interface SessionLinkTaskRouteView {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Outbox event line the `sessionLinks/taskView` Remote reports (task row lifecycle). */
export interface SessionLinkTaskOutboxView {
  readonly eventId: string
  readonly kind: 'model_fallback_selected' | 'model_unavailable' | 'turn_finished' | 'interrupted' | 'cancelled'
  readonly status: 'pending' | 'admitted' | 'delivered' | 'blocked'
  readonly requestedModel?: SessionLinkTaskRouteView
  readonly actualModel?: SessionLinkTaskRouteView
  readonly decisionRequired: boolean
  readonly resumable: boolean
  readonly blockedReason?: string
}

/**
 * Read-only task line the human panel shows. Task state against one durable
 * tracked-task intent: state, scope, requested vs actual route (a persistent
 * label appears only once the baseline persist actually committed), the
 * target Session, the latest attempt issue, and the outbox lifecycle.
 * `pending`/`admitted` never claim execution; `currentlyExecuting` comes
 * straight from the durable runtime projection.
 */
export interface SessionLinkTaskViewEntry {
  readonly taskId: string
  readonly taskState: string
  readonly revision: number
  readonly executionState?: 'not_started' | 'partial' | 'unknown'
  readonly reason?: string
  readonly targetSessionId?: SessionId
  readonly requestedModel: SessionLinkTaskRouteView
  readonly currentRoute?: SessionLinkTaskRouteView
  readonly routeUsed?: SessionLinkTaskRouteView
  readonly scope: 'task' | 'session'
  /** True only when the session-baseline persist committed; a skipped persist stays honest (see `reason`). */
  readonly routePersisted: boolean
  readonly currentlyExecuting: boolean
  readonly latestIssue?: { readonly code?: string; readonly message?: string }
  readonly outbox: readonly SessionLinkTaskOutboxView[]
  readonly updatedAt: string
}

/** Current full catalogs; deleted groups disappear from the next poll. */
export interface SessionLinkView {
  readonly pollIntervalMs: number
  readonly links: readonly SessionLinkSummary[]
  readonly sessions: readonly SessionLinkSessionView[]
}

/** Request accepted by the `sessionLinks/taskView` Remote. */
export interface SessionLinkTaskViewRequest {
  /** Managing Session; only tasks whose callerId or targetSessionId is this may appear. */
  readonly sessionId: SessionId
}

/** Read-only task projection for the human panel; never a wake, never a decision. */
export interface SessionLinkTaskViewResponse {
  readonly pollIntervalMs: number
  readonly tasks: readonly SessionLinkTaskViewEntry[]
}

/**
 * Request accepted by the `sessionLinks/linkFrom` Remote: link the caller's
 * Session with one peer, granted as `{ kind: 'human' }` like the `/session-link`
 * command path.
 */
export interface SessionLinkAddRequest {
  /** Session the browser caller operates from; becomes one member. */
  readonly callerId: SessionId
  /** Ordinary Session to link with; validated through the Session Controller. */
  readonly peerId: SessionId
  /** Whether admitted messages may wake the peer automatically. */
  readonly autoWake: boolean
  /** Whether replies may wake the caller; omitted preserves the legacy false default. */
  readonly autoWakeCaller?: boolean
}

/** Result of one accepted `sessionLinks/linkFrom` Remote call. */
export interface SessionLinkAddResult {
  readonly linkId: SessionLinkId
}

/** Request accepted by the `sessionLinks/unlinkFrom` Remote; the caller must be a member. */
export interface SessionLinkRevokeRequest {
  readonly callerId: SessionId
  readonly linkId: SessionLinkId
}

/** Request accepted by the `sessionLinks/setAutoWakeFrom` Remote: toggle one member's auto-wake in one group. */
export interface SessionLinkWakeRequest {
  readonly callerId: SessionId
  readonly linkId: SessionLinkId
  /** Member whose auto-wake flag flips; may be the caller itself for human RPC requests. */
  readonly peerId: SessionId
  readonly on: boolean
}

/** What earlier attempts of one spawn call already recorded. */
export interface SessionLinkSpawnReplay {
  /** Session the earlier attempt created. */
  readonly sessionId: SessionId
  /** Group the earlier attempt granted. */
  readonly linkId: SessionLinkId
  /** Whether a human removed the call's group (or its pairing); a removed group is never granted again. */
  readonly removed: boolean
  /** The first task, when an earlier attempt admitted it. */
  readonly task?: SessionLinkSendResult
}

/** The outcome of admitting one message to the mailbox. */
export interface SessionLinkSendResult {
  readonly messageId: SessionLinkMessageId
  /**
   * `accepted` means the target Session durably records the message (model-visible history or pending inbox).
   * `queued` means durable in the mailbox only; the target has not recorded it.
   * Neither state claims the message was processed or its task completed.
   */
  readonly status: 'queued' | 'accepted'
}

/** Request accepted by {@link import('./link.ts').SessionLinkService.send}. */
export interface SessionLinkSendRequest {
  readonly targetId: SessionId
  readonly text: string
  /** Original message this replies to; must be one the caller received. */
  readonly inReplyTo?: SessionLinkMessageId
  /** Call-site idempotency identity: a resubmitted key returns the original admission result. */
  readonly idempotencyKey?: string
  /** Optional pre-delivery cancellation. */
  readonly signal?: AbortSignal
  /**
   * Caller-derived message identity (tracked-task admission only). Legacy
   * model-less calls NEVER pass this and keep the mailbox's own random
   * identity mint untouched.
   */
  readonly messageId?: SessionLinkMessageId
}

/** Deployment limits for the Session Link service. */
export interface Config {
  /** Browser catalog refresh interval in milliseconds, from 1000 to 2147483647. @default 30000 */
  readonly uiPollIntervalMs?: number
  /** Maximum members in one link group. @default 8 */
  readonly maxLinkMembers?: number
  /** Maximum pending messages retained for one target Session. @default 16 */
  readonly maxPendingPerTarget?: number
  /** Maximum UTF-8 bytes of one sender-framed message body. @default 16384 */
  readonly maxMessageBytes?: number
  /** Maximum automatic wakes a Session may spend in one UTC day. @default 6 */
  readonly maxAutoWakesPerSessionPerDay?: number
  /** Maximum automatic wake claims any single message may cause. @default 1 */
  readonly maxAutoWakesPerMessage?: number
  /** Maximum automatic wakes spent on one reply chain across the link. @default 4 */
  readonly maxAutoWakesPerChain?: number
  /** Failed cold-target resumes after which a message the target does not hold becomes terminal `failed`. @default 3 */
  readonly maxDeliveryAttempts?: number
}

/** Structured failure raised by the Session Link service. */
export class SessionLinkError extends Error {
  /**
   * @param message - caller-facing explanation.
   * @param code - stable machine-readable cause.
   */
  constructor(
    message: string,
    readonly code:
      | 'LINK_NOT_FOUND'
      | 'LINK_MEMBER_LIMIT'
      | 'LINK_NAME_INVALID'
      | 'LINK_TARGET_NOT_MEMBER'
      | 'LINK_SELF'
      | 'LINK_ALREADY_LINKED'
      | 'LINK_CALLER_NOT_MEMBER'
      | 'TARGET_NOT_FOUND'
      | 'LINK_REVOKED'
      | 'MESSAGE_NOT_FOUND'
      | 'MESSAGE_NOT_REPLYABLE'
      | 'MESSAGE_UNDELIVERABLE'
      | 'MAILBOX_FULL'
      | 'MESSAGE_TOO_LARGE'
      | 'WAKE_BUDGET_EXHAUSTED'
      | 'TARGET_NOT_ORDINARY'
      | 'TARGET_ARCHIVED'
      | 'TARGET_OWNED_BY_SUBAGENT'
      | 'TARGET_UNAVAILABLE'
      | 'DISPOSED',
  ) {
    super(message)
    this.name = 'SessionLinkError'
  }
}
