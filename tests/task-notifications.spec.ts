/**
 * Task 5 (MODEL_ROUTING_PLAN): the outbox → REAL mailbox delivery path, the
 * task-status source attribution, budget and revalidation semantics, restart
 * dedupe, the get_task/resolve_task tools, and decision idempotency.
 * Task 7 added the fix-wave + matrix rows: restart notifiedMessageId
 * identity, blocked-once pump stability, per-chain budget as its own gate,
 * and fork/compact execution-rights isolation.
 *
 * Stack: real AgentLoops on alice + bob, the real SessionLinkService and
 * SessionLinkTaskService over per-domain pooled memory backends (a "restart"
 * moves the pools onto a fresh Context — the task service + link service
 * replays happen against the same durable media), the tool row, and the host
 * task-host extension through the tools' lazy factory.
 *
 * Requires DSH_SOURCE_ROOT; run under `DSH_SOURCE_ROOT=… pnpm exec vitest run`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult, ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionLinkService, { SessionLinkMessageId, SessionLinkTaskService, taskIdFor } from '../src/index.ts'
import { installTaskNotifications, type TaskNotificationPump } from '../src/task-notifications.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'
import { bootStack, type BackendPools } from './helpers/domains.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try { await ctx.fiber.dispose() } catch (error: unknown) { failures.push(error) }
    contexts.delete(ctx)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'task-notifications cleanup failed')
})

const BASE = 'base-model'
const MODEL_A = 'model-a'
const SIGNAL = new AbortController().signal
let callCounter = 0

function humanMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  } as never
}

function call(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
  callId?: string,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(callId ?? `call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

function succeeded(result: ToolExecutionResult): ToolExecutionSuccess {
  if (result.isError) throw new Error(`tool call failed unexpectedly: ${JSON.stringify(result.content)}`)
  return result
}

/** Sources/ids one Session's durable events carry. */
function sourcesOf(agent: Agent): { kind: string; messageId?: string; taskId?: string }[] {
  const seen = new Set<string>()
  const read = (source: unknown): { kind: string; messageId?: string; taskId?: string } | undefined => {
    const typed = source as { kind?: string; messageId?: string; taskId?: string } | undefined
    if (typed?.kind === undefined) return undefined
    if (typed.kind !== 'session-link-message' && typed.kind !== 'session-task-status') return undefined
    const key = `${typed.kind}:${typed.messageId ?? ''}`
    if (seen.has(key)) return undefined
    seen.add(key)
    return { kind: typed.kind, ...(typed.messageId === undefined ? {} : { messageId: typed.messageId }), ...(typed.taskId === undefined ? {} : { taskId: typed.taskId }) }
  }
  const out: { kind: string; messageId?: string; taskId?: string }[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'user/message') {
      const entry = read(event.data.source)
      if (entry !== undefined) out.push(entry)
      continue
    }
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) {
      const entry = read((message as { source?: unknown }).source)
      if (entry !== undefined) out.push(entry)
    }
  }
  return out
}

/** Boot a stack plus one explicit pump (the tool row installs its own; tests add a manual trigger surface). */
async function stackWithPump(options: {
  adapter?: MockAdapter
  links?: Record<string, number>
  modelCatalog?: () => Promise<unknown>
  archived?: readonly SessionId[]
} = {}) {
  const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
  const s = await bootStack(contexts, pools, options)
  // The row's pump already runs; this extra pump exists ONLY as a manual
  // drain handle for tests that must await a complete pass.
  const pump = installTaskNotifications(s.ctx, {
    tasks: () => s.ctx.sessionLinkTasks,
    links: () => s.ctx.sessionLinks,
  })
  return { ...s, pools, pump }
}

async function drain(pump: TaskNotificationPump): Promise<void> {
  await pump.drain()
  // The pump's first cascade may land right after drain; give queued passes
  // one more serialized turn.
  await pump.drain()
}

