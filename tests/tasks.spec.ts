/**
 * Suite for the Session Link durable task protocol (MODEL_ROUTING_PLAN Task
 * 3): write-ahead intents, CAS state transitions, attempt journals, decision
 * idempotency, outbox lifecycles, and replay reconciliation. Mount-free of
 * the agent loop: contexts carry only the in-memory storage domain; the
 * catalog/precheck and the host capability are mocked in-process; the links
 * probe is a stub. Every write boundary is fault-injected through the shared
 * MemoryMediaPool (`failNextWrites`), and restart scenarios reopen a fresh
 * service over the same media pool.
 *
 * Requirement note: like tests/link.spec.ts this suite imports
 * `@deepseek-ai/dsh-storage`, which the plugin repo resolves through the
 * DSH source checkout; run it with DSH_SOURCE_ROOT set (the full
 * `DSH_SOURCE_ROOT=... pnpm exec vitest run` covers it). No agent loop,
 * no adapters, and no host extension from the checkout are touched.
 *
 * Verification mapping (task-3 brief):
 *  - 逐个写入边界故障注入 → the "write-boundary fault injection" describe;
 *  - 崩溃重启 → "crash and restart" describe;
 *  - 并发 resolve 的 CAS → resolveTask concurrency tests;
 *  - 重放参数冲突 → saveTaskIntent replay tests;
 *  - 旧数据加载 → "legacy row loading";
 *  - 任务表写失败不派发默认模型 → intent write failure test;
 *  - 恢复不重复创建/不唤醒/不伪造邮件 → reconcile assertion tests.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  SessionLinkError,
  SessionLinkMessageId,
  SessionLinkTaskError,
  SessionLinkTaskId,
  SessionLinkTaskService,
  taskIdFor,
} from '../src/index.ts'
import type {
  CreateTaskIntentInput,
  OriginalRequestInput,
  TaskChange,
} from '../src/tasks.ts'
import type { SessionLinkTaskServiceOptions } from '../src/tasks.ts'
import type { ModelRoutingPolicy, ModelRouteSelection } from '../src/model-policy.ts'
import type { SessionLinkMessageRecordData } from '../src/spec.ts'
import type { SessionLinkId } from '../src/types.ts'
import type { HostTaskHostCapability } from '../src/host-capability.ts'
import type { SessionLinkTaskRecordData } from '../src/task-spec.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
    contexts.delete(ctx)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'session-link-tasks test cleanup failed')
})

const aliceId = brandString<SessionId>('session-alice')
const bobId = brandString<SessionId>('session-bob')
const carolId = brandString<SessionId>('session-carol')

const routeA: ModelRouteSelection = { provider: 'deepseek-account', model: 'deepseek-chat' }
const routeB: ModelRouteSelection = { provider: 'openai', model: 'gpt-x' }

function policy(routes: readonly ModelRouteSelection[] = [routeA]): ModelRoutingPolicy {
  return {
    scope: 'task',
    candidates: routes.map(route => ({ ...route })),
    ifExhausted: 'notify_sender',
    usesSessionDefault: false,
  }
}

function spawnRequest(callId: string, text = 'do the thing'): OriginalRequestInput {
  return {
    kind: 'spawn',
    callId,
    text,
    spawn: { cwd: '/repo', autoAwake: true, targetSessionId: bobId },
  }
}

function sendRequest(callId: string, text = 'ping'): OriginalRequestInput {
  return { kind: 'send', callId, text, targetSessionId: bobId }
}

interface Stack {
  readonly ctx: Context
  readonly tasks: SessionLinkTaskService
  readonly pool: MemoryMediaPool
  readonly disposeTasks: () => Promise<void>
}

/** Mount the task service alone over the in-memory storage domain (host-free). */
async function stack(
  pool: MemoryMediaPool = new MemoryMediaPool(),
  options: SessionLinkTaskServiceOptions = {},
): Promise<Stack> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(SessionLinkTaskService, options)
  return { ctx, pool, tasks: ctx.sessionLinkTasks, disposeTasks: async () => {
    await fiber.dispose()
  } }
}

/** Links-probe stub over an in-memory catalog of mailbox facts. */
function probeStub(seed: {
  messages?: readonly SessionLinkMessageRecordData[]
  linkedPairs?: readonly [SessionLinkId, SessionId, SessionId][]
} = {}) {
  const messages = new Map<string, SessionLinkMessageRecordData>()
  for (const record of seed.messages ?? []) {
    // Derive the test key the same way production ids are minted.
    messages.set(`${record.senderId}->${record.targetId}:${record.createdAt}`, record)
  }
  return {
    messages,
    probe: {
      message(messageId: SessionLinkMessageId) {
        return messages.get(String(messageId))
      },
      pairLinked(linkId: SessionLinkId, first: SessionId, second: SessionId) {
        return (seed.linkedPairs ?? []).some(([id, a, b]) =>
          id === linkId && ((a === first && b === second) || (a === second && b === first)))
      },
    },
    putMessage(messageId: SessionLinkMessageId, record: SessionLinkMessageRecordData) {
      messages.set(String(messageId), record)
    },
  }
}

function mailRecord(senderId: SessionId, targetId: SessionId, linkId: SessionLinkId): SessionLinkMessageRecordData {
  return {
    linkId, senderId, senderTitle: 'sender', targetId,
    text: 'framed', status: 'pending', wakesUsed: 0, chainLength: 1, attempts: 0,
    createdAt: new Date().toISOString(),
  }
}

async function saveSpawn(s: Stack, callId = 'call-1', text?: string, pol = policy()) {
  return await s.tasks.saveTaskIntent({
    callerId: aliceId,
    request: spawnRequest(callId, text),
    policy: pol,
    tracked: true,
  })
}

