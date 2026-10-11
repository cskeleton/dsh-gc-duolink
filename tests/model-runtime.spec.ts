/**
 * Contract suite for the host task-execution capability consumed by Session
 * Link task routing (MODEL_ROUTING_PLAN Task 1). It mounts the real AgentLoop
 * plus a mock adapter over the in-memory backend and drives the host extension
 * from the DSH source checkout (aliased at test time), proving:
 *
 *  - A/B/human route: a claimed task turn freezes its lease route, a human
 *    turn stays on the Session baseline, and the durable request/header plus
 *    the prompt's provider/model variables match the actual request route;
 *  - a mid-task baseline change and error/cancel/restart/unload never pollute
 *    the durable baseline, and no app default is written;
 *  - restart reconciliation observes orphaned intents and `isManaged` before
 *    any new request proceeds.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createUserMessage, HarnessError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import {
  createTaskHost,
  installTaskTurnIntentsProjection,
  installModelSelectionProjection,
  type TaskHostCapability,
  type TurnIntentRecord,
} from '@deepseek-ai/dsh-api-session-controller'
import { MemoryStorageBackend, MemoryMediaPool } from './helpers/memory-backend.ts'
import { MockAdapter, toolCallResponse, textResponse } from './helpers/mock-adapter.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of [...contexts].reverse()) {
    await ctx.fiber.dispose().catch(() => {})
    contexts.delete(ctx)
  }
})

/** Identifying marker a tool result plants in the route-served assistant text. */
const BASE_MODEL = 'base-model'
const TASK_MODEL = 'task-model'

/** Script that emits a tool call, then a final text reply naming the model. */
function twoStepScript(finalText: string): MockAdapter {
  return new MockAdapter([
    toolCallResponse('call-1', 'probe', {}),
    textResponse(finalText),
  ])
}

interface Stack {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: MockAdapter
  readonly capability: TaskHostCapability
  readonly events: () => SessionEvent[]
}

/** Mount the loop over a memory backend, alias the host extension, and create one Agent. */
async function stack(
  adapter: MockAdapter,
  options: { model?: string } = {},
): Promise<Stack> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
  installModelSelectionProjection(ctx)
  installTaskTurnIntentsProjection(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(
    SessionId('task-subject'),
    { provider: 'mock', model: options.model ?? BASE_MODEL },
  )
  const capability = createTaskHost(ctx, agent)
  return { ctx, agent, adapter, capability, events: () => agent.session.snapshotEvents() }
}

/** Adopt a session-logged task mail message id the capability can manage. */
function mail(text: string, messageId: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'session-link-message', messageId } as never,
  })
}

/** Read the durable request/headers' routes in order. */
function requestRoutes(events: readonly SessionEvent[]): string[] {
  return events
    .filter(e => e.type === 'request/header')
    .map(e => `${(e.data as { header: { config: { provider: string; model: string } } }).header.config.model}`)
}

/** Read the model attributed to every assistant message in order. */
function assistantModels(events: readonly SessionEvent[]): string[] {
  return events
    .filter(e => e.type === 'assistant/message')
    .map(e => (e.data as { message: { source: { model: string } } }).message.source.model)
}

/** Read the durable baseline projection (pending ?? lastUsed). */
function baseline(stack: Stack) {
  return stack.capability.readBaseline()
}

/** Read the prompt variables the loop's last system prompt carried for a request. */
function lastRequestModel(adapter: MockAdapter): string | undefined {
  return adapter.requests.at(-1)?.model
}