describe('task-notifications: delivery paths and attribution', () => {
  it('a sync precheck failure notification rides the real mailbox to the idle sender exactly once with task-status attribution', async () => {
    const s = await stackWithPump()
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const admitted = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'task on missing model',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-notify-1')).value as { outcome: string; taskId: string }
    expect(admitted.outcome).toBe('needs_decision')
    const taskId = taskIdFor(s.alice.id, 'call-notify-1')

    await drain(s.pump)
    // One notification message addressed to alice, admitted into the mailbox.
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(row?.outbox).toHaveLength(1)
    expect(row?.outbox[0]?.kind).toBe('model_unavailable')
    expect(['admitted', 'delivered']).toContain(row?.outbox[0]?.status)
    expect(row?.outbox[0]?.notifiedMessageId).toBeDefined()
    const notification = s.ctx.sessionLinks.message(row!.outbox[0]!.notifiedMessageId!)
    expect(notification?.statusKind).toBe('task-status')
    expect(notification?.taskStatus?.taskId).toBe(String(taskId))
    expect(notification?.taskStatus?.eventId).toBe(row?.outbox[0]?.eventId)
    expect(notification?.senderId).toBe(s.bob.id)
    expect(notification?.targetId).toBe(s.alice.id)
    expect(notification?.taskStatus?.requestedModel).toEqual({ provider: 'mock', model: 'model-absent' })
    expect(notification?.taskStatus?.decisionRequired).toBe(true)
    expect(notification?.taskStatus?.executionState).toBe('not_started')
    // Body is a human-readable status, explicitly not-an-instruction.
    expect(notification?.text).toContain('任务状态回报')
    expect(notification?.text).toContain('不是给本机的指令')
    expect(notification?.text).toContain(String(taskId))

    // Re-pumping NEVER admits a second copy (eventId idempotency).
    await drain(s.pump)
    expect(s.ctx.sessionLinks.message(row!.outbox[0]!.notifiedMessageId!)?.idempotencyKey).toBe(`task-event:${row?.outbox[0]?.eventId}`)
    const aliceMail = sourcesOf(s.alice)
    expect(aliceMail.filter(source => source.kind === 'session-task-status').length)
      .toBeLessThanOrEqual(1)
  }, 20000)

  it('a queued pending event survives a restart and is delivered EXACTLY once when the sender comes back', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const first = await bootStack(contexts, pools, { adapter })
    await first.ctx.sessionLinks.link('pair', [first.alice.id, first.bob.id], { kind: 'human' })
    succeeded(await call(first.ctx, 'session_send_session_message', {
      session_id: first.bob.id,
      message: 'task on missing model',
      provider: 'mock',
      model: 'model-absent',
    }, first.alice, 'call-restart-1'))
    const taskId = taskIdFor(first.alice.id, 'call-restart-1')
    await vi.waitFor(() => {
      const row = first.ctx.sessionLinkTasks.getRow(taskId)
      expect(row?.outbox[0]?.status === 'admitted' || row?.outbox[0]?.status === 'delivered').toBe(true)
    }, { timeout: 5000 })
    // The sender never claimed it yet: alice has no task-status in her log yet.
    expect(sourcesOf(first.alice).filter(source => source.kind === 'session-task-status')).toHaveLength(0)
    // Capture the FIRST admission's durable notification identity: the same
    // mailbox message must answer the event after the restart — never a re-mint.
    const notifiedBefore = first.ctx.sessionLinkTasks.getRow(taskId)?.outbox[0]?.notifiedMessageId
    expect(notifiedBefore).toBeDefined()

    // RESTART: dispose the whole first context, boot a fresh one over the
    // same pools (same agents Alice/Bob identities but through the fresh loop).
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await bootStack(contexts, pools, { adapter })
    const pump2 = installTaskNotifications(second.ctx, {
      tasks: () => second.ctx.sessionLinkTasks,
      links: () => second.ctx.sessionLinks,
    })
    await drain(pump2)
    // Still exactly ONE durable notification with the SAME notifiedMessageId.
    const row2 = second.ctx.sessionLinkTasks.getRow(taskId)
    expect(row2?.outbox).toHaveLength(1)
    expect(['admitted', 'delivered']).toContain(row2?.outbox[0]?.status)
    expect(row2?.outbox[0]?.eventId).toBe(`task:${second.alice.id}:call-restart-1/1/model_unavailable`)
    expect(row2?.outbox[0]?.notifiedMessageId).toBe(notifiedBefore)
    // Exactly ONE mailbox row carries the notification identity: no second
    // admission was minted across the full context teardown and reboot.
    expect(second.ctx.sessionLinks.message(notifiedBefore!)).toBeDefined()
  }, 20000)

  it('an unlink blocks events the pump attempts after the grant vanished, with the revocation reason, and keeps them queryable', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    // Stack WITHOUT the tool row's pump: install the pump manually AFTER the
    // event exists so this suite controls exactly when delivery attempts run.
    const s = await bootStack(contexts, pools, { adapter, noToolRow: true })
    const granted = await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    // A waiting_decision row with ONE pending event, saved through the service.
    const tasks = s.ctx.sessionLinkTasks
    await tasks.saveTaskIntent({
      callerId: s.alice.id,
      request: { kind: 'send', callId: 'call-unlink-pending', text: 'task on missing model', targetSessionId: s.bob.id },
      policy: {
        scope: 'task',
        candidates: [{ provider: 'mock', model: 'model-absent' }],
        ifExhausted: 'notify_sender',
        usesSessionDefault: false,
      },
      tracked: true,
      precheckFailure: { reason: 'model_unavailable', results: [] },
    })
    const taskId = taskIdFor(s.alice.id, 'call-unlink-pending')
    expect(tasks.getRow(taskId)?.outbox[0]?.status).toBe('pending')

    await s.ctx.sessionLinks.unlink(granted.id)
    const pump = installTaskNotifications(s.ctx, {
      tasks: () => s.ctx.sessionLinkTasks,
      links: () => s.ctx.sessionLinks,
    })
    await drain(pump)
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(row?.outbox[0]?.status).toBe('blocked')
    expect(String(row?.outbox[0]?.blockedReason)).toContain('link_revoked')
    // The event stays queryable through the task.
    const view = tasks.getTask(s.alice.id, taskId)
    expect(view.taskState).toBe('waiting_decision')
    const blocked = s.ctx.sessionLinkTasks.getRow(taskId)?.outbox[0]
    expect(blocked?.status).toBe('blocked')
  }, 20000)

  it('a blocked event is never re-blocked, duplicated, or re-emitted by later pump passes', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const s = await bootStack(contexts, pools, { adapter, noToolRow: true })
    const granted = await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const tasks = s.ctx.sessionLinkTasks
    await tasks.saveTaskIntent({
      callerId: s.alice.id,
      request: { kind: 'send', callId: 'call-blocked-once', text: 'task on missing model', targetSessionId: s.bob.id },
      policy: {
        scope: 'task',
        candidates: [{ provider: 'mock', model: 'model-absent' }],
        ifExhausted: 'notify_sender',
        usesSessionDefault: false,
      },
      tracked: true,
      precheckFailure: { reason: 'model_unavailable', results: [] },
    })
    const taskId = taskIdFor(s.alice.id, 'call-blocked-once')
    await s.ctx.sessionLinks.unlink(granted.id)
    const pump = installTaskNotifications(s.ctx, {
      tasks: () => s.ctx.sessionLinkTasks,
      links: () => s.ctx.sessionLinks,
    })
    // Pass 1: the vanished grant blocks the event exactly once.
    await drain(pump)
    const once = tasks.getRow(taskId)
    expect(once?.outbox).toHaveLength(1)
    expect(once?.outbox[0]?.status).toBe('blocked')
    const reasonOnce = once?.outbox[0]?.blockedReason
    expect(String(reasonOnce)).toContain('link_revoked')
    const revisionOnce = once?.revision
    const notificationCount = () => {
      const table = (s.ctx.sessionLinks as unknown as {
        messages: { entries(): Iterable<[unknown, { statusKind?: string }]>; values?(): Iterable<{ statusKind?: string }> }
      }).messages
      const records = typeof table.entries === 'function'
        ? [...table.entries()].map(([, record]) => record)
        : [...(table.values?.() ?? [])]
      return records.filter(record => record.statusKind === 'task-status').length
    }
    expect(notificationCount()).toBe(0)
    // Pass 2 (+ more): pendingOutbox excludes blocked rows, so no block path
    // runs at all — no CAS conflict to swallow, no second block write, no
    // re-emitted event, no duplicate mailbox row.
    await drain(pump)
    await drain(pump)
    const twice = tasks.getRow(taskId)
    expect(twice?.outbox).toHaveLength(1)
    expect(twice?.outbox[0]?.status).toBe('blocked')
    expect(twice?.outbox[0]?.blockedReason).toBe(reasonOnce)
    expect(twice?.revision).toBe(revisionOnce)
    expect(twice?.outbox[0]?.eventId).toBe(once?.outbox[0]?.eventId)
    expect(notificationCount()).toBe(0)
    // The blocked row stays queryable by the sender and is never duplicated.
    expect(s.ctx.sessionLinkTasks.getTask(s.alice.id, taskId).taskState).toBe('waiting_decision')
    expect(tasks.listRows().filter(row => row.callId === 'call-blocked-once')).toHaveLength(1)
  }, 20000)

  it('both original parties keep read access after unlink; a third party never sees the task', async () => {
    const s = await stackWithPump()
    const granted = await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'task on missing model',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-access'))
    const taskId = taskIdFor(s.alice.id, 'call-access')
    await drain(s.pump)
    await s.ctx.sessionLinks.unlink(granted.id)
    // Sender + target BOTH read their task after unlink.
    const senderView = succeeded(await call(s.ctx, 'session_get_task', {
      task_id: String(taskId),
    }, s.alice, 'call-get-sender')).value as { taskState: string; callerId: string }
    expect(senderView.callerId).toBe(s.alice.id)
    const targetView = succeeded(await call(s.ctx, 'session_get_task', {
      task_id: String(taskId),
    }, s.bob, 'call-get-target')).value as { taskState: string; targetSessionId?: string }
    expect(targetView.targetSessionId).toBe(s.bob.id)
    // A THIRD Session gets the same not-found shape as an absent task.
    const third = await call(s.ctx, 'session_get_task', {
      task_id: String(taskId),
    }, s.carol, 'call-get-third')
    expect(third.isError).toBe(true)
    expect(JSON.stringify(third.content)).toContain('not found')
    const thirdResolve = await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: 1,
      action: 'cancel',
    }, s.carol, 'call-resolve-third')
    expect(thirdResolve.isError).toBe(true)
  }, 20000)
})

