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

export const name = 'tasks-session-link'
export const inject = ['storageDomain', 'sessionLinks']

/**
 * Mount `SessionLinkTaskService` with its read-side probe built from the live
 * link service's public methods (`links.message(id)`; `links.list(sessionId)`
 * rows with `.id`/`.memberIds`). The service's own `static inject =
 * ['storageDomain']` keeps the domain dependency honest; this row adds the
 * link-service wiring a bare `ctx.plugin(SessionLinkTaskService, …)` caller
 * would have to hand-build.
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
  })
}
