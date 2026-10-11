/**
 * End-to-end tracked model-routing integration (MODEL_ROUTING_PLAN Task 4):
 * real AgentLoops on alice + bob + spawned Sessions, the real SessionLinkService
 * and SessionLinkTaskService over a shared in-memory domain, the host task-host
 * extension mounted on every live Agent, and the tool layer's tracked
 * spawn/send admission. Verification mapping (task-4 brief):
 *
 *  - spawn 首次请求即指定模型 → tracked spawn tests;
 *  - 多 step/工具回合模型一致 → the tool-call two-step test;
 *  - busy target 不被中途换模 → the busy-bob baseline tests;
 *  - 多条指定不同模型任务按顺序执行 → the two-tasks-in-order test;
 *  - fallback first-request/partial 两条分支 → first-request fallback vs
 *    mid-turn terminal failure;
 *  - 长期 CAS → session-scope persist + human_selection_changed skip;
 *  - 用户消息不受影响 → every baseline assertion after task turns;
 *  - needs_decision 同步预检失败 → precheck failure shapes + no Session;
 *  - unlink 后未启动任务不得执行 → the queue → unlink → gate drop test;
 *  - 取消语义 → target-turn cancel projecting cancelled honestly.
 *
 * Requires DSH_SOURCE_ROOT (host extension + agent-loop testkit aliasing);
 * run under `DSH_SOURCE_ROOT=… pnpm exec vitest run`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult, ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, HarnessError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  installModelSelectionProjection,
  installTaskTurnIntentsProjection,
} from '@deepseek-ai/dsh-api-session-controller'
import SessionLinkService, {
  SessionLinkId,
  SessionLinkTaskService,
  taskIdFor,
} from '../src/index.ts'
import * as toolPlugin from '../src/tools.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { MockAdapter, textResponse, toolCallResponse } from './helpers/mock-adapter.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try { await ctx.fiber.dispose() } catch (error: unknown) { failures.push(error) }
    contexts.delete(ctx)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'task-routing test cleanup failed')
})

const SIGNAL = new AbortController().signal


const BASE_MODEL = 'base-model'
const MODEL_A = 'model-a'
const MODEL_B = 'model-b'
let callCounter = 0

/** Catalog the mock Session Controller reports: mock provider serving every model id we use. */
function catalog() {
  return Promise.resolve({
    default: { provider: 'mock', model: BASE_MODEL },
    routableProviders: ['mock'],
    groups: [{
      id: 'mock',
      name: 'Mock',
      models: [BASE_MODEL, MODEL_A, MODEL_B].map(id => ({ id })),
    }],
    failures: [],
  })
}

interface Stack {
  readonly ctx: Context
  readonly alice: Agent
  readonly bob: Agent
  readonly carol: Agent
  readonly creates: readonly { cwd?: string; sessionId?: SessionId }[]
}

/**
 * Boot the full tracked-routing stack: host projections + extension on every
 * Agent (object-define onto each agent context), the link and task services on
 * the shared domain, the tool row, and three live Agents. Spawned Sessions
 * adopt `carol` in id order (like tests/tool-session-link.spec.ts).
 */