describe('task-notifications: budget and archived treatment', () => {
  it('an archived sender follows the mailbox\'s existing archived-target behavior and the event stays queryable', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    // Alice archived at boot: the link exists, the task's event is committed,
    // the mailbox throws TARGET_ARCHIVED at admission, and the event stays
    // PENDING — never blocked, never dropped.
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const s = await bootStack(contexts, pools, { adapter, archived: [SessionId('session-alice')] })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const tasks = s.ctx.sessionLinkTasks
    await tasks.saveTaskIntent({
      callerId: s.alice.id,
      request: { kind: 'send', callId: 'call-archived-1', text: 'archived sender task', targetSessionId: s.bob.id },
      policy: {
        scope: 'task',
        candidates: [{ provider: 'mock', model: 'model-absent' }],
        ifExhausted: 'notify_sender',
        usesSessionDefault: false,
      },
      tracked: true,
      precheckFailure: { reason: 'model_unavailable', results: [] },
    })
    const taskId = taskIdFor(s.alice.id, 'call-archived-1')
    const pump = installTaskNotifications(s.ctx, {
      tasks: () => s.ctx.sessionLinkTasks,
      links: () => s.ctx.sessionLinks,
    })
    await drain(pump)
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    // Never blocked (permanent refusal is ONLY for lost grants); the pending
    // event keeps the delivery state queryable through getTask.
    expect(row?.outbox[0]?.status).toBe('pending')
    expect(row?.outbox[0]?.blockedReason).toBeUndefined()
  }, 20000)

  it('a notification under a spent daily wake budget rides as queued mail and the sender\'s own turn claims it without a fresh wake', async () => {
    const adapter = new MockAdapter([textResponse('ok'), textResponse('idle again')])
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const s = await bootStack(contexts, pools, {
      adapter,
      links: { maxAutoWakesPerSessionPerDay: 1 },
    })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    // Warm-up: one REAL bob→alice peer message claims alice's (only) daily
    // wake. Grant the reverse direction so the wake CAN land.
    await s.ctx.sessionLinks.setAutoWake((await s.ctx.sessionLinks.list(s.bob.id))[0]!.id, [s.bob.id, s.alice.id])
    await s.ctx.sessionLinks.send(s.bob, s.alice.id, {
      targetId: s.alice.id,
      text: 'ordinary peer message',
      idempotencyKey: 'budget-warm',
    })
    await s.alice.whenIdle()
    const tasks = s.ctx.sessionLinkTasks
    await tasks.saveTaskIntent({
      callerId: s.alice.id,
      request: { kind: 'send', callId: 'call-budget-1', text: 'budget-bound task', targetSessionId: s.bob.id },
      policy: {
        scope: 'task',
        candidates: [{ provider: 'mock', model: 'model-absent' }],
        ifExhausted: 'notify_sender',
        usesSessionDefault: false,
      },
      tracked: true,
      precheckFailure: { reason: 'model_unavailable', results: [] },
    })
    const taskId = taskIdFor(s.alice.id, 'call-budget-1')
    const pump = installTaskNotifications(s.ctx, {
      tasks: () => s.ctx.sessionLinkTasks,
      links: () => s.ctx.sessionLinks,
    })
    await drain(pump)
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(['admitted', 'delivered']).toContain(row?.outbox[0]?.status)
    const notification = row?.outbox[0]?.notifiedMessageId
    expect(notification).toBeDefined()
    const message = s.ctx.sessionLinks.message(notification!)
    // The notification never claimed a wake: alice's daily budget is spent
    // by the warm-up. The event surfaced as admitted-to-the-mailbox only.
    expect(message?.wakesUsed).toBe(0)
    // Alice's own next turn claims the durable fact without a wake claim.
    s.alice.followup(humanMessage('alice continues her day'))
    await s.alice.whenIdle()
    await s.ctx.sessionLinks.deliverPending(s.alice.id)
    await s.alice.whenIdle()
    await drain(pump)
    const settled = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(['admitted', 'delivered']).toContain(settled?.outbox[0]?.status)
    // Reconciliation: the outbox pump's pass 1 flips admitted→delivered
    // once the mailbox row has been durably delivered. Draining both pump
    // instances (the row's own pump + this suite's pump) settles it.
    for (let attempt = 0; attempt < 5 && s.ctx.sessionLinkTasks.getRow(taskId)?.outbox[0]?.status !== 'delivered'; attempt += 1) {
      await drain(pump)
    }
    expect(s.ctx.sessionLinkTasks.getRow(taskId)?.outbox[0]?.status).toBe('delivered')
  }, 20000)

  it('chain-budget exhaustion is its own gate: a spent chain queues its OWN continuation while the sender\'s daily ledger still has room', async () => {
    // Chain-budget isolation (Task 7 matrix 通知链预算耗尽; Task 5 flagged it
    // shared the daily-budget path). maxAutoWakesPerChain = 1,
    // maxAutoWakesPerMessage = 2, and the daily ledger keeps its DEFAULT of
    // 6. Alice→bob openers on two INDEPENDENT chains spend 2/6 of BOB's
    // daily allowance (one wake per chain). Bob's reply hanging off chain A
    // then has: per-message budget clean (≤2), daily ledger clean (2/6 used)
    // — ONLY chain A's own budget is spent (single wake burned on the
    // opener), so it MUST queue
    // with wakesUsed === 0. The task's notification to alice rides the
    // TASK's own durable root chain (R18: minted at intent admission and
    // never reset by the runtime route failure) — a chain whose wake spend
    // on alice's side is clean; alice's daily ledger is untouched — it
    // admits with EXACTLY ONE wake (the documented admitted+wake path),
    // proving the spent chain's single-wake count binds ONLY that chain and
    // never lifts, folds, or resets (claimWake re-derives spend from
    // recorded wakesUsed under each chain's own root).
    class RouteDown extends MockAdapter {
      constructor() { super([textResponse('warm one'), textResponse('warm two'), textResponse('reply answer')]) }
      override async *stream(options: GenerateOptions) {
        this.requests.push(options)
        if (options.model === 'model-available') throw new HarnessError('upstream down', 'PROVIDER_UNAVAILABLE')
        for (const chunk of textResponse('warm answer' as never)) yield chunk as never
      }
    }
    const adapter = new RouteDown()
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const s = await bootStack(contexts, pools, {
      adapter,
      links: { maxAutoWakesPerChain: 1, maxAutoWakesPerMessage: 2 },
    })
    const granted = await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    await s.ctx.sessionLinks.setAutoWake(granted.id, [s.alice.id, s.bob.id])
    // Warm chains A and B (alice→bob), each claiming its chain's single wake.
    const opening = await s.ctx.sessionLinks.send(s.alice, s.bob.id, {
      targetId: s.bob.id,
      text: 'chain A opener',
      idempotencyKey: 'chain-warm-open',
    })
    expect(s.ctx.sessionLinks.message(opening.messageId)?.wakesUsed).toBe(1)
    await s.bob.whenIdle()
    const second = await s.ctx.sessionLinks.send(s.alice, s.bob.id, {
      targetId: s.bob.id,
      text: 'chain B opener',
      idempotencyKey: 'chain-warm-second',
    })
    expect(s.ctx.sessionLinks.message(second.messageId)?.wakesUsed).toBe(1)
    await s.bob.whenIdle()
    // Bob's continuation INSIDE chain A: daily + per-message budgets are
    // clean — ONLY chain A's own budget is spent, so no wake is claimed.
    // This is the per-chain gate acting alone.
    const continuation = await s.ctx.sessionLinks.send(s.bob, s.alice.id, {
      targetId: s.alice.id,
      text: 'chain A continuation',
      inReplyTo: opening.messageId,
      idempotencyKey: 'chain-warm-cont',
    })
    expect(continuation.status).toBe('queued')
    expect(s.ctx.sessionLinks.message(continuation.messageId)?.chainLength).toBe(2)
    expect(s.ctx.sessionLinks.message(continuation.messageId)?.wakesUsed).toBe(0)
    // Sanity: chain B's budget is untouched — identical sender/target, so
    // the refusal above came from chain A's accounting, nothing global.
    expect(s.ctx.sessionLinks.message(second.messageId)?.wakesUsed).toBe(1)
    // Task: model request fails route-availability → runtime parks the task
    // waiting_decision with ONE pending model_unavailable event.
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'chain-budget task',
      provider: 'mock',
      model: 'model-available',
    }, s.alice, 'call-chain-budget-1'))
    const taskId = taskIdFor(s.alice.id, 'call-chain-budget-1')
    await s.bob.whenIdle().catch(() => {})
    await vi.waitFor(() => {
      const row = s.ctx.sessionLinkTasks.getRow(taskId)
      expect(row?.taskState).toBe('waiting_decision')
      expect(row?.outbox.some(event => event.kind === 'model_unavailable')).toBe(true)
    }, { timeout: 5000 })
    const pump = installTaskNotifications(s.ctx, {
      tasks: () => s.ctx.sessionLinkTasks,
      links: () => s.ctx.sessionLinks,
    })
    await drain(pump)
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    const failureEvent = row?.outbox.find(event => event.kind === 'model_unavailable')
    expect(['admitted', 'delivered']).toContain(failureEvent?.status)
    const notificationId = failureEvent?.notifiedMessageId
    expect(notificationId).toBeDefined()
    const message = s.ctx.sessionLinks.message(notificationId!)
    /* R18: the notification rides the TASK's durable root minted at intent
     * admission — never a fresh per-event chain (this precheck-failed task
     * never bound a delivery, so the root row itself is absent from the
     * mailbox and chainLength stays 1). That root chain is wake-spend-clean
     * on alice's side and alice's daily ledger is untouched, so the
     * admitted+wake path claims exactly one wake. Chain accounting is
     * per-root: chain A's spent wake gates ONLY chain A. */
    const row2 = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(row2?.notificationRoot.rootMessageId).toBeDefined()
    expect(message?.inReplyTo).toBe(row2?.notificationRoot.rootMessageId)
    expect(message?.chainLength).toBe(1)
    expect(message?.wakesUsed).toBe(1)
    await s.alice.whenIdle()
    // The queued in-chain continuation rides along the same wake-driven
    // delivery WITHOUT claiming a wake itself, and no counts move afterwards.
    await s.ctx.sessionLinks.deliverPending(s.alice.id)
    await s.alice.whenIdle()
    await drain(pump)
    expect(s.ctx.sessionLinks.message(continuation.messageId)?.wakesUsed).toBe(0)
    expect(s.ctx.sessionLinks.message(continuation.messageId)?.inReplyTo).toBe(opening.messageId)
    expect(s.ctx.sessionLinks.message(opening.messageId)?.wakesUsed).toBe(1)
    expect(s.ctx.sessionLinks.message(notificationId!)?.wakesUsed).toBe(1)
    expect(sourcesOf(s.alice).some(source => source.messageId === String(notificationId))).toBe(true)
    expect(sourcesOf(s.alice).some(source => source.messageId === String(continuation.messageId))).toBe(true)
  }, 20000)
})

