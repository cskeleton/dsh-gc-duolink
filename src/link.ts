/**
 * The Session Link service (`ctx.sessionLinks`): link-group lifecycle and the
 * durable mailbox that admits, orders, and acknowledges peer deliveries.
 * @module dsh-session-link/link
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
  SESSION_LINK_LEDGER_KEY,
} from './spec.ts'
import type {
  SessionLinkLedgersData,
  SessionLinkMessageRecordData,
  SessionLinkRecordData,
} from './spec.ts'
import {
  SessionLinkError,
  SessionLinkId,
  SessionLinkMessageId,
} from './types.ts'
import type {
  Config as SessionLinkConfigShape,
  SessionLinkAddRequest,
  SessionLinkAddResult,
  SessionLinkGrant,
  SessionLinkMessageSource,
  SessionLinkRevokeRequest,
  SessionLinkSendRequest,
  SessionLinkSendResult,
  SessionLinkSpawnReplay,
  SessionLinkSummary,
  SessionLinkTaskStatusReport,
  SessionLinkTaskStatusSource,
  SessionLinkTaskViewEntry,
  SessionLinkTaskViewRequest,
  SessionLinkTaskViewResponse,
  SessionLinkWakeRequest,
  SessionLinkView,
} from './types.ts'
import type { SessionLinkTaskRecordData } from './task-spec.ts'
import { requestedRouteOf } from './task-runtime.ts'

const wireSessionId = wire.string().min(1).transform(value => brandString<SessionId>(value))
const wireLinkId = wire.string().min(1).transform(value => SessionLinkId(value))
const addRequestSchema = wire.strictObject({ callerId: wireSessionId, peerId: wireSessionId, autoWake: wire.boolean(), autoWakeCaller: wire.boolean().optional() })
const revokeRequestSchema = wire.strictObject({ callerId: wireSessionId, linkId: wireLinkId })
const wakeRequestSchema = wire.strictObject({ callerId: wireSessionId, linkId: wireLinkId, peerId: wireSessionId, on: wire.boolean() })
const taskViewRequestSchema = wire.strictObject({ sessionId: wireSessionId })

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
  maxAutoWakesPerSessionPerDay: z.natural().min(1).default(6),
  maxAutoWakesPerMessage: z.natural().min(1).default(1),
  maxAutoWakesPerChain: z.natural().min(1).default(4),
  maxDeliveryAttempts: z.natural().min(1).default(3),
})

/** Fallbacks applied when a programmatic caller omits a field; the loader path resolves defaults through {@link Config}. */
const DEFAULTS: SessionLinkLimits = {
  maxLinkMembers: 8,
  maxPendingPerTarget: 16,
  maxMessageBytes: 16 * 1024,
  maxAutoWakesPerSessionPerDay: 6,
  maxAutoWakesPerMessage: 1,
  maxAutoWakesPerChain: 4,
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
 * the message id that `session_send_session_message` takes as `in_reply_to`.
 * @param frame - sender title and id, the minted message id, and the caller's complete body.
 * @returns the sender-framed body stored in the mailbox and delivered to the target.
 */
export function frameSessionLinkText(frame: {
  readonly senderTitle: string
  readonly senderId: SessionId
  readonly messageId: SessionLinkMessageId
  readonly text: string
}): string {
  return `[会话消息] 来自会话「${frame.senderTitle}」（${frame.senderId}）的协作消息，非本机人类直接输入。\n`
    + `消息 ID：${frame.messageId}。如需回复，调用 session_send_session_message，`
    + `session_id 填 ${frame.senderId}，in_reply_to 填 ${frame.messageId}。\n${frame.text}`
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

/**
 * Human-readable body of one task-status report. Explicitly framed as a
 * host-generated STATUS — never an instruction, never the target Session
 * speaking: the receiver may quote the structured fields but nothing in the
 * text asks it to act.
 */
export function renderTaskStatusText(request: SessionLinkTaskStatusReport, targetTitle: string): string {
  const lines: string[] = [
    `[任务状态回报] 宿主生成的任务状态事实（非会话「${targetTitle}」（${request.targetId}）的发言，也不是给本机的指令。`,
    `任务：${request.taskId}（尝试 ${request.attemptId}，修订 ${request.revision}，事件 ${request.eventId}）。`,
    `类别：${request.eventKind}；请求路由：${request.requestedModel.provider}/${request.requestedModel.model}${request.requestedModel.reasoningEffort === undefined ? '' : ` (effort ${request.requestedModel.reasoningEffort})`}${request.actualModel === undefined ? '' : `；实际路由：${request.actualModel.provider}/${request.actualModel.model}${request.actualModel.reasoningEffort === undefined ? '' : ` (effort ${request.actualModel.reasoningEffort})`}`}。`,
    `候选尝试 ${request.attempts} 次${request.executionState === undefined ? '' : `；执行进度：${request.executionState}`}${request.reason === undefined ? '' : `；原因：${request.reason}`}。`,
    `需要决策：${request.decisionRequired ? '是' : '否'}；可恢复：${request.resumable ? '是' : '否'}。`,
    `详情通过 session_get_task 查询；如需决策，调用 session_resolve_task，task_id 填 ${request.taskId}。`,
  ]
  return lines.join('\n')
}

/**
 * Project one stored task row into the panel's read-only entry. The route
 * label stays honest: `persisted` is claimed only when `routeUsed` committed
 * (a turn that fell back before finishing shows the route it actually ran);
 * a session-scope task whose persist was skipped carries the skip reason and
 * `routePersisted: false`. Outbox events keep their own delivery lifecycle;
 * `pending`/`admitted` make no execution claim.
 * @param row - one stored task row the caller may read.
 * @returns the panel's projection line.
 */
function taskEntryOf(row: SessionLinkTaskRecordData): SessionLinkTaskViewEntry {
  const requested = requestedRouteOf(row.policy)
  const routeWire = (route: { provider: string; model: string; reasoningEffort?: string } | undefined) =>
    route === undefined ? undefined : {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
  return {
    taskId: `task:${row.callerId}:${row.callId}`,
    taskState: row.taskState,
    revision: row.revision,
    ...(row.executionState === undefined ? {} : { executionState: row.executionState }),
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.targetSessionId === undefined ? {} : { targetSessionId: row.targetSessionId }),
    requestedModel: {
      provider: requested.provider,
      model: requested.model,
      ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }),
    },
    ...(routeWire(row.execution.currentRoute) === undefined ? {} : { currentRoute: routeWire(row.execution.currentRoute) }),
    ...(routeWire(row.execution.routeUsed) === undefined ? {} : { routeUsed: routeWire(row.execution.routeUsed) }),
    scope: row.policy.scope,
    // Only a committed turn-finished route may claim persistence; a partial or
    // waiting decision never shows a baseline label it did not earn.
    routePersisted: row.taskState === 'turn_finished' && row.execution.routeUsed !== undefined,
    currentlyExecuting: row.execution.currentlyExecuting === true,
    ...(row.attempts.at(-1)?.results.at(-1) === undefined ? {} : {
      latestIssue: {
        ...(row.attempts.at(-1)!.results.at(-1)!.code === undefined ? {} : { code: row.attempts.at(-1)!.results.at(-1)!.code }),
        ...(row.attempts.at(-1)!.results.at(-1)!.message === undefined ? {} : { message: row.attempts.at(-1)!.results.at(-1)!.message }),
      },
    }),
    outbox: row.outbox.map(event => ({
      eventId: event.eventId,
      kind: event.kind,
      status: event.status,
      ...(routeWire(event.requestedModel) === undefined ? {} : { requestedModel: routeWire(event.requestedModel) }),
      ...(routeWire(event.actualModel) === undefined ? {} : { actualModel: routeWire(event.actualModel) }),
      decisionRequired: event.decisionRequired,
      resumable: event.resumable,
      ...(event.blockedReason === undefined ? {} : { blockedReason: event.blockedReason }),
    })),
    updatedAt: row.updatedAt,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One durable mailbox/link fact changed so a previous refusal may now
     * succeed: capacity freed (pending → delivered/cancelled/revoked/failed),
     * a receiver took delivery, or an auto-wake/membership grant changed. The
     * task-notification pump subscribes and schedules a coalesced pass;
     * emission is strictly after the durable write, never from a timer.
     * @mode emit
     */
    'session-link/mailbox'(): void
  }
}