async function stack(options: {
  adapter?: MockAdapter
  links?: Record<string, number>
  modelCatalog?: () => Promise<unknown>
  toolsOnly?: boolean
} = {}): Promise<Stack> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] as readonly SessionId[] } as never)
  installModelSelectionProjection(ctx)
  installTaskTurnIntentsProjection(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], options.adapter ?? new MockAdapter([textResponse('ok')]))
  await ctx.plugin(SessionLinkService, options.links ?? {})
  // Task service mounts BEFORE the tool row but cordis inject-gates the root
  // context the tools were defined on; the test stack publishes it through the
  // documented escape hatch the accessor honors.
  const taskFiber = await ctx.plugin(SessionLinkTaskService, {
    links: {
      message: messageId => ctx.sessionLinks.message(messageId),
      pairLinked: (linkId, first, second) =>
        ctx.sessionLinks.list(first).some(link => link.id === linkId && link.memberIds.includes(second)),
    },
  })
  Object.defineProperty(ctx, '__sessionLinkTasks', { value: ctx.sessionLinkTasks })
  // Retain the service fiber's settlement promise so the runtime's intent-side
  // CAS never runs before the service initializes.
  await taskFiber.await()
  const alice = await ctx.agentLoop.create(SessionId('session-alice'), { provider: 'mock', model: BASE_MODEL })
  const bob = await ctx.agentLoop.create(SessionId('session-bob'), { provider: 'mock', model: BASE_MODEL })
  const carol = await ctx.agentLoop.create(SessionId('session-carol'), { provider: 'mock', model: BASE_MODEL })

  ctx.provide('sessionTitle', {
    get: (session: { id: SessionId }) => ({ title: `title-of-${session.id}` }),
  } as never)
  const pool = [bob.id, carol.id]
  const adopted = new Map<string, SessionId>()
  const creates: { cwd?: string; sessionId?: SessionId }[] = []
  ctx.provide('sessionController', {
    create: (request: { cwd?: string; sessionId?: SessionId }) => {
      creates.push(request)
      const key = String(request.sessionId)
      let sessionId = adopted.get(key)
      if (sessionId === undefined) {
        sessionId = pool[Math.min(adopted.size, pool.length - 1)]!
        adopted.set(key, sessionId)
      }
      return Promise.resolve({ sessionId })
    },
    rename: () => Promise.resolve({}),
    modelCatalog: options.modelCatalog ?? catalog,
  } as never)
  await ctx.plugin(toolPlugin)
  for (const agent of [alice, bob]) {
    await vi.waitFor(() => { expect(ctx.tools.get('session_list_links', agent)).toBeDefined() })
  }
  return { ctx, alice, bob, carol, creates }
}

/** Invoke one tool through the real registry path as one Agent. */
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

/** The durable request routes the adapter served, in order (GenerateOptions). */
function requestLog(adapter: MockAdapter): { provider: string; model: string }[] {
  return adapter.requests.map(request => ({ provider: request.provider, model: request.model }))
}

function modelsOf(adapter: MockAdapter): string[] {
  return requestLog(adapter).map(request => request.model)
}

/** Mail text one Session has recorded (inbox splices or claimed history). */
function mailTexts(agent: Agent): string[] {
  const seen = new Set<string>()
  const texts: string[] = []
  const collect = (source: unknown, content: readonly { type: string; text?: string }[]): void => {
    const mailSource = source as { kind?: string; messageId?: string }
    if (mailSource.kind !== 'session-link-message' || seen.has(mailSource.messageId ?? '')) return
    seen.add(mailSource.messageId ?? '')
    for (const block of content) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text)
    }
  }
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) {
        collect((message as { source?: unknown }).source, message.content)
      }
    }
    if (event.type === 'user/message') collect(event.data.source, event.data.content)
  }
  return texts
}