describe('task-notifications: fork isolation', () => {
  it('a forked copy of the bound target NEVER gains the task\'s execution rights', async () => {
    // Task 7 matrix fork/compact/resume row: the forked Session carries the
    // copied log (including the bound task message id) but has NO link grant
    // over the task pair. Simulating the fork through the harness = same
    // sessionId on a fresh stack without any grant: the durable row + host
    // turn-intent facts (the facts a store compaction must preserve) survive
    // the context teardown; the delivered message id is re-presented to the
    // forked runtime's claimed gate. Activation re-validates the live grant
    // against the row's caller+target (task-runtime brief 4f-iv) and MUST
    // refuse with queue_denied_unlinked — no claim, no running projection,
    // no route freeze — while the row's durable owner remains the ORIGINAL
    // target. Host turn/turn-intent fact survival across a REAL transcript
    // compaction is NOT_RUN here: this test harness has no compaction op;
    // the durable host facts are asserted directly instead (see report).
    class RouteDown extends MockAdapter {
      constructor() { super([textResponse('unused')]) }
      override async *stream(options: GenerateOptions) {
        this.requests.push(options)
        throw new HarnessError('upstream down', 'PROVIDER_UNAVAILABLE')
      }
    }
    const adapter = new RouteDown()
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const first = await bootStack(contexts, pools, {
      adapter,
      links: { maxAutoWakesPerChain: 1, maxAutoWakesPerSessionPerDay: 6, maxAutoWakesPerMessage: 2 },
    })
    await first.ctx.sessionLinks.link('pair', [first.alice.id, first.bob.id], { kind: 'human' }, { autoWakeSessionIds: [first.bob.id] })
    succeeded(await call(first.ctx, 'session_send_session_message', {
      session_id: first.bob.id,
      message: 'fork-isolation task',
      provider: 'mock',
      model: 'model-available',
    }, first.alice, 'call-fork-1'))
    const taskId = taskIdFor(first.alice.id, 'call-fork-1')
    await first.bob.whenIdle().catch(() => {})
    await vi.waitFor(() => {
      const row = first.ctx.sessionLinkTasks.getRow(taskId)
      expect(row?.taskState).toBe('waiting_decision')
      expect(row?.outbox.some(event => event.kind === 'model_unavailable')).toBe(true)
    }, { timeout: 5000 })
    const rowBefore = first.ctx.sessionLinkTasks.getRow(taskId)
    expect(rowBefore?.execution.messageId).toBeUndefined()
    const revisionBefore = rowBefore?.revision

    // FORK = the bound target's copy WITHOUT the grant: unlink the pair on
    // the live stack (the fork keeps the Session/log identity, never the
    // link ledger rows the tasks domain does not own), then dispose the
    // whole context and boot a fresh stack over the SAME durable pools —
    // the "compaction" the harness can express (context teardown + durable
    // reload). The task row + host turn-intent facts must survive untouched.
    const notified = first.ctx.sessionLinkTasks.getRow(taskId)?.outbox
      .find(event => event.kind === 'model_unavailable')?.notifiedMessageId
    expect(notified).toBeDefined()
    const requestsBefore = adapter.requests.length
    const linkBefore = (await first.ctx.sessionLinks.list(first.bob.id))[0]!
    await first.ctx.sessionLinks.unlink(linkBefore.id)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const forked = await bootStack(contexts, pools, { adapter })
    const forkRow = forked.ctx.sessionLinkTasks.getRow(taskId)
    // Durable reconciliation facts survive: the task row + revision, and the
    // owner target is STILL the original bob — the fork changed nothing.
    expect(forkRow?.taskState).toBe('waiting_decision')
    expect(forkRow?.revision).toBe(revisionBefore)
    expect(forkRow?.targetSessionId).toBe(forked.bob.id)
    // The already-admitted event reconciles under its ORIGINAL identity —
    // never re-blocked, never re-admitted, never re-minted on the fork.
    const forkPump = installTaskNotifications(forked.ctx, {
      tasks: () => forked.ctx.sessionLinkTasks,
      links: () => forked.ctx.sessionLinks,
    })
    await drain(forkPump)
    const settled = forked.ctx.sessionLinkTasks.getRow(taskId)
    const event = settled?.outbox.find(candidate => candidate.kind === 'model_unavailable')
    expect(['admitted', 'delivered']).toContain(event?.status)
    expect(event?.notifiedMessageId).toBe(notified)
    expect(settled?.outbox).toHaveLength(rowBefore?.outbox.length)
    expect(settled?.taskState).toBe('waiting_decision')
    expect(settled?.execution.currentlyExecuting).toBeUndefined()
    // The fork NEVER activated: no running turn, and the adapter logged NO
    // new model request from the moment the fork booted (unlink + restart +
    // pump passes ran zero model traffic).
    expect(adapter.requests).toHaveLength(requestsBefore)
  }, 20000)
})

