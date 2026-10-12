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
 * `session-task-status`, which nothing in the plugin treats as a task.
 * Chain semantics are honest by design: EVERY task's events ride the
 * task's notification root as `inReplyTo`, and that root mints at FIRST
 * intent admission (R18 — `saveTaskIntent`, the deterministic attempt-1
 * delivery identity). Precheck failures, runtime route failures that
 * cleared the binding, and reconcile's repair notices therefore share the
 * task's ONE wake-budget chain instead of minting fresh chains per event
 * that would bypass the per-chain budget on retry; where the root row
 * itself never reached the mailbox (never-bound tasks), the mailbox
 * threads the event to the durable root id it names, so the per-chain
 * accounting's root resolution still attributes every report to the same
 * chain.
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
import { SessionLinkTaskError, TASK_WRITE_FAILED } from './tasks.ts'
import type { SessionLinkTaskService } from './tasks.ts'
import type { SessionLinkTaskId } from './types.ts'

/** The pump one root context owns: scheduled passes plus the serialized chain. */
export interface TaskNotificationPump {
  /** Queue one pump pass; multiple triggers collapse into one scheduled pass. */
  schedule(): void
  /**
   * Queue a cascade pass sharing the current schedule epoch's remaining
   * budget; reaches zero on persistently failing marker writes instead of
   * re-entering unboundedly (review risk 2). The next schedule() re-arms.
   */
  cascade(remaining: number): void
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
 *
 * R14 (MODEL_ROUTING_FIX_PLAN Task 4): the pump also subscribes to the
 * mailbox's own retry-condition signal (`session-link/mailbox`): the link
 * service emits it strictly after durable transitions that can make a
 * previously refused event deliverable — capacity freed (pending →
 * delivered/cancelled/revoked/failed), a receiver taking delivery (a turn
 * claimed/inserted), or grant changes (auto-wake re-granted, link
 * created/updated/removed). An event refused MAILBOX_FULL or denied budget
 * writes nothing and emits nothing, so the feedback settles: every emission
 * maps to a real transition, and a pass that changes nothing retriggers
 * nothing. Single-flight coalescing lives in {@link TaskNotificationPump.schedule}
 * (one scheduled pass absorbs any burst of triggers).
 *
 * Review risk 2 (MODEL_ROUTING_FIX_PLAN Task 5, marker-write failure
 * cascade): a mailbox admission that SUCCEEDED while its durable outbox
 * marker write keeps FAILING must never cascade unboundedly. The cascade
 * budget caps consecutive failure-driven cascades within ONE schedule epoch
 * (see {@link TaskNotificationPump.schedule}); a cascaded pass inherits the
 * remaining budget and a pass that fails only marker writes STOPS — the
 * event honestly stays admitted-not-marker-confirmed, visible in
 * `session_get_task` through the live marker-failure notes, and both the
 * retry-condition subscription and any new schedule() re-arm a full-budget
 * epoch (never a timer/poller).
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
      /* A fresh epoch: the full cascade budget is granted HERE, at the
       * schedule-boundary — a cascaded pass shares its predecessor's budget
       * (the cascade does NOT re-enter schedule()), so a persistently failing
       * marker write caps out instead of re-entering without bound. The next
       * genuine trigger (a durable mailbox transition, a task mutation that
       * schedules the pump) re-arms a full budget: progress never freezes. */
      const run = tail.then(async () => {
        scheduled = false
        await pumpPending(resolve, MARKER_CASCADE_BUDGET, remaining => pump.cascade(remaining))
      }).catch((error: unknown) => {
        ctx.logger?.warn?.(`task-notifications: pump pass failed: ${String(error)}`)
      })
      tail = run.then(() => undefined, () => undefined)
    },
    /** Re-pump from INSIDE a pass with the epoch's remaining budget. */
    cascade(remaining: number): void {
      if (disposed || scheduled || remaining <= 0) return
      scheduled = true
      const run = tail.then(async () => {
        scheduled = false
        await pumpPending(resolve, remaining, rest => pump.cascade(rest))
      }).catch((error: unknown) => {
        ctx.logger?.warn?.(`task-notifications: pump pass failed: ${String(error)}`)
      })
      tail = run.then(() => undefined, () => undefined)
    },
    async drain(): Promise<void> {
      // Run one explicit pass NOW — pending scheduled work settles first,
      // then one fresh full-budget pass reads the live rows so the drain
      // observes any reconciliation the caller's preceding mutations
      // obligated.
      await tail
      const run = tail.then(async () => {
        await pumpPending(resolve, MARKER_CASCADE_BUDGET, () => {})
      }).catch(() => {})
      tail = run.then(() => undefined, () => undefined)
      await tail
    },
  }
  // R14: real retry conditions, wired from the mailbox's own transitions.
  // Each emission is a durable transition, so it legitimately re-arms a
  // full-budget epoch.
  ctx.on('session-link/mailbox', () => {
    pump.schedule()
  })
  ctx.effect(() => async () => {
    disposed = true
    await tail
  }, 'sessionLinkTaskNotifications.close')
  // Restart wipe: reconcile every pending/admitted marker the prior process
  // left, against the mailbox facts durable now.
  pump.schedule()
  return pump
}

/**
 * Maximum consecutive cascade passes ONE schedule epoch tolerates after
 * success-with-failing-marker sequences. A single admission ideally cascades
 * exactly once (marker settles, next pass sees no new writes); anything
 * beyond this bound is a persistently failing durable write — the pump
 * stops and waits for the next genuine trigger instead of re-entering.
 * Small and total: the bound covers the legitimate settle legs of several
 * same-pass admissions without approaching "unbounded".
 */