describe('session-link tasks: intent save + replay protection', () => {
  it('saves a preparing spawn intent with stable taskId, revision 1, and no binding', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    expect(saved.taskId).toBe(taskIdFor(aliceId, 'call-1'))
    expect(String(saved.taskId)).toBe(`task:${aliceId}:call-1`)
    expect(saved.row.taskState).toBe('preparing')
    expect(saved.row.revision).toBe(1)
    expect(saved.row.execution.messageId).toBeUndefined()
    expect(saved.row.execution.turnIntentId).toBeUndefined()
    expect(saved.row.spawn?.callKey).toBe('call-1')
    expect(String(saved.row.spawn!.targetSessionId)).toBe(String(bobId))
    expect(saved.row.attempts).toHaveLength(1)
    expect(saved.row.attempts[0]!.kind).toBe('original')
    expect(saved.row.outbox).toHaveLength(0)
  })

  it('replaying the same caller+callId returns the existing row after a simulated restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(pool)
    await saveSpawn(first)
    await first.disposeTasks()
    // New service instance over the same media: the process "restarted".
    const second = await stack(pool)
    const replayed = await second.tasks.saveTaskIntent({
      callerId: aliceId, request: spawnRequest('call-1'), policy: policy(), tracked: true,
    })
    expect(replayed.taskId).toBe(taskIdFor(aliceId, 'call-1'))
    expect(replayed.row.createdAt).toBe(replayed.row.updatedAt)
    const rows = second.tasks.listRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revision).toBe(1)
  })

  it('rejects a replay whose parameters differ and leaves the stored row untouched', async () => {
    const s = await stack()
    await saveSpawn(s)
    await expect(s.tasks.saveTaskIntent({
      callerId: aliceId,
      request: spawnRequest('call-1', 'different task text'),
      policy: policy(),
      tracked: true,
    })).rejects.toMatchObject({ code: 'LINK_ALREADY_LINKED' })
    await expect(s.tasks.saveTaskIntent({
      callerId: aliceId,
      request: spawnRequest('call-1'),
      policy: policy([routeB]),
      tracked: true,
    })).rejects.toMatchObject({ code: 'LINK_ALREADY_LINKED' })
    const row = s.tasks.getRow(taskIdFor(aliceId, 'call-1'))
    expect(row?.revision).toBe(1)
    expect(row?.policy.candidates[0]).toMatchObject(routeA)
  })

  it('persists the precheck failure as waiting_decision/not_started with NO session and NO mailbox message', async () => {
    const s = await stack()
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId,
      request: spawnRequest('call-pc'),
      policy: policy([routeA, routeB]),
      tracked: true,
      precheckFailure: {
        reason: 'PROVIDER_NOT_FOUND',
        results: [
          { route: routeA, code: 'PROVIDER_NOT_FOUND', message: 'provider missing' },
          { route: routeB, code: 'MODEL_NOT_FOUND' },
        ],
      },
    })
    expect(saved.row.taskState).toBe('waiting_decision')
    expect(saved.row.executionState).toBe('not_started')
    expect(saved.row.targetSessionId).toBeUndefined()
    expect(saved.row.execution.messageId).toBeUndefined()
    expect(saved.row.attempts[0]!.results).toHaveLength(2)
    expect(saved.row.attempts[0]!.results[0]).toMatchObject({ route: routeA, outcome: 'unavailable', code: 'PROVIDER_NOT_FOUND' })
    expect(saved.row.outbox).toHaveLength(1)
    const event = saved.row.outbox[0]!
    expect(event.kind).toBe('model_unavailable')
    expect(event.eventId).toBe(`task:${aliceId}:call-pc/1/model_unavailable`)
    expect(event.decisionRequired).toBe(true)
    expect(event.resumable).toBe(true)
    expect(event.reason).toBe('PROVIDER_NOT_FOUND')
    expect(s.tasks.isExecutionBound(saved.taskId)).toBe(false)
    expect(() => s.tasks.assertBindingDurable(saved.taskId)).toThrowError(expect.objectContaining({ code: 'TASK_TERMINAL' }))
  })
})