/**
 * R17 (MODEL_ROUTING_FIX_PLAN Task 4): the mailbox identity of one task-status
 * report derives from the FULL eventId through a stable hash — never a
 * lossy character-sanitize, so `review/a` and `review_a` (or any pair of
 * eventIds diverging only in non-identifier characters) hash to DISTINCT
 * message ids and can never overwrite each other. The full eventId already
 * includes arbitrary user-controlled callId characters; hashing absorbs them.
 */
export function notificationMessageId(eventId: string): SessionLinkMessageId {
  const hex = createHash('sha256').update(`task-report\0${eventId}`).digest('hex')
  return SessionLinkMessageId(`task-report-${hex.slice(0, 32)}`)
}

/**
 * Durable link registry plus mailbox. Cross-session state lives in the
 * `session-link` storage domain; delivery to a live target uses the Agent
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
    super(ctx, 'sessionLinks')
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
    }, 'sessionLinks.close')
    this.ctx.on('agent/created', ({ agent }) => {
      // Auto-wake policy never applies to recovery-triggered replays: a boot
      // that resumes Sessions must not silently spend model calls.
      void this.tryDeliverPending(agent.id).catch((error: unknown) => {
        this.ctx.logger.warn(`session-link: recovery delivery to "${agent.id}" failed: ${String(error)}`)
      })
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      // A target that starts work (human turn, schedule, another wake) admits
      // its deferred mail as a follow-up behind the active turn.
      if (status !== 'running') return
      void this.tryDeliverPending(agent.id).catch((error: unknown) => {
        this.ctx.logger.warn(`session-link: deferred delivery to "${agent.id}" failed: ${String(error)}`)
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
      this.mailboxSettled()
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
    const id = options.createAs ?? SessionLinkId(`session-link-${randomUUID()}`)
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
    this.mailboxSettled()
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
      this.mailboxSettled()
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
    this.mailboxSettled()
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
   * Remote: link the caller's Session with one peer as `{ kind: 'human' }`,
   * mirroring the `/session-link add` command's validation and naming. Both
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
   * Remote: the read-only task projection the human panel polls. Lists every
   * durable tracked task the managing Session may read (its own tasks + those
   * targeting it), newest first, with the route/outbox facts the cards
   * already carry. Read-only: no wake, no decision, no outbox scan beyond
   * the task rows' own stored events. The task service is optional in stacks
   * without the tracked layer; its absence yields an empty projection, never
   * an error the panel would have to special-case.
   * @param request - the managing Session identity; callers only ever see
   *   tasks whose caller or target matches it.
   * @returns the projection and the configured poll interval.
   */
  @Remote('taskView')
  async taskView(request: SessionLinkTaskViewRequest): Promise<SessionLinkTaskViewResponse> {
    request = taskViewRequestSchema.parse(request)
    let service: Context['sessionLinkTasks'] | undefined
    try {
      service = this.ctx.sessionLinkTasks
    } catch {
      service = undefined
    }
    if (service === undefined) return { pollIntervalMs: this.uiPollIntervalMs, tasks: [] }
    const entries = service.listRows()
      .filter(row => row.callerId === request.sessionId
        || (row.targetSessionId !== undefined && row.targetSessionId === request.sessionId))
      .map(row => taskEntryOf(row))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId))
    return { pollIntervalMs: this.uiPollIntervalMs, tasks: entries }
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
      const linkId = earlier?.id ?? SessionLinkId(`session-link-${randomUUID()}`)
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
   * on the message, or an earlier version's idempotency-ledger entry.
   */
  private findAdmitted(senderId: SessionId, idempotencyKey: string): SessionLinkMessageId | undefined {
    for (const [id, candidate] of this.messages.entries()) {
      if (candidate.senderId === senderId && candidate.idempotencyKey === idempotencyKey) return id
    }
    const legacy = this.readLedgers().idempotency[`${senderId}:${idempotencyKey}`]
    return legacy !== undefined && this.messages.get(SessionLinkMessageId(legacy)) !== undefined
      ? SessionLinkMessageId(legacy)
      : undefined
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
    await this.chain(async () => {
      if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
      const record = this.messages.get(messageId)
      if (record === undefined) {
        throw new SessionLinkError(`message "${messageId}" not found`, 'MESSAGE_NOT_FOUND')
      }
      if (caller !== undefined && record.senderId !== caller.id && record.targetId !== caller.id) {
        throw new SessionLinkError('only the sender or target Session may cancel a message', 'MESSAGE_NOT_FOUND')
      }
      if (record.status !== 'pending') return
      const target = this.ctx.agents.get(record.targetId)
      if (this.mayBeHeld(messageId, record, target)) {
        if (target !== undefined) await this.confirmDurable(target, [messageId])
        return
      }
      await this.messages.put(messageId, { ...record, status: 'cancelled' })
      this.mailboxSettled()
    })
  }

  /**
   * R08(1) (MODEL_ROUTING_FIX_PLAN Task 3): adopt an ALREADY-CONSUMED tracked
   * delivery's next-attempt identity. The SOLE effect is renaming the stored
   * record's idempotency key `<callKey> → <callKey>/consumed` so the wire
   * layer's replay of the ORIGINAL call key never re-admits this delivery as
   * the new attempt's own. Status, target, and delivery facts stay exactly
   * what the mailbox already recorded — a consumed (delivered) message stays
   * delivered; the consumed namespace prevents phantom `queued` projections
   * without letting any new identity silently disappear either.
   *
   * Best-effort caller contract: the caller invokes this only for messages
   * that are NOT pending (delivered/cancelled terminal realms); a pending
   * record is left untouched (its honest cancellation is the R03 path).
   * @param messageId - the stored delivery the new attempt supersedes.
   * @param aliasKey - the consumed-namespace key (`<callKey>/consumed`).
   */
  async markRetried(messageId: SessionLinkMessageId, aliasKey: string): Promise<void> {
    await this.chain(async () => {
      const record = this.messages.get(messageId)
      if (record === undefined) return
      if (record.status === 'pending') return
      if (record.idempotencyKey === aliasKey) return
      await this.messages.put(messageId, { ...record, idempotencyKey: aliasKey })
    })
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

  /**
   * R14: announce one durable retry-condition change (capacity freed,
   * receiver moved pending mail to delivered, grant changed). Listeners —
   * the task outbox pump — coalesce bursts themselves; this service just
   * reports transitions, never deciding what may retry. Emission happens
   * strictly AFTER the durable write that settles the transition.
   */
  private mailboxSettled(): void {
    if (this.disposed) return
    this.ctx.emit('session-link/mailbox')
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
    const messageId = request.messageId ?? SessionLinkMessageId(`session-link-message-${randomUUID()}`)
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
    try {
      await this.deliverTarget(record.targetId, { wakeFor: messageId, ...(signal === undefined ? {} : { signal }) })
    } catch (error: unknown) {
      if (this.messages.get(messageId)?.status === 'cancelled') throw error
      this.ctx.logger.warn(`session-link: delivery of "${messageId}" stays queued: ${String(error)}`)
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
      this.mailboxSettled()
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
        this.mailboxSettled()
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
    const wakeGranted = !archived && triggerRecord !== undefined && triggerLink !== undefined
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
    if (record.statusKind === 'task-status') {
      if (record.taskStatus === undefined) throw new SessionLinkError(`task-status message "${messageId}" lost its status record`, 'MESSAGE_NOT_FOUND')
      const source: SessionLinkTaskStatusSource = {
        kind: 'session-task-status',
        messageId,
        linkId: record.linkId,
        taskId: record.taskStatus.taskId as SessionLinkTaskStatusSource['taskId'],
        targetSessionId: record.senderId,
        attemptId: record.taskStatus.attemptId,
      }
      return createUserMessage({ content: [{ type: 'text', text: record.text }], source })
    }
    const source: SessionLinkMessageSource = {
      kind: 'session-link-message',
      messageId,
      linkId: record.linkId,
      senderId: record.senderId,
      senderTitle: record.senderTitle,
      ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
    }
    return createUserMessage({ content: [{ type: 'text', text: record.text }], source })
  }

  /**
   * Trusted INTERNAL admission of one host-generated task-status report over
   * the REAL mailbox path (Task 5 of the model-routing plan). Only this
   * explicit entry exists; it never opens an arbitrary-senderId admission
   * surface — the caller forwards strictly its own durable outbox facts and
   * the task pair it owns. Everything the public `send` enforces (chain
   * serialization, group membership, archived targets, residency, per-target
   * pending budget, per-message wake budget, per-chain budget through the
   * supplied inReplyTo root, daily wake ledger, admission-order delivery) is
   * enforced here identically.
   *
   * Attribution: the message is stamped `statusKind: 'task-status'` and a
   * `source.kind === 'session-task-status'` at delivery, so the receiving
   * side attributes it honestly to the host-generated task status of the
   * ORIGINAL task — never as the target Session speaking, never as an
   * instruction. The body is a human-readable status text plus structured
   * fields the receiver quotes; nothing about it asks the receiver to act.
   *
   * Idempotency: `eventId` is the admission key. A replay re-attempts
   * delivery of the stored message under the recorded identity instead of
   * admitting a second copy (restart-safe dedupe across the task row's own
   * outbox marker in the task service and this mailbox row).
   */
  async admitTaskStatus(request: SessionLinkTaskStatusReport): Promise<SessionLinkSendResult> {
    return await this.chain(() => this.admissionTaskStatus(request))
  }

  /** Serialized admission of one task-status report. */
  private async admissionTaskStatus(request: SessionLinkTaskStatusReport): Promise<SessionLinkSendResult> {
    if (this.disposed) throw new SessionLinkError('Session Link service is disposing', 'DISPOSED')
    if (request.callerId === request.targetId) {
      throw new SessionLinkError('a Session cannot report a task to itself', 'LINK_SELF')
    }
    const prior = this.findAdmitted(request.targetId, `task-event:${request.eventId}`)
    if (prior !== undefined) return await this.deliverStored(prior, undefined)
    const link = this.requireMembership(request.targetId, request.callerId)
    const liveTarget = this.ctx.agents.get(request.callerId)
    if (liveTarget !== undefined) this.assertOrdinaryTarget(request.callerId, liveTarget.session.header)
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(request.callerId)) {
      throw new SessionLinkError(`session "${request.callerId}" is archived`, 'TARGET_ARCHIVED')
    }
    // Compute the status body and the target attribution ONCE: both the byte
    // budget and the durable row read the same strings (a second render would
    // also re-resolve the title).
    const targetTitle = this.titleOfSession(request.targetId)
    const text = renderTaskStatusText(request, targetTitle)
    if (Buffer.byteLength(text, 'utf8') > this.resolved.maxMessageBytes) {
      throw new SessionLinkError(`task-status message exceeds ${this.resolved.maxMessageBytes} bytes`, 'MESSAGE_TOO_LARGE')
    }
    let inReplyTo: SessionLinkMessageId | undefined
    let chainLength = 1
    if (request.inReplyTo !== undefined) {
      const original = this.messages.get(request.inReplyTo)
      if (original === undefined) {
        /* R18: the root may be a HOST-MINTED task delivery identity the
         * mailbox never admitted — a precheck-failed task's notifications
         * thread the root its durable intent row minted at FIRST admission
         * (the deterministic attempt-1 delivery identity; Task 4), which no
         * mailbox write ever reached. Thread it anyway: the root identity is
         * not fabricated per event, it is the task's single durable root, and
         * the per-chain wake budget keys on the root id through
         * {@link rootIdOf} — threading is what keeps the task's whole
         * notification lifecycle on ONE chain (chainLength stays 1: no parent
         * chain existed to extend). */
        inReplyTo = request.inReplyTo
      } else if (original.targetId === request.targetId && original.senderId === request.callerId) {
        inReplyTo = request.inReplyTo
        chainLength = original.chainLength + 1
      } else {
        /* A root the mailbox recorded for a DIFFERENT pair is never threaded
         * onto this report — the report stays admissible on its own chain
         * rather than riding a foreign root's budget. */
      }
    }
    const pendingForTarget = this.pendingFor(request.callerId).length
    if (pendingForTarget >= this.resolved.maxPendingPerTarget) {
      throw new SessionLinkError(
        `session "${request.callerId}" already has ${pendingForTarget} pending peer messages`,
        'MAILBOX_FULL',
      )
    }
    const messageId = notificationMessageId(request.eventId)
    /* R17 put-time conflict validation: the id must name THIS event. A stored
     * row whose event differs (a genuine digest collision, or corruption)
     * refuses loudly — NEVER overwrite one event's report with another's. The
     * same-event replay never reaches here (the idempotency probe above
     * adopts it), so a same-id row at put time is always a different event. */
    const existingRow = this.messages.get(messageId)
    if (existingRow !== undefined && existingRow.taskStatus?.eventId !== request.eventId) {
      throw new SessionLinkError(
        `task-status message "${messageId}" already names a different event ("${existingRow.taskStatus?.eventId ?? '<non-task row>'}"); refusing to overwrite`,
        'MESSAGE_UNDELIVERABLE',
      )
    }
    const record: SessionLinkMessageRecordData = {
      linkId: link.id,
      senderId: request.targetId,
      senderTitle: targetTitle,
      targetId: request.callerId,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      text,
      status: 'pending',
      wakesUsed: 0,
      chainLength,
      attempts: 0,
      createdAt: new Date().toISOString(),
      seq: this.nextSeq(),
      statusKind: 'task-status',
      taskStatus: {
        taskId: request.taskId,
        attemptId: request.attemptId,
        eventId: request.eventId,
        revision: request.revision,
        kind: request.eventKind,
        ...(request.executionState === undefined ? {} : { executionState: request.executionState }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        requestedModel: request.requestedModel,
        ...(request.actualModel === undefined ? {} : { actualModel: request.actualModel }),
        attempts: request.attempts,
        decisionRequired: request.decisionRequired,
        resumable: request.resumable,
      },
      idempotencyKey: `task-event:${request.eventId}`,
    }
    await this.messages.put(messageId, record)
    return await this.deliverStored(messageId, undefined)
  }

  /**
   * Pending messages for one target in admission order: the monotonic
   * admission sequence, falling back to the timestamp for messages admitted
   * before 0.4.0 carried one.
   */
  private pendingFor(targetId: SessionId): [SessionLinkMessageId, SessionLinkMessageRecordData][] {
    return [...this.messages.entries()]
      .filter(([, record]) => record.status === 'pending' && record.targetId === targetId)
      .sort(([, left], [, right]) => left.seq !== undefined && right.seq !== undefined
        ? left.seq - right.seq
        : left.createdAt.localeCompare(right.createdAt))
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
   * Claim one automatic wake for this already-granted delivery under
   * per-message, per-chain, and per-target-day budgets. The claim is written
   * durably before the target is woken; the chain spend is derived from
   * recorded wakesUsed.
   */
  private async claimWake(
    messageId: SessionLinkMessageId,
    record: SessionLinkMessageRecordData,
  ): Promise<boolean> {
    if (record.wakesUsed >= this.resolved.maxAutoWakesPerMessage) return false
    const root = rootIdOf(this.messages, messageId, record)
    const chainSpent = [...this.messages.entries()]
      // Roots are message ids, so a chain counts across every group it moved through.
      .filter(([candidateId, candidate]) => rootIdOf(this.messages, candidateId, candidate) === root)
      .reduce((sum, [, candidate]) => sum + candidate.wakesUsed, 0)
    if (chainSpent >= this.resolved.maxAutoWakesPerChain) return false
    const ledger = this.readLedgers()
    const today = dayKey(new Date())
    const entry = ledger.wakes[String(record.targetId)]
    const spentToday = entry !== undefined && entry.day === today ? entry.wakes : 0
    if (spentToday >= this.resolved.maxAutoWakesPerSessionPerDay) return false
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
    this.mailboxSettled()
  }

  /** Record a failed immediate leg; never terminal from a single attempt. */
  private async bumpAttempts(messageId: SessionLinkMessageId, error: string): Promise<void> {
    const record = this.messages.get(messageId)
    if (record === undefined || record.status !== 'pending' || record.inserted === true) return
    const attempts = record.attempts + 1
    if (attempts >= this.resolved.maxDeliveryAttempts) {
      await this.messages.put(messageId, { ...record, attempts, status: 'failed', error })
      this.mailboxSettled()
      return
    }
    await this.messages.put(messageId, { ...record, attempts, error })
  }

  /** Service-start recovery: replay pending mail for any already-live target. */
  private async recoverPending(): Promise<void> {
    const targets = new Set<SessionId>()
    for (const [, record] of this.messages.entries()) {
      if (record.status === 'pending') targets.add(record.targetId)
    }
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
    let tombstoned = false
    for (const [messageId, record] of this.messages.entries()) {
      if (record.linkId !== linkId || record.status !== 'pending') continue
      const stillGranted = memberIds.includes(record.senderId) && memberIds.includes(record.targetId)
      if (stillGranted) continue
      // Possibly held by the target: not recalled, confirmed by a later flush.
      if (this.mayBeHeld(messageId, record, this.ctx.agents.get(record.targetId))) continue
      await this.messages.put(messageId, { ...record, status: 'revoked' })
      tombstoned = true
    }
    if (tombstoned) this.mailboxSettled()
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
    return this.ledgers.get(SESSION_LINK_LEDGER_KEY) ?? { idempotency: {}, wakes: {}, spawns: {} }
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

  /** Human-facing label for one Session id (task-status attribution). */
  private titleOfSession(sessionId: SessionId): string {
    const titles = this.ctx.get('sessionTitle')
    const live = this.ctx.sessions?.get(sessionId)
    return (live !== undefined ? titles?.get(live)?.title : undefined) ?? String(sessionId)
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
    if (event.type === 'user/message'
      && (event.data.source.kind === 'session-link-message' || event.data.source.kind === 'session-task-status')) {
      const source = event.data.source as { kind: string; messageId?: string }
      if (source.messageId !== undefined) ids.add(source.messageId)
      continue
    }
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) {
      const source = (message as { source?: { kind?: string; messageId?: string } }).source
      if ((source?.kind === 'session-link-message' || source?.kind === 'session-task-status')
        && source.messageId !== undefined) {
        ids.add(source.messageId)
      }
    }
  }
  return ids
}

export default SessionLinkService
