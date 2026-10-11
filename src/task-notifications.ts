/**
 * The Session Link task-notification pump (MODEL_ROUTING_PLAN Task 5): the
 * event-driven closure of the durable task outbox. Pending task outbox events
 * (committed atomically with the task state that obligated them — Task 3/4)
 * ride the REAL mailbox path to the ORIGINAL sender through the trusted
 * `SessionLinkService.admitTaskStatus` entry: same admission chain, budget,
 * residency, ordering, and dedup infrastructure as peer mail, with strictly
 * host-generated status attribution. There are no timers and no pollers —
 * the pump runs at plugin mount, and once after every runtime/service
 * mutation that may leave pending outbox work (saved intents, admissions,
 * runtime projections, decisions, outbox lifecycle CAS results, mailbox
 * admission writes).
 *
 * Delivery semantics per pending event (in commit order across tasks):
 *
 *  - **Dedupe** — the task row's own eventId marker AND the mailbox's
 *    eventId-keyed idempotency (`task-event:<eventId>`) both gate: replay
 *    after restart NEVER admits a second copy.
 *  - **Revalidation** — the ORIGINAL link pair is re-read at SEND time: a
 *    lost grant blocks the event durably with the revocation reason (the
 *    event stays queryable; no alternate channel silently re-opens).
 *  - **Budgets** — the SAME wake budgets peer mail honors gate admission.
 *    Budget denial (daily, per-message, per-chain, archived target) keeps the
 *    event PENDING — never blocked — so the sender's later activity or a
 *    human wake still delivers the already-durable fact later.
 *  - **Cascade** — one successful mailbox write pumps again exactly once,
 *    so an `admitted`/`delivered` marker waiting on a later mailbox leg
 *    reconciles without polling.
 *
 * Notifications never trigger notifications: the delivered source is
 * `session-task-status`, which nothing in the plugin treats as a task —
 * and the chain wake budget is never reset, because the report rides the
 * ORIGINAL task's notification root (`inReplyTo`).
 * @module dsh-session-link/task-notifications
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLinkService } from './link.ts'
import type {
  SessionLinkId,
  SessionLinkMessageId,
  SessionLinkTaskStatusReport,
} from './types.ts'
import { SessionLinkError } from './types.ts'
import type {
  SessionLinkTaskOutboxEvent,
  SessionLinkTaskRecordData,
} from './task-spec.ts'
import type { SessionLinkTaskService } from './tasks.ts'
import type { SessionLinkTaskId } from './types.ts'

/** The pump one root context owns: scheduled passes plus the serialized chain. */
export interface TaskNotificationPump {
  /** Queue one pump pass; multiple triggers collapse into one scheduled pass. */
  schedule(): void
  /** Await every queued pass (test/flush boundary). */
  drain(): Promise<void>
}

/**
 * Resolve the pair's live grant at send time: the task row's recorded linkId
 * must still pair caller and target. Send-side waiting_decision rows may
 * have no recorded linkId; fall back to ANY group pairing them.
 */
function resolveLiveLink(
  links: SessionLinkService,
  row: SessionLinkTaskRecordData,
): SessionLinkId | undefined {
  if (row.targetSessionId === undefined) return undefined
  if (row.execution.linkId !== undefined) {
    const paired = links.list(row.callerId).some(summary =>
      summary.id === row.execution.linkId && summary.memberIds.includes(row.targetSessionId!))
    return paired ? row.execution.linkId : undefined
  }
  return links.list(row.callerId).find(summary =>
    row.targetSessionId !== undefined && summary.memberIds.includes(row.targetSessionId)
  )?.id
}

/** Project one outbox event into the trusted report shape the mailbox admits. */
function reportOf(
  row: SessionLinkTaskRecordData,
  taskId: SessionLinkTaskId,
  event: SessionLinkTaskOutboxEvent,
  inReplyTo: SessionLinkMessageId | undefined,
): SessionLinkTaskStatusReport {
  const requested = event.requestedModel ?? { provider: 'session', model: 'session_default' }
  return {
    eventId: event.eventId,
    taskId,
    attemptId: event.attemptId ?? row.currentAttemptId,
    revision: event.revision,
    eventKind: event.kind,
    callerId: row.callerId,
    targetId: (row.targetSessionId ?? row.callerId) as SessionId,
    ...(event.executionState === undefined ? {} : { executionState: event.executionState }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    requestedModel: {
      provider: requested.provider,
      model: requested.model,
      ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }),
    },
    ...(event.actualModel === undefined ? {} : {
      actualModel: {
        provider: event.actualModel.provider,
        model: event.actualModel.model,
        ...(event.actualModel.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: event.actualModel.reasoningEffort }),
      },
    }),
    attempts: event.attempts ?? (row.attempts.at(-1)?.results.length ?? 0),
    decisionRequired: event.decisionRequired,
    resumable: event.resumable,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  }
}