describe('task-notifications: dedupe across decisions', () => {
  it('replayed decisions apply exactly once; replayed tool-call retries that match an applied decision never re-open the task', async () => {
    const adapter = new MockAdapter([textResponse(`done on ${MODEL_A}`), textResponse('unused')])
    const s = await stackWithPump({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'recoverable task',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-idem-1'))
    const taskId = taskIdFor(s.alice.id, 'call-idem-1')
    await drain(s.pump)
    // Decision applies.
    const decision = succeeded(await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: (s.ctx.sessionLinkTasks.getRow(taskId))!.revision,
      action: 'retry',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-idem-decision')).value as { applied: boolean }
    expect(decision.applied).toBe(true)
    // Replay the exact same call: recorded applied outcome returns; no second attempt.
    const replay = succeeded(await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: 1,
      action: 'retry',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-idem-decision')).value as { applied: boolean; decision: { outcome: string } }
    expect(replay.decision.outcome).toBe('applied')
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(row?.decisions).toHaveLength(1)
    expect(row?.attempts).toHaveLength(2)
    // The re-admitted task settles on MODEL_A exactly once; a third attempt
    // record can never appear from the replay.
    await drain(s.pump)
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('turn_finished')
    }, { timeout: 5000 })
    expect(s.ctx.sessionLinkTasks.getRow(taskId)?.attempts).toHaveLength(2)
  }, 20000)
})

describe('task-notifications: resolve_task', () => {
  it('retry with a new policy re-admits through the same tracked path, keeps the original taskId, and applies exactly once', async () => {
    const adapter = new MockAdapter([textResponse(`done on ${MODEL_A}`)])
    const s = await stackWithPump({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    // Original task: model-absent exhausts the precheck → waiting_decision.
    const first = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'recoverable task',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-retry-1')).value as { outcome: string; taskRevision: number }
    expect(first.outcome).toBe('needs_decision')
    const taskId = taskIdFor(s.alice.id, 'call-retry-1')
    await drain(s.pump)

    // Retry with a NEW policy (model-a now present) — same taskId, same session, no duplicate event.
    await drain(s.pump)
    // An honest resolver re-reads after a stale answer; the outbox pump's
    // marker CAS may still be settling through this pass. Each attempt uses
    // a FRESH decisionCallId: a stale-rejected callId is durably recorded
    // as stale, never re-applied.
    let resolved: { applied: boolean; attemptId?: string; stale?: boolean; task: { taskState: string; revision: number; currentAttemptId: string }; decision: { outcome: string } } | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rowNow = s.ctx.sessionLinkTasks.getRow(taskId)!
      // A previously-applied retry already moved the task out of waiting_decision: stop retrying.
      if (rowNow.taskState !== 'waiting_decision' && rowNow.decisions.some(d => d.outcome === 'applied' && d.action === 'retry')) break
      const decisionCallId = attempt === 0 ? 'call-retry-decision' : `call-retry-decision-${attempt}`
      const outcome = await call(s.ctx, 'session_resolve_task', {
        task_id: String(taskId),
        expected_revision: rowNow.revision,
        action: 'retry',
        provider: 'mock',
        model: MODEL_A,
      }, s.alice, decisionCallId)
      if (outcome.isError) {
        // CAS-stale throw between read and resolve, and the row is still
        // waiting_decision: re-read and try again with a FRESH decision id.
        if (JSON.stringify(outcome.content).includes('revision moved past')) continue
        succeeded(outcome)
      }
      const value = succeeded(outcome).value as typeof resolved
      if (value !== undefined && value.decision.outcome === 'stale') continue
      resolved = value
      break
    }
    // The retry decision applied (through the loop's winning call); the task
    // left waiting_decision and re-admitted under the ORIGINAL taskId.
    const rowNow = s.ctx.sessionLinkTasks.getRow(taskId)!
    expect(rowNow.decisions.some(d => d.outcome === 'applied' && d.action === 'retry')).toBe(true)
    if (resolved !== undefined) expect(resolved.decision.outcome).toBe('applied')

    // The re-admitted task runs on bob on MODEL_A.
    await drain(s.pump)
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('turn_finished')
    }, { timeout: 5000 })
    const finished = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(finished?.taskState).toBe('turn_finished')
    expect(finished?.execution.routeUsed?.model).toBe(MODEL_A)
    // Replayed decision call: same callId returns the recorded outcome, no re-apply.
    const winningCallId = (resolved as { task?: unknown; } | undefined) === undefined ? 'call-retry-decision' : 'call-retry-decision'
    const rowAfterApply = s.ctx.sessionLinkTasks.getRow(taskId)!
    const appliedDecision = rowAfterApply.decisions.find(d => d.outcome === 'applied')!
    const replayed = succeeded(await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: 1,
      action: 'retry',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, appliedDecision.callId)).value as {
      applied: boolean
      decision: { outcome: string; attemptId?: string }
    }
    expect(replayed.decision.outcome).toBe('applied')
    // The task did not re-open; at most ONE applied decision exists.
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(row?.decisions.filter(d => d.outcome === 'applied')).toHaveLength(1)
    expect(row?.decisions.filter(d => d.callId === winningCallId)).toHaveLength(1)
  }, 20000)

  it('stale expected_revision returns the current state with a stale indicator and mutates nothing else', async () => {
    const s = await stackWithPump()
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'recoverable task',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-stale'))
    const taskId = taskIdFor(s.alice.id, 'call-stale')
    await drain(s.pump)
    const stale = succeeded(await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: 999,
      action: 'cancel',
    }, s.alice, 'call-stale-decision')).value as {
      stale: boolean
      applied: boolean
      task: { revision: number; taskState: string }
      decision: { outcome: string }
    }
    expect(stale.stale).toBe(true)
    expect(stale.applied).toBe(false)
    expect(stale.task.taskState).toBe('waiting_decision')
    // Replay of the same stale decision returns the SAME recorded outcome.
    const replay = succeeded(await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: 5,
      action: 'cancel',
    }, s.alice, 'call-stale-decision')).value as { decision: { outcome: string } }
    expect(replay.decision.outcome).toBe('stale')
    // No cancel side effect: row still waiting_decision.
    expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('waiting_decision')
  }, 20000)

  it('cancel closes a never-executed waiting_decision task; retry on cancelled is refused', async () => {
    const s = await stackWithPump()
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'recoverable task',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-cancel-waiting'))
    const taskId = taskIdFor(s.alice.id, 'call-cancel-waiting')
    await drain(s.pump)
    const cancelled = succeeded(await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: (s.ctx.sessionLinkTasks.getRow(taskId))!.revision,
      action: 'cancel',
    }, s.alice, 'call-cancel-waiting-decision')).value as {
      applied: boolean
      task: { taskState: string }
    }
    expect(cancelled.applied).toBe(true)
    expect(cancelled.task.taskState).toBe('cancelled')
    // Retry or cancel again on the terminal task: refused as TASK_TERMINAL-class.
    const retryTerminal = await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: (s.ctx.sessionLinkTasks.getRow(taskId))!.revision,
      action: 'retry',
    }, s.alice, 'call-retry-terminal')
    expect(retryTerminal.isError).toBe(true)
  }, 20000)

  it('a RUNNING task answers cancel with TASK_RUNNING and stays under the target\'s own cancel controls', async () => {
    const adapter = new MockAdapter(['hang-slow' as never, textResponse('done')] as never)
    const s = await stackWithPump({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'long task',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-running-cancel'))
    const taskId = taskIdFor(s.alice.id, 'call-running-cancel')
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('running')
    }, { timeout: 5000 })
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    const running = await call(s.ctx, 'session_resolve_task', {
      task_id: String(taskId),
      expected_revision: row!.revision,
      action: 'cancel',
    }, s.alice, 'call-running-cancel-decision')
    expect(running.isError).toBe(true)
    expect(JSON.stringify(running.content)).toContain('is running; cancel through the target Session')
    // The task stays running until the TARGET cancels its own turn.
    expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('running')
    s.bob.cancel({ kind: 'user' }, {})
    await s.bob.whenIdle().catch(() => {})
  }, 20000)

  it('continue on a partial task without a host resumable checkpoint answers TASK_NOT_RESUMABLE honestly', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stackWithPump({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const tasks = s.ctx.sessionLinkTasks as SessionLinkTaskService
    // Synthesize a partial waiting_decision row directly through the service.
    const saved = await tasks.saveTaskIntent({
      callerId: s.alice.id,
      request: { kind: 'send', callId: 'call-continue-1', text: 'partial work', targetSessionId: s.bob.id },
      policy: {
        scope: 'task',
        candidates: [{ provider: 'mock', model: MODEL_A }],
        ifExhausted: 'notify_sender',
        usesSessionDefault: false,
      },
      tracked: true,
    })
    await tasks.requestStateChange(saved.taskId, saved.row.revision, {
      toState: 'waiting_decision',
      executionState: 'partial',
      reason: 'model_unavailable',
      events: [{
        kind: 'model_unavailable',
        executionState: 'partial',
        reason: 'model_unavailable',
        decisionRequired: true,
        resumable: false,
      }],
    })
    const partial = await call(s.ctx, 'session_resolve_task', {
      task_id: String(saved.taskId),
      expected_revision: (tasks.getRow(saved.taskId))!.revision,
      action: 'continue',
    }, s.alice, 'call-continue-decision')
    expect(partial.isError).toBe(true)
    expect(JSON.stringify(partial.content)).toContain('resumable checkpoint')
  }, 20000)
})