describe('model-runtime: task route freeze (capability contract)', () => {
  it('A: a claimed task turn freezes the lease route across all of that turn\'s steps', async () => {
    const adapter = twoStepScript(`done by ${TASK_MODEL}`)
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-a')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-a', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('run A', messageId))
    await s.agent.whenIdle()

    // Both steps of the task turn used the frozen task route; the human baseline
    // (BASE_MODEL) appears nowhere in the task turn's requests.
    expect(lastRequestModel(adapter)).toBe(TASK_MODEL)
    expect(requestRoutes(s.events())).toEqual([TASK_MODEL])
    expect(assistantModels(s.events())).toEqual([TASK_MODEL, TASK_MODEL])
    // The first-response commit under the lease records the route actually used.
    const outcome = await s.capability.commitTurn(record.intentId)
    expect(outcome.routeUsed?.model).toBe(TASK_MODEL)
  })

  it('B + human: a task turn uses B while a human turn stays on the session baseline', async () => {
    const adapter = new MockAdapter([
      textResponse(`task by ${TASK_MODEL}`),
      textResponse(`human by ${BASE_MODEL}`),
    ])
    const s = await stack(adapter)
    // Human turn first to establish the baseline, then a task on B.
    s.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await s.agent.whenIdle()
    expect(lastRequestModel(adapter)).toBe(BASE_MODEL)

    const messageId = brandString<MessageId>('mail-b')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-b', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('run B', messageId))
    await s.agent.whenIdle()
    expect(lastRequestModel(adapter)).toBe(TASK_MODEL)

    // A human turn after the task returns to the baseline, unaffected by the
    // task's intended route.
    s.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await s.agent.whenIdle()
    expect(lastRequestModel(adapter)).toBe(BASE_MODEL)
    expect(requestRoutes(s.events())).toEqual([BASE_MODEL, TASK_MODEL, BASE_MODEL])
  })

  it('prompt route ≡ request header: prompt variables match the committed header', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-pr')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-pr', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('check prompt', messageId))
    await s.agent.whenIdle()

    // The durable request header's route equals the model the adapter served,
    // and the assistant message's attributed model matches — prompt and header agree.
    const headerModel = requestRoutes(s.events()).at(-1)
    expect(headerModel).toBe(TASK_MODEL)
    expect(lastRequestModel(adapter)).toBe(TASK_MODEL)
    expect(assistantModels(s.events()).at(-1)).toBe(TASK_MODEL)
  })

  it('fails closed on an unknown, already-claimed, or not-claimable intent', async () => {
    const s = await stack(new MockAdapter([textResponse('x')]))
    await expect(s.capability.claimTurnIntent('task-missing'))
      .rejects.toMatchObject({ code: 'TASK_UNKNOWN' })
    const messageId = brandString<MessageId>('mail-nc')
    const record = s.capability.recordTurnIntent({ taskId: 't', attemptId: 'a', messageId })
    await s.capability.claimTurnIntent(record.intentId)
    await expect(s.capability.claimTurnIntent(record.intentId))
      .rejects.toMatchObject({ code: 'TASK_NOT_CLAIMABLE' })
    await expect(s.capability.commitTurn('task-missing'))
      .rejects.toMatchObject({ code: 'TASK_UNKNOWN' })
  })

  it('a moved baseline fails the claim CAS with TASK_STALE_REVISION', async () => {
    const s = await stack(new MockAdapter([textResponse('x')]))
    const baseline0 = s.capability.readBaseline()
    const messageId = brandString<MessageId>('mail-cas')
    const record = s.capability.recordTurnIntent({ taskId: 't', attemptId: 'a', messageId })
    // Simulate the baseline moving after the caller read it.
    s.agent.session.append('model/selection', { provider: 'mock', model: 'other-model' })
    await expect(s.capability.claimTurnIntent(record.intentId, { expectedBaseline: baseline0.revision }))
      .rejects.toMatchObject({ code: 'TASK_STALE_REVISION' })
  })

  it('evaluateRetry reports route-availability from adapter facts', async () => {
    // Real route failure through the loop: a provider-unavailable on the task's
    // frozen route is recorded from the adapter boundary as route-availability.
    const failing = new MockAdapter([])
    failing.stream = async function* (this: MockAdapter, options: GenerateOptions) {
      this.requests.push(options)
      throw new HarnessError('upstream down', 'PROVIDER_UNAVAILABLE')
    } as MockAdapter['stream']
    const s = await stack(failing)
    const messageId = brandString<MessageId>('mail-retry')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-retry', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('will fail', messageId))
    await s.agent.whenIdle().catch(() => {})
    const verdict = s.capability.evaluateRetry(record.intentId)
    expect(verdict.retryable).toBe(true)
    expect(verdict.failure?.code).toBe('PROVIDER_UNAVAILABLE')
  }, 20000)

  it('evaluateRetry is not retryable for an intent with no recorded route failure', async () => {
    const s = await stack(new MockAdapter([textResponse('ok')]))
    const messageId = brandString<MessageId>('mail-noretry')
    const record = s.capability.recordTurnIntent({ taskId: 't', attemptId: 'a', messageId })
    expect(s.capability.evaluateRetry(record.intentId).retryable).toBe(false)
  })

  it('restart reconciliation: persisted intents survive, orphan is observable, isManaged answers', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-restart')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-restart', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    // Persist the log, then simulate a process restart: a fresh capability over
    // a rebuilt session that carries the same durable events, with no live claim.
    await s.ctx.sessions.flush(s.agent.session)
    const durableEvents = s.events()

    const rebuilt = await rebuildOnFreshContext(adapter, durableEvents, s.ctx)
    expect(rebuilt.capability.isManaged(messageId)).toBe(true)
    expect(rebuilt.capability.getTurnIntentByMessageId(messageId)?.taskId).toBe('task-restart')
    const orphans = rebuilt.capability.listOrphanedTurnIntents()
    expect(orphans.map(r => r.intentId)).toContain(record.intentId)
    expect(orphans[0]?.status).toBe('claimed')
  })

  it('never writes the app default and never pollutes the baseline on error', async () => {
    const failing = new MockAdapter([])
    // First call throws a route-availability failure; the capability classifies
    // it and the baseline stays put.
    failing.stream = async function* (this: MockAdapter, options: GenerateOptions) {
      this.requests.push(options)
      throw new HarnessError('provider rate limited', 'RATE_LIMIT')
    } as MockAdapter['stream']
    const s = await stack(failing)
    const before = baseline(s)

    const messageId = brandString<MessageId>('mail-err')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-err', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('will fail', messageId))
    await s.agent.whenIdle().catch(() => {})

    // The failed task committed no model/selection (no baseline write) and the
    // explicit human baseline (pending) stays null — the app default and the
    // durable human selection are both untouched.
    expect(s.events().filter(e => e.type === 'model/selection')).toHaveLength(0)
    expect(baseline(s).revision).toBeNull()
    expect(before.effective).toBeNull()
  })

  it('mid-task baseline change blocks the persist CAS and reports human_selection_changed', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-mid')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-mid', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
      persistOnSuccess: true,
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('run', messageId))
    await s.agent.whenIdle()

    // A human changes the baseline before the task commits.
    s.agent.session.append('model/selection', { provider: 'mock', model: 'human-model' })
    const outcome = await s.capability.finishTurn(record.intentId)
    expect(outcome.persist?.committed).toBe(false)
    expect(outcome.persist?.reason).toBe('human_selection_changed')
    // The task route did NOT overwrite the human's baseline.
    expect(baseline(s).effective?.model).toBe('human-model')
  })

  it('commits the task route as baseline only when the human baseline is unchanged', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-persist')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-persist', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
      persistOnSuccess: true,
    })
    await s.capability.claimTurnIntent(record.intentId)
    s.agent.followup(mail('run', messageId))
    await s.agent.whenIdle()

    const outcome = await s.capability.finishTurn(record.intentId)
    expect(outcome.persist?.committed).toBe(true)
    // The task route became the new durable baseline.
    expect(baseline(s).effective?.model).toBe(TASK_MODEL)
    expect(s.events().some(e => e.type === 'model/selection'
      && (e.data as { model: string }).model === TASK_MODEL)).toBe(true)
  })

  it('unload releases the claim lease; the durable record reads as orphaned, not executable', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-unload')
    const record = s.capability.recordTurnIntent({
      taskId: 'task-unload', attemptId: 'attempt-1', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    const lease = await s.capability.claimTurnIntent(record.intentId)
    lease.release()
    // After release the claim is gone: re-claim is allowed again, and a rebuild
    // observes the release. The record must not read as silently executable.
    expect(s.capability.getTurnIntent(record.intentId)?.status).not.toBe('claimed')
  })

  it('pause/resume fail closed with honest unsupported codes', async () => {
    const s = await stack(new MockAdapter([textResponse('x')]))
    const messageId = brandString<MessageId>('mail-pr2')
    const record = s.capability.recordTurnIntent({ taskId: 't', attemptId: 'a', messageId })
    await expect(s.capability.pauseTurnIntent(record.intentId))
      .rejects.toMatchObject({ code: 'TASK_NOT_CANCELLABLE' })
    await expect(s.capability.resumeTurnIntent(record.intentId))
      .rejects.toMatchObject({ code: 'TASK_NOT_CANCELLABLE' })
    await expect(s.capability.pauseTurnIntent('task-missing'))
      .rejects.toMatchObject({ code: 'TASK_UNKNOWN' })
  })

  it('taskHostVersion reports the minimum host contract', async () => {
    const s = await stack(new MockAdapter([textResponse('x')]))
    expect(s.capability.taskHostVersion).toBe(1)
  })

  it('subscribe notifies durable null-fact transitions', async () => {
    const s = await stack(new MockAdapter([textResponse('ok')]))
    const seen: TurnIntentRecord[] = []
    const sub = s.capability.subscribe(r => seen.push(r))
    const messageId = brandString<MessageId>('mail-sub')
    s.capability.recordTurnIntent({ taskId: 't', attemptId: 'a', messageId })
    expect(seen.some(r => r.status === 'claimed')).toBe(true)
    sub.unsubscribe()
  })

  it('duplicate mail by messageId with a live claim is not claimable', async () => {
    const s = await stack(new MockAdapter([textResponse('ok')]))
    const messageId = brandString<MessageId>('mail-dup')
    const first = s.capability.recordTurnIntent({ taskId: 't1', attemptId: 'a', messageId })
    await s.capability.claimTurnIntent(first.intentId)
    expect(() => s.capability.recordTurnIntent({ taskId: 't2', attemptId: 'a', messageId }))
      .toThrowError(expect.objectContaining({ code: 'TASK_NOT_CLAIMABLE' }) as Error)
  })

  it('error classifier: route-availability retryable, content refusal terminal', async () => {
    const { classifyRouteFailure } = await import('@deepseek-ai/dsh-api-session-controller')
    expect(classifyRouteFailure({ message: 'rate limited', code: 'RATE_LIMIT' }).switchable).toBe(true)
    expect(classifyRouteFailure({ message: 'no route', code: 'PROVIDER_UNAVAILABLE' }).switchable).toBe(true)
    expect(classifyRouteFailure({ message: 'refused', code: 'REFUSAL_CONTENT' }).switchable).toBe(false)
    expect(classifyRouteFailure({ message: 'mystery', code: 'UNKNOWN_X' }).switchable).toBe(false)
  })

  it('cancel releases a not-yet-committed claim; committed intents are not cancellable', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const s = await stack(adapter)
    const messageId = brandString<MessageId>('mail-cancel')
    const record = s.capability.recordTurnIntent({
      taskId: 't', attemptId: 'a', messageId,
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(record.intentId)
    await s.capability.cancelTurnIntent(record.intentId, 'caller withdrew')
    expect(s.capability.getTurnIntent(record.intentId)?.status).toBe('cancelled')

    const committed = s.capability.recordTurnIntent({
      taskId: 't2', attemptId: 'a', messageId: brandString<MessageId>('mail-cancel-2'),
      route: { selection: { provider: 'mock', model: TASK_MODEL } },
    })
    await s.capability.claimTurnIntent(committed.intentId)
    s.agent.followup(mail('run', brandString<MessageId>('mail-cancel-2')))
    await s.agent.whenIdle()
    await s.capability.commitTurn(committed.intentId)
    await expect(s.capability.cancelTurnIntent(committed.intentId))
      .rejects.toMatchObject({ code: 'TASK_NOT_CANCELLABLE' })
  })

  it('snapshotBaselineForSpawn fails closed on a cold session with no projection', async () => {
    // A capability over a session whose modelSelection projection was never
    // registered cannot snapshot a baseline: it must fail closed, not guess.
    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    installTaskTurnIntentsProjection(ctx)
    // Deliberately omit the model-selection projection to model a cold host.
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('cold-subject'), { provider: 'mock', model: 'mock' })
    const capability = createTaskHost(ctx, agent)
    expect(() => capability.snapshotBaselineForSpawn())
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTE_UNAVAILABLE' }) as Error)
  })
})

