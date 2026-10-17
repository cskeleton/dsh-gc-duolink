/**
 * The Session Link service (`ctx.gcDuolink`): link-group lifecycle and the
 * durable mailbox that admits, orders, and acknowledges peer deliveries.
 * @module dsh-gc-duolink/link
 */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as wire } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import {
  sessionLinkDomainSpec,
  initializeDuolinkDomain,
  SESSION_LINK_LEDGER_KEY,
} from './spec.ts'
import type {
  SessionLinkLedgersData,
  SessionLinkMessageRecordData,
  SessionLinkRecordData,
  InitialModelSpawnRecord,
} from './spec.ts'
import {
  SessionLinkError,
  SessionLinkId,
  SessionLinkMessageId,
} from './types.ts'
import type {
  Config as SessionLinkConfigShape,
  SessionLinkActivityEntry,
  SessionLinkActivityRequest,
  SessionLinkActivityView,
  SessionLinkAddRequest,
  SessionLinkAddResult,
  SessionLinkBlockingReason,
  SessionLinkCancelRequest,
  SessionLinkCancelResult,
  SessionLinkWakeBudget,
  SessionLinkExtendWakeRequest,
  SessionLinkExtendWakeResult,
  SessionLinkGrant,
  SessionLinkMessageSource,
  SessionLinkRevokeRequest,
  SessionLinkSendRequest,
  SessionLinkSendResult,
  SessionLinkSpawnReplay,
  SessionLinkSummary,
  SessionLinkWakeRequest,
  SessionLinkView,
} from './types.ts'

const wireSessionId = wire.string().min(1).transform(value => brandString<SessionId>(value))
const wireLinkId = wire.string().min(1).transform(value => SessionLinkId(value))
const addRequestSchema = wire.strictObject({ callerId: wireSessionId, peerId: wireSessionId, autoWake: wire.boolean(), autoWakeCaller: wire.boolean().optional() })
const revokeRequestSchema = wire.strictObject({ callerId: wireSessionId, linkId: wireLinkId })
const wakeRequestSchema = wire.strictObject({ callerId: wireSessionId, linkId: wireLinkId, peerId: wireSessionId, on: wire.boolean() })
const cancelRequestSchema = wire.strictObject({ sessionId: wireSessionId, messageId: wire.string().min(1).transform(value => SessionLinkMessageId(value)) })
const extendWakeRequestSchema = wire.strictObject({
  sessionId: wireSessionId,
  messageId: wire.string().min(1).transform(value => SessionLinkMessageId(value)),
  additional: wire.number().int().min(1).max(100),
  expectedExtra: wire.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: wire.string().min(1).max(128),
})
const activityRequestSchema = wire.strictObject({
  sessionId: wireSessionId,
  section: wire.enum(['pending', 'recent']),
  peerId: wireSessionId.optional(),
  cursor: wire.string().min(1).max(512).optional(),
  limit: wire.number().int().min(1).max(50).optional(),
})

/** Fully resolved deployment limits. */
export interface SessionLinkLimits {
  readonly maxLinkMembers: number
  readonly maxPendingPerTarget: number
  readonly maxMessageBytes: number
  readonly maxAutoWakesPerSessionPerDay: number
  readonly maxAutoWakesPerMessage: number
  readonly maxAutoWakesPerChain: number
  readonly maxDeliveryAttempts: number
}

/** Schemastery deployment configuration; defaults resolve at mount. */
export const Config: z<SessionLinkConfigShape> = z.object({
  uiPollIntervalMs: z.natural().min(1000).max(2147483647).default(30000),
  maxLinkMembers: z.natural().min(2).default(8),
  maxPendingPerTarget: z.natural().min(1).default(16),
  maxMessageBytes: z.natural().min(1).default(16 * 1024),
  maxAutoWakesPerSessionPerDay: z.natural().min(1).default(12),
  maxAutoWakesPerMessage: z.natural().min(1).default(1),
  maxAutoWakesPerChain: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  maxDeliveryAttempts: z.natural().min(1).default(3),
})

/** Fallbacks applied when a programmatic caller omits a field; the loader path resolves defaults through {@link Config}. */
const DEFAULTS: SessionLinkLimits = {
  maxLinkMembers: 8,
  maxPendingPerTarget: 16,
  maxMessageBytes: 16 * 1024,
  maxAutoWakesPerSessionPerDay: 12,
  maxAutoWakesPerMessage: 1,
  maxAutoWakesPerChain: 8,
  maxDeliveryAttempts: 3,
}

/** Resolve one optional-field Config into the full limits the runtime reads. */
function resolveLimits(config: SessionLinkConfigShape): SessionLinkLimits {
  return {
    maxLinkMembers: config.maxLinkMembers ?? DEFAULTS.maxLinkMembers,
    maxPendingPerTarget: config.maxPendingPerTarget ?? DEFAULTS.maxPendingPerTarget,
    maxMessageBytes: config.maxMessageBytes ?? DEFAULTS.maxMessageBytes,
    maxAutoWakesPerSessionPerDay: config.maxAutoWakesPerSessionPerDay ?? DEFAULTS.maxAutoWakesPerSessionPerDay,
    maxAutoWakesPerMessage: config.maxAutoWakesPerMessage ?? DEFAULTS.maxAutoWakesPerMessage,
    maxAutoWakesPerChain: config.maxAutoWakesPerChain ?? DEFAULTS.maxAutoWakesPerChain,
    maxDeliveryAttempts: config.maxDeliveryAttempts ?? DEFAULTS.maxDeliveryAttempts,
  }
}

/** Optional controls for {@link SessionLinkService.link}. */
export interface SessionLinkOptions {
  /** Members whose admitted messages may wake them; ids outside the group are dropped. */
  readonly autoWakeSessionIds?: readonly SessionId[]
  /** Existing group to update in place. */
  readonly linkId?: SessionLinkId
  /** Reject a new group when any two of its members already share one. */
  readonly requireNewPair?: boolean
  /** Identity for a newly granted group; omitted, one is minted. */
  readonly createAs?: SessionLinkId
}

/** Today's UTC day key for the wake ledger. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Frame a peer body so the receiving model attributes the sender without
 * trusting the text, and can reply: the frame names the sender Session id and
 * the message id that `gc_duolink_send_message` takes as `in_reply_to`.
 * @param frame - sender title and id, the minted message id, and the caller's complete body.
 * @returns the sender-framed body stored in the mailbox and delivered to the target.
 */
export function frameSessionLinkText(frame: {
  readonly senderTitle: string
  readonly senderId: SessionId
  readonly messageId: SessionLinkMessageId
  readonly text: string
}): string {
  return frameSessionLinkHeader(frame) + REPLY_GUIDANCE + frame.text
}

const REPLY_GUIDANCE = '无需纯礼貌确认，有实质结果、问题或阻塞再回复；纯信息同步可设置 wake:false，不申请唤醒空闲对端。\n'

/** Exact pre-M2 prefix retained for reading already persisted messages. */
function frameSessionLinkHeader(frame: {
  readonly senderTitle: string
  readonly senderId: SessionId
  readonly messageId: SessionLinkMessageId
}): string {
  return `[会话消息] 来自会话「${frame.senderTitle}」（${frame.senderId}）的协作消息，非本机人类直接输入。\n`
    + `消息 ID：${frame.messageId}。如需回复，调用 gc_duolink_send_message，`
    + `session_id 填 ${frame.senderId}，in_reply_to 填 ${frame.messageId}。\n`
}

/** Walk a reply chain to its root identity, used for per-chain wake accounting. */
function chainRootOf(
  table: KvTable<SessionLinkMessageId, SessionLinkMessageRecordData>,
  messageId: SessionLinkMessageId,
): SessionLinkMessageId {
  let current = messageId
  for (let depth = 0; depth < 256; depth += 1) {
    const record = table.get(current)
    if (record?.inReplyTo === undefined) return current
    current = record.inReplyTo
  }
  return current
}

/** Presence of either old report marker prevents normal peer execution. */
function legacyTaskReport(record: SessionLinkMessageRecordData): boolean {
  return record.statusKind !== undefined || record.taskStatus !== undefined
}

/**
 * Opaque page-cursor payload. `recent` pages keyset on the enqueue identity of
 * the last returned entry. `pending` pages pin a bounded snapshot instead: the
 * mixed-generation admission comparator is not a total order, so a keyset
 * could skip or repeat rows; the snapshot digest invalidates the cursor as
 * soon as the queue under it changes, and the offset walks that snapshot.
 */
const activityCursorSchema = wire.strictObject({
  v: wire.literal(1),
  kind: wire.enum(['recent', 'pending']),
  seq: wire.number().int().positive().nullable().optional(),
  createdAt: wire.string().optional(),
  id: wire.string().min(1).optional(),
  sig: wire.string().min(1).optional(),
  offset: wire.number().int().nonnegative().optional(),
})

type ActivityCursor = wire.infer<typeof activityCursorSchema>

/**
 * Delivery admission order, shared verbatim with `pendingFor` so the pending
 * projection can never diverge from what delivery would do: the monotonic
 * admission sequence, falling back to the timestamp for messages admitted
 * before 0.4.0 carried one. This comparator is only pairwise — a mailbox
 * mixing generations with inverted sequence/timestamp pairs is not totally
 * ordered by it — which is why pending paging pins snapshots, not keysets.
 */
function compareAdmission(
  left: { seq?: number; createdAt: string },
  right: { seq?: number; createdAt: string },
): number {
  return left.seq !== undefined && right.seq !== undefined
    ? left.seq - right.seq
    : left.createdAt.localeCompare(right.createdAt)
}

/**
 * Total order over enqueue identity for the display-only recent section: the
 * admission sequence, with every pre-0.4.0 unsequenced record preceding all
 * sequenced ones. The timestamp and the durable id break ties so keyset
 * paging stays stable even when a mailbox mixes both generations. This order
 * is a reading convention, not a delivery claim; pending uses the delivery
 * comparator plus snapshot cursors instead.
 */
function compareEnqueue(
  left: { seq?: number; createdAt: string },
  leftId: string,
  right: { seq?: number; createdAt: string },
  rightId: string,
): number {
  if (left.seq === undefined && right.seq !== undefined) return -1
  if (left.seq !== undefined && right.seq === undefined) return 1
  if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) return left.seq - right.seq
  const byTime = left.createdAt.localeCompare(right.createdAt)
  if (byTime !== 0) return byTime
  return String(leftId).localeCompare(String(rightId))
}