describe('session-link tasks: write-ahead binding sequence', () => {
  it('walks intent → binding → turn intent and only then reports execution-bound', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    const messageId = SessionLinkMessageId('session-link-message-m1')
    expect(s.tasks.isExecutionBound(saved.taskId)).toBe(false)
    const bound = await s.tasks.attachBinding(saved.taskId, 1, {
      messageId, sessionId: bobId, linkId: 'session-link-l1' as SessionLinkId, admittedAs: 'queued',
    })
    expect(bound.taskState).toBe('queued')
    expect(bound.revision).toBe(2)
    expect(bound.notificationRoot.rootMessageId).toBe(messageId)
    // Message bound but no host turn intent: not deliverable/wakeable.
    expect(s.tasks.isExecutionBound(saved.taskId)).toBe(false)
    expect(() => s.tasks.assertBindingDurable(saved.taskId)).toThrowError(expect.objectContaining({ code: 'TASK_BINDING_INCOMPLETE' }))
    const attached = await s.tasks.recordTurnIntent(saved.taskId, 2, { turnIntentId: 'intent-1', messageId })
    expect(attached.revision).toBe(3)
    expect(attached.execution.turnIntentAttachedAt).toBeTypeOf('string')
    expect(s.tasks.isExecutionBound(saved.taskId)).toBe(true)
    expect(s.tasks.assertBindingDurable(saved.taskId).execution.turnIntentId).toBe('intent-1')
  })

  it('rejects an accepted admission registered before the turn intent exists', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    await expect(s.tasks.attachBinding(saved.taskId, 1, {
      messageId: SessionLinkMessageId('session-link-message-m2'),
      sessionId: bobId,
      admittedAs: 'accepted',
    })).rejects.toMatchObject({ code: 'TASK_BINDING_INCOMPLETE' })
    expect(s.tasks.getRow(saved.taskId)?.taskState).toBe('preparing')
    expect(s.tasks.getRow(saved.taskId)?.execution.messageId).toBeUndefined()
  })

  it('rejects a turn intent naming a different message', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    await s.tasks.attachBinding(saved.taskId, 1, {
      messageId: SessionLinkMessageId('session-link-message-m3'), sessionId: bobId, admittedAs: 'queued',
    })
    await expect(s.tasks.recordTurnIntent(saved.taskId, 2, {
      turnIntentId: 'intent-x',
      messageId: SessionLinkMessageId('session-link-message-other'),
    })).rejects.toMatchObject({ code: 'TASK_BINDING_INCOMPLETE' })
  })

  it('keeps one send task binding per attempt and routes claims through the running transition', async () => {
    const s = await stack()
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-s1'), policy: policy(), tracked: true,
    })
    const messageId = SessionLinkMessageId('session-link-message-send1')
    await s.tasks.attachBinding(saved.taskId, 1, { messageId, sessionId: bobId, admittedAs: 'queued' })
    await s.tasks.recordTurnIntent(saved.taskId, 2, { turnIntentId: 'intent-s1', messageId })
    const running = await s.tasks.requestStateChange(saved.taskId, 3, { toState: 'running' })
    expect(running.execution.currentlyExecuting).toBe(true)
    const finished = await s.tasks.requestStateChange(saved.taskId, 4, {
      toState: 'turn_finished',
      routeUsed: routeA,
      events: [{ kind: 'turn_finished', actualModel: routeA, resumable: false }],
    })
    expect(finished.taskState).toBe('turn_finished')
    expect(finished.execution.currentlyExecuting).toBeUndefined()
    expect(finished.execution.routeUsed).toEqual(routeA)
    expect(finished.outbox.at(-1)).toMatchObject({
      kind: 'turn_finished',
      eventId: `task:${aliceId}:call-s1/5/turn_finished`,
      status: 'pending',
    })
    expect(s.tasks.isExecutionBound(saved.taskId)).toBe(true)
    expect(() => s.tasks.assertBindingDurable(saved.taskId)).toThrowError(expect.objectContaining({ code: 'TASK_TERMINAL' }))
  })
})

describe('session-link tasks: state machine + CAS', () => {
  it('commits state change and outbox events in one row write', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    const row = await s.tasks.requestStateChange(saved.taskId, 1, {
      toState: 'waiting_decision',
      executionState: 'partial',
      reason: 'MODEL_NOT_FOUND',
      events: [{ kind: 'model_unavailable', reason: 'MODEL_NOT_FOUND', decisionRequired: true, resumable: true, actualModel: routeB }],
    })
    expect(row.taskState).toBe('waiting_decision')
    expect(row.executionState).toBe('partial')
    expect(row.outbox).toHaveLength(1)
    expect(row.outbox[0]).toMatchObject({
      eventId: `task:${aliceId}:call-1/2/model_unavailable`,
      revision: 2,
      decisionRequired: true,
      actualModel: routeB,
    })
  })

  it('rejects illegal transitions with a typed terminal error', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    await expect(s.tasks.requestStateChange(saved.taskId, 1, { toState: 'running' }))
      .rejects.toMatchObject({ code: 'TASK_TERMINAL' })
    await expect(s.tasks.requestStateChange(saved.taskId, 1, { toState: 'turn_finished' }))
      .rejects.toMatchObject({ code: 'TASK_TERMINAL' })
    const queued = await s.tasks.requestStateChange(saved.taskId, 1, { toState: 'queued' })
    await expect(s.tasks.requestStateChange(saved.taskId, queued.revision, { toState: 'preparing' }))
      .rejects.toMatchObject({ code: 'TASK_TERMINAL' })
    const cancelled = await s.tasks.requestStateChange(saved.taskId, queued.revision, { toState: 'cancelled' })
    await expect(s.tasks.requestStateChange(saved.taskId, cancelled.revision, { toState: 'queued' }))
      .rejects.toMatchObject({ code: 'TASK_TERMINAL' })
  })

  it('fails a concurrent writer with TASK_STALE_REVISION and loses none of the winner\'s write', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    const [winner, loser] = await Promise.allSettled([
      s.tasks.requestStateChange(saved.taskId, 1, { toState: 'queued' }),
      s.tasks.requestStateChange(saved.taskId, 1, {
        toState: 'waiting_decision', executionState: 'not_started', reason: 'MODEL_NOT_FOUND',
      }),
    ])
    const results = [winner, loser]
    const fulfilled = results.find(result => result.status === 'fulfilled')
    const rejected = results.find(result => result.status === 'rejected')
    expect(fulfilled).toBeDefined()
    expect(rejected).toBeDefined()
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'TASK_STALE_REVISION' })
    const row = s.tasks.getRow(saved.taskId)!
    expect(row.revision).toBe(2)
  })

  it('serializes entire retry+finish chains through CAS tokens', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    const queued = await s.tasks.requestStateChange(saved.taskId, saved.row.revision, { toState: 'queued' })
    const running = await s.tasks.requestStateChange(saved.taskId, queued.revision, { toState: 'running' })
    const finished = await s.tasks.requestStateChange(saved.taskId, running.revision, { toState: 'turn_finished', routeUsed: routeA })
    expect(finished.revision).toBe(4)
    expect(finished.taskState).toBe('turn_finished')
  })
})