describe('task-routing: tracked spawn admission', () => {
  it('tracked spawn: admitted wire shape, first request on the requested model, task row bound', async () => {
    const adapter = new MockAdapter([textResponse(`done by ${MODEL_A}`)])
    const s = await stack({ adapter })
    ;(s.ctx as unknown as { on: (n: string, f: (p: unknown) => void) => void }).on('internal/listener', () => undefined)
    const result = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-spawn-A',
      task: 'review the report',
      title: 'reviewer',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-spawn-A')).value as {
      outcome: string; taskId: string; taskRevision: number; messageId: string
      status: string; sessionId: string; linkId: string; taskState: string
      requestedModel: { provider: string; model: string }
      selectedModel?: { provider: string; model: string }
    }
    expect(result.outcome).toBe('admitted')
    expect(result.taskId).toBe(String(taskIdFor(s.alice.id, 'call-spawn-A')))
    expect(result.status).toBe('accepted')
    expect(result.sessionId).toBe(s.bob.id)
    expect(result.requestedModel).toEqual({ provider: 'mock', model: MODEL_A })
    expect(result.selectedModel).toEqual({ provider: 'mock', model: MODEL_A })
    // The spawned Session's FIRST request ran on the requested route.
    await s.bob.whenIdle()
    // Close projections ride the microtask queue after the turn publishes; await their CAS settle.
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-A'))?.taskState).toBe('turn_finished')
    })
    // Durable row projection.
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-A'))
    expect(row?.taskState).toBe('turn_finished')
    expect(row?.execution.messageId).toBe(result.messageId)
    expect(row?.execution.turnIntentId).toBeDefined()
    expect(row?.execution.routeUsed?.model).toBe(MODEL_A)
    // One turn_finished outbox event, decisionRequired false.
    const finished = row?.outbox.filter(event => event.kind === 'turn_finished')
    expect(finished).toHaveLength(1)
    expect(finished?.[0]?.decisionRequired).toBe(false)
    expect(finished?.[0]?.actualModel?.model).toBe(MODEL_A)
  })

  it('multi-step task turn freezes the route across both a tool step and the final answer', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'probe', {}),
      textResponse(`finished by ${MODEL_A}`),
    ])
    const s = await stack({ adapter })
    succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-spawn-steps',
      task: 'probe then answer',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-spawn-steps'))
    await s.bob.whenIdle()
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-steps'))?.taskState).toBe('turn_finished')
    })
    // Both adapter requests of the task turn carried the frozen route.
    expect(modelsOf(adapter)).toEqual([MODEL_A, MODEL_A])
    const headers = s.bob.session.snapshotEvents()
      .filter(e => e.type === 'request/header')
      .map(e => (e.data as { header: { config: { model: string } } }).header.config.model)
    expect(headers).toEqual([MODEL_A])
  })

  it('tracked spawn never makes the sender Session use the task route', async () => {
    const adapter = new MockAdapter([
      textResponse('alice-before'),
      textResponse(`done by ${MODEL_A}`),
    ])
    const s = await stack({ adapter })
    // Alice works BEFORE the tracked spawn so her baseline request is recorded first.
    s.alice.followup(humanMessage('alice-before'))
    await s.alice.whenIdle()
    succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-spawn-human',
      task: 'task run',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-spawn-human'))
    await s.bob.whenIdle()
    // Alice's tracked-spawned task runs on the fresh session under model-a;
    // alice herself never saw the task route.
    const byAlice = modelsOf(adapter).slice(0, 2)
    expect(byAlice).toEqual([BASE_MODEL, MODEL_A])
  })

  it('tracked spawn params are rejected MODEL_PARAMS_INVALID when provider and model do not pair, before any intent exists', async () => {
    const s = await stack()
    const result = await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-badparams',
      task: 'work',
      provider: 'mock',
    }, s.alice, 'call-spawn-badparams')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('provider and model must be supplied together')
    // No task row, no Session/link created, no precheck side effects.
    expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-badparams'))).toBeUndefined()
    expect(s.creates).toHaveLength(0)
    expect(s.ctx.sessionLinks.list()).toEqual([])
  })

  it('sync precheck failure: needs_decision wire shape, durable waiting row, NO Session and NO message', async () => {
    const s = await stack()
    const result = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-precheck',
      task: 'impossible',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-spawn-precheck')).value as {
      outcome: string; taskId: string; taskRevision: number; taskState: string
      executionState: string; reason: string; attempts: number
      sessionId?: string; linkId?: string
    }
    expect(result).toMatchObject({
      outcome: 'needs_decision',
      taskId: String(taskIdFor(s.alice.id, 'call-spawn-precheck')),
      taskState: 'waiting_decision',
      executionState: 'not_started',
    })
    expect(result.sessionId).toBeUndefined()
    expect(result.linkId).toBeUndefined()
    // Exactly ONE model_unavailable outbox event, decisionRequired true, and nothing else created.
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-precheck'))
    expect(row?.taskState).toBe('waiting_decision')
    expect(row?.outbox).toHaveLength(1)
    expect(row?.outbox[0]?.kind).toBe('model_unavailable')
    expect(row?.outbox[0]?.decisionRequired).toBe(true)
    expect(s.creates).toHaveLength(0)
    expect(s.ctx.sessionLinks.list()).toEqual([])
    expect(mailTexts(s.bob)).toHaveLength(0)
    // A replay returns the SAME stored task; precheck NEVER re-runs.
    const replay = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-precheck',
      task: 'impossible',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-spawn-precheck')).value as { outcome: string; taskId: string }
    expect(replay).toMatchObject({ outcome: 'needs_decision', taskId: String(taskIdFor(s.alice.id, 'call-spawn-precheck')) })
    expect(s.creates).toHaveLength(0)
    // A different-params replay is a conflict naming session_resolve_task.
    const changed = await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-precheck',
      task: 'impossible, but different',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-spawn-precheck')
    expect(changed.isError).toBe(true)
    expect(JSON.stringify(changed.content)).toContain('session_resolve_task')
  })

  it('catalog read failure: needs_decision with catalog_unavailable reason, never an empty-model verdict', async () => {
    const s = await stack({ modelCatalog: () => Promise.reject(new Error('transport down')) })
    const result = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-catalog',
      task: 'work',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-spawn-catalog')).value as { outcome: string; reason: string }
    expect(result.outcome).toBe('needs_decision')
    expect(result.reason).toBe('catalog_unavailable')
    expect(s.creates).toHaveLength(0)
  })
})

