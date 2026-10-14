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

/** Current full catalogs; deleted groups disappear from the next poll. */
export interface SessionLinkView {
  readonly pollIntervalMs: number
  readonly links: readonly SessionLinkSummary[]
  readonly sessions: readonly SessionLinkSessionView[]
}

/** Mailbox section an activity query pages through. */
export type SessionLinkActivitySection = 'pending' | 'recent'

/**
 * Why one pending message is still waiting. Several reasons may coexist on one
 * entry; `unknown` appears alone when none of the known blockers applies.
 */
export type SessionLinkBlockingReason =
  | 'wake-unauthorized'
  | 'wake-budget'
  | 'archived'
  | 'cold-target'
  | 'delivery-unverified'
  | 'link-revoked'
  | 'unknown'

/** One mailbox row as the activity view projects it; carries no model-visible body. */
export interface SessionLinkActivityEntry {
  readonly messageId: SessionLinkMessageId
  readonly linkId: SessionLinkId
  /** Direction relative to the querying Session. */
  readonly direction: 'inbound' | 'outbound'
  readonly senderId: SessionId
  readonly targetId: SessionId
  readonly status: SessionLinkMessageStatus
  /** ISO-8601 admission timestamp; enqueue time, never a delivery time. */
  readonly createdAt: string
  /** Admission sequence; absent on messages admitted before 0.4.0. */
  readonly seq?: number
  readonly inReplyTo?: SessionLinkMessageId
  /** Sender body without its delivery frame, control characters collapsed, capped at 160 characters. */
  readonly preview: string
  /** Sanitized failure detail for `failed` records; capped, markup inert. */
  readonly lastError?: string
  /** Whether a cancel request could still succeed for this pending message right now. */
  readonly canCancel: boolean
  /** Known reasons this pending message has not moved; empty for terminal and delivered rows. */
  readonly blockingReasons: readonly SessionLinkBlockingReason[]
}

/** Live posture of one counterparty named on the returned page. */
export interface SessionLinkActivityTarget {
  readonly id: SessionId
  /** Whether an Agent exists for the Session without resuming it. */
  readonly live: boolean
  /** Whether that live Agent is currently running a turn. */
  readonly running: boolean
  readonly archived: boolean
}

/** Session-level counters beside one page; never filtered by section or peer. */
export interface SessionLinkActivitySummary {
  readonly wake: {
    /** Automatic wakes the querying Session's incoming mail already spent today. */
    readonly used: number
    readonly limit: number
    /** UTC day key the counter belongs to. */
    readonly day: string
    /** Start of the next UTC day, when the counter resets. */
    readonly resetsAt: string
  }
  readonly pendingInbound: number
  readonly pendingOutbound: number
  /** Whether any spawn-granted group still owes this Session its one first-task wake. */
  readonly firstTaskWakeOwed: boolean
  /** Legacy report-marked records held in isolation; informational, never actionable here. */
  readonly legacyBlocked: number
  readonly targets: readonly SessionLinkActivityTarget[]
}

/** One bounded page of mailbox activity plus the counters a quick glance needs. */
export interface SessionLinkActivityView {
  /** ISO-8601 instant the snapshot was assembled. */
  readonly sampledAt: string
  /** Rows matching the section and filters before paging. */
  readonly total: number
  readonly entries: readonly SessionLinkActivityEntry[]
  /** Pass back as `cursor` for the next page; absent when this page is the last. */
  readonly nextCursor?: string
  readonly summary: SessionLinkActivitySummary
}

/**
 * Request accepted by the `sessionLinks/activityView` Remote: a read-only,
 * paginated mailbox observation. `sessionId` selects the viewed mailbox and is
 * not an identity credential; viewing grants no send rights.
 */
export interface SessionLinkActivityRequest {
  readonly sessionId: SessionId
  readonly section: SessionLinkActivitySection
  /** Restrict entries to mail with this one counterparty, in either direction. */
  readonly peerId?: SessionId
  /** Opaque continuation token from an earlier page's `nextCursor`. */
  readonly cursor?: string
  /** Page size; defaults to 20, never above 50. */
  readonly limit?: number
}

/**
 * Client-side `activityView` page request: the caller binds its own Session
 * identity before invoking the Remote.
 */
export type SessionLinkActivityQuery = Omit<SessionLinkActivityRequest, 'sessionId'>

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
      | 'LEGACY_TASK_MESSAGE_BLOCKED'
      | 'MAILBOX_FULL'
      | 'MESSAGE_TOO_LARGE'
      | 'WAKE_BUDGET_EXHAUSTED'
      | 'TARGET_NOT_ORDINARY'
      | 'TARGET_ARCHIVED'
      | 'TARGET_OWNED_BY_SUBAGENT'
      | 'TARGET_UNAVAILABLE'
      | 'ACTIVITY_CURSOR_INVALID'
      | 'DISPOSED',
  ) {
    super(message)
    this.name = 'SessionLinkError'
  }
}