describe('session-link tasks: attempt journal + default freeze', () => {
  it('appends candidate outcomes immutably and enforces the 5-record attempt budget', async () => {
    const s = await stack()
    const saved = await saveSpawn(s)
    let revision = saved.row.revision
    const codes = ['PROVIDER_NOT_FOUND', 'MODEL_NOT_FOUND', 'EFFORT_UNSUPPORTED', 'CATALOG_UNAVAILABLE', 'selected']
    for (let index = 0; index < 5; index += 1) {
      const row = await s.tasks.appendCandidateResult(saved.taskId, revision, index === 4
        ? { route: routeB, outcome: 'selected' }
        : { route: routeA, outcome: 'unavailable', code: codes[index] })
      revision = row.revision
    }
    const attempt = s.tasks.getRow(saved.taskId)!.attempts[0]!
    expect(attempt.results).toHaveLength(5)
    await expect(s.tasks.appendCandidateResult(saved.taskId, revision, { route: routeA, outcome: 'unavailable', code: 'X' }))
      .rejects.toMatchObject({ code: 'TASK_NOT_RETRYABLE' })
    // History is append-only: a restart keeps the spent budget.
    const pool = s.pool
    await s.disposeTasks()
    const second = await stack(pool)
    expect(second.tasks.getRow(taskIdFor(aliceId, 'call-1'))!.attempts[0]!.results).toHaveLength(5)
  })

  it('freezes a session_default binding exactly once and never re-samples on replay', async () => {
    const s = await stack()
    const defaultPolicy: ModelRoutingPolicy = {
      scope: 'task',
      candidates: [{ use: 'session_default' }, { ...routeB }],
      ifExhausted: 'notify_sender',
      usesSessionDefault: true,
    }
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-d1'), policy: defaultPolicy, tracked: true,
    })
    const frozen = await s.tasks.freezeDefaultRoute(saved.taskId, saved.row.revision, routeB)
    expect(frozen.attempts[0]!.defaultFrozenRoute).toEqual(routeB)
    const again = await s.tasks.freezeDefaultRoute(saved.taskId, frozen.revision, routeB)
    expect(again.revision).toBe(frozen.revision)
    await expect(s.tasks.freezeDefaultRoute(saved.taskId, again.revision, routeA))
      .rejects.toMatchObject({ code: 'TASK_NOT_RETRYABLE' })
    // A restart keeps the frozen route: replay must reuse it.
    await s.disposeTasks()
    const second = await stack(s.pool)
    expect(second.tasks.getRow(saved.taskId)!.attempts[0]!.defaultFrozenRoute).toEqual(routeB)
  })
})