describe('task-routing: tracked send admission', () => {
  it('tracked send to an already-linked target runs on the requested model and keeps the session baseline', async () => {
    const adapter = new MockAdapter([
      textResponse('baseline turn'),
      textResponse(`task by ${MODEL_A}`),
      textResponse('human after'),
    ])
    const s = await stack({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    // Human baseline turn on bob first.
    s.bob.followup(humanMessage('hello'))
    await s.bob.whenIdle()
    const result = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'tracked task',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-send-A')).value as {
      outcome: string; taskId: string; messageId: string; status: string
      requestedModel: { provider: string; model: string }; selectedModel?: { provider: string; model: string }
    }
    expect(result).toMatchObject({
      outcome: 'admitted',
      taskId: String(taskIdFor(s.alice.id, 'call-send-A')),
      requestedModel: { provider: 'mock', model: MODEL_A },
      selectedModel: { provider: 'mock', model: MODEL_A },
    })
    // An idle target queues (no wake grant here): wake it via an unrelated
    // human turn; that turn's inbox claim runs the queued tracked task first.
    s.bob.followup(humanMessage('plain follow-up'))
    await s.bob.whenIdle()
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-A'))?.taskState).toBe('turn_finished')
    }, { timeout: 3000 })
    await s.ctx.sessionLinks.deliverPending(s.bob.id)
    await s.bob.whenIdle()
    // Adapter log proves the sequence: baseline human turn, human follow-up baseline turn,
    // then the queued tracked task on its own route.
    expect(modelsOf(adapter).slice(-3)).toEqual([BASE_MODEL, BASE_MODEL, MODEL_A])
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-A'))
    expect(row?.taskState).toBe('turn_finished')
  })

  it('a second model-bound task to the same busy target executes IN ORDER behind the first', async () => {
    const adapter = new MockAdapter([
      textResponse(`first by ${MODEL_A}`),
      textResponse(`second by ${MODEL_B}`),
    ])
    const s = await stack({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    const first = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'task one',
      provider: 'mock', model: MODEL_A,
    }, s.alice, 'call-send-one')).value as { messageId: string }
    const second = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'task two',
      provider: 'mock', model: MODEL_B,
    }, s.alice, 'call-send-two')).value as { messageId: string }
    expect(first.messageId).not.toBe(second.messageId)
    await s.bob.whenIdle()
    // Mail order: A first, then B — the single-active lease keeps them isolated per turn.
    expect(modelsOf(adapter)).toEqual([MODEL_A, MODEL_B])
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-one'))?.taskState).toBe('turn_finished')
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-two'))?.taskState).toBe('turn_finished')
    })
    const one = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-one'))
    const two = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-two'))
    expect(one?.execution.routeUsed?.model).toBe(MODEL_A)
    expect(two?.execution.routeUsed?.model).toBe(MODEL_B)
    expect(one?.taskState).toBe('turn_finished')
    expect(two?.taskState).toBe('turn_finished')
  })

  it('send-side needs_decision includes the existing link target and creates no new state', async () => {
    const s = await stack()
    const granted = await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const result = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'unknown model task',
      provider: 'mock',
      model: 'model-absent',
    }, s.alice, 'call-send-precheck')).value as {
      outcome: string; sessionId?: string; linkId?: string; executionState: string
    }
    expect(result.outcome).toBe('needs_decision')
    expect(result.sessionId).toBe(s.bob.id)
    expect(result.linkId).toBe(String(granted.id))
    // The intent row exists, but NO mailbox message was admitted under this call.
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-precheck'))
    expect(row?.taskState).toBe('waiting_decision')
    expect(row?.execution.messageId).toBeUndefined()
    expect(mailTexts(s.bob)).toHaveLength(0)
  })
})