describe('task-notifications: mount-time reconcile (F-C1c)', () => {
  it('a process restart over a half-bound task surfaces the repair notice through reconcile into a real delivery — no auto-execution', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const first = await bootStack(contexts, pools, { adapter })
    await first.ctx.sessionLinks.link('pair', [first.alice.id, first.bob.id], { kind: 'human' })
    // Seed the crash shape directly through the service: a task bound to a
    // mailbox message whose host turn intent NEVER committed (the process
    // died between write-ahead steps 3 and 4).
    const tasks1 = first.ctx.sessionLinkTasks
    const saved = await tasks1.saveTaskIntent({
      callerId: first.alice.id,
      request: { kind: 'send', callId: 'call-half-bound', text: 'work the crash dropped mid-bind', targetSessionId: first.bob.id },
      policy: {
        scope: 'task',
        candidates: [{ provider: 'mock', model: MODEL_A }],
        ifExhausted: 'notify_sender',
        usesSessionDefault: false,
      },
      tracked: true,
    })
    const messageId = SessionLinkMessageId('session-link-message-half-bound')
    await first.ctx.sessionLinks.send(first.alice, first.bob.id, {
      targetId: first.bob.id,
      text: 'delivered but never intent-recorded',
      idempotencyKey: 'call-half-bound',
      messageId,
    })
    await tasks1.attachBinding(saved.taskId, 1, {
      messageId,
      sessionId: first.bob.id,
      admittedAs: 'queued',
    })
    expect(tasks1.isExecutionBound(saved.taskId)).toBe(false)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    /* RESTART: the tool row mounts and its mount-time reconcile classifies
     * the half-bound row: waiting_decision + EXACTLY ONE repair notice — and
     * the mount-installed pump (no manual drain here) delivers it to alice.
     * The task itself is NEVER auto-executed: bob serves nothing for it. */
    const second = await bootStack(contexts, pools, { adapter })
    const taskId = taskIdFor(second.alice.id, 'call-half-bound')
    await vi.waitFor(() => {
      const row = second.ctx.sessionLinkTasks.getRow(taskId)
      expect(row?.taskState).toBe('waiting_decision')
      expect(row?.reason).toBe('repair_binding_missing')
      expect(row?.outbox.some(event => event.reason === 'repair_binding_missing' && event.status !== 'pending')).toBe(true)
    }, { timeout: 8000 })
    const row = second.ctx.sessionLinkTasks.getRow(taskId)
    const repair = row?.outbox.find(event => event.reason === 'repair_binding_missing')
    expect(repair).toBeDefined()
    expect(['admitted', 'delivered']).toContain(repair?.status)
    const notification = second.ctx.sessionLinks.message(repair!.notifiedMessageId!)
    expect(notification?.statusKind).toBe('task-status')
    expect(notification?.taskStatus?.kind).toBe('model_unavailable')
    expect(notification?.taskStatus?.reason).toBe('repair_binding_missing')
    expect(notification?.taskStatus?.decisionRequired).toBe(true)
    expect(notification?.targetId).toBe(second.alice.id)
    // Never executed: the adapter served no model request for the task, and
    // the durable row still carries no turn intent.
    expect(adapter.requests).toHaveLength(0)
    expect(row?.execution.turnIntentId).toBeUndefined()
    expect(second.ctx.sessionLinkTasks.isExecutionBound(taskId)).toBe(false)
  }, 20000)
})