describe('session-link tasks: resolution decisions', () => {
  async function waitingTask(s: Stack, executionState: 'not_started' | 'partial' = 'not_started') {
    const saved = await saveSpawn(s, 'call-r1')
    return await s.tasks.requestStateChange(saved.taskId, 1, {
      toState: 'waiting_decision', executionState, reason: 'MODEL_NOT_FOUND',
      events: [{ kind: 'model_unavailable', reason: 'MODEL_NOT_FOUND', decisionRequired: true, resumable: true }],
    })
  }

  it('retry opens a new attempt, returns to preparing, and clears the binding — without any Session or mailbox message', async () => {
    const s = await stack()
    const row = await waitingTask(s)
    const taskId = taskIdFor(aliceId, 'call-r1')
    const decided = await s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'decision-1',
      expectedRevision: row.revision, action: 'retry', policy: policy([routeB]),
    })
    expect(decided.outcome).toBe('applied')
    expect(decided.row.taskState).toBe('preparing')
    expect(decided.row.executionState).toBeUndefined()
    expect(decided.row.execution.messageId).toBeUndefined()
    expect(decided.row.execution.sessionId).toBeUndefined()
    expect(decided.row.attempts).toHaveLength(2)
    const attempt = decided.row.attempts[1]!
    expect(attempt.kind).toBe('retry')
    expect(attempt.decisionIdemKey).toBe('decision-1')
    expect(attempt.candidates).toEqual([{ ...routeB }])
    expect(decided.decision).toMatchObject({
      callId: 'decision-1', action: 'retry', outcome: 'applied', attemptId: attempt.attemptId,
    })
    // The original spawn callKey is intact for Task 4's replay: the SAME Session would be created.
    expect(decided.row.spawn?.callKey).toBe('call-r1')
    expect(String(decided.row.spawn!.targetSessionId)).toBe(String(bobId))
    const repaired = await s.tasks.attachBinding(taskId, decided.row.revision, {
      messageId: SessionLinkMessageId('session-link-message-retry1'), sessionId: bobId, admittedAs: 'queued',
    })
    expect(repaired.taskState).toBe('queued')
    expect(repaired.notificationRoot.rootMessageId).toBe(SessionLinkMessageId('session-link-message-retry1'))
  })

  it('rejects retry on partial or unknown execution progress', async () => {
    const s = await stack()
    const partial = await waitingTask(s, 'partial')
    const taskId = taskIdFor(aliceId, 'call-r1')
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd2', expectedRevision: partial.revision, action: 'retry',
    })).rejects.toMatchObject({ code: 'TASK_NOT_RETRYABLE' })
  })

  it('continue requires waiting_decision + partial + a host-confirmed checkpoint and returns to queued', async () => {
    const s = await stack()
    const row = await waitingTask(s, 'partial')
    const taskId = taskIdFor(aliceId, 'call-r1')
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd3', expectedRevision: row.revision, action: 'continue',
    })).rejects.toMatchObject({ code: 'TASK_NOT_CONTINUABLE' })
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd4', expectedRevision: row.revision, action: 'continue',
      hostResumable: true,
    })).resolves.toMatchObject({ outcome: 'applied' })
    const after = s.tasks.getRow(taskId)!
    expect(after.taskState).toBe('queued')
    expect(after.attempts.at(-1)!.kind).toBe('continue')
    expect(after.attempts.at(-1)!.candidates).toEqual(row.attempts.at(-1)!.candidates)
    expect(after.execution.messageId).toBeUndefined()
  })

  it('cancel closes a paused intent with a cancelled event; running and unknown progress refuse', async () => {
    const s = await stack()
    const row = await waitingTask(s)
    const taskId = taskIdFor(aliceId, 'call-r1')
    const decided = await s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd5', expectedRevision: row.revision, action: 'cancel',
    })
    expect(decided.row.taskState).toBe('cancelled')
    expect(decided.row.outbox.at(-1)).toMatchObject({ kind: 'cancelled' })
    // unknown progress: never auto-cancelled.
    const saved2 = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-r2'), policy: policy(), tracked: true,
    })
    await s.tasks.requestStateChange(saved2.taskId, 1, { toState: 'queued' })
    const unknown = await s.tasks.requestStateChange(saved2.taskId, 2, {
      toState: 'interrupted', executionState: 'unknown', reason: 'crash-during-turn',
    })
    expect(unknown.executionState).toBe('unknown')
    // A running task: TASK_RUNNING.
    const saved3 = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-r3'), policy: policy(), tracked: true,
    })
    const messageId = SessionLinkMessageId('session-link-message-running')
    await s.tasks.attachBinding(saved3.taskId, 1, { messageId, sessionId: bobId, admittedAs: 'queued' })
    await s.tasks.recordTurnIntent(saved3.taskId, 2, { turnIntentId: 'intent-r3', messageId })
    const running = await s.tasks.requestStateChange(saved3.taskId, 3, { toState: 'running' })
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId: saved3.taskId, decisionCallId: 'd7',
      expectedRevision: running.revision, action: 'cancel',
    })).rejects.toMatchObject({ code: 'TASK_RUNNING' })
  })

  it('records a stale revision as a no-op outcome the same call id replays forever', async () => {
    const s = await stack()
    const row = await waitingTask(s)
    const taskId = taskIdFor(aliceId, 'call-r1')
    const stale = await s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd8', expectedRevision: row.revision - 1, action: 'cancel',
    })
    expect(stale.outcome).toBe('stale')
    expect(stale.row.taskState).toBe('waiting_decision')
    const replay = await s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd8', expectedRevision: stale.row.revision, action: 'cancel',
    })
    expect(replay.outcome).toBe('stale')
    expect(replay.decision.attemptId).toBe(stale.decision.attemptId)
    expect(s.tasks.getRow(taskId)!.taskState).toBe('waiting_decision')
  })

  it('is idempotent across resolution replays and safe under two concurrent decisions', async () => {
    const s = await stack()
    const row = await waitingTask(s)
    const taskId = taskIdFor(aliceId, 'call-r1')
    const first = await s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd9', expectedRevision: row.revision, action: 'retry',
    })
    const replay = await s.tasks.resolveTask({
      callerId: aliceId, taskId, decisionCallId: 'd9', expectedRevision: 999, action: 'cancel',
    })
    expect(replay.outcome).toBe('applied')
    expect(replay.decision).toEqual(first.decision)
    expect(replay.row.revision).toBe(first.row.revision)
    expect(replay.row.attempts).toHaveLength(2)
    // A different action under the recorded call id still returns the recorded outcome.
    expect(replay.row.taskState).toBe('preparing')

    // Concurrent conflicting decisions on a fresh task: exactly one applies.
    const saved2 = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: spawnRequest('call-rc'), policy: policy(), tracked: true,
    })
    const waiting = await s.tasks.requestStateChange(saved2.taskId, 1, {
      toState: 'waiting_decision', executionState: 'not_started', reason: 'MODEL_NOT_FOUND',
    })
    const results = await Promise.allSettled([
      s.tasks.resolveTask({
        callerId: aliceId, taskId: saved2.taskId, decisionCallId: 'dx',
        expectedRevision: waiting.revision, action: 'retry',
      }),
      s.tasks.resolveTask({
        callerId: aliceId, taskId: saved2.taskId, decisionCallId: 'dy',
        expectedRevision: waiting.revision, action: 'cancel',
      }),
    ])
    const applied = results.filter(result => result.status === 'fulfilled' && result.value.outcome === 'applied')
    expect(applied).toHaveLength(1)
    // The loser never applied its decision: it either recorded `stale` (it
    // observed the winner's revision bump) or threw before recording. Either
    // way exactly one decision was applied.
    const loser = results.find((result, index) => results[index] !== applied[0])!
    const final = s.tasks.getRow(saved2.taskId)!
    if (loser.status === 'fulfilled') {
      expect(loser.value.outcome).toBe('stale')
      expect(final.decisions).toHaveLength(2)
    } else {
      expect(final.decisions).toHaveLength(1)
    }
  })

  it('denies decisions by any Session other than the original sender', async () => {
    const s = await stack()
    const row = await waitingTask(s)
    await expect(s.tasks.resolveTask({
      callerId: bobId, taskId: taskIdFor(aliceId, 'call-r1'), decisionCallId: 'dz',
      expectedRevision: row.revision, action: 'cancel',
    })).rejects.toMatchObject({ code: 'LINK_CALLER_NOT_MEMBER' })
    await expect(s.tasks.resolveTask({
      callerId: carolId, taskId: taskIdFor(aliceId, 'call-r1'), decisionCallId: 'dz',
      expectedRevision: row.revision, action: 'cancel',
    })).rejects.toMatchObject({ code: 'LINK_CALLER_NOT_MEMBER' })
  })

  it('retry/continue revalidate the grant when a binding exists; cancel stays permitted after unlink', async () => {
    const linkId = 'session-link-grant' as SessionLinkId
    const probe = probeStub({ linkedPairs: [[linkId, aliceId, bobId]] })
    const s = await stack(new MemoryMediaPool(), { links: probe.probe })
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-g1'), policy: policy(), tracked: true,
    })
    const messageId = SessionLinkMessageId('session-link-message-g1')
    probe.putMessage(messageId, mailRecord(aliceId, bobId, linkId))
    await s.tasks.attachBinding(saved.taskId, 1, { messageId, sessionId: bobId, linkId, admittedAs: 'queued' })
    await s.tasks.recordTurnIntent(saved.taskId, 2, { turnIntentId: 'intent-g1', messageId })
    const waiting = await s.tasks.requestStateChange(saved.taskId, 3, {
      toState: 'waiting_decision', executionState: 'partial', reason: 'MODEL_NOT_FOUND',
    })
    // Grant intact: retry is refused for partial; use continue with host confirmation.
    const continued = await s.tasks.resolveTask({
      callerId: aliceId, taskId: saved.taskId, decisionCallId: 'dg1',
      expectedRevision: waiting.revision, action: 'continue', hostResumable: true,
    })
    expect(continued.outcome).toBe('applied')
    // Now the grant is gone: build a scenario where the binding exists and the link is revoked.
    const saved2 = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-g2'), policy: policy(), tracked: true,
    })
    const messageId2 = SessionLinkMessageId('session-link-message-g2')
    await s.tasks.attachBinding(saved2.taskId, 1, { messageId: messageId2, sessionId: bobId, linkId, admittedAs: 'queued' })
    await s.tasks.recordTurnIntent(saved2.taskId, 2, { turnIntentId: 'intent-g2', messageId: messageId2 })
    const waiting2 = await s.tasks.requestStateChange(saved2.taskId, 3, {
      toState: 'waiting_decision', executionState: 'not_started', reason: 'MODEL_NOT_FOUND',
    })
    // "unlink": the pairLinked probe now answers false for this link.
    probe.probe.pairLinked = () => false
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId: saved2.taskId, decisionCallId: 'dg2',
      expectedRevision: waiting2.revision, action: 'retry',
    })).rejects.toMatchObject({ code: 'LINK_REVOKED' })
    const cancelled = await s.tasks.resolveTask({
      callerId: aliceId, taskId: saved2.taskId, decisionCallId: 'dg3',
      expectedRevision: waiting2.revision, action: 'cancel',
    })
    expect(cancelled.row.taskState).toBe('cancelled')
  })

  it('archived targets refuse retry', async () => {
    const s = await stack()
    const row = await waitingTask(s)
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId: taskIdFor(aliceId, 'call-r1'), decisionCallId: 'da',
      expectedRevision: row.revision, action: 'retry', targetArchived: true,
    })).rejects.toMatchObject({ code: 'TARGET_ARCHIVED' })
  })
})