describe('task-routing: fallback boundaries', () => {
  it('first-request route-availability failure switches to the fallback inside the same step', async () => {
    class FailingOnce extends MockAdapter {
      constructor() { super([]) }
      override async *stream(options: GenerateOptions) {
        this.requests.push(options)
        if (options.model === MODEL_A) throw new HarnessError('upstream down', 'PROVIDER_UNAVAILABLE')
        for (const chunk of textResponse(`served by ${options.model}`)) yield chunk
      }
    }
    const adapter = new FailingOnce()
    const s = await stack({ adapter })
    const result = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-fallback',
      task: 'run with fallback',
      provider: 'mock',
      model: MODEL_A,
      on_model_unavailable: { fallbacks: [{ provider: 'mock', model: MODEL_B }] },
    }, s.alice, 'call-spawn-fallback')).value as { outcome: string; selectedModel?: { model: string } }
    expect(result.outcome).toBe('admitted')
    // Precheck selected the PRIMARY (B only resolved at runtime).
    expect(result.selectedModel?.model).toBe(MODEL_A)
    await s.bob.whenIdle()
    // The step retried on B: durable adapter log proves first-request fallback.
    expect(modelsOf(adapter)).toEqual([MODEL_A, MODEL_B])
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-fallback'))?.taskState).toBe('turn_finished')
    })
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-fallback'))
    expect(row?.taskState).toBe('turn_finished')
    expect(row?.execution.routeUsed?.model).toBe(MODEL_B)
    const attempt = row?.attempts.at(-1)
    const outcomes = attempt?.results.map(entry => `${entry.route.model}:${entry.outcome}`)
    expect(outcomes).toEqual([`${MODEL_A}:unavailable`, `${MODEL_B}:selected`])
    // The turn_finished event reports the actual route used.
    const finished = row?.outbox.filter(event => event.kind === 'turn_finished')
    expect(finished?.[0]?.actualModel?.model).toBe(MODEL_B)
    expect(finished?.[0]?.requestedModel?.model).toBe(MODEL_A)
    // F1: exactly ONE model_fallback_selected notification rode the same
    // pipeline: the failed route named as requestedModel, the replacement as
    // actualModel, decisionRequired false, and an eventId keyed by the
    // revision its own CAS committed.
    const fallbacks = row?.outbox.filter(event => event.kind === 'model_fallback_selected')
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks?.[0]?.requestedModel?.model).toBe(MODEL_A)
    expect(fallbacks?.[0]?.actualModel?.model).toBe(MODEL_B)
    expect(fallbacks?.[0]?.decisionRequired).toBe(false)
    expect(fallbacks?.[0]?.resumable).toBe(false)
    expect(fallbacks?.[0]?.eventId.endsWith(`/${fallbacks?.[0]?.revision}/model_fallback_selected`)).toBe(true)
  }, 20000)

  it('non-retryable terminal failure (refusal class) stops the task in waiting_decision with no fallback executed', async () => {
    class Refusing extends MockAdapter {
      constructor() { super([]) }
      override async *stream(options: GenerateOptions) {
        this.requests.push(options)
        throw new HarnessError('content refused', 'REFUSAL_CONTENT')
      }
    }
    const adapter = new Refusing()
    const s = await stack({ adapter })
    succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-refusal',
      task: 'refused work',
      provider: 'mock',
      model: MODEL_A,
      on_model_unavailable: { fallbacks: [{ provider: 'mock', model: MODEL_B }] },
    }, s.alice, 'call-spawn-refusal'))
    await s.bob.whenIdle().catch(() => {})
    await vi.waitFor(() => {
      const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-refusal'))
      expect(row?.taskState).toBe('waiting_decision')
    }, { timeout: 3000 })
    // ONLY model A was ever requested: a refusal never routes around the user's policy.
    expect(modelsOf(adapter)).toEqual([MODEL_A])
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-refusal'))
    expect(row?.executionState).toBe('not_started')
    expect(row?.outbox.some(event => event.kind === 'model_unavailable' && event.decisionRequired)).toBe(true)
  }, 20000)

  it('a mid-turn failure AFTER the first response is terminal: partial class forbids auto-fallback (no retry attempted)', async () => {
    // Step one emits a TEXT response (committed), step two refactor-fails.
    class LateFailing extends MockAdapter {
      constructor() { super([]) }
      override async *stream(options: GenerateOptions) {
        this.requests.push(options)
        if (this.requests.length === 1) {
          for (const chunk of toolCallResponse('call-1', 'probe', {})) yield chunk
          return
        }
        throw new HarnessError('upstream down', 'PROVIDER_UNAVAILABLE')
      }
    }
    const adapter = new LateFailing()
    const s = await stack({ adapter })
    succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-partial',
      task: 'two-step with mid-turn failure',
      provider: 'mock',
      model: MODEL_A,
      on_model_unavailable: { fallbacks: [{ provider: 'mock', model: MODEL_B }] },
    }, s.alice, 'call-spawn-partial'))
    await s.bob.whenIdle().catch(() => {})
    await vi.waitFor(() => {
      const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-partial'))
      expect(row?.taskState).toBe('waiting_decision')
    }, { timeout: 3000 })
    // Plan clause 5: once a response committed, NO auto-fallback — B is never requested.
    expect(modelsOf(adapter)).toEqual([MODEL_A, MODEL_A])
  }, 20000)
})