const MARKER_CASCADE_BUDGET = 4

/**
 * One pass over pending outbox events plus admitted-marker reconciliation.
 * Returns the cascade decision: whether a follow-up pass is needed and the
 * budget it may spend.
 */
async function pumpPending(
  resolve: { tasks: () => SessionLinkTaskService | undefined; links: () => SessionLinkService },
  cascadeBudget: number,
  cascade: (remaining: number) => void,
): Promise<void> {
  const tasks = resolve.tasks()
  if (tasks === undefined) return
  const links = resolve.links()
  let settledMailboxWrite = false
  /** A marker write FAILED durably this pass: re-pumping immediately would
   * re-attempt the same failing write — stop instead (bounded cascade). */
  let markerWriteFailed = false

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
      const live = tasks.getRow(taskId)
      if (live === undefined) continue
      markerWriteFailed = await recordMarkerResult(
        tasks, taskId, event.eventId, live.revision,
        () => tasks.markOutboxDelivered(taskId, live.revision, event.eventId),
      ) || markerWriteFailed
      settledMailboxWrite = !markerWriteFailed || settledMailboxWrite
    }
  }

  // Pass 2: deliver pending events in commit order (revalidating each pair at SEND time).
  for (const { taskId, event } of tasks.pendingOutbox()) {
    const row = tasks.getRow(taskId)
    if (row === undefined) continue
    const linkId = resolveLiveLink(links, row)
    if (linkId === undefined) {
      // Unlinked: a permanent refusal. Keep the event queryable + blocked.
      const blockedFailed = await recordMarkerResult(
        tasks, taskId, event.eventId, row.revision,
        () => tasks.blockOutboxEvent(taskId, row.revision, event.eventId, 'link_revoked: original pair no longer shares a link grant'),
      )
      markerWriteFailed = blockedFailed || markerWriteFailed
      settledMailboxWrite = !blockedFailed || settledMailboxWrite
      continue
    }
    try {
      const sent = await links.admitTaskStatus(reportOf(row, taskId, event, row.notificationRoot.rootMessageId))
      const live = tasks.getRow(taskId)
      if (live !== undefined) {
        /* Mailbox admission committed; its marker is the durable receipt.
         * A durable failure here leaves the event admitted-not-marker-
         * confirmed (honest pending-with-note), visible in session_get_task —
         * the event is NEVER re-admitted with a second mailbox copy because
         * the mailbox's own eventId idempotency makes a re-admission replay
         * its first row, which the marker then adopts. */
        const admittedFailed = await recordMarkerResult(
          tasks, taskId, event.eventId, live.revision,
          () => tasks.markOutboxAdmitted(taskId, live.revision, event.eventId, sent.messageId),
        )
        markerWriteFailed = admittedFailed || markerWriteFailed
        settledMailboxWrite = !markerWriteFailed || settledMailboxWrite
        const after = tasks.getRow(taskId)
        if (after !== undefined && sent.status === 'accepted' && !admittedFailed) {
          markerWriteFailed = await recordMarkerResult(
            tasks, taskId, event.eventId, after.revision,
            () => tasks.markOutboxDelivered(taskId, after.revision, event.eventId),
          ) || markerWriteFailed
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

  /* Cascade exactly once when durable facts changed — the writes above may
   * have settled markers/events the same pass could not yet see. A pass
   * whose marker writes FAILED does not cascade: an immediate re-pass would
   * race the same failing storage write; the event honestly stays
   * admitted-not-marker-confirmed until a genuine retry-condition signal or
   * the next task mutation re-arms a full-budget epoch. */
  if (markerWriteFailed) return
  if (settledMailboxWrite) cascade(cascadeBudget - 1)
}

/**
 * Run one marker write with honest failure classification (review risk 2):
 *
 *  - a STALE CAS means a concurrent projection/marker legitimately advanced
 *    the row — forward progress; nothing is recorded, the pass may cascade;
 *  - a DURABLE write failure means the admission succeeded but its receipt
 *    never persisted. The failure is recorded onto the LATEST task-row
 *    snapshot (best-effort, in-memory; a fresh durable read replaces it) so
 *    `session_get_task` surfaces the event as pending with a visible
 *    marker-write failure `reason` instead of a silent stuck pending, and
 *    the pass refrains from cascading (bounded re-entry).
 *
 * Returns true when a durable failure was observed.
 */
async function recordMarkerResult(
  tasks: SessionLinkTaskService,
  taskId: SessionLinkTaskId,
  eventId: string,
  attemptedRevision: number,
  write: () => Promise<SessionLinkTaskRecordData>,
): Promise<boolean> {
  try {
    await write()
    return false
  } catch (error: unknown) {
    if (error instanceof SessionLinkTaskError && error.code === TASK_WRITE_FAILED) {
      /* Visible failure accounting: note the failure against the exact event
       * and revision the marker attempted (live-only; the note never forges
       * a marker, and clears the moment one lands). */
      tasks.noteOutboxMarkerFailure(taskId, eventId, attemptedRevision, error)
      return true
    }
    /* Concurrent transition (stale revision / illegal lifecycle step): the
     * row legitimately moved on — the next pass reconciles against it. */
    return false
  }
}

/** Derive the task id of one stored row (the service's stable identity). */
function taskIdOf(row: SessionLinkTaskRecordData): SessionLinkTaskId {
  return `task:${row.callerId}:${row.callId}` as SessionLinkTaskId
}