describe('session-link tasks: access rules', () => {
  it('get_task is readable by sender and target only, including after unlink', async () => {
    const s = await stack()
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-a1'), policy: policy([routeA, routeB]), tracked: true,
    })
    const sender = s.tasks.getTask(aliceId, saved.taskId)
    expect(sender.taskState).toBe('preparing')
    const target = s.tasks.getTask(bobId, saved.taskId)
    expect(target.callerId).toBe(aliceId)
    expect(target.expectedRevision).toBe(sender.revision)
    expect(() => s.tasks.getTask(carolId, saved.taskId)).toThrowError(expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }))
    expect(() => s.tasks.getTask(carolId, SessionLinkTaskId('task:nobody:none'))).toThrowError(expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }))
    // Latest issue surfaces for tools.
    const waiting = await s.tasks.requestStateChange(saved.taskId, 1, {
      toState: 'waiting_decision', executionState: 'not_started', reason: 'PROVIDER_NOT_FOUND',
      events: [{ kind: 'model_unavailable', reason: 'PROVIDER_NOT_FOUND', decisionRequired: true, resumable: true }],
    })
    await s.tasks.appendCandidateResult(saved.taskId, waiting.revision, {
      route: routeA, outcome: 'unavailable', code: 'PROVIDER_NOT_FOUND', message: 'no provider',
    })
    const view = s.tasks.getTask(aliceId, saved.taskId)
    expect(view.latestIssue).toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
    expect(view.policy.candidates).toHaveLength(2)
  })
})

describe('session-link tasks: outbox lifecycle', () => {
  it('walks pending → admitted → delivered with recipient guards', async () => {
    const linkId = 'session-link-ob' as SessionLinkId
    const probe = probeStub()
    const s = await stack(new MemoryMediaPool(), { links: probe.probe })
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-o1'), policy: policy(), tracked: true,
      precheckFailure: { reason: 'MODEL_NOT_FOUND', results: [{ route: routeA, code: 'MODEL_NOT_FOUND' }] },
    })
    const event = saved.row.outbox[0]!
    const pending = s.tasks.pendingOutbox()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.event.eventId).toBe(event.eventId)
    // A foreign message id (not naming the caller) is refused.
    const foreignId = SessionLinkMessageId('session-link-message-foreign')
    probe.putMessage(foreignId, mailRecord(bobId, carolId, linkId))
    await expect(s.tasks.markOutboxAdmitted(saved.taskId, saved.row.revision, event.eventId, foreignId))
      .rejects.toMatchObject({ code: 'LINK_CALLER_NOT_MEMBER' })
    // The right recipient admits.
    const notifyId = SessionLinkMessageId('session-link-message-notify1')
    probe.putMessage(notifyId, mailRecord(bobId, aliceId, linkId))
    const admitted = await s.tasks.markOutboxAdmitted(saved.taskId, saved.row.revision, event.eventId, notifyId)
    expect(admitted.outbox[0]).toMatchObject({ status: 'admitted', notifiedMessageId: notifyId })
    // Idempotent re-admission under the same id.
    const again = await s.tasks.markOutboxAdmitted(saved.taskId, admitted.revision, event.eventId, notifyId)
    expect(again.revision).toBe(admitted.revision)
    // Delivered is idempotent too.
    const delivered = await s.tasks.markOutboxDelivered(saved.taskId, admitted.revision, event.eventId)
    expect(delivered.outbox[0]!.status).toBe('delivered')
    const redelivered = await s.tasks.markOutboxDelivered(saved.taskId, delivered.revision, event.eventId)
    expect(redelivered.revision).toBe(delivered.revision)
    expect(s.tasks.pendingOutbox()).toHaveLength(0)
  })

  it('blocks events with a durable notificationBlocked reason (link gone etc.)', async () => {
    const s = await stack()
    const saved = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-o2'), policy: policy(), tracked: true,
      precheckFailure: { reason: 'MODEL_NOT_FOUND', results: [{ route: routeA, code: 'MODEL_NOT_FOUND' }] },
    })
    const event = saved.row.outbox[0]!
    const blocked = await s.tasks.blockOutboxEvent(saved.taskId, saved.row.revision, event.eventId, 'link_unlinked')
    expect(blocked.outbox[0]).toMatchObject({ status: 'blocked', blockedReason: 'link_unlinked' })
  })
})