describe('task-routing: session-scope baseline CAS', () => {
  it('model_scope session commits only the SUCCEEDED route as the baseline; app default untouched', async () => {
    const adapter = new MockAdapter([textResponse(`done by ${MODEL_A}`)])
    const s = await stack({ adapter })
    succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-scope-session',
      task: 'persist me',
      provider: 'mock',
      model: MODEL_A,
      model_scope: 'session',
    }, s.alice, 'call-spawn-persist'))
    await s.bob.whenIdle()
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-persist'))?.taskState).toBe('turn_finished')
    })
    // The spawned Session's durable baseline is now the task route …
    const selections = s.bob.session.snapshotEvents().filter(e => e.type === 'model/selection')
    expect(selections.some(e => (e.data as { model: string }).model === MODEL_A)).toBe(true)
    // … while the row reports turn_finished with routeUsed = MODEL_A.
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-persist'))
    expect(row?.taskState).toBe('turn_finished')
    expect(row?.execution.routeUsed?.model).toBe(MODEL_A)
  })

  it('a mid-turn human selection change skips the session persist and projects persistent_selection_skipped', async () => {
    const adapter = new MockAdapter([textResponse(`done by ${MODEL_A}`)])
    const s = await stack({ adapter })
    succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-scope-skip',
      task: 'try to persist me',
      provider: 'mock',
      model: MODEL_A,
      model_scope: 'session',
    }, s.alice, 'call-spawn-persist-skip'))
    // Simulate the human's later explicit choice BEFORE the task commits:
    s.bob.session.append('model/selection', { provider: 'mock', model: 'human-model' })
    await s.bob.whenIdle()
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-persist-skip'))?.taskState).toBe('turn_finished')
    }, { timeout: 3000 })
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-spawn-persist-skip'))
    expect(row?.taskState).toBe('turn_finished')
    const finished = row?.outbox.find(event => event.kind === 'turn_finished')
    // The baseline CAS skipped and the projection says so — the human change won.
    expect(finished?.reason).toBe('persistent_selection_skipped: human_selection_changed')
    // The human's baseline holds: model selection did NOT move to the task route.
    const selections = s.bob.session.snapshotEvents()
      .filter(e => e.type === 'model/selection')
      .map(e => (e.data as { model: string }).model)
    expect(selections).toContain('human-model')
    expect(selections).not.toContain(MODEL_A)
  })
})