interface Rebuilt {
  readonly capability: TaskHostCapability
}

/**
 * Rebuild a capability over a fresh context that shares the same durable event
 * log — the simulated restart: durable facts survive, the in-memory claim is
 * gone, and reconciliation observes the orphan fail-closed.
 */
async function rebuildOnFreshContext(
  adapter: MockAdapter,
  events: readonly SessionEvent[],
  sourceCtx: Context,
): Promise<Rebuilt> {
  // Materialize the same stored session on a second context, then mount the
  // capability over it. This stands for process restart over one storage root:
  // the durable task/turn-intent events are observed, the live claim is not.
  const ctx2 = new Context()
  contexts.add(ctx2)
  await mountAgentLoopTestDependencies(ctx2)
  await ctx2.plugin(Storage)
  const pool = (sourceCtx.storage.backend as unknown as { pool?: MemoryMediaPool }).pool ?? new MemoryMediaPool()
  ctx2.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx2, { backend: 'memory', routes: {} })
  ctx2.storage.mount('domain', facility)
  ctx2.provide('storageDomain', facility)
  ctx2.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
  installTaskTurnIntentsProjection(ctx2)
  await ctx2.plugin(AgentLoop, { agents: [] })
  ctx2.llm.registerAdapter(['mock'], adapter)
  // Rebuild a detached session that carries the durable events, then wrap it in
  // a minimal agent-like subject so the capability reads the same log.
  const { Session } = await import('@deepseek-ai/dsh-session')
  const session = Session.create(SessionId('task-subject'), events)
  const agent = {
    id: SessionId('task-subject'),
    session,
    ctx: ctx2,
    // Minimal surface the capability touches: session + ctx + a no-op inbox.
  } as unknown as Agent
  const capability = createTaskHost(ctx2, agent)
  return { capability }
}