/**
 * Install the outbox pump on one root context. Every pass is serialized
 * behind one chain; the subscription at mount replays pending/admitted rows
 * the prior process left, and every trigger point the wiring registers calls
 * `schedule` — an event-driven pump, never a timer.
 */
export function installTaskNotifications(
  ctx: Context,
  resolve: { tasks: () => SessionLinkTaskService | undefined; links: () => SessionLinkService },
): TaskNotificationPump {
  let tail: Promise<unknown> = Promise.resolve()
  let scheduled = false
  let disposed = false
  const pump: TaskNotificationPump = {
    schedule(): void {
      if (disposed || scheduled) return
      scheduled = true
      const run = tail.then(async () => {
        scheduled = false
        await pumpPending(resolve, () => pump.schedule())
      }).catch((error: unknown) => {
        ctx.logger?.warn?.(`task-notifications: pump pass failed: ${String(error)}`)
      })
      tail = run.then(() => undefined, () => undefined)
    },
    async drain(): Promise<void> {
      // Run one explicit pass NOW — pending scheduled work settles first,
      // then one fresh pass reads the live rows so the drain observes any
      // reconciliation the caller's preceding mutations obligated.
      await tail
      const run = tail.then(async () => {
        await pumpPending(resolve, () => {})
      }).catch(() => {})
      tail = run.then(() => undefined, () => undefined)
      await tail
    },
  }
  ctx.effect(() => async () => {
    disposed = true
    await tail
  }, 'sessionLinkTaskNotifications.close')
  // Restart wipe: reconcile every pending/admitted marker the prior process
  // left, against the mailbox facts durable now.
  pump.schedule()
  return pump
}

/** One pass over pending outbox events plus admitted-marker reconciliation. */
async function pumpPending(
  resolve: { tasks: () => SessionLinkTaskService | undefined; links: () => SessionLinkService },
  cascade: () => void,
): Promise<void> {
  const tasks = resolve.tasks()
  if (tasks === undefined) return
  const links = resolve.links()
  let settledMailboxWrite = false

  // Pass 1: an event already admitted whose mailbox message since reached
  // `delivered` flips to delivered — with NO new admission. The row's
  // revision is re-read live for every marker CAS, because pass 2 below /
  // other pumps may just have bumped it.
  for (const row of tasks.listRows()) {
    const taskId = taskIdOf(row)
    for (const event of row.outbox) {
      if (event.status !== 'admitted' || event.notifiedMessageId === undefined) continue
      const message = links.message(event.notifiedMessageId)
      if (message === undefined || message.status !== 'delivered') continue
      try {
        const live = tasks.getRow(taskId)
        if (live === undefined) continue
        await tasks.markOutboxDelivered(taskId, live.revision, event.eventId)
        settledMailboxWrite = true
      } catch { /* a concurrent projection settled; nothing re-applies */ }
    }
  }

  // Pass 2: deliver pending events in commit order (revalidating each pair at SEND time).
  for (const { taskId, event } of tasks.pendingOutbox()) {
    const row = tasks.getRow(taskId)
    if (row === undefined) continue
    const linkId = resolveLiveLink(links, row)
    if (linkId === undefined) {
      // Unlinked: a permanent refusal. Keep the event queryable + blocked.
      try {
        await tasks.blockOutboxEvent(taskId, row.revision, event.eventId, 'link_revoked: original pair no longer shares a link grant')
        settledMailboxWrite = true
      } catch { /* concurrent transition */ }
      continue
    }
    try {
      const sent = await links.admitTaskStatus(reportOf(row, taskId, event, row.notificationRoot.rootMessageId))
      settledMailboxWrite = true
      const live = tasks.getRow(taskId)
      if (live !== undefined) {
        try {
          await tasks.markOutboxAdmitted(taskId, live.revision, event.eventId, sent.messageId)
        } catch { /* concurrent transition */ }
        const after = tasks.getRow(taskId)
        if (after !== undefined && sent.status === 'accepted') {
          try {
            await tasks.markOutboxDelivered(taskId, after.revision, event.eventId)
          } catch { /* concurrent transition */ }
        }
      }
    } catch (error: unknown) {
      // Budget / residency / archived / disposed: never a permanent block.
      // The event stays PENDING; the sender's later activity or human wake
      // delivers the already-durable fact.
      const code = error instanceof SessionLinkError ? error.code : 'TARGET_UNAVAILABLE'
      if (code === 'DISPOSED') return
      continue
    }
  }

  // Cascade exactly once: the writes above may have settled markers/events
  // the same pass could not yet see.
  if (settledMailboxWrite) cascade()
}

/** Derive the task id of one stored row (the service's stable identity). */
function taskIdOf(row: SessionLinkTaskRecordData): SessionLinkTaskId {
  return `task:${row.callerId}:${row.callId}` as SessionLinkTaskId
}