describe('task-routing: busy target and mismatched-model order', () => {
  it('a running busy target keeps its current request untouched; the task waits and runs on its own route', async () => {
    const adapter = new MockAdapter([
      textResponse('busy answer on base'),
      textResponse(`task by ${MODEL_A}`),
    ])
    const s = await stack({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    // Bob is ALREADY running an ordinary (baseline) turn.
    s.bob.followup(humanMessage('busy work'))
    const admission = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'queued task',
      provider: 'mock', model: MODEL_A,
    }, s.alice, 'call-send-busy')).value as { status: string; outcome: string }
    expect(admission.outcome).toBe('admitted')
    await s.bob.whenIdle()
    // The in-flight baseline request finished first, untouched by the task route.
    expect(modelsOf(adapter)).toEqual([BASE_MODEL, MODEL_A])
  })

  it('tracked and untracked tasks coexist; ONLY the tracked delivery leaves a task row', async () => {
    const adapter = new MockAdapter([
      textResponse(`tracked by ${MODEL_A}`),
      textResponse('untracked on base'),
    ])
    const s = await stack({ adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'tracked',
      provider: 'mock', model: MODEL_A,
    }, s.alice, 'call-send-tracked'))
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'untracked',
    }, s.alice, 'call-send-untracked'))
    await s.bob.whenIdle()
    // The untracked delivery ran with NO task row at all (unmanaged path).
    expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-untracked'))).toBeUndefined()
    await vi.waitFor(() => {
      expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-tracked'))?.taskState).toBe('turn_finished')
    })
    // Mail order: tracked first, untracked second.
    expect(modelsOf(adapter).length).toBe(2)
  })
})

describe('task-routing: unlink and cancellation semantics', () => {
  it('a queued tracked task never runs after unlink', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const s = await stack({ adapter })
    const granted = await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    // Bob idle with NO auto-wake grant: the task is admitted queued and stays put.
    const result = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'task waiting',
      provider: 'mock', model: MODEL_A,
    }, s.alice, 'call-send-unlinked')).value as { status: string; outcome: string }
    expect(result.outcome).toBe('admitted')
    expect(result.status).toBe('queued')
    await s.ctx.sessionLinks.unlink(granted.id)
    // Even once bob wakes for an unrelated human turn, the dropped grant means
    // the task message is revoked at delivery time and no request ever runs.
    s.bob.followup(humanMessage('unrelated'))
    await s.ctx.sessionLinks.deliverPending(s.bob.id)
    await s.bob.whenIdle()
    expect(modelsOf(adapter)).toEqual([BASE_MODEL])
    expect(mailTexts(s.bob)).toHaveLength(0)
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-unlinked'))
    expect(row?.taskState).not.toBe('running')
    expect(row?.taskState).not.toBe('turn_finished')
  })

  it('target-side user cancel of the claimed turn projects cancelled + a cancelled outbox event', async () => {
    class Hanging extends MockAdapter {
      constructor() { super(['hang-slow']) }
    }
    const s = await stack({ adapter: new Hanging() })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'long task',
      provider: 'mock', model: MODEL_A,
    }, s.alice, 'call-send-cancel'))
    await vi.waitFor(() => {
      const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-cancel'))
      expect(row?.taskState).toBe('running')
    })
    s.bob.cancel({ kind: 'user' }, {})
    await s.bob.whenIdle().catch(() => {})
    await vi.waitFor(() => {
      const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-cancel'))
      expect(row?.taskState).toBe('interrupted')
    }, { timeout: 3000 })
    const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'call-send-cancel'))
    expect(row?.outbox.some(event => event.kind === 'interrupted')).toBe(true)
  }, 20000)

  it('spawn replay under a CHANGED catalog returns the stored task as-is (no re-precheck)', async () => {
    const s = await stack()
    const args = {
      cwd: '/tmp/task-routing-replay',
      task: 'replayable work',
      provider: 'mock',
      model: MODEL_A,
    }
    const first = succeeded(await call(s.ctx, 'session_spawn_linked_session', args, s.alice, 'call-spawn-replay')).value as { taskId: string; status: string }
    await s.bob.whenIdle()
    // Swap the catalog so a fresh precheck would now fail: replay must not care.
    ;(s.ctx.sessionController as unknown as { modelCatalog: () => Promise<unknown> }).modelCatalog =
      () => Promise.resolve({ default: { provider: 'mock', model: BASE_MODEL }, groups: [{ id: 'mock', models: [{ id: BASE_MODEL }] }], failures: [] })
    const replay = succeeded(await call(s.ctx, 'session_spawn_linked_session', args, s.alice, 'call-spawn-replay')).value as {
      outcome: string; taskId: string; status: string
    }
    expect(replay.outcome).toBe('admitted')
    expect(replay.taskId).toBe(first.taskId)
    expect(s.creates).toHaveLength(1)
    // Exactly ONE spawned Session, one admitted message, one group.
    expect(mailTexts(s.bob).length).toBe(1)
  })
})

/** One plain human message for followup turns. */
function humanMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  } as never
}