function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Decode one page cursor; anything malformed or cross-section rejects as a caller error. */
function decodeActivityCursor(cursor: string, section: 'pending' | 'recent'): ActivityCursor {
  const invalid = (): never => {
    throw new SessionLinkError('ACTIVITY_CURSOR_INVALID: activity cursor is invalid, stale, or belongs to another view', 'ACTIVITY_CURSOR_INVALID')
  }
  let parsed: ActivityCursor
  try {
    parsed = activityCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    return invalid()
  }
  if (parsed.kind !== section) invalid()
  if (parsed.kind === 'recent') {
    if (parsed.seq === undefined || parsed.createdAt === undefined || parsed.id === undefined
      || parsed.sig !== undefined || parsed.offset !== undefined) invalid()
  } else if (parsed.sig === undefined || parsed.offset === undefined
    || parsed.seq !== undefined || parsed.createdAt !== undefined || parsed.id !== undefined) invalid()
  return parsed
}

/** Flatten control runs so one row renders as one inert line; markup is escaped by React. */
function flattenForDisplay(text: string, limit: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/**
 * Fixed failure summary for the read-only view. Delivery errors come from
 * arbitrary layers (storage, flush, resume, host channels) as free text, and
 * arbitrary free text cannot be made safe by rewriting it: no redaction
 * pattern set is complete for unconstrained input (URL query keys, JSON
 * values containing the opposite quote character, escaped quotes, unknown
 * credential shapes), and truncating plus flattening control characters does
 * not satisfy "do not return sensitive errors" either. The projection
 * therefore reports only that a delivery error happened, never any fragment
 * of the original message, so no credential shape can leak regardless of how
 * the error was formatted. Records keep their original `error` verbatim:
 * nothing is rewritten, redacted, or migrated in durable state.
 */
const DELIVERY_ERROR_SUMMARY = 'delivery error (details withheld)'

/**
 * Project a stored delivery error into the view contract: `undefined` when
 * the record carries no error, otherwise the fixed safe summary above. The
 * optional short-string contract of `lastError` is unchanged.
 */
function errorSummary(error: string | undefined): string | undefined {
  return error === undefined ? undefined : DELIVERY_ERROR_SUMMARY
}

/**
 * Strip the delivery frame only when the stored text provably carries this
 * record's own frame, rebuilt byte-exact from the record's sender title,
 * sender id, and message id — never by counting lines, which a sender title
 * containing newlines would break. Unrecognized or legacy shapes keep their
 * full text rather than guessing. The caller's words are then capped at 160.
 */
function previewText(record: SessionLinkMessageRecordData, messageId: SessionLinkMessageId): string {
  const frame = frameSessionLinkText({
    senderTitle: record.senderTitle,
    senderId: record.senderId,
    messageId,
    text: '',
  })
  const oldFrame = frameSessionLinkHeader({ senderTitle: record.senderTitle, senderId: record.senderId, messageId })
  const body = record.text.startsWith(frame) ? record.text.slice(frame.length)
    : record.text.startsWith(oldFrame) ? record.text.slice(oldFrame.length) : record.text
  return flattenForDisplay(body, 160)
}

/**
 * Durable link registry plus mailbox. Cross-session state lives in the
 * `gc_duolink` storage domain; delivery to a live target uses the Agent
 * inbox channel with a dedicated non-human source, and acceptance is recorded
 * only after the target write handle flushes.
 */
export class SessionLinkService extends TypertRemoteService {
  static inject = [
    'agents',
    'storageDomain',
    'sessions',
    'workspaceRegistry',
  ]

  /** Loader-visible deployment schema. */
  static Config: z<SessionLinkConfigShape> = Config

  private links!: KvTable<SessionLinkId, SessionLinkRecordData>
  private messages!: KvTable<SessionLinkMessageId, SessionLinkMessageRecordData>
  private ledgers!: KvTable<string, SessionLinkLedgersData>
  private readonly resolved: SessionLinkLimits
  private readonly uiPollIntervalMs: number
  /** Serializes admission + immediate delivery so idempotency, quotas, ordering, and ledger see one order. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Rejects new admissions while the service unwinds. */
  private disposed = false

  /**
   * @param ctx - host context carrying the Agent, storage, and Workspace services.
   * @param config - deployment limits; omitted fields fall back to {@link DEFAULTS}.
   */
  constructor(ctx: Context, config: SessionLinkConfigShape = {}) {
    super(ctx, 'gcDuolink')
    this.resolved = resolveLimits(config)
    this.uiPollIntervalMs = config.uiPollIntervalMs ?? 30000
    if (!Number.isSafeInteger(this.uiPollIntervalMs) || this.uiPollIntervalMs < 1000 || this.uiPollIntervalMs > 2147483647) {
      throw new Error('uiPollIntervalMs must be an integer between 1000 and 2147483647 milliseconds')
    }
  }

  /** Open the domain, subscribe to later activations, and redeliver what a previous process left pending. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sessionLinkDomainSpec)
    this.links = domain.table('links')
    this.messages = domain.table('messages')
    this.ledgers = domain.table('ledgers')
    // One disposer orders shutdown: refuse new operations, drain the
    // in-flight chain, and only then close the domain those operations write.
    this.ctx.effect(() => async () => {
      this.disposed = true
      await this.tail
      await domain.close()
    }, 'gcDuolink.close')
    await initializeDuolinkDomain(domain)
    this.ctx.on('agent/created', ({ agent }) => {
      // Auto-wake policy never applies to recovery-triggered replays: a boot
      // that resumes Sessions must not silently spend model calls.
      void this.tryDeliverPending(agent.id).catch((error: unknown) => {
        this.ctx.logger.warn(`gc-duolink: recovery delivery to "${agent.id}" failed: ${String(error)}`)
      })
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      // A target that starts work (human turn, schedule, another wake) admits
      // its deferred mail as a follow-up behind the active turn.
      if (status !== 'running') return
      void this.tryDeliverPending(agent.id).catch((error: unknown) => {
        this.ctx.logger.warn(`gc-duolink: deferred delivery to "${agent.id}" failed: ${String(error)}`)
      })
    })
    await this.recoverPending()
  }

  /** The deployment limits tools read for descriptive text. */
  get limits(): SessionLinkLimits {
    return this.resolved
  }

  /**
   * Create or replace a communication group. Only host code may call this;
   * model-facing creation goes through the spawn tool with its own policy.
   * @param name - human-facing group name.
   * @param memberIds - every ordinary Session allowed to message every other.
   * @param grant - authenticated authority of the granting operation.
   * @param options - optional auto-wake subset, a link id to update in place, and whether a new group must be the members' first shared group.
   * @returns the durable link record.
   */
  async link(
    name: string,
    memberIds: readonly SessionId[],
    grant: SessionLinkGrant,
    options: SessionLinkOptions = {},
  ): Promise<{ id: SessionLinkId; record: SessionLinkRecordData }> {
    return await this.chain(async () => this.linkNow(name, memberIds, grant, options))
  }

  /** Durable write of {@link link}, already inside the admission chain. */
  private async linkNow(
    name: string,
    memberIds: readonly SessionId[],
    grant: SessionLinkGrant,
    options: SessionLinkOptions,
  ): Promise<{ id: SessionLinkId; record: SessionLinkRecordData }> {
    if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      throw new SessionLinkError('link name must not be empty', 'LINK_NAME_INVALID')
    }
    const unique = [...new Set(memberIds)]
    if (unique.length < 2) {
      throw new SessionLinkError('a link needs at least two distinct members', 'LINK_MEMBER_LIMIT')
    }
    if (unique.length > this.resolved.maxLinkMembers) {
      throw new SessionLinkError(
        `a link accepts at most ${this.resolved.maxLinkMembers} members`,
        'LINK_MEMBER_LIMIT',
      )
    }
    const autoWake = (options.autoWakeSessionIds ?? [])
      .filter(id => unique.includes(id))
    const now = new Date().toISOString()
    if (options.linkId !== undefined) {
      const existing = this.links.get(options.linkId)
      if (existing === undefined) {
        throw new SessionLinkError(`link "${options.linkId}" not found`, 'LINK_NOT_FOUND')
      }
      const next: SessionLinkRecordData = {
        ...existing,
        name: trimmed,
        memberIds: unique,
        autoWakeSessionIds: autoWake,
        revision: existing.revision + 1,
        updatedAt: now,
      }
      await this.links.put(options.linkId, next)
      await this.revokeUndelivered(options.linkId, unique)
      return { id: options.linkId, record: next }
    }
    if (options.requireNewPair === true) {
      // Checked inside the admission chain so concurrent requests cannot both pass.
      const [first, ...others] = unique
      const shared = this.list(first).find(link => others.some(other => link.memberIds.includes(other)))
      if (shared !== undefined) {
        throw new SessionLinkError(`会话已在互联组 ${shared.id} 中互联`, 'LINK_ALREADY_LINKED')
      }
    }
    const id = options.createAs ?? SessionLinkId(`gc-duolink-${randomUUID()}`)
    const record: SessionLinkRecordData = {
      name: trimmed,
      memberIds: unique,
      autoWakeSessionIds: autoWake,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      grantedBy: grant,
    }
    await this.links.put(id, record)
    return { id, record }
  }

  /**
   * Delete one group. Pending undelivered messages under it become terminal
   * `revoked`; anything already recorded at a target Session is not recalled.
   * @param linkId - group to remove.
   */
  async unlink(linkId: SessionLinkId): Promise<void> {
    await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      if (this.links.get(linkId) === undefined) {
        throw new SessionLinkError(`link "${linkId}" not found`, 'LINK_NOT_FOUND')
      }
      // Commit the removal on spawn records before the group disappears, so a
      // failed delete leaves a still-listed group that no replay can recreate.
      const ledger = this.readLedgers()
      const spawns = Object.entries(ledger.spawns)
      if (spawns.some(([, spawn]) => spawn.linkId === linkId && spawn.removed !== true)) {
        await this.writeLedgers({
          ...ledger,
          spawns: Object.fromEntries(spawns.map(([key, spawn]) =>
            [key, spawn.linkId === linkId ? { ...spawn, removed: true } : spawn])),
        })
      }
      await this.links.delete(linkId)
      await this.revokeUndelivered(linkId, [])
    })
  }

  /**
   * Turn one member's auto-wake flag on or off. Reading the current subset,
   * computing the next one, and writing it happen in one admission-chain
   * slot, so concurrent toggles for different members never drop each other.
   * @param linkId - group to update.
   * @param memberId - member whose flag changes; must belong to the group.
   * @param on - the new flag.
   * @param callerId - when given, the requesting Session, which must also belong to the group.
   * @returns the updated record, paired with its id like {@link link}.
   */
  async setMemberAutoWake(
    linkId: SessionLinkId,
    memberId: SessionId,
    on: boolean,
    callerId?: SessionId,
  ): Promise<{ id: SessionLinkId; record: SessionLinkRecordData }> {
    return await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const existing = this.links.get(linkId)
      if (callerId !== undefined && !existing?.memberIds.includes(callerId)) {
        throw new SessionLinkError(`当前会话不属于互联组 ${linkId}`, 'LINK_CALLER_NOT_MEMBER')
      }
      if (existing === undefined) {
        throw new SessionLinkError(`link "${linkId}" not found`, 'LINK_NOT_FOUND')
      }
      if (!existing.memberIds.includes(memberId)) {
        throw new SessionLinkError(`会话 ${memberId} 与本会话不在同一互联组`, 'LINK_TARGET_NOT_MEMBER')
      }
      const next = on
        ? [...new Set([...existing.autoWakeSessionIds, memberId])]
        : existing.autoWakeSessionIds.filter(member => member !== memberId)
      return await this.writeAutoWake(linkId, existing, next)
    })
  }

  /**
   * Replace one link's auto-wake subset without touching membership. Pending
   * mail keeps queued-without-wake semantics; nothing already delivered is
   * affected.
   * @param linkId - group to update.
   * @param autoWakeSessionIds - members whose admitted messages may wake them; ids outside the group reject.
   * @returns the updated record, paired with its id like {@link link}.
   */
  async setAutoWake(
    linkId: SessionLinkId,
    autoWakeSessionIds: readonly SessionId[],
  ): Promise<{ id: SessionLinkId; record: SessionLinkRecordData }> {
    return await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const existing = this.links.get(linkId)
      if (existing === undefined) {
        throw new SessionLinkError(`link "${linkId}" not found`, 'LINK_NOT_FOUND')
      }
      for (const id of autoWakeSessionIds) {
        if (!existing.memberIds.includes(id)) {
          throw new SessionLinkError(
            `session "${id}" is not a member of link "${linkId}"`,
            'LINK_TARGET_NOT_MEMBER',
          )
        }
      }
      return await this.writeAutoWake(linkId, existing, autoWakeSessionIds)
    })
  }

  /** Durable auto-wake write, already inside the admission chain. */
  private async writeAutoWake(
    linkId: SessionLinkId,
    existing: SessionLinkRecordData,
    autoWakeSessionIds: readonly SessionId[],
  ): Promise<{ id: SessionLinkId; record: SessionLinkRecordData }> {
    const next: SessionLinkRecordData = {
      ...existing,
      autoWakeSessionIds: [...new Set(autoWakeSessionIds)],
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    await this.links.put(linkId, next)
    return { id: linkId, record: next }
  }

  /**
   * List link groups, optionally only those naming one Session.
   * @param memberId - restrict to groups containing this Session.
   * @returns current summaries.
   */
  list(memberId?: SessionId): SessionLinkSummary[] {
    const rows: SessionLinkSummary[] = []
    for (const [id, record] of this.links.entries()) {
      if (memberId !== undefined && !record.memberIds.includes(memberId)) continue
      rows.push({
        id,
        name: record.name,
        memberIds: record.memberIds,
        autoWakeSessionIds: record.autoWakeSessionIds,
        revision: record.revision,
      })
    }
    return rows
  }

  /**
   * Read complete link and Session catalogs without activating any Agent.
   * Titles come from the Session Controller's public title projection.
   * @param signal - optional cancellation for catalog reads.
   * @returns current catalogs and the configured browser refresh interval.
   */
  @Remote('view')
  async view(signal?: AbortSignal): Promise<SessionLinkView> {
    signal?.throwIfAborted()
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new SessionLinkError('Session Controller is required to read the Session catalog', 'TARGET_UNAVAILABLE')
    }
    const { items } = await controller.list({}, signal ?? new AbortController().signal)
    signal?.throwIfAborted()
    return {
      pollIntervalMs: this.uiPollIntervalMs,
      links: this.list(),
      sessions: items.map(row => {
        const live = this.ctx.agents.get(row.sessionId)
        const parent = row.parentSessionId === undefined ? undefined : this.ctx.agents.get(row.parentSessionId)
        const title = row.projections?.values.title
        return {
          id: row.sessionId,
          title: typeof title === 'string' ? title : String(row.sessionId),
          running: row.running,
          archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(row.sessionId),
          ordinary: row.origin !== 'subagent'
            && (live === undefined || parent === undefined || !this.ctx.agents.isOwnedBy(live.id, parent)),
          blank: row.blank,
        }
      }),
    }
  }

  /**
   * Remote: one bounded, read-only page of mailbox activity for one Session.
   * Observing never claims wake budget, writes the domain, consults the
   * Session Controller, or resumes a cold target; live posture comes from the
   * already-running Agent registry and the archived-id list only. `sessionId`
   * is a view selector, not an identity credential: an unlinked party may read
   * its history without regaining any send rights.
   * @param request - viewed Session, section, optional peer filter, cursor, and page size.
   * @returns the page, session-level counters, and a continuation cursor when more rows remain.
   */
  @Remote('activityView')
  async activityView(request: SessionLinkActivityRequest): Promise<SessionLinkActivityView> {
    const parsed = activityRequestSchema.parse(request)
    const limit = parsed.limit ?? 20
    const after = parsed.cursor === undefined ? undefined : decodeActivityCursor(parsed.cursor, parsed.section)
    const descending = parsed.section === 'recent'
    const rows = [...this.messages.entries()]
      .filter(([, record]) => !legacyTaskReport(record))
      .filter(([, record]) => record.senderId === parsed.sessionId || record.targetId === parsed.sessionId)
      .filter(([, record]) => parsed.peerId === undefined
        || record.senderId === parsed.peerId || record.targetId === parsed.peerId)
      .filter(([, record]) => parsed.section === 'recent' || record.status === 'pending')
    let page: [SessionLinkMessageId, SessionLinkMessageRecordData][]
    let more = false
    let nextCursor: string | undefined
    if (descending) {
      // Recent history is display-only: a documented total enqueue order,
      // newest first, with a stable keyset cursor. It claims no delivery order.
      rows.sort(([leftId, left], [rightId, right]) => -compareEnqueue(left, leftId, right, rightId))
      const paged = after === undefined ? rows : rows.filter(([id, record]) => {
        const order = compareEnqueue(record, id, { seq: after.seq ?? undefined, createdAt: after.createdAt ?? '' }, after.id ?? '')
        return order < 0
      })
      page = paged.slice(0, limit)
      more = paged.length > limit
      const last = page.length === 0 ? undefined : page[page.length - 1]!
      if (more && last !== undefined) {
        nextCursor = encodeActivityCursor({
          v: 1, kind: 'recent', seq: last[1].seq ?? null, createdAt: last[1].createdAt, id: last[0],
        })
      }
    } else {
      // Pending mirrors the real delivery queues, never a global comparator:
      // `pendingFor` is authoritative for each target's relative order —
      // including same-target records from senders this view filters out —
      // and the visible targets interleave by a documented k-way merge on
      // enqueue time (ties: target id, then message id). Sorting a superset
      // with the pairwise, non-transitive admission comparator and filtering
      // afterwards would not preserve any target's true queue.
      const visible = new Set(rows.map(([id]) => id))
      const lanes: [SessionLinkMessageId, SessionLinkMessageRecordData][][] = []
      const laneTargets: SessionId[] = []
      for (const [, record] of rows) {
        if (!laneTargets.includes(record.targetId)) {
          laneTargets.push(record.targetId)
          lanes.push(this.pendingFor(record.targetId).filter(([id]) => visible.has(id)))
        }
      }
      const heads = lanes.map(() => 0)
      const ordered: [SessionLinkMessageId, SessionLinkMessageRecordData][] = []
      for (;;) {
        let best = -1
        for (let lane = 0; lane < lanes.length; lane += 1) {
          const candidate = lanes[lane]![heads[lane]!]
          if (candidate === undefined) continue
          if (best === -1) { best = lane; continue }
          const [bestId, bestRecord] = lanes[best]![heads[best]!]!
          const [id, record] = candidate
          const byTime = record.createdAt.localeCompare(bestRecord.createdAt)
          if (byTime < 0 || (byTime === 0
            && (String(record.targetId) < String(bestRecord.targetId)
              || (record.targetId === bestRecord.targetId && String(id) < String(bestId))))) {
            best = lane
          }
        }
        if (best === -1) break
        ordered.push(lanes[best]![heads[best]!]!)
        heads[best]! += 1
      }
      // Pages pin a snapshot digest over the final visible ordered
      // identities: any queue change under an open page invalidates its
      // cursor instead of skipping rows. `sig` is an unkeyed content digest
      // for change detection only, not a security signature.
      const sig = createHash('sha256').update(ordered.map(([id]) => id).join('')).digest('hex').slice(0, 16)
      const offset = after === undefined ? 0 : after.offset ?? 0
      if (after !== undefined && after.sig !== sig) {
        throw new SessionLinkError('ACTIVITY_CURSOR_INVALID: the pending queue changed since this page chain started; reload from the first page', 'ACTIVITY_CURSOR_INVALID')
      }
      page = ordered.slice(offset, offset + limit)
      more = offset + limit < ordered.length
      if (more) nextCursor = encodeActivityCursor({ v: 1, kind: 'pending', sig, offset: offset + limit })
    }
    const entries: SessionLinkActivityEntry[] = page.map(([messageId, record]) => {
      const pending = record.status === 'pending'
      const lastError = errorSummary(record.error)
      const wakeBudget = this.wakeBudget(messageId, record)
      return {
        messageId,
        linkId: record.linkId,
        direction: record.targetId === parsed.sessionId ? 'inbound' : 'outbound',
        senderId: record.senderId,
        targetId: record.targetId,
        status: record.status,
        createdAt: record.createdAt,
        ...(record.seq === undefined ? {} : { seq: record.seq }),
        ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
        preview: previewText(record, messageId),
        ...(lastError === undefined ? {} : { lastError }),
        canCancel: pending && !this.mayBeHeld(messageId, record, this.ctx.agents.get(record.targetId)),
        blockingReasons: pending ? this.blockingReasons(messageId, record) : [],
        ...(wakeBudget === undefined ? {} : { wakeBudget }),
      }
    })
    const now = new Date()
    const today = dayKey(now)
    const wakeEntry = this.readLedgers().wakes[String(parsed.sessionId)]
    let pendingInbound = 0
    let pendingOutbound = 0
    let legacyBlocked = 0
    for (const [, record] of this.messages.entries()) {
      if (record.senderId !== parsed.sessionId && record.targetId !== parsed.sessionId) continue
      if (legacyTaskReport(record)) { legacyBlocked += 1; continue }
      if (record.status !== 'pending') continue
      if (record.targetId === parsed.sessionId) pendingInbound += 1
      else pendingOutbound += 1
    }
    // Only groups the viewed Session belongs to may owe it a first-task wake;
    // an unrelated spawn grant between other Sessions is not this viewer's debt.
    let firstTaskWakeOwed = false
    for (const [linkId, link] of this.links.entries()) {
      if (!link.memberIds.includes(parsed.sessionId)) continue
      if (this.firstWakeOwed(linkId, link, parsed.sessionId)) { firstTaskWakeOwed = true; break }
    }
    const counterparties = new Set<SessionId>()
    for (const entry of entries) counterparties.add(entry.direction === 'inbound' ? entry.senderId : entry.targetId)
    if (parsed.peerId !== undefined) counterparties.add(parsed.peerId)
    return {
      sampledAt: now.toISOString(),
      total: rows.length,
      entries,
      ...(more && nextCursor !== undefined ? { nextCursor } : {}),
      summary: {
        wake: {
          used: wakeEntry !== undefined && wakeEntry.day === today ? wakeEntry.wakes : 0,
          limit: this.resolved.maxAutoWakesPerSessionPerDay,
          day: today,
          resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
        },
        pendingInbound,
        pendingOutbound,
        firstTaskWakeOwed,
        legacyBlocked,
        targets: [...counterparties].map(id => {
          const live = this.ctx.agents.get(id)
          return {
            id,
            live: live !== undefined,
            running: live?.status === 'running',
            archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(id),
          }
        }),
      },
    }
  }

  /**
   * Remote: link the caller's Session with one peer as `{ kind: 'human' }`,
   * mirroring the `/gc-duolink add` command's validation and naming. Both
   * Sessions must exist and be ordinary and unarchived; a pair that already
   * shares a group rejects atomically. Domain refusals throw
   * {@link SessionLinkError}; the Gateway carries their message to the caller.
   * @param request - caller Session, peer Session, and the peer's auto-wake flag.
   * @returns the created group's durable id.
   */
  @Remote('linkFrom')
  async linkFrom(request: SessionLinkAddRequest): Promise<SessionLinkAddResult> {
    request = addRequestSchema.parse(request)
    if (request.peerId === request.callerId) {
      throw new SessionLinkError('不能把会话与自身互联', 'LINK_SELF')
    }
    this.assertOrdinaryTarget(request.callerId, await this.inspectHeader(request.callerId))
    this.assertOrdinaryTarget(request.peerId, await this.inspectHeader(request.peerId))
    const tail = String(request.peerId).split('-').at(-1) ?? String(request.peerId)
    const { id } = await this.link(
      `互联-${tail}`,
      [request.callerId, request.peerId],
      { kind: 'human' },
      {
        autoWakeSessionIds: [
          ...(request.autoWake ? [request.peerId] : []),
          ...(request.autoWakeCaller === true ? [request.callerId] : []),
        ],
        requireNewPair: true,
      },
    )
    return { linkId: id }
  }

  /**
   * Read one Session header through the Session Controller without activating it.
   * @param sessionId - Session to inspect.
   * @returns its attached or persisted header.
   */
  async inspectHeader(sessionId: SessionId): Promise<SessionHeader> {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new SessionLinkError('当前部署缺少会话控制器，无法校验会话', 'TARGET_UNAVAILABLE')
    }
    try {
      return (await controller.inspect(sessionId)).meta
    } catch {
      throw new SessionLinkError(
        `找不到会话 ${sessionId}：请确认 ID 完整（形如 session-xxxx）`,
        'TARGET_NOT_FOUND',
      )
    }
  }

  /**
   * Remote: delete one group the caller's Session belongs to. Pending
   * undelivered messages become terminal `revoked`; delivered content stays.
   * @param request - caller Session and the group to remove.
   */
  @Remote('unlinkFrom')
  async unlinkFrom(request: SessionLinkRevokeRequest): Promise<void> {
    request = revokeRequestSchema.parse(request)
    const owned = this.list(request.callerId).find(link => link.id === request.linkId)
    if (owned === undefined) {
      throw new SessionLinkError(`当前会话不属于互联组 ${request.linkId}`, 'LINK_CALLER_NOT_MEMBER')
    }
    await this.unlink(request.linkId)
  }

  /**
   * Human Remote: toggle one member's auto-wake flag inside one group the
   * caller belongs to, including the caller itself, without touching other flags.
   * @param request - caller Session, group, member (legacy peerId field), and new flag.
   */
  @Remote('setAutoWakeFrom')
  async setAutoWakeFrom(request: SessionLinkWakeRequest): Promise<void> {
    request = wakeRequestSchema.parse(request)
    await this.setMemberAutoWake(request.linkId, request.peerId, request.on, request.callerId)
  }

  /**
   * Read what earlier attempts of one spawn call recorded, creating and
   * linking nothing. Recognizes this version's spawn ledger and, for calls
   * made by earlier versions, the first task admitted under the call id as
   * its idempotency key.
   * @param callerId - spawning Session.
   * @param callKey - the spawn call's identity, also its first task's idempotency key.
   * @returns the earlier outcome, or undefined for a call seen for the first time.
   */
  spawnReplay(callerId: SessionId, callKey: string): SessionLinkSpawnReplay | undefined {
    const spawn = this.readLedgers().spawns[`${callerId}:${callKey}`]
    const admitted = this.findAdmitted(callerId, callKey)
    const message = admitted === undefined ? undefined : this.messages.get(admitted)
    if (admitted !== undefined && message !== undefined) {
      return {
        sessionId: message.targetId,
        linkId: message.linkId,
        removed: spawn?.removed === true || !this.pairLinked(message.linkId, callerId, message.targetId),
        task: { messageId: admitted, status: message.status === 'delivered' ? 'accepted' : 'queued' },
      }
    }
    if (spawn === undefined) return undefined
    return { sessionId: spawn.sessionId, linkId: spawn.linkId, removed: this.spawnRemoved(spawn, callerId) }
  }

  /**
   * Place a new spawn before its first task. Completed/legacy tasks never
   * restore membership a human later removed. Pending retries use the saved
   * Workspace identity rather than recreating a deleted registration.
   * @param callerId - exact spawning Session.
   * @param callKey - spawn tool call identity.
   * @param cwd - directory used to create the target Session.
   * @param inherit - use the caller's membership, including Ungrouped.
   */
  async placeSpawnWorkspace(callerId: SessionId, callKey: string, cwd: string, inherit: boolean): Promise<void> {
    await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const key = `${callerId}:${callKey}`
      const spawn = this.readLedgers().spawns[key]
      if (spawn === undefined) throw new Error('spawn has no recorded Session/link')
      if (this.spawnRemoved(spawn, callerId)) throw new SessionLinkError('spawn link was removed', 'LINK_REVOKED')
      if (spawn.workspacePlacement?.completed === true || this.findAdmitted(callerId, callKey) !== undefined) return
      let placement = spawn.workspacePlacement
      const save = async (next: NonNullable<typeof placement>) => {
        const ledger = this.readLedgers()
        await this.writeLedgers({
          ...ledger,
          spawns: { ...ledger.spawns, [key]: { ...ledger.spawns[key]!, workspacePlacement: next } },
        })
      }
      if (placement === undefined) {
        const workspace = inherit
          ? this.ctx.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(callerId))
          : await this.ctx.workspaceRegistry.create(cwd)
        placement = { ...(workspace === undefined ? {} : { workspaceId: workspace.id }), completed: workspace === undefined }
        await save(placement)
      }
      if (placement.completed) return
      const workspace = this.ctx.workspaceRegistry.get(placement.workspaceId!)
      if (workspace === undefined) throw new Error(`recorded workspace '${placement.workspaceId}' was removed; it will not be recreated`)
      await workspace.attachSession(spawn.sessionId)
      await save({ ...placement, completed: true })
    })
  }

  /** Read the immutable bootstrap intent, without activating or changing a model. */
  initialModelSpawn(callerId: SessionId, callKey: string): InitialModelSpawnRecord | undefined {
    return this.readLedgers().initialModelSpawns[`${callerId}:${callKey}`]
  }

  /** Reserve the exact request before any Session write, in the existing ledger chain. */
  async reserveInitialModelSpawn(callerId: SessionId, callKey: string, next: InitialModelSpawnRecord): Promise<InitialModelSpawnRecord> {
    return await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const key = `${callerId}:${callKey}`
      const ledger = this.readLedgers()
      const prior = ledger.initialModelSpawns[key]
      if (prior !== undefined) {
        if (prior.digest !== next.digest) throw new Error('INITIAL_MODEL_REPLAY_CONFLICT: this call already reserved different spawn parameters')
        return prior
      }
      if (this.spawnReplay(callerId, callKey) !== undefined) throw new Error('INITIAL_MODEL_REPLAY_CONFLICT: an ordinary spawn cannot be replayed with initial_model')
      await this.writeLedgers({ ...ledger, initialModelSpawns: { ...ledger.initialModelSpawns, [key]: next } })
      return next
    })
  }

  /** Commit one proven bootstrap fact; never holds this chain during Agent activation. */
  async confirmInitialModelSpawn(callerId: SessionId, callKey: string, digest: string, fact: 'headerCreated' | 'seedConfirmed'): Promise<void> {
    await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const key = `${callerId}:${callKey}`
      const ledger = this.readLedgers()
      const prior = ledger.initialModelSpawns[key]
      if (prior === undefined || prior.digest !== digest) throw new Error('INITIAL_MODEL_REPLAY_CONFLICT: bootstrap intent no longer matches')
      await this.writeLedgers({ ...ledger, initialModelSpawns: { ...ledger.initialModelSpawns, [key]: { ...prior, [fact]: true } } })
    })
  }

  /**
   * Whether a recorded spawn group was removed. An intent whose group was
   * never written is not removed: the group may still be granted under its
   * recorded id. A 0.3.2 record without intent was written after its group
   * existed, so its absent group was removed.
   */
  private spawnRemoved(
    spawn: SessionLinkLedgersData['spawns'][string],
    callerId: SessionId,
  ): boolean {
    if (spawn.removed === true) return true
    const link = this.links.get(spawn.linkId)
    if (link === undefined) return spawn.intent !== true
    return !(link.memberIds.includes(callerId) && link.memberIds.includes(spawn.sessionId))
  }

  /**
   * Grant the group of one spawn call exactly once. Recording the call and
   * creating the group share one admission-chain slot, so concurrent or
   * replayed attempts reuse the recorded group, and a group a human has since
   * unlinked is never recreated.
   * @param callerId - spawning Session, recorded as the granting authority.
   * @param sessionId - the Session the call created.
   * @param callKey - the spawn call's identity.
   * @param name - group name for a newly granted group.
   * @param autoWake - whether later messages may wake the spawned Session.
   * @param wakeCaller - whether peer replies may wake the caller; defaults false for direct-call compatibility.
   * @returns the call's group.
   */
  async claimSpawnLink(
    callerId: SessionId,
    sessionId: SessionId,
    callKey: string,
    name: string,
    autoWake: boolean,
    wakeCaller = false,
  ): Promise<SessionLinkId> {
    return await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const key = `${callerId}:${callKey}`
      const initialWakes = [...(autoWake ? [sessionId] : []), ...(wakeCaller ? [callerId] : [])]
      const grant = (linkId: SessionLinkId, recordedSession: SessionId, autoWakeSessionIds: readonly SessionId[]) => this.linkNow(
        name,
        [callerId, recordedSession],
        { kind: 'session', sessionId: callerId },
        {
          autoWakeSessionIds,
          createAs: linkId,
        },
      )
      const recorded = this.readLedgers().spawns[key]
      if (recorded !== undefined) {
        if (this.spawnRemoved(recorded, callerId)) {
          throw new SessionLinkError(
            `spawn call ${callKey} already created session ${recorded.sessionId}; its link ${recorded.linkId} was removed and is not recreated`,
            'LINK_REVOKED',
          )
        }
        // An intent committed before a failed group write completes under its recorded id.
        // Legacy intents did not record grants: conservatively recover with none.
        if (this.links.get(recorded.linkId) === undefined) await grant(recorded.linkId, recorded.sessionId, recorded.autoWakeSessionIds ?? [])
        return recorded.linkId
      }
      const ledger = this.readLedgers()
      // A 0.3.1 attempt may have linked this hash-derived Session before spawn records existed.
      const earlier = this.list(callerId).find(link => link.memberIds.includes(sessionId))
      const linkId = earlier?.id ?? SessionLinkId(`gc-duolink-${randomUUID()}`)
      // The call record commits first; the group follows under the recorded id.
      await this.writeLedgers({
        ...ledger,
        spawns: { ...ledger.spawns, [key]: { sessionId, linkId, ...(earlier === undefined ? { intent: true, autoWakeSessionIds: initialWakes } : {}) } },
      })
      if (earlier === undefined) await grant(linkId, sessionId, initialWakes)
      return linkId
    })
  }

  /**
   * The message one sender admitted under one idempotency key: the key stored
   * on that message; no external or old-version ledger is consulted.
   */
  private findAdmitted(senderId: SessionId, idempotencyKey: string): SessionLinkMessageId | undefined {
    for (const [id, candidate] of this.messages.entries()) {
      if (candidate.senderId === senderId && candidate.idempotencyKey === idempotencyKey) return id
    }
    return undefined
  }

  /** Whether one group still exists and contains both Sessions. */
  private pairLinked(linkId: SessionLinkId, first: SessionId, second: SessionId): boolean {
    const link = this.links.get(linkId)
    return link !== undefined && link.memberIds.includes(first) && link.memberIds.includes(second)
  }

  /**
   * Read one message record.
   * @param messageId - durable mailbox identity.
   * @returns the record, or `undefined` when absent.
   */
  message(messageId: SessionLinkMessageId): SessionLinkMessageRecordData | undefined {
    return this.messages.get(messageId)
  }

  /**
   * Admit one peer message into the mailbox and attempt immediate delivery.
   * Grant, archived, residency, and budget checks re-run here against current
   * state; callers must not assume a preflight result survived the awaits.
   * Cold delivery is supported through the write lock acquired at resume:
   * the same operation that resumes an idle target delivers pending mail
   * before the endpoint's prompt lands.
   * @param caller - exact live sending Agent; never trusted from input.
   * @param targetId - target Session the caller is currently linked to.
   * @param request - body, reply threading, and idempotency identity.
   * @returns admission outcome: durable `queued`, or `accepted` once the target records the message.
   */
  async send(
    caller: Agent,
    targetId: SessionId,
    request: SessionLinkSendRequest,
  ): Promise<SessionLinkSendResult> {
    return await this.chain(() => this.admission(caller, targetId, request))
  }

  /**
   * Cancel one pending message. The terminal `cancelled` record is the
   * tombstone recovery never resurrects; nothing recorded at the target is
   * recalled. A message the target may already hold is no longer
   * cancellable: it stays pending until a successful flush confirms it.
   * @param caller - exact live Agent asking, or undefined for host tooling.
   * @param messageId - the message to cancel.
   */
  async cancel(caller: Agent | undefined, messageId: SessionLinkMessageId): Promise<void> {
    await this.chain(() => this.cancelStored(caller?.id, messageId, false))
  }

  /** Trusted human RPC; sessionId scopes the UI, it is not model authentication. */
  @Remote('cancelMessageFrom')
  async cancelMessageFrom(request: SessionLinkCancelRequest): Promise<SessionLinkCancelResult> {
    request = cancelRequestSchema.parse(request)
    return await this.chain(() => this.cancelStored(request.sessionId, request.messageId, true))
  }

  /** Human-only append receipt; authorization, CAS, persistence and continuation share one write slot. */
  @Remote('extendChainWakeFrom')
  async extendChainWakeFrom(request: SessionLinkExtendWakeRequest): Promise<SessionLinkExtendWakeResult> {
    request = extendWakeRequestSchema.parse(request)
    return await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const record = this.messages.get(request.messageId)
      if (record === undefined || (record.senderId !== request.sessionId && record.targetId !== request.sessionId)) {
        throw new SessionLinkError('message not found for this participant', 'MESSAGE_NOT_FOUND')
      }
      if (legacyTaskReport(record)) throw new SessionLinkError('legacy experimental reports are read-only', 'LEGACY_TASK_MESSAGE_BLOCKED')
      let budget = this.wakeBudget(request.messageId, record)
      if (budget === undefined) throw new SessionLinkError('reply chain cannot be reliably resolved', 'WAKE_CHAIN_INVALID')
      const ledger = this.readLedgers()
      const prior = Object.hasOwn(ledger.chainWakeExtensions, request.requestId) ? ledger.chainWakeExtensions[request.requestId] : undefined
      if (prior !== undefined && (prior.rootId !== budget.rootId || prior.sessionId !== request.sessionId
        || prior.messageId !== request.messageId || prior.additional !== request.additional || prior.expectedExtra !== request.expectedExtra)) {
        throw new SessionLinkError('requestId already belongs to a different extension confirmation', 'WAKE_EXTENSION_REQUEST_CONFLICT')
      }
      const outcome = prior === undefined ? 'applied' : 'replayed'
      if (prior === undefined) {
        if (!budget.canExtend) this.assertExtensionGrant(record)
        if (request.expectedExtra !== budget.chain.extra) {
          return {
            messageId: request.messageId, requestId: request.requestId, outcome: 'conflict', budget,
            continuation: 'not_attempted', status: record.status,
            blockingReasons: record.status === 'pending' ? this.blockingReasons(request.messageId, record) : [],
          }
        }
        if (!Number.isSafeInteger(budget.chain.extra + request.additional) || !Number.isSafeInteger(budget.chain.limit + request.additional)) {
          throw new SessionLinkError('chain extension exceeds the safe integer limit', 'WAKE_EXTENSION_INVALID')
        }
        await this.writeLedgers({
          ...ledger,
          chainWakeExtensions: {
            ...ledger.chainWakeExtensions,
            [request.requestId]: {
              rootId: budget.rootId, sessionId: request.sessionId, messageId: request.messageId,
              additional: request.additional, expectedExtra: request.expectedExtra, createdAt: new Date().toISOString(),
            },
          },
        })
      }
      // A terminal message only retains the grant for later replies. Replays after
      // unlink/archive never restore permission or deliver a previously revoked queue.
      let continuation: SessionLinkExtendWakeResult['continuation'] = 'not_pending'
      if (record.status === 'pending') {
        continuation = 'queued'
        if (this.extensionGrantAllowed(record)) {
          try {
            await this.deliverTarget(record.targetId, { wakeFor: request.messageId })
          } catch {
            // Receipt is committed. Report only fixed delivery facts, never internal errors.
            this.ctx.logger.warn(`gc-duolink: extension continuation for "${request.messageId}" stays unconfirmed`)
          }
        }
      }
      const current = this.messages.get(request.messageId)!
      if (record.status === 'pending' && current.status === 'delivered') continuation = 'accepted'
      else if (current.status !== 'pending') continuation = 'not_pending'
      budget = this.wakeBudget(request.messageId, current)!
      return {
        messageId: request.messageId, requestId: request.requestId, outcome, budget, continuation,
        status: current.status, blockingReasons: current.status === 'pending' ? this.blockingReasons(request.messageId, current) : [],
      }
    })
  }

  /** Existing membership plus known ordinary/unarchived participants, without cold inspection. */
  private extensionGrantAllowed(record: SessionLinkMessageRecordData): boolean {
    const link = this.links.get(record.linkId)
    if (link === undefined || !link.memberIds.includes(record.senderId) || !link.memberIds.includes(record.targetId)) return false
    return [record.senderId, record.targetId].every(id => {
      const live = this.ctx.agents.get(id)
      return !this.ctx.workspaceRegistry.archivedSessionIds.includes(id)
        && (live === undefined || !subagentOwned(this.ctx, id, live.session.header))
    })
  }

  private assertExtensionGrant(record: SessionLinkMessageRecordData): void {
    const link = this.links.get(record.linkId)
    if (link === undefined || !link.memberIds.includes(record.senderId) || !link.memberIds.includes(record.targetId)) {
      throw new SessionLinkError('the message group no longer grants both participants', 'LINK_REVOKED')
    }
    for (const id of [record.senderId, record.targetId]) {
      if (this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new SessionLinkError('a participant is archived', 'TARGET_ARCHIVED')
      const live = this.ctx.agents.get(id)
      if (live !== undefined) this.assertOrdinaryTarget(id, live.session.header)
    }
  }

  /** Check ownership and the actual target receipt inside the same serial write slot. */
  private async cancelStored(sessionId: SessionId | undefined, messageId: SessionLinkMessageId, ordinaryOnly: boolean): Promise<SessionLinkCancelResult> {
    if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
    const record = this.messages.get(messageId)
    if (record === undefined) {
      throw new SessionLinkError(`message "${messageId}" not found`, 'MESSAGE_NOT_FOUND')
    }
    if (sessionId !== undefined && record.senderId !== sessionId && record.targetId !== sessionId) {
      throw new SessionLinkError('only the sender or target Session may cancel a message', 'MESSAGE_NOT_FOUND')
    }
    if (ordinaryOnly && legacyTaskReport(record)) {
      throw new SessionLinkError('legacy experimental reports are read-only', 'LEGACY_TASK_MESSAGE_BLOCKED')
    }
    if (record.status !== 'pending') return { messageId, outcome: 'already_terminal', status: record.status }
    const target = this.ctx.agents.get(record.targetId)
    if (this.mayBeHeld(messageId, record, target)) {
      if (target !== undefined) await this.confirmDurable(target, [messageId])
      return { messageId, outcome: 'too_late', status: this.messages.get(messageId)!.status }
    }
    await this.messages.put(messageId, { ...record, status: 'cancelled' })
    return { messageId, outcome: 'cancelled', status: 'cancelled' }
  }

  /**
   * Deliver every pending message addressed to one Session if its Agent is
   * live, in admission order. Call after any operation that may have resumed
   * the target — including the endpoint's own prompt run — so queued peer
   * mail is never stranded behind a human turn.
   * @param sessionId - now-live target Session.
   */
  async deliverPending(sessionId: SessionId): Promise<void> {
    await this.tryDeliverPending(sessionId)
  }

  /**
   * Guard a target as an ordinary top-level Session eligible for link
   * delivery. Archived membership stays intact, but admission refuses to
   * reanimate an archived Session.
   * @param sessionId - candidate target.
   * @param header - attached or persisted header of that Session.
   */
  assertOrdinaryTarget(
    sessionId: SessionId,
    header: SessionHeader,
  ): void {
    if (subagentOwned(this.ctx, sessionId, header)) {
      throw new SessionLinkError(`session "${sessionId}" is owned by subagent routing`, 'TARGET_OWNED_BY_SUBAGENT')
    }
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      throw new SessionLinkError(`session "${sessionId}" is archived`, 'TARGET_ARCHIVED')
    }
  }

  /**
   * Resolve one cold target through the Session Controller's formal resume
   * path, which takes write ownership before reading. A resume failure keeps
   * the message pending for the next recovery pass.
   * @param sessionId - durable target Session.
   * @returns the live Agent, or undefined when unavailable.
   */
  private async resolveColdTarget(sessionId: SessionId): Promise<Agent | undefined> {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) return undefined
    const result = await controller.resolveAgent(sessionId)
    if ('error' in result) return undefined
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) return undefined
    return result.agent
  }

  /** Serialize one mailbox operation against every other. */
  private chain<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Admission plus one immediate delivery leg, in one serialized chain slot. */
  private async admission(
    caller: Agent,
    targetId: SessionId,
    request: SessionLinkSendRequest,
  ): Promise<SessionLinkSendResult> {
    if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new SessionLinkError('send requires the exact live sending agent', 'TARGET_UNAVAILABLE')
    }
    this.assertOrdinaryTarget(caller.id, caller.session.header)
    if (targetId === caller.id) {
      throw new SessionLinkError('a Session cannot send peer messages to itself', 'LINK_SELF')
    }
    request.signal?.throwIfAborted()
    const prior = request.idempotencyKey === undefined ? undefined : this.findAdmitted(caller.id, request.idempotencyKey)
    // A replay re-attempts delivery of the stored message instead of admitting another.
    if (prior !== undefined) return await this.deliverStored(prior, request.signal)
    const link = this.requireMembership(caller.id, targetId)
    const liveTarget = this.ctx.agents.get(targetId)
    if (liveTarget !== undefined) this.assertOrdinaryTarget(targetId, liveTarget.session.header)
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(targetId)) {
      throw new SessionLinkError(`session "${targetId}" is archived`, 'TARGET_ARCHIVED')
    }
    const messageId = SessionLinkMessageId(`gc-duolink-message-${randomUUID()}`)
    const senderTitle = this.titleOf(caller)
    const framed = frameSessionLinkText({ senderTitle, senderId: caller.id, messageId, text: request.text })
    if (Buffer.byteLength(framed, 'utf8') > this.resolved.maxMessageBytes) {
      throw new SessionLinkError(`message exceeds ${this.resolved.maxMessageBytes} bytes`, 'MESSAGE_TOO_LARGE')
    }
    let inReplyTo: SessionLinkMessageId | undefined
    let chainLength = 1
    if (request.inReplyTo !== undefined) {
      const original = this.messages.get(request.inReplyTo)
      if (original === undefined) {
        throw new SessionLinkError(`message "${request.inReplyTo}" not found`, 'MESSAGE_NOT_REPLYABLE')
      }
      if (original.targetId !== caller.id || original.senderId !== targetId || original.status !== 'delivered') {
        throw new SessionLinkError(
          'inReplyTo must name a message this Session received from the target',
          'MESSAGE_NOT_REPLYABLE',
        )
      }
      inReplyTo = request.inReplyTo
      chainLength = original.chainLength + 1
    }
    const pendingForTarget = this.pendingFor(targetId).length
    if (pendingForTarget >= this.resolved.maxPendingPerTarget) {
      throw new SessionLinkError(
        `session "${targetId}" already has ${pendingForTarget} pending peer messages`,
        'MAILBOX_FULL',
      )
    }
    const record: SessionLinkMessageRecordData = {
      linkId: link.id,
      senderId: caller.id,
      senderTitle,
      targetId,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      text: framed,
      wake: request.wake ?? true,
      status: 'pending',
      wakesUsed: 0,
      chainLength,
      attempts: 0,
      createdAt: new Date().toISOString(),
      seq: this.nextSeq(),
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    }
    // One write commits the message together with its idempotency key.
    await this.messages.put(messageId, record)
    return await this.deliverStored(messageId, request.signal)
  }

  /**
   * Run delivery for one stored message and report it under the send
   * contract: a throw means the message will never be delivered (it was
   * cancelled before reaching the target, or is already terminal); any other
   * delivery failure leaves it durable and reports `queued`, and `accepted`
   * follows only a successful flush of the target.
   */
  private async deliverStored(messageId: SessionLinkMessageId, signal: AbortSignal | undefined): Promise<SessionLinkSendResult> {
    const record = this.messages.get(messageId)
    if (record === undefined) throw new SessionLinkError(`message "${messageId}" not found`, 'MESSAGE_NOT_FOUND')
    if (legacyTaskReport(record)) {
      throw new SessionLinkError(`legacy experimental report "${messageId}" is retained but blocked from peer delivery; inspect the old profile before migration`, 'LEGACY_TASK_MESSAGE_BLOCKED')
    }
    try {
      await this.deliverTarget(record.targetId, { wakeFor: messageId, ...(signal === undefined ? {} : { signal }) })
    } catch (error: unknown) {
      if (this.messages.get(messageId)?.status === 'cancelled') throw error
      this.ctx.logger.warn(`gc-duolink: delivery of "${messageId}" stays queued: ${String(error)}`)
    }
    const status = this.messages.get(messageId)?.status
    if (status === 'delivered') return { messageId, status: 'accepted' }
    if (status === 'pending') return { messageId, status: 'queued' }
    throw new SessionLinkError(`message "${messageId}" is ${status ?? 'missing'} and will not be delivered`, 'MESSAGE_UNDELIVERABLE')
  }

  /**
   * Deliver one target's mailbox in admission order, inside the caller's
   * chain slot. Only `wakeFor` may wake an idle target, and only under its
   * group's grant and the wake budgets; when it does, earlier pending mail is
   * inserted ahead of it. A running target receives all pending mail as
   * follow-ups. Insertion is not delivery: every message present in the live
   * target is marked `delivered` only after a successful flush. Until
   * `wakeFor` is inserted, an aborted `signal` cancels it durably and throws.
   * @param targetId - target Session.
   * @param options - the message whose grant may wake the target, and its caller's cancellation.
   */
  private async deliverTarget(
    targetId: SessionId,
    options: { readonly wakeFor?: SessionLinkMessageId; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    let target = this.ctx.agents.get(targetId)
    let recorded = target === undefined ? new Set<string>() : recordedIds(target)
    const cancelIfAborted = async (): Promise<void> => {
      const signal = options.signal
      if (signal?.aborted !== true || options.wakeFor === undefined) return
      const record = this.messages.get(options.wakeFor)
      if (record?.status !== 'pending' || this.mayBeHeld(options.wakeFor, record, target, recorded)) return
      await this.messages.put(options.wakeFor, { ...record, status: 'cancelled' })
      throw signal.reason
    }
    await cancelIfAborted()
    const queue: SessionLinkMessageId[] = []
    for (const [messageId, record] of this.pendingFor(targetId)) {
      if (this.mayBeHeld(messageId, record, target, recorded)) continue
      const link = this.links.get(record.linkId)
      if (link === undefined || !link.memberIds.includes(record.senderId) || !link.memberIds.includes(record.targetId)) {
        // The grant vanished under a message the target does not hold: tombstone rather than retry forever.
        await this.messages.put(messageId, { ...record, status: 'revoked' })
        continue
      }
      queue.push(messageId)
    }
    const trigger = options.wakeFor === undefined || !queue.includes(options.wakeFor)
      ? undefined
      : options.wakeFor
    const triggerRecord = trigger === undefined ? undefined : this.messages.get(trigger)
    const triggerLink = triggerRecord === undefined ? undefined : this.links.get(triggerRecord.linkId)
    const archived = this.ctx.workspaceRegistry.archivedSessionIds.includes(targetId)
    const wakeGranted = !archived && triggerRecord !== undefined && triggerRecord.wake !== false && triggerLink !== undefined
      && (triggerLink.autoWakeSessionIds.includes(targetId) || this.firstWakeOwed(triggerRecord.linkId, triggerLink, targetId))
    if (target === undefined && wakeGranted && trigger !== undefined) {
      // Cold target with a wake grant: resume through the formal path (write ownership first).
      target = await this.resolveColdTarget(targetId)
      if (target !== undefined) recorded = recordedIds(target)
      await cancelIfAborted()
      if (target === undefined) {
        await this.bumpAttempts(trigger, 'cold target resume unavailable')
        return
      }
    }
    if (target === undefined || subagentOwned(this.ctx, target.id, target.session.header)) {
      await cancelIfAborted()
      return
    }
    const live = target
    // A resumed target's loaded log may already hold messages a crash left unconfirmed.
    const pending = queue.filter(messageId => !recorded.has(messageId))
    let insert = false
    let wakeClaimed = false
    if (!archived && pending.length > 0) {
      if (live.status === 'running') {
        insert = true
      } else if (wakeGranted && trigger !== undefined && triggerRecord !== undefined) {
        await cancelIfAborted()
        if (await this.claimWake(trigger, triggerRecord)) {
          wakeClaimed = true
          if (options.signal?.aborted === true) {
            // Cancelled while the wake was being claimed: return the day's wake, then cancel.
            await this.refundWake(targetId)
            await cancelIfAborted()
          }
          try {
            await this.messages.put(trigger, { ...triggerRecord, wakesUsed: triggerRecord.wakesUsed + 1 })
          } catch (error: unknown) {
            await this.refundWake(targetId)
            throw error
          }
          insert = true
        }
      }
    }
    if (insert) {
      const marked: SessionLinkMessageId[] = []
      try {
        await cancelIfAborted()
        // Mark the caller-owned trigger first. Cancellation that happens while
        // this write settles is still observed before any message reaches the
        // target. The remaining markers may then commit in mailbox order.
        const markerOrder = trigger === undefined
          ? pending
          : [trigger, ...pending.filter(messageId => messageId !== trigger)]
        for (const messageId of markerOrder) {
          const record = this.messages.get(messageId)
          if (record !== undefined && record.inserted !== true) {
            await this.messages.put(messageId, { ...record, inserted: true })
            marked.push(messageId)
          }
          if (messageId === trigger) await cancelIfAborted()
        }
        await cancelIfAborted()
      } catch (error: unknown) {
        // No followup has run yet. Remove every speculative marker so a retry
        // may deliver the same records, and return a wake claimed for work that
        // never reached the target.
        for (const messageId of marked) {
          const current = this.messages.get(messageId)
          if (current !== undefined && current.inserted === true && !recorded.has(messageId)) {
            await this.messages.put(messageId, { ...current, inserted: false })
          }
        }
        if (wakeClaimed && trigger !== undefined && triggerRecord !== undefined) {
          const current = this.messages.get(trigger)
          if (current !== undefined && current.wakesUsed !== triggerRecord.wakesUsed) {
            await this.messages.put(trigger, { ...current, wakesUsed: triggerRecord.wakesUsed })
          }
          await this.refundWake(targetId)
        }
        throw error
      }
      // Never steer; hand off in admission order with no await between the
      // final cancellation check and the complete batch.
      for (const messageId of pending) live.followup(this.inputFor(messageId))
      recorded = recordedIds(live)
    }
    await cancelIfAborted()
    const present = this.pendingFor(targetId)
      .map(([messageId]) => messageId)
      .filter(messageId => recorded.has(messageId))
    await this.confirmDurable(live, present)
  }

  /**
   * Whether the target may already hold one pending message, so no path may
   * cancel, revoke, or fail it. A live target answers from its loaded log; a
   * cold one is assumed to hold anything ever handed to it.
   */
  private mayBeHeld(
    messageId: SessionLinkMessageId,
    record: SessionLinkMessageRecordData,
    target: Agent | undefined,
    recorded?: ReadonlySet<string>,
  ): boolean {
    if (target === undefined) return record.inserted === true
    return (recorded ?? recordedIds(target)).has(messageId)
  }

  /**
   * Every known reason one pending message has not moved, checked against the
   * same predicates the delivery branch consults. A message the target may
   * already hold reports only the unverified receipt — idle-wake limits no
   * longer apply to it. A running target receives pending mail as follow-ups,
   * so wake authorization and budget are not its blockers either. Only a
   * resident-idle or cold target lists the conditions a future admission's
   * wake request would face. `['unknown']` means none of the known blockers
   * applies yet the message has not moved.
   */
  private blockingReasons(
    messageId: SessionLinkMessageId,
    record: SessionLinkMessageRecordData,
  ): SessionLinkBlockingReason[] {
    const target = this.ctx.agents.get(record.targetId)
    if (this.mayBeHeld(messageId, record, target)) return ['delivery-unverified']
    const reasons: SessionLinkBlockingReason[] = []
    const archived = this.ctx.workspaceRegistry.archivedSessionIds.includes(record.targetId)
    if (archived) reasons.push('archived')
    const link = this.links.get(record.linkId)
    const granted = link !== undefined
      && link.memberIds.includes(record.senderId)
      && link.memberIds.includes(record.targetId)
    if (!granted) {
      reasons.push('link-revoked')
    } else if (target === undefined) {
      // Not resident: nothing can move until a later admission resumes it.
      reasons.push('cold-target')
      if (!archived) {
        const wakeGranted = link.autoWakeSessionIds.includes(record.targetId)
          || this.firstWakeOwed(record.linkId, link, record.targetId)
        if (record.wake === false) reasons.push('wake-not-requested')
        else if (!wakeGranted) reasons.push('wake-unauthorized')
        else if (this.wakeBudgetExhausted(messageId, record)) reasons.push('wake-budget')
      }
    } else if (target.status !== 'running' && !archived) {
      // Resident but idle: the next admission needs an idle wake under the
      // group's grant and the wake budgets.
      const wakeGranted = link.autoWakeSessionIds.includes(record.targetId)
        || this.firstWakeOwed(record.linkId, link, record.targetId)
      if (record.wake === false) reasons.push('wake-not-requested')
      else if (!wakeGranted) reasons.push('wake-unauthorized')
      else if (this.wakeBudgetExhausted(messageId, record)) reasons.push('wake-budget')
    }
    // A running target needs none of these; delivery follows as a follow-up.
    // There the empty list is the honest answer — no blocker is claimed — while
    // an idle or cold target with every permission intact reports `unknown`,
    // because something outside the checked predicates kept the message queued.
    if (reasons.length === 0 && target?.status !== 'running') return ['unknown']
    return reasons
  }

  /** Return one claimed wake to a target's day budget after its message was cancelled. */
  private async refundWake(targetId: SessionId): Promise<void> {
    const ledger = this.readLedgers()
    const entry = ledger.wakes[String(targetId)]
    if (entry === undefined || entry.day !== dayKey(new Date()) || entry.wakes === 0) return
    await this.writeLedgers({ ...ledger, wakes: { ...ledger.wakes, [String(targetId)]: { ...entry, wakes: entry.wakes - 1 } } })
  }

  /** The model input carrying one stored message and its non-human source. */
  private inputFor(messageId: SessionLinkMessageId): ReturnType<typeof createUserMessage> {
    const record = this.messages.get(messageId)
    if (record === undefined) throw new SessionLinkError(`message "${messageId}" not found`, 'MESSAGE_NOT_FOUND')
    const source: SessionLinkMessageSource = {
      kind: 'gc-duolink-message',
      messageId,
      linkId: record.linkId,
      senderId: record.senderId,
      senderTitle: record.senderTitle,
      ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
    }
    return createUserMessage({ content: [{ type: 'text', text: record.text }], source })
  }

  /**
   * Pending messages for one target in admission order: the monotonic
   * admission sequence, falling back to the timestamp for messages admitted
   * before 0.4.0 carried one. The comparator is the shared
   * {@link compareAdmission}, so the activity projection reads the same order
   * delivery executes.
   */
  private pendingFor(targetId: SessionId): [SessionLinkMessageId, SessionLinkMessageRecordData][] {
    return [...this.messages.entries()]
      .filter(([, record]) => record.status === 'pending' && record.targetId === targetId && !legacyTaskReport(record))
      .sort(([, left], [, right]) => compareAdmission(left, right))
  }

  /** The next admission sequence number, one above every stored message's. */
  private nextSeq(): number {
    let highest = 0
    for (const [, record] of this.messages.entries()) {
      if (record.seq !== undefined && record.seq > highest) highest = record.seq
    }
    return highest + 1
  }

  /**
   * Whether a spawn-granted group still owes its spawned member the one wake
   * that starts its first task. Derived from the mailbox, so a first task
   * that was refused or queued keeps the wake for the next admission: the
   * debt ends once any message under the group was delivered to that member
   * or spent a wake on it.
   */
  private firstWakeOwed(linkId: SessionLinkId, link: SessionLinkRecordData, targetId: SessionId): boolean {
    if (link.grantedBy.kind !== 'session' || link.grantedBy.sessionId === targetId) return false
    for (const [, candidate] of this.messages.entries()) {
      if (candidate.linkId === linkId && candidate.targetId === targetId
        && (candidate.status === 'delivered' || candidate.wakesUsed > 0)) return false
    }
    return true
  }

  /**
   * Acknowledge messages present in the live target only after its write
   * handle flushes: the in-memory insertion is not a durable receipt. A
   * failed flush leaves them pending with the error recorded; it never makes
   * them terminal, because the target already holds them and a later
   * successful flush confirms them exactly once.
   */
  private async confirmDurable(target: Agent, messageIds: readonly SessionLinkMessageId[]): Promise<void> {
    if (messageIds.length === 0) return
    try {
      await this.ctx.sessions.flush(target.session)
    } catch (error: unknown) {
      for (const messageId of messageIds) {
        const record = this.messages.get(messageId)
        if (record?.status === 'pending' && record.error !== String(error)) {
          await this.messages.put(messageId, { ...record, error: String(error) })
        }
      }
      return
    }
    const recorded = recordedIds(target)
    for (const messageId of messageIds) {
      if (recorded.has(messageId)) await this.markDelivered(messageId)
    }
  }

  /**
   * Read-only wake budget check shared by claiming and the activity
   * projection: whether any of the per-message, per-chain, and per-target-day
   * budgets is already spent for one more wake of this message.
   */
  private wakeBudgetExhausted(
    messageId: SessionLinkMessageId,
    record: SessionLinkMessageRecordData,
    ledger: SessionLinkLedgersData = this.readLedgers(),
    today: string = dayKey(new Date()),
  ): boolean {
    if (record.wakesUsed >= this.resolved.maxAutoWakesPerMessage) return true
    const root = rootIdOf(this.messages, messageId, record)
    if (this.chainWakesUsed(root) >= this.resolved.maxAutoWakesPerChain + this.chainExtra(root, ledger)) return true
    const entry = ledger.wakes[String(record.targetId)]
    const spentToday = entry !== undefined && entry.day === today ? entry.wakes : 0
    return spentToday >= this.resolved.maxAutoWakesPerSessionPerDay
  }

  /** Strict bounded read for human extension; legacy delivery's root walk stays unchanged. */
  private extensionRoot(messageId: SessionLinkMessageId, selected: SessionLinkMessageRecordData): SessionLinkMessageId | undefined {
    if (selected.senderId === selected.targetId) return undefined
    const seen = new Set<SessionLinkMessageId>()
    let current = messageId
    for (let depth = 0; depth < 256; depth += 1) {
      if (seen.has(current)) return undefined
      seen.add(current)
      const record = this.messages.get(current)
      if (record === undefined || legacyTaskReport(record)) return undefined
      const samePair = (record.senderId === selected.senderId && record.targetId === selected.targetId)
        || (record.senderId === selected.targetId && record.targetId === selected.senderId)
      if (!samePair) return undefined
      if (record.inReplyTo === undefined) return current
      current = record.inReplyTo
    }
    return undefined
  }

  /** Roots count across all groups and both directions, including the initial task. */
  private chainWakesUsed(root: SessionLinkMessageId): number {
    let used = 0
    for (const [id, record] of this.messages.entries()) {
      if (rootIdOf(this.messages, id, record) === root) used += record.wakesUsed
    }
    return used
  }

  /** The append facts are the only source of extra quota. */
  private chainExtra(root: SessionLinkMessageId, ledger = this.readLedgers()): number {
    let extra = 0
    for (const fact of Object.values(ledger.chainWakeExtensions)) {
      if (fact.rootId === root) extra += fact.additional
    }
    return extra
  }

  private wakeBudget(messageId: SessionLinkMessageId, record: SessionLinkMessageRecordData): SessionLinkWakeBudget | undefined {
    const rootId = this.extensionRoot(messageId, record)
    if (rootId === undefined) return undefined
    const ledger = this.readLedgers()
    const used = this.chainWakesUsed(rootId)
    const extra = this.chainExtra(rootId, ledger)
    const baseLimit = this.resolved.maxAutoWakesPerChain
    const limit = baseLimit + extra
    if (![used, extra, limit].every(Number.isSafeInteger)) return undefined
    const now = new Date()
    const day = dayKey(now)
    const targetEntry = ledger.wakes[String(record.targetId)]
    return {
      rootId,
      chain: { used, baseLimit, extra, limit, remaining: Math.max(0, limit - used) },
      targetDay: {
        used: targetEntry?.day === day ? targetEntry.wakes : 0,
        limit: this.resolved.maxAutoWakesPerSessionPerDay, day,
        resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
      },
      message: { used: record.wakesUsed, limit: this.resolved.maxAutoWakesPerMessage },
      canExtend: this.extensionGrantAllowed(record) && limit < Number.MAX_SAFE_INTEGER,
    }
  }

  /**
   * Claim one automatic wake for this already-granted delivery under
   * per-message, per-chain, and per-target-day budgets. The claim is written
   * durably before the target is woken; the chain spend is derived from
   * recorded wakesUsed.
   */
  private async claimWake(
    messageId: SessionLinkMessageId,
    record: SessionLinkMessageRecordData,
  ): Promise<boolean> {
    const ledger = this.readLedgers()
    const today = dayKey(new Date())
    if (this.wakeBudgetExhausted(messageId, record, ledger, today)) return false
    const entry = ledger.wakes[String(record.targetId)]
    const spentToday = entry !== undefined && entry.day === today ? entry.wakes : 0
    await this.writeLedgers({
      ...ledger,
      wakes: {
        ...ledger.wakes,
        [String(record.targetId)]: { day: today, wakes: spentToday + 1 },
      },
    })
    return true
  }

  /** Durable delivery acknowledgement. */
  private async markDelivered(messageId: SessionLinkMessageId): Promise<void> {
    const record = this.messages.get(messageId)
    if (record === undefined || record.status !== 'pending') return
    await this.messages.put(messageId, { ...record, status: 'delivered' })
  }

  /** Record a failed immediate leg; never terminal from a single attempt. */
  private async bumpAttempts(messageId: SessionLinkMessageId, error: string): Promise<void> {
    const record = this.messages.get(messageId)
    if (record === undefined || record.status !== 'pending' || record.inserted === true) return
    const attempts = record.attempts + 1
    await this.messages.put(messageId, attempts >= this.resolved.maxDeliveryAttempts
      ? { ...record, attempts, status: 'failed', error }
      : { ...record, attempts, error })
  }

  /** Service-start recovery: replay pending mail for any already-live target. */
  private async recoverPending(): Promise<void> {
    const targets = new Set<SessionId>()
    let blocked = 0
    for (const [, record] of this.messages.entries()) {
      if (record.status !== 'pending') continue
      if (legacyTaskReport(record)) { blocked += 1; continue }
      targets.add(record.targetId)
    }
    if (blocked > 0) this.ctx.logger.warn(`gc-duolink: ${blocked} legacy experimental reports retained without delivery or wake; inspect this profile before migration`)
    for (const targetId of targets) {
      await this.tryDeliverPending(targetId)
    }
  }

  /** Serialize-and-deliver pending mail for one target without spending a wake. */
  private async tryDeliverPending(targetId: SessionId): Promise<void> {
    await this.chain(async () => {
      if (this.disposed) return
      await this.deliverTarget(targetId)
    })
  }

  /** Tombstone undelivered messages whose link membership no longer pairs sender and target. */
  private async revokeUndelivered(linkId: SessionLinkId, memberIds: readonly SessionId[]): Promise<void> {
    for (const [messageId, record] of this.messages.entries()) {
      if (record.linkId !== linkId || record.status !== 'pending') continue
      const stillGranted = memberIds.includes(record.senderId) && memberIds.includes(record.targetId)
      if (stillGranted) continue
      // Possibly held by the target: not recalled, confirmed by a later flush.
      if (this.mayBeHeld(messageId, record, this.ctx.agents.get(record.targetId))) continue
      await this.messages.put(messageId, { ...record, status: 'revoked' })
    }
  }

  /** Require a live membership edge between caller and target. */
  private requireMembership(senderId: SessionId, targetId: SessionId): SessionLinkSummary {
    for (const summary of this.list()) {
      if (summary.memberIds.includes(senderId) && summary.memberIds.includes(targetId)) return summary
    }
    throw new SessionLinkError(
      `sessions "${senderId}" and "${targetId}" share no link grant`,
      'LINK_TARGET_NOT_MEMBER',
    )
  }

  /** Read the durable ledgers row, defaulting to empty. */
  private readLedgers(): SessionLinkLedgersData {
    const row = this.ledgers.get(SESSION_LINK_LEDGER_KEY)
    return row === undefined
      ? { wakes: {}, spawns: {}, initialModelSpawns: {}, chainWakeExtensions: {} }
      : { ...row, chainWakeExtensions: row.chainWakeExtensions ?? {} }
  }

  /** Persist one ledgers row. */
  private async writeLedgers(row: SessionLinkLedgersData): Promise<void> {
    await this.ledgers.put(SESSION_LINK_LEDGER_KEY, row)
  }

  /** Human-facing sender label recorded beside the durable sender id. */
  private titleOf(agent: Agent): string {
    const titles = this.ctx.get('sessionTitle')
    return titles?.get(agent.session)?.title ?? String(agent.id)
  }
}