describe('session-link tasks: write-boundary fault injection', () => {
  it('a failed intent write persists nothing and dispatches nothing', async () => {
    const pool = new MemoryMediaPool()
    const s = await stack(pool)
    pool.failNextWrites = 1
    await expect(s.tasks.saveTaskIntent({
      callerId: aliceId, request: spawnRequest('call-f1'), policy: policy(), tracked: true,
    })).rejects.toMatchObject({ code: 'TASK_WRITE_FAILED' })
    expect(s.tasks.getRow(taskIdFor(aliceId, 'call-f1'))).toBeUndefined()
    expect(s.tasks.listRows()).toHaveLength(0)
    // Retrying after the durable failure succeeds normally.
    const retried = await s.tasks.saveTaskIntent({
      callerId: aliceId, request: spawnRequest('call-f1'), policy: policy(), tracked: true,
    })
    expect(retried.row.taskState).toBe('preparing')
  })

  it('a failed binding write leaves the intent untouched and reports TASK_WRITE_FAILED', async () => {
    const pool = new MemoryMediaPool()
    const s = await stack(pool)
    const saved = await saveSpawn(s)
    pool.failNextWrites = 1
    await expect(s.tasks.attachBinding(saved.taskId, 1, {
      messageId: SessionLinkMessageId('session-link-message-f2'), sessionId: bobId, admittedAs: 'queued',
    })).rejects.toMatchObject({ code: 'TASK_WRITE_FAILED' })
    const row = s.tasks.getRow(saved.taskId)!
    expect(row.taskState).toBe('preparing')
    expect(row.execution.messageId).toBeUndefined()
    // The retry path reuses the same task id; no second task is created.
    const bound = await s.tasks.attachBinding(saved.taskId, 1, {
      messageId: SessionLinkMessageId('session-link-message-f2'), sessionId: bobId, admittedAs: 'queued',
    })
    expect(bound.taskState).toBe('queued')
    expect(s.tasks.listRows()).toHaveLength(1)
  })

  it('a failed state-change write commits neither the state nor its outbox events', async () => {
    const pool = new MemoryMediaPool()
    const s = await stack(pool)
    const saved = await saveSpawn(s)
    pool.failNextWrites = 1
    await expect(s.tasks.requestStateChange(saved.taskId, 1, {
      toState: 'waiting_decision', executionState: 'not_started', reason: 'MODEL_NOT_FOUND',
      events: [{ kind: 'model_unavailable', reason: 'MODEL_NOT_FOUND', decisionRequired: true, resumable: true }],
    })).rejects.toMatchObject({ code: 'TASK_WRITE_FAILED' })
    const row = s.tasks.getRow(saved.taskId)!
    expect(row.taskState).toBe('preparing')
    expect(row.outbox).toHaveLength(0)
    // The atomicity holds across a restart as well: no half-written event exists.
    await s.disposeTasks()
    const second = await stack(pool)
    expect(second.tasks.getRow(saved.taskId)!.outbox).toHaveLength(0)
    expect(second.tasks.getRow(saved.taskId)!.taskState).toBe('preparing')
  })

  it('a failed decision write leaves the task waiting and the decision unrecorded', async () => {
    const pool = new MemoryMediaPool()
    const s = await stack(pool)
    const saved = await saveSpawn(s, 'call-f4')
    const waiting = await s.tasks.requestStateChange(saved.taskId, 1, {
      toState: 'waiting_decision', executionState: 'not_started', reason: 'MODEL_NOT_FOUND',
    })
    pool.failNextWrites = 1
    await expect(s.tasks.resolveTask({
      callerId: aliceId, taskId: saved.taskId, decisionCallId: 'df1',
      expectedRevision: waiting.revision, action: 'retry',
    })).rejects.toMatchObject({ code: 'TASK_WRITE_FAILED' })
    const row = s.tasks.getRow(saved.taskId)!
    expect(row.taskState).toBe('waiting_decision')
    expect(row.decisions).toHaveLength(0)
    const decided = await s.tasks.resolveTask({
      callerId: aliceId, taskId: saved.taskId, decisionCallId: 'df1',
      expectedRevision: waiting.revision, action: 'retry',
    })
    expect(decided.outcome).toBe('applied')
  })
})