/** Resolve the live host capability for one test Agent via the plugin's resolver. */
function resolveTaskHostRef(agent: Agent): ReturnType<typeof import('../src/host-capability.ts').resolveTaskHost> {
  try {
    return (agent.ctx as unknown as { taskHost?: unknown }).taskHost as ReturnType<typeof import('../src/host-capability.ts').resolveTaskHost>
  } catch {
    return undefined
  }
}

/* Task 6: tool-result presentation — the legacy first-segment stays byte-
 * identical, and the tracked-task sidecar carries the card facts. */
describe('task-routing: result presentation', () => {
  it('tracked spawn admitted keeps the legacy first segment byte-identical and appends the task sidecar', async () => {
    const adapter = new MockAdapter([textResponse(`done by ${MODEL_A}`)])
    const s = await stack({ adapter })
    const result = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-render-A',
      task: 'review the report',
      title: 'reviewer',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-render-A'))
    const blocks = result.content.filter(block => block.type === 'text')
    expect(blocks.length).toBe(2)
    // The FIRST segment is exactly the Task-4 tracked shape the client card
    // patterns replay; today and before Task 6 it is byte-identical.
    expect(blocks[0]!.text).toBe(
      `task task:${s.alice.id}:call-render-A admitted: session ${s.bob.id} linked (${blocks[0]!.text!.match(/linked \((\S+)\)/)?.[1]})`
      + `; task message ${(result.value as { messageId: string }).messageId} accepted`
      + ` (requested mock/${MODEL_A}, selected mock/${MODEL_A})`,
    )
    // The sidecar carries the machine-readable card facts AFTER the legacy text.
    expect(blocks[1]!.text).toContain('session-link/task-result')
    const jsonStart = blocks[1]!.text!.indexOf('{')
    const parsed = JSON.parse(blocks[1]!.text!.slice(jsonStart)) as Record<string, unknown>
    expect(parsed.type).toBe('session-link/task-result')
    expect(parsed.outcome).toBe('admitted')
    expect(parsed.taskId).toBe(`task:${s.alice.id}:call-render-A`)
    expect(parsed.scope).toBe('task')
    expect(parsed.sessionId).toBe(s.bob.id)
    expect(parsed.requestedModel).toEqual({ provider: 'mock', model: MODEL_A })
    expect(parsed.selectedModel).toEqual({ provider: 'mock', model: MODEL_A })
    await s.bob.whenIdle()
  })

  it('legacy spawn/send first segments stay byte-identical and carry NO sidecar', async () => {
    const s = await stack()
    const spawned = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-render-legacy', task: 'legacy task',
    }, s.alice, 'call-render-legacy'))
    const blocks = spawned.content.filter(block => block.type === 'text')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toMatch(/^session \S+ created and linked \(\S+\); task message \S+ (queued|accepted)$/)
    await s.bob.whenIdle()
    const sent = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id, message: 'legacy ping',
    }, s.alice, 'call-render-legacy-send'))
    const sentBlocks = sent.content.filter(block => block.type === 'text')
    expect(sentBlocks).toHaveLength(1)
    expect(sentBlocks[0]!.text).toMatch(/^message \S+ (accepted by|queued for) session \S+( \(durable; awaits the peer's next turn\))?$/)
    await s.bob.whenIdle()
  })

  it('spawn precheck failure renders needs_decision with no sessionId in the sidecar (no fake session jump)', async () => {
    const s = await stack()
    const result = succeeded(await call(s.ctx, 'session_spawn_linked_session', {
      cwd: '/tmp/task-routing-render-fail',
      task: 'will not start',
      provider: 'mock', model: 'model-absent',
    }, s.alice, 'call-render-fail'))
    const blocks = result.content.filter(block => block.type === 'text')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toContain('needs a decision')
    expect(blocks[0]!.text).toContain('no Session was created and nothing was sent')
    const jsonStart = blocks[1]!.text!.indexOf('{')
    const parsed = JSON.parse(blocks[1]!.text!.slice(jsonStart)) as Record<string, unknown>
    expect(parsed.outcome).toBe('needs_decision')
    expect(parsed.sessionId).toBeUndefined()
    expect(parsed.linkId).toBeUndefined()
    expect(parsed.taskState).toBe('waiting_decision')
    expect(parsed.executionState).toBe('not_started')
  })
})