/**
 * Whether one Session identity belongs to subagent routing and must never be a
 * link member: an explicit subagent origin, or a live parent Agent that still
 * owns this identity in the runtime registry. Mirrors the Session
 * Controller's ownership policy using only the public Agent registry.
 * @param ctx - host context carrying the Agent registry.
 * @param sessionId - candidate identity under test.
 * @param header - attached or persisted header of that Session.
 * @returns whether subagent routing owns the identity.
 */
export function subagentOwned(
  ctx: Context,
  sessionId: SessionId,
  header: SessionHeader,
): boolean {
  if (header.origin === 'subagent') return true
  const parentId = header.parentSession
  const live = ctx.agents.get(sessionId)
  if (parentId === undefined || live === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(live.id, parent)
}

/** The chain root of one admitted message: its own id at the root, else the walk stops at the first ancestor. */
function rootIdOf(
  table: KvTable<SessionLinkMessageId, SessionLinkMessageRecordData>,
  id: SessionLinkMessageId,
  record: SessionLinkMessageRecordData,
): SessionLinkMessageId {
  return record.inReplyTo === undefined ? id : chainRootOf(table, record.inReplyTo)
}

/**
 * Session Link message ids one live Agent's loaded log holds: claimed into
 * model-visible history, or inserted into the inbox by a splice. A later
 * claim-removal splice does not remove an id. Presence here is not a durable
 * receipt by itself; callers confirm it with a successful flush.
 */
function recordedIds(target: Agent): Set<string> {
  const ids = new Set<string>()
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of target.session.snapshotEvents(target.session.inheritedEventCount)) {
    if (event.type === 'user/message' && event.data.source.kind === 'gc-duolink-message') {
      ids.add(event.data.source.messageId)
      continue
    }
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) {
      const source = (message as { source?: { kind?: string; messageId?: string } }).source
      if (source?.kind === 'gc-duolink-message' && source.messageId !== undefined) ids.add(source.messageId)
    }
  }
  return ids
}

export default SessionLinkService