describe('session-link tasks: crash and restart', () => {
  it('reloads rows across a service restart with unchanged state and revision', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(pool)
    const saved = await saveSpawn(first)
    await first.tasks.requestStateChange(saved.taskId, 1, {
      toState: 'waiting_decision', executionState: 'partial', reason: 'interrupted-mid-turn',
    })
    await first.disposeTasks()
    const second = await stack(pool)
    const row = second.tasks.getRow(saved.taskId)!
    expect(row.taskState).toBe('waiting_decision')
    expect(row.executionState).toBe('partial')
    expect(row.revision).toBe(2)
    expect(row.policy).toEqual(policy())
  })

  it('reconcile reports a mid-binding task once, never executes it, and never duplicates the report on a second restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(pool)
    const saved = await saveSpawn(first)
    // Crash between binding commit and turn-intent commit.
    await first.tasks.attachBinding(saved.taskId, 1, {
      messageId: SessionLinkMessageId('session-link-message-crash'), sessionId: bobId, admittedAs: 'queued',
    })
    await first.disposeTasks()
    const second = await stack(pool)
    const report1 = await second.tasks.reconcile()
    expect(report1.report.resumableIntents).toHaveLength(0)
    expect(report1.report.needsBindingRepair).toHaveLength(1)
    expect(report1.notifiedRepairs).toEqual([saved.taskId])
    const repaired = second.tasks.getRow(saved.taskId)!
    expect(repaired.taskState).toBe('waiting_decision')
    expect(repaired.executionState).toBe('not_started')
    expect(repaired.reason).toBe('repair_binding_missing')
    expect(repaired.outbox.at(-1)).toMatchObject({
      kind: 'model_unavailable', reason: 'repair_binding_missing', decisionRequired: true, resumable: true, status: 'pending',
    })
    // The repair notification is an intent only: no session was created, no
    // mailbox message was fabricated, and the task is NOT executable.
    expect(second.tasks.isExecutionBound(saved.taskId)).toBe(false)
    // A second restart reports nothing twice.
    await second.disposeTasks()
    const third = await stack(pool)
    const report2 = await third.tasks.reconcile()
    expect(report2.notifiedRepairs).toHaveLength(0)
    expect(third.tasks.getRow(saved.taskId)!.outbox).toHaveLength(1)
  })

  it('reconcile classifies intent-only tasks as resumable without touching them', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(pool)
    const saved = await saveSpawn(first)
    await first.disposeTasks()
    const second = await stack(pool)
    const { report, notifiedRepairs } = await second.tasks.reconcile()
    expect(report.resumableIntents.map(row => taskIdFor(row.callerId, row.callId))).toContain(saved.taskId)
    expect(report.needsBindingRepair).toHaveLength(0)
    expect(notifiedRepairs).toHaveLength(0)
    // The row is exactly as the crash left it: replay consults it BEFORE creating anything.
    const row = second.tasks.getRow(saved.taskId)!
    expect(row.taskState).toBe('preparing')
    expect(row.revision).toBe(1)
  })

  it('reconcile pairs host orphan facts with fully bound tasks and never claims them', async () => {
    const pool = new MemoryMediaPool()
    const orphans = [{ intentId: 'intent-orphan' } ] as never[]
    const host: HostTaskHostCapability = {
      taskHostVersion: 1,
      listOrphanedTurnIntents: () => orphans,
    } as unknown as HostTaskHostCapability
    const first = await stack(pool, { hostFor: () => host })
    const saved = await saveSpawn(first)
    const messageId = SessionLinkMessageId('session-link-message-bound')
    await first.tasks.attachBinding(saved.taskId, 1, { messageId, sessionId: bobId, admittedAs: 'queued' })
    await first.tasks.recordTurnIntent(saved.taskId, 2, { turnIntentId: 'intent-bound', messageId })
    await first.disposeTasks()
    const second = await stack(pool, { hostFor: () => host })
    const { report } = await second.tasks.reconcile()
    expect(report.resumableIntents).toHaveLength(0)
    expect(report.needsBindingRepair).toHaveLength(0)
    expect(report.orphanChecks).toHaveLength(1)
    expect(report.orphanChecks[0]).toMatchObject({ taskId: saved.taskId, turnIntentId: 'intent-bound' })
    expect(report.orphanChecks[0]!.orphans).toEqual(orphans)
    // Nothing about the row changed: reconciliation is a report, not a repair.
    expect(second.tasks.getRow(saved.taskId)!.revision).toBe(3)
  })
})

describe('session-link tasks: legacy row loading', () => {
  it('opens over rows written by the same v1 schema across a domain reopen', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(pool)
    const saved = await first.tasks.saveTaskIntent({
      callerId: aliceId, request: sendRequest('call-legacy'), policy: policy(), tracked: false,
    })
    await first.disposeTasks()
    // A fresh process opening the medium: rows validate against v1 and read back.
    const second = await stack(pool)
    const row = second.tasks.getRow(saved.taskId)!
    expect(row.tracked).toBe(false)
    expect(row.taskState).toBe('preparing')
    expect(second.tasks.getTask(aliceId, saved.taskId).taskId).toBe(saved.taskId)
  })
})

describe('session-link tasks: guards', () => {
  it('isExecutionBound rejects everything without the full durable binding', async () => {
    const s = await stack()
    expect(s.tasks.isExecutionBound(SessionLinkTaskId('task:none:none'))).toBe(false)
    const saved = await saveSpawn(s)
    expect(s.tasks.isExecutionBound(saved.taskId)).toBe(false)
  })

  it('update on an absent task is MESSAGE_NOT_FOUND; mutations after dispose fail', async () => {
    const s = await stack()
    await expect(s.tasks.update(SessionLinkTaskId('task:none:none'), 0, row => row))
      .rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
    await s.disposeTasks()
    contexts.delete(s.ctx)
    await expect(s.tasks.saveTaskIntent({
      callerId: aliceId, request: spawnRequest('call-late'), policy: policy(), tracked: true,
    })).rejects.toMatchObject({ code: 'TASK_WRITE_FAILED' })
    await s.ctx.fiber.dispose()
  })
})
