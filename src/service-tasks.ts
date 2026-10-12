/**
 * Raw-loader sub-plugin that mounts the durable tracked-task service the
 * production way: cordis inject declares BOTH dependencies (`storageDomain`
 * for the task domain, `sessionLinks` for the mailbox/link probe), and the
 * service lands on `ctx.sessionLinkTasks` through cordis' own service
 * registration — never through a test-only `Object.defineProperty` escape.
 * Named exports (`name`/`inject`/`apply`) mirror the `dsh-session-link/tools`
 * and `dsh-session-link/command` row modules the loader already consumes.
 * @module dsh-session-link/tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLinkTaskService } from './tasks.ts'
import { ensureTaskHostLazy } from './task-host-lazy.ts'

export const name = 'tasks-session-link'
export const inject = ['storageDomain', 'sessionLinks']

/**
 * Mount `SessionLinkTaskService` with its read-side probe built from the live
 * link service's public methods (`links.message(id)`; `links.list(sessionId)`
 * rows with `.id`/`.memberIds`). The service's own `static inject =
 * ['storageDomain']` keeps the domain dependency honest; this row adds the
 * link-service wiring a bare `ctx.plugin(SessionLinkTaskService, …)` caller
 * would have to hand-build.
 *
 * R03/R08 (MODEL_ROUTING_FIX_PLAN Task 3): the decision-time side facts the
 * durable service itself must never perform (mailbox revocation, host intent
 * cancel, legacy-delivery marking) are wired here through capsule closures so
 * a bare test mount keeps the honest no-hook default: the decision commits
 * durably first, the revocation follows best-effort, and the activation
 * gates reading the terminal row stay the execution authority either way.
 *
 * @param ctx - host context carrying the storage domain and the link service.
 */
export async function apply(ctx: Context): Promise<void> {
  const links = ctx.sessionLinks
  await ctx.plugin(SessionLinkTaskService, {
    links: {
      message: messageId => links.message(messageId),
      pairLinked: (linkId, first, second) =>
        links.list(first).some(link => link.id === linkId && link.memberIds.includes(second)),
    },
    // R03: cancel → revoke the un-consumed mailbox delivery + host intent.
    revokeDelivery: (_taskId, row) => {
      void (async () => {
        const messageId = row.execution.messageId
        if (messageId !== undefined) {
          const record = links.message(messageId)
          if (record?.status === 'pending') await links.cancel(undefined, messageId).catch(() => {})
        }
        const intentId = row.execution.turnIntentId
        const targetId = row.execution.sessionId ?? row.targetSessionId ?? row.spawn?.targetSessionId
        if (intentId === undefined || targetId === undefined) return
        const agent = ctx.agents.get(targetId)
        if (agent === undefined) return
        const host = await ensureTaskHostLazy(agent).catch(() => undefined)
        if (host === undefined) return
        try { await host.cancelTurnIntent(intentId, 'resolve_task onset cancel') } catch { /* already settled */ }
      })()
    },
    // R08(1): retry → mark the previous attempt's legacy delivery consumed.
    markLegacyDelivery: messageId => {
      const record = links.message(messageId)
      if (record === undefined || record.idempotencyKey === undefined) return
      if (record.status === 'pending') {
        // A never-consumed retry delivery cancels durably (the cancel path
        // keeps it from ever executing); the consumed realm rekeys below.
        void links.cancel(undefined, messageId).catch(() => {})
        return
      }
      void links.markRetried(messageId, `${record.idempotencyKey}/consumed`).catch(() => {})
    },
  })
}
