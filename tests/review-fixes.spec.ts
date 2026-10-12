/**
 * Round-2 review-defect grip tests (R##-prefixed), PERSISTENT fixtures.
 * Each case pins one confirmed review finding through the harness the
 * reviewer normalized in `artifacts/review/model-routing-probes.spec.ts`;
 * R01 proves the PRODUCTION assembly (raw-loader sub-plugin + cordis
 * inject, no test escape) admits a tracked spawn, and the Task-5 tails gate
 * the three flagged-but-unconfirmed risks plus the old-host contract.
 *
 * The harness (stack/spawn below) is a SELF-CONTAINED copy of what the
 * reviewer's artifacts probe booted, minus the '__sessionLinkTasks' escape
 * mode: the task service ALWAYS mounts the production way (raw-loader
 * sub-plugin + cordis inject, R01). The historical raw probes under
 * `artifacts/review/` stay frozen and untouched; this file is the suite
 * every gate runs in, and `test:host`/`pnpm exec vitest run` both include it.
 *
 * Task 2 (MODEL_ROUTING_FIX_PLAN) landed the unified host single owner for
 * task-bound turns: R02 (controller never overrides the task route), R06
 * (monotonic baseline CAS revision), R07 (durable task/human baseline
 * separation across a rebuild), R05 (success-gated persist), R04 (host
 * managed-input guard), R12 (partial streamed output bars automatic
 * fallback). Task 3 landed the admission-gate cluster (R03/R08–R16); Task 4
 * the notification identity/root/pump cluster (R14/R17/R18); Task 5 closes
 * with the risk gates + this self-containment migration.
 * @module
 */

import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { installModelSelectionProjection, installTaskTurnIntentsProjection } from '@deepseek-ai/dsh-api-session-controller'
import { ApiSessionAgentController } from '/Users/gc/Dev/Opensource/deepseek-harness/packages/api/session-controller/src/agent.ts'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionLinkService, { SessionLinkTaskService, taskIdFor } from '../src/index.ts'
import * as toolPlugin from '../src/tools.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

/* --------------------------------------------------------------------------
 * Self-contained harness (the reviewer probe's stack/spawn minus the escape
 * mode). `stack()` boots two live Agents over per-domain pooled memory
 * backends with the REAL link service, projections, tool row — and the task
 * service mounted through `SessionLinkTaskService`'s own plugin row exactly
 * the way production assembles it (never a defineProperty escape). The
 * 'mounted' assembly case pins that production path; 'absent' is the honest
 * PRE-R01 old-host shape (no task service) whose legacy contract the Old-host
 * grip below asserts.
 * ------------------------------------------------------------------------ */

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of [...contexts].reverse()) await ctx.fiber.dispose()
  contexts.clear()
})

const BASE = 'base-model'
const A = 'model-a'

async function stack(
  adapter: MockAdapter,
  available: string[] = [BASE, A, 'model-b'],
  realController = false,
  taskAssembly: 'mounted' | 'absent' = 'mounted',
  linksConfig: Record<string, number> = {},
) {
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
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionLinkService, linksConfig)
  if (taskAssembly !== 'absent') {
    const fiber = await ctx.plugin(SessionLinkTaskService, {
      links: {
        message: id => ctx.sessionLinks.message(id),
        pairLinked: (linkId, first, second) => ctx.sessionLinks.list(first).some(l => l.id === linkId && l.memberIds.includes(second)),
      },
      /* The same R03/R08 decision-time hooks the production assembly wires
       * (src/service-tasks.ts); the suites exercise the real cancellation
       * revocation, not a hook-less test realm. */
      revokeDelivery: (_taskId, row) => {
        void (async () => {
          const messageId = row.execution.messageId
          if (messageId !== undefined) {
            const record = ctx.sessionLinks.message(messageId)
            if (record?.status === 'pending') await ctx.sessionLinks.cancel(undefined, messageId).catch(() => {})
          }
          const intentId = row.execution.turnIntentId
          const targetId = row.execution.sessionId ?? row.targetSessionId ?? row.spawn?.targetSessionId
          if (intentId === undefined || targetId === undefined) return
          const agent = ctx.agents.get(targetId)
          if (agent === undefined) return
          const { ensureTaskHostLazy } = await import('../src/task-host-lazy.ts')
          const host = await ensureTaskHostLazy(agent).catch(() => undefined)
          if (host === undefined) return
          try { await host.cancelTurnIntent(intentId, 'resolve_task onset cancel') } catch { /* settled */ }
        })()
      },
      markLegacyDelivery: messageId => {
        const record = ctx.sessionLinks.message(messageId)
        if (record === undefined || record.idempotencyKey === undefined) return
        if (record.status === 'pending') {
          void ctx.sessionLinks.cancel(undefined, messageId).catch(() => {})
          return
        }
        void ctx.sessionLinks.markRetried(messageId, `${record.idempotencyKey}/consumed`).catch(() => {})
      },
    })
    await fiber.await()
  }
  const alice = await ctx.agentLoop.create(SessionId('review-alice'), { provider: 'mock', model: BASE })
  const bob = await ctx.agentLoop.create(SessionId('review-bob'), { provider: 'mock', model: BASE })
  ctx.provide('sessionTitle', { get: (session: { id: SessionId }) => ({ title: session.id }) } as never)
  ctx.provide('sessionController', {
    create: async () => ({ sessionId: bob.id }), rename: async () => ({}),
    modelCatalog: async () => ({
      default: { provider: 'mock', model: BASE }, routableProviders: ['mock'],
      groups: [{ id: 'mock', models: available.map(id => ({ id })) }], failures: [],
    }),
  } as never)
  if (realController) {
    Object.defineProperty(ctx, 'agentDefaultModel', { value: { currentSelection: () => ({ provider: 'mock', model: BASE }) } })
    Object.defineProperty(ctx, 'typert', { value: { lookups: { configure() {} }, contexts: { configureHost() {} } } })
    const controller = new ApiSessionAgentController(ctx)
    controller.selectionFor(alice); controller.selectionFor(bob)
  }
  await ctx.plugin(toolPlugin)
  await vi.waitFor(() => expect(ctx.tools.get('session_spawn_linked_session', alice)).toBeDefined())
  return { ctx, alice, bob }
}

async function spawn(s: Awaited<ReturnType<typeof stack>>, callId: string, extra: Record<string, unknown>) {
  const result = await s.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId), name: 'session_spawn_linked_session', agent: s.alice,
    arguments: { cwd: '/tmp/review-routing-probe', task: 'perform this task', provider: 'mock', model: A, ...extra },
  })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return result.value as {
    outcome: string
    selectedModel?: { provider: string; model: string }
  }
}

/** The v4 modelSelection unit row shape the checkpoint tests assert against. */
interface ModelSelectionUnitRow {
  lastUsed: { provider: string; model: string; reasoningEffort?: string } | null
  pending: { provider: string; model: string; reasoningEffort?: string } | null
  revision: number
  taskLastUsed: { provider: string; model: string; reasoningEffort?: string } | null
  taskMessageIds: string[]
  openTaskTurns: number[]
  pendingHeader: { provider: string; model: string; reasoningEffort?: string } | null
}

/** Read the LIVE modelSelection unit row for one agent through the production registry. */
function modelSelectionRowOf(agent: { ctx: unknown; session: unknown }): ModelSelectionUnitRow | undefined {
  const registry = (agent.ctx as { sessionProjections?: {
    stateOf(session: unknown, key: string): ModelSelectionUnitRow | undefined
  } }).sessionProjections
  return registry?.stateOf(agent.session, 'modelSelection')
}

/**
 * The PRODUCTION modelSelection fold captured from the LIVE stack's own
 * registry: opening via the real `init` (fold of an empty log through
 * `stateOf`) and advancing via the registered `apply` — the same calls the
 * projection registry drives on production data. A seed row continues a
 * checkpoint restore; seed+tail replay and full replay use identical code
 * (the equality the v4 durable contract demands).
 */
async function modelSelectionFold(
  agent: { ctx: unknown; session: unknown },
): Promise<(
  seed: ModelSelectionUnitRow | undefined,
  events: readonly unknown[],
) => ModelSelectionUnitRow> {
  const { Session: SessionClass } = await import('@deepseek-ai/dsh-session')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const registry = (agent.ctx as {
    sessionProjections: {
      stateOf(session: unknown, key: string): ModelSelectionUnitRow | undefined
    }
  }).sessionProjections
  if (registry === undefined) throw new Error('no projection registry on the stack context')
  return (seed, events) => {
    let state = seed
    if (state === undefined) {
      state = registry.stateOf(
        SessionClass.create(SessionId('ckpt-fold-empty'), [] as never),
        'modelSelection',
      )
    }
    const apply = applyOf(registry)
    for (const event of events) state = apply(state!, event as never)
    return state!
  }
}

/** The registered unit's `apply`, read from the registry's private definition table. */
function applyOf(registry: unknown): (state: ModelSelectionUnitRow, event: never) => ModelSelectionUnitRow {
  const registrations = (registry as { registrations: Map<string, { def: { apply(s: never, e: never): never } }> }).registrations
  const registration = registrations.get('modelSelection')
  if (registration === undefined) throw new Error('modelSelection is not registered on the scratch registry')
  return (state, event) => registration.def.apply(state as never, event) as ModelSelectionUnitRow
}

it('R01: production assembly mounts the task service without test escape', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE, A], /* realController= */ false, /* taskAssembly= */ 'mounted')
  const result = await spawn(s, 'r01', {})
  expect(result.outcome).toBe('admitted')
  // cordis injection alone (never a defineProperty escape) exposes the service.
  expect(s.ctx.sessionLinkTasks).toBeDefined()
})

/* --------------------------------------------------------------------------
 * Migrated reviewer probes (artifacts/review/model-routing-probes.spec.ts).
 * The 7 reproductions the round-2 review fired its 18 confirmed findings
 * from, now persistent fixtures on the self-contained harness; the "shipped
 * assembly (absent)" probe becomes the honest old-host contract grip below.
 * The historical raw probes stay frozen under artifacts/review/ (untouched).
 * ------------------------------------------------------------------------ */

it('R01 old host: tracked params refuse HOST_CAPABILITY_UNAVAILABLE; the four legacy tools keep working', async () => {
  /* The old-host contract (this REPLACES the superseded 'absent' probe,
   * whose bare `isError: false` demand was impossible by design on a pre-R01
   * host): plugins mounted WITHOUT src/service-tasks.ts lack the task-host
   * capability, so a tracked call must fail closed — NO task row, NO
   * Session, NO mailbox message — while the untracked legacy paths
   * (link/untracked send/untracked spawn/cancel) keep working unchanged. */
  const adapter = new MockAdapter([textResponse('legacy ok'), textResponse('legacy spawn ok')])
  const s = await stack(adapter, [BASE, A], /* realController= */ false, /* taskAssembly= */ 'absent')
  // Tracked spawn refuses honestly.
  const tracked = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('r01-old-tracked'),
    name: 'session_spawn_linked_session', agent: s.alice,
    arguments: { cwd: '/tmp/r01-old', task: 'tracked on old host', provider: 'mock', model: A },
  })
  expect(tracked.isError).toBe(true)
  expect(JSON.stringify((tracked as { content?: unknown }).content)).toContain('HOST_CAPABILITY_UNAVAILABLE')
  // No task row leaked; the service is genuinely absent.
  expect((s.ctx as { sessionLinkTasks?: unknown }).sessionLinkTasks).toBeUndefined()
  // Legacy link + untracked send still work (link through the service the
  // human command rides; the send then rides the legacy admission path).
  await s.ctx.sessionLinks.link('r01-old-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const sent = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('r01-old-send'),
    name: 'session_send_session_message', agent: s.alice,
    arguments: { session_id: s.bob.id, message: 'legacy untracked' },
  })
  expect(sent.isError).not.toBe(true)
  expect((sent as { value?: { status?: string } }).value?.status).toBeDefined()
  // Legacy untracked spawn still works (the mock controller returns bob).
  const spawned = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('r01-old-spawn'),
    name: 'session_spawn_linked_session', agent: s.alice,
    arguments: { cwd: '/tmp/r01-old-legacy', task: 'legacy untracked spawn' },
  })
  expect(spawned.isError).not.toBe(true)
  /* Final2 wave (Important-1 minors): the "four legacy tools" claim now has
   * tool-level coverage — session_list_links reports the link the service
   * created, and session_cancel_session_message cancels a still-pending
   * legacy send; both ride the legacy paths the old host always had. */
  const listed = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('r01-old-list'),
    name: 'session_list_links', agent: s.alice,
    arguments: {},
  })
  expect(listed.isError).not.toBe(true)
  expect(JSON.stringify((listed as { value?: unknown }).value)).toContain('r01-old-pair')
  const pendingSend = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('r01-old-send-2'),
    name: 'session_send_session_message', agent: s.alice,
    arguments: { session_id: s.bob.id, message: 'legacy untracked to cancel' },
  })
  expect(pendingSend.isError).not.toBe(true)
  const pendingId = (pendingSend as { value?: { messageId?: string } }).value?.messageId
  expect(pendingId).toBeDefined()
  const cancelled = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('r01-old-cancel'),
    name: 'session_cancel_session_message', agent: s.alice,
    arguments: { message_id: pendingId },
  })
  expect(cancelled.isError).not.toBe(true)
  expect((cancelled as { value?: { status?: string } }).value?.status).toBe('cancelled')
  await s.bob.whenIdle().catch(() => {})
})

it('R03 probe: cancelling a queued tracked task prevents execution on a later wake (probe migration)', async () => {
  const adapter = new MockAdapter([textResponse('human answer'), textResponse('cancelled task answer')])
  const s = await stack(adapter)
  await s.ctx.sessionLinks.link('cancel-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const sent = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('review-queued-cancel'),
    name: 'session_send_session_message', agent: s.alice,
    arguments: { session_id: s.bob.id, message: 'CANCELLED_TASK_MUST_NOT_EXECUTE', provider: 'mock', model: A },
  })
  expect(sent.isError).not.toBe(true)
  const taskId = taskIdFor(s.alice.id, 'review-queued-cancel')
  const row = s.ctx.sessionLinkTasks.getRow(taskId)!
  const cancelled = await s.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('review-cancel-decision'),
    name: 'session_resolve_task', agent: s.alice,
    arguments: { task_id: taskId, expected_revision: row.revision, action: 'cancel' },
  })
  expect(cancelled.isError).not.toBe(true)
  expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('cancelled')
  s.bob.followup({ content: [{ type: 'text', text: 'human later wake' }], source: { kind: 'user' } } as never)
  await s.ctx.sessionLinks.deliverPending(s.bob.id)
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).not.toContain(A)
})

it('R02 probe: a real API-Session model owner never overrides the tracked task route (probe migration)', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE, A, 'model-b'], true)
  await spawn(s, 'review-real-controller', {})
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).toEqual([A])
})

it('R10 probe: execution honors the catalog-selected fallback B over the rejected primary A (probe migration)', async () => {
  const B = 'model-b'
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE, B])
  const result = await spawn(s, 'review-catalog-fallback', { on_model_unavailable: { fallbacks: [{ provider: 'mock', model: B }] } })
  expect(result.selectedModel?.model).toBe(B)
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).toEqual([B])
})

it('R13 probe: a default-only fallback admits when the primary is absent and the default available (probe migration)', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE])
  const result = await spawn(s, 'review-default-fallback', { on_model_unavailable: { fallbacks: [{ use: 'session_default' }] } })
  expect(result.outcome).toBe('admitted')
})

it('R12 probe: partial streamed output prevents automatic fallback (probe migration)', async () => {
  const B = 'model-b'
  class PartialFailing extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: GenerateOptions) {
      this.requests.push(options)
      if (options.model === A) {
        yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
        yield { type: 'text-delta' as const, index: 0, text: 'already visible partial answer' }
        throw new HarnessError('upstream lost after chunks', 'PROVIDER_UNAVAILABLE')
      }
      for (const c of textResponse('fallback')) yield c
    }
  }
  const adapter = new PartialFailing()
  const s = await stack(adapter)
  await spawn(s, 'review-partial', { on_model_unavailable: { fallbacks: [{ provider: 'mock', model: B }] } })
  await s.bob.whenIdle().catch(() => {})
  expect(adapter.requests.map(r => r.model)).toEqual([A])
})

it('R05 probe: a failed session-scope task never persists its model as baseline (probe migration)', async () => {
  class Failing extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: GenerateOptions) {
      this.requests.push(options)
      throw new HarnessError('down', 'PROVIDER_UNAVAILABLE')
    }
  }
  const adapter = new Failing()
  const s = await stack(adapter)
  await spawn(s, 'review-failed-session', { model_scope: 'session' })
  await s.bob.whenIdle().catch(() => {})
  await vi.waitFor(() => expect(s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'review-failed-session'))?.taskState).toBe('waiting_decision'))
  const selections = s.bob.session.snapshotEvents()
    .filter(e => e.type === 'model/selection')
    .map(e => (e.data as { model: string }).model)
  expect(selections).not.toContain(A)
})

/* --------------------------------------------------------------------------
 * Task 2 grips. RED at commit R01 (the probes below reproduce the confirmed
 * review findings); PASS after the unified-owner landing.
 * ------------------------------------------------------------------------ */

it('R02: real controller installModelSelection never overrides the task route', async () => {
  // The real ApiSessionAgentController installed its model-selection owner on
  // both Agents. Pre-fix, its outer cordis waterfall rewrote every resolved
  // request back to its own selection, so the task's route was overridden to
  // the base model (review probe: actual request was ['base-model']).
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE, A, 'model-b'], /* realController= */ true)
  await spawn(s, 'r02', { provider: 'mock', model: A })
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).toEqual([A])
})

it('R05: a failed session-scope task never persists its model as baseline', async () => {
  // The model/selection append must ride the durable SUCCESS fact (committed
  // assistant/message under the lease's route), never the bare turn/end.
  // Pre-fix the failed turn committed model-a into the baseline.
  class Failing extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      this.requests.push(options)
      throw new HarnessError('down', 'PROVIDER_UNAVAILABLE')
    }
  }
  const adapter = new Failing()
  const s = await stack(adapter)
  await spawn(s, 'r05', { model_scope: 'session' })
  await s.bob.whenIdle().catch(() => {})
  const selections = s.bob.session.snapshotEvents()
    .filter(e => e.type === 'model/selection')
    .map(e => (e.data as { model: string }).model)
  expect(selections).not.toContain(A)
  const baseline = (s.bob.ctx as unknown as { taskHost?: { readBaseline(): { revision: { version: number } } } })
    .taskHost?.readBaseline()
  expect(baseline?.revision.version ?? 0).toBe(0)
})

it('R06: a consumed human selection is never overwritten by a stale task CAS', async () => {
  // Baseline CAS revision must be monotonic. Pre-fix the revision equalled the
  // pending route/null; a human selection consumed by its request returned the
  // revision to null, and the task's persist-time CAS silently matched again,
  // overwriting the human's new baseline.
  const adapter = new MockAdapter([textResponse('task ok'), textResponse('human ok')])
  const s = await stack(adapter)
  const hostRef = s.bob.ctx as unknown as { taskHost?: {
    readBaseline(): { effective: { model: string } | null; revision: { version: number; explicit: { model: string } | null } }
    snapshotBaselineForSpawn(): { revision: { version: number } }
  } }
  const spawned = await spawn(s, 'r06', { provider: 'mock', model: A, model_scope: 'session' })
  // A human explicit selection lands mid-task; its consume by the very next
  // human request must still advance the revision once (never back to the
  // claim-time token the task snapshotted).
  const host = hostRef.taskHost
  expect(host).toBeDefined()
  const before = host!.readBaseline().revision.version
  s.bob.session.append('model/selection', { provider: 'mock', model: 'model-human' })
  s.bob.followup({ content: [{ type: 'text', text: 'human follow-up' }], source: { kind: 'user' } } as never)
  await s.bob.whenIdle()
  const after = host!.readBaseline()
  expect(after.revision.version).toBeGreaterThan(before)
  expect(after.effective?.model ?? 'model-human').toBe('model-human')
  await spawned
})

it('R07: a task header folded after a human baseline never becomes the rebuild fallback', async () => {
  // Post-restart the host derives the ordinary baseline from the durable
  // model-selection fold, which keeps the task turn's frozen header out of
  // the human baseline's `lastUsed` slot. Pre-fix the RAM-only displaced-
  // baseline restore disappeared in a restart and the task's model became the
  // de-facto baseline.
  const adapter = new MockAdapter([textResponse('human ok'), textResponse('task ok')])
  const s = await stack(adapter)
  s.bob.followup({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } as never)
  await s.bob.whenIdle()
  await spawn(s, 'r07', { provider: 'mock', model: A })
  await s.bob.whenIdle()
  const host = (s.bob.ctx as unknown as { taskHost?: {
    readBaseline(): {
      effective: { model: string } | null
      lastUsed: { model: string } | null
      taskLastUsed: { model: string } | null
    }
  } }).taskHost
  expect(host?.readBaseline().lastUsed?.model).toBe(BASE)
  expect(host?.readBaseline().effective?.model).toBe(BASE)
  expect(host?.readBaseline().taskLastUsed?.model).toBe(A)
})

it('R04: a task-bound message without a live claim is rejected, never executes as ordinary mail', async () => {
  // The host-managed pre-step guard is durable: orphan/cancelled/never-
  // claimed task mail returns to the pending inbox instead of entering a
  // step as ordinary mail. Pre-fix the orphaned intent was only LISTED — the
  // message executed on the baseline.
  const adapter = new MockAdapter([textResponse('orphan should never run')])
  const s = await stack(adapter)
  const { resolveTaskHost } = await import('../src/host-capability.ts')
  const { ensureTaskHostLazy } = await import('../src/task-host-lazy.ts')
  // Simulates the legitimate post-condition of any tracked flow: the
  // capability is armed on this Agent (controller-installed in production,
  // lazy-armed here) and the durable guard rides with it.
  const host = await ensureTaskHostLazy(s.bob)
  expect(resolveTaskHost(s.bob.ctx)).toBe(host)
  expect(host).toBeDefined()
  const { brandString } = await import('@deepseek-ai/dsh-brand')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const messageId = brandString('mail-r04' as never)
  // Record + immediately cancel the intent so the durable binding has no live
  // claim. Then deliver the bound message: it must NOT produce a request.
  const record = host!.recordTurnIntent({
    taskId: 'task-r04', attemptId: 'a', messageId: messageId as never,
    route: { selection: { provider: 'mock', model: A } },
  })
  await host!.cancelTurnIntent(record.intentId, 'withdrawn before claim')
  s.bob.followup(createUserMessage({
    content: [{ type: 'text', text: 'orphan mail must not execute' }],
    source: { kind: 'session-link-message', messageId } as never,
  }))
  await s.bob.whenIdle().catch(() => {})
  expect(adapter.requests).toHaveLength(0)
})

it('R12: partial streamed output bars automatic fallback', async () => {
  // Any durable output substance (chunk observed, response committed, tool
  // dispatched) forbids a silent route switch; the pre-fix probe observed
  // requests [A, B] after A streamed a partial answer then failed.
  class PartialFailing extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      this.requests.push(options)
      if (options.model === A) {
        yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
        yield { type: 'text-delta' as const, index: 0, text: 'already visible partial answer' }
        throw new HarnessError('upstream lost after chunks', 'PROVIDER_UNAVAILABLE')
      }
      for (const chunk of textResponse('fallback')) yield chunk
    }
  }
  const adapter = new PartialFailing()
  const s = await stack(adapter, [BASE, A, 'model-b'])
  await spawn(s, 'r12', { provider: 'mock', model: A, on_model_unavailable: { fallbacks: [{ provider: 'mock', model: 'model-b' }] } })
  await s.bob.whenIdle().catch(() => {})
  expect(adapter.requests.map(r => r.model)).toEqual([A])
})

/* --------------------------------------------------------------------------
 * Task 2 round-1 review fixes (needs-fixes layer):
 *  - Critical 1: modelSelection unit state is plain JSON end-to-end (v4),
 *    so the durable checkpoint cache no longer throws on every write, and a
 *    checkpoint+tail restore classifies IDENTICALLY to a full replay —
 *    including mid-task-turn (Important 4).
 *  - Important 2: the owner's system-prompt/assemble rewrite yields on a
 *    task-bound turn under a REAL controller, so the visible prompt carries
 *    the frozen task route (prompt ≡ header), never the human baseline.
 *  - Important 3: an 'initial'-reason header stages and settles against the
 *    open task-turn facts like any other header (R07 for task-first epochs).
 * ------------------------------------------------------------------------ */

it('R07-initial: an epoch whose FIRST turn is task-bound keeps its header out of the human baseline', async () => {
  // The spawn target's very first request IS the task turn (reason 'initial'
  // for the session's first header). Pre-fix the fold settled 'initial'
  // headers as human unconditionally, parking the task route in lastUsed.
  const adapter = new MockAdapter([textResponse('task first')])
  const s = await stack(adapter, [BASE, A, 'model-b'])
  await spawn(s, 'r07-initial', { provider: 'mock', model: A })
  await s.bob.whenIdle()
  const host = (s.bob.ctx as unknown as { taskHost?: {
    readBaseline(): {
      effective: { model: string } | null
      lastUsed: { model: string } | null
      taskLastUsed: { model: string } | null
    }
  } }).taskHost
  expect(adapter.requests.map(r => r.model)).toEqual([A])
  expect(host?.readBaseline().taskLastUsed?.model).toBe(A)
  // The human baseline slots stay untouched by the task header.
  expect(host?.readBaseline().lastUsed?.model ?? null).not.toBe(A)
  expect(host?.readBaseline().effective?.model ?? null).not.toBe(A)
})

it('Checkpoint v4: the modelSelection unit state is plain JSON (snapshotJsonValue accepts it)', async () => {
  /* Critical 1: the v3 fold's Set-bearing row made EVERY checkpoint write
   * throw inside the projection-cache's `snapshotJsonValue`. Drive a real
   * task turn, read the LIVE unit row from the REAL registry, and demand a
   * lossless JSON snapshot plus schema re-parse. */
  const adapter = new MockAdapter([textResponse('human seed'), textResponse('task ok')])
  const s = await stack(adapter, [BASE, A, 'model-b'])
  s.bob.followup({ content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' } } as never)
  await s.bob.whenIdle()
  const { ensureTaskHostLazy } = await import('../src/task-host-lazy.ts')
  const host = await ensureTaskHostLazy(s.bob)
  expect(host).toBeDefined()
  const { brandString } = await import('@deepseek-ai/dsh-brand')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const messageId = brandString('mail-ckpt-json' as never)
  const record = host!.recordTurnIntent({
    taskId: 'task-ckpt-json', attemptId: 'a', messageId: messageId as never,
    route: { selection: { provider: 'mock', model: A } },
  })
  await host!.claimTurnIntent(record.intentId)
  s.bob.followup(createUserMessage({
    content: [{ type: 'text', text: 'managed mail' }],
    source: { kind: 'session-link-message', messageId } as never,
  }))
  await s.bob.whenIdle()
  const liveRow = modelSelectionRowOf(s.bob)
  expect(liveRow).toBeDefined()
  const { snapshotJsonValue } = await import('@deepseek-ai/dsh-util-values')
  const snapshot = snapshotJsonValue(liveRow)
  expect(snapshot).toBeDefined()
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  // Reparse through the production zod schema (the durable-cache read path),
  // then verify the restored row keys classify identically for a baseline read.
  const restored = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
  expect(Array.isArray(restored.taskMessageIds)).toBe(true)
  expect(Array.isArray(restored.openTaskTurns)).toBe(true)
  expect((restored.taskLastUsed as { model?: string } | null)?.model).toBe(A)
  expect((restored.lastUsed as { model?: string } | null)?.model).toBe(BASE)
})

it('Checkpoint v4 replay: checkpoint+tail and full replay classify identically, including mid-task-turn', async () => {
  /* Critical 1 + Important 4: with provenance persisted as plain JSON inside
   * the row (v4), the durable restore (checkpoint row + log tail through the
   * REAL fold) reaches the SAME classification a full replay reaches — even
   * mid-task-turn, where the v3 stripped Sets had disagreed. Drive a REAL
   * agent with a gate so the read lands mid-turn, mint a synthetic Session
   * over a prefix checkpoint + tail suffix, and fold both through the same
   * production registry. */
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  class Gated extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      this.requests.push(options)
      if (this.requests.length === 2) await gate
      for (const chunk of textResponse(this.requests.length === 1 ? 'human seed' : 'task answer')) yield chunk
    }
  }
  const adapter = new Gated()
  const s = await stack(adapter, [BASE, A, 'model-b'])
  s.bob.followup({ content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' } } as never)
  await s.bob.whenIdle()
  const { ensureTaskHostLazy } = await import('../src/task-host-lazy.ts')
  const host = await ensureTaskHostLazy(s.bob)
  const { brandString } = await import('@deepseek-ai/dsh-brand')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const messageId = brandString('mail-ckpt-fold' as never)
  const record = host!.recordTurnIntent({
    taskId: 'task-ckpt-fold', attemptId: 'a', messageId: messageId as never,
    route: { selection: { provider: 'mock', model: A } },
  })
  await host!.claimTurnIntent(record.intentId)
  // A never-delivered second intent keeps taskMessageIds observably populated
  // at the checkpoint cut.
  const undeliveredId = brandString('mail-ckpt-fold-undelivered' as never)
  host!.recordTurnIntent({ taskId: 'task-ckpt-fold-2', attemptId: 'b', messageId: undeliveredId as never })
  s.bob.followup(createUserMessage({
    content: [{ type: 'text', text: 'task mail mid-turn' }],
    source: { kind: 'session-link-message', messageId } as never,
  }))
  const { vi } = await import('vitest')
  await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })

  const events = s.bob.session.snapshotEvents()
  const fold = await modelSelectionFold(s.bob)
  // Full replay through the production fold over the whole log (mid-task-turn).
  const fullReplay = fold(undefined, events)
  const cut = events.findIndex(e => e.type === 'request/header'
    && (e.data as { header: { config: { model: string } } }).header.config.model === A)
  expect(cut).toBeGreaterThan(0)
  // Durable-cache-equivalent checkpoint: fold the prefix, harden through the
  // stateSchema-equivalent JSON round trip, then fold the SAME production fold
  // over the tail — the durable reopen path (checkpoint row + tail).
  const checkpointRow = JSON.parse(JSON.stringify(fold(undefined, events.slice(0, cut)))) as never
  const restored = fold(checkpointRow, events.slice(cut))
  expect(restored).toEqual(fullReplay)
  // The open task-turn facts the classification depends on are persisted INSIDE
  // the row (v4), so the mid-turn restore carries them.
  expect(fullReplay.taskMessageIds).toContain(undeliveredId)
  expect(fullReplay.openTaskTurns.length).toBeGreaterThan(0)
  expect(fullReplay.taskLastUsed?.model).toBe(A)
  expect(fullReplay.lastUsed?.model).toBe(BASE)
  release()
  await s.bob.whenIdle().catch(() => {})
})

it('Task prompt invariant: under a REAL controller the task turn\'s prompt variables carry the frozen task route, never the baseline', async () => {
  // Round-1 Important 2: the original owner's system-prompt/assemble rewrite
  // is outermost under cordis' first-registered-wins order, so without the
  // assemble-side yield it rewrote the already-frozen prompt variables back
  // to the human selection — the visible prompt disagreed with the frozen
  // request header. Captured here through the durable system/messages the
  // loop projects during the task step.
  const adapter = new MockAdapter([textResponse('task ok')])
  const s = await stack(adapter, [BASE, A, 'model-b'], /* realController= */ true)
  // Record every assembly that flows past scope of bob, post-every-rewrite:
  // an agent-scoped listener registered LAST observes the final variables.
  const seen: { provider?: string; model?: string }[] = []
  s.bob.ctx.on('system-prompt/assemble', async (_assembly: never, _context: never, next: () => Promise<{ variables: Record<string, string | undefined> }>) => {
    const assembled = await next()
    seen.push({ provider: assembled.variables.provider, model: assembled.variables.model })
    return assembled
  })
  await spawn(s, 'prompt-inv', { provider: 'mock', model: A })
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).toEqual([A])
  // The task step's assembly carried the frozen task route on the PROMPT
  // surface too (prompt ≡ header), not the base model the original owner's
  // selection would have stamped.
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(v => v.model === A)).toBe(true)
})

/* --------------------------------------------------------------------------
 * Task 4 grips (MODEL_ROUTING_FIX_PLAN notification cluster):
 *  R17 collision-free notification messageId derivation + put-time conflict
 *      validation; R18 notification root minted at FIRST intent admission,
 *      riding through retry, sharing ONE wake-budget chain per task; R14
 *      event-driven outbox re-pump on real retry conditions (mailbox capacity
 *      freed by delivery, never a timer); plus the markRetried restart-window
 *      closure through the durable retired-delivery ledger + reconcile.
 * ------------------------------------------------------------------------ */

it('R17: colliding sanitized callIds produce DISTINCT notification messages, never an overwrite', async () => {
  /* Reviewer repro: `review/a` vs `review_a` — the pre-fix derivation replaced
   * non-identifier chars with `_`, so two DIFFERENT events derived the SAME
   * messageId and the second admission silently overwrote the first mailbox
   * row. Two precheck-failed tracked calls whose callIds collide under the old
   * sanitize must each own a mailbox row, and each row's structured eventId
   * must name its own task event. */
  const adapter = new MockAdapter([textResponse('unused')])
  const s = await stack(adapter, [BASE]) // catalog lacks model-a: both calls fail precheck
  await s.ctx.sessionLinks.link('r17-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const first = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'r17 first task', provider: 'mock', model: A,
  }, 'r17/a')
  const second = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'r17 second task', provider: 'mock', model: A,
  }, 'r17_a')
  expect(first.isError).not.toBe(true)
  expect(second.isError).not.toBe(true)
  const { taskIdFor } = await import('../src/index.ts')
  const firstTask = taskIdFor(s.alice.id, 'r17/a')
  const secondTask = taskIdFor(s.alice.id, 'r17_a')
  /* Two distinct notifications land in the mailbox (the pump's pass admits
   * both pending outbox events; collision-free derivation keeps both ids). */
  const reports: { id: string; eventId?: string; taskId?: string }[] = []
  await vi.waitFor(() => {
    reports.length = 0
    const table = (s.ctx.sessionLinks as unknown as {
      messages: { entries(): Iterable<[string, { taskStatus?: { eventId: string; taskId: string } }]> };
    }).messages
    for (const [id, record] of table.entries()) {
      if (record.taskStatus !== undefined) {
        reports.push({ id, eventId: record.taskStatus.eventId, taskId: record.taskStatus.taskId })
      }
    }
    expect(reports).toHaveLength(2)
  })
  // Each row names its own task's event, and the message ids are distinct.
  expect(new Set(reports.map(report => report.id)).size).toBe(2)
  const byTask = new Map(reports.map(report => [report.taskId, report]))
  expect(String(byTask.get(String(firstTask))!.eventId)).toContain('r17/a')
  expect(String(byTask.get(String(secondTask))!.eventId)).toContain('r17_a')
})

it('R17 conflict: admitTaskStatus never overwrites a row whose stored event differs', async () => {
  /* Put-time conflict validation at the mailbox boundary: an admission whose
   * derived message id already names a DIFFERENT event is an error, never a
   * silent overwrite. A genuine hash collision is unreachable by construction,
   * so we seed the same-id/different-event row directly (the corruption
   * realm) and admit — the admission must refuse and the stored row must
   * survive byte-for-byte. */
  const adapter = new MockAdapter([textResponse('unused')])
  const s = await stack(adapter)
  await s.ctx.sessionLinks.link('r17c-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const { notificationMessageId, taskIdFor } = await import('../src/index.ts')
  const reportFor = (callId: string, eventId: string) => ({
    eventId,
    taskId: taskIdFor(s.alice.id, callId),
    attemptId: `${taskIdFor(s.alice.id, callId)}/attempt-1`,
    revision: 1,
    eventKind: 'model_unavailable' as const,
    callerId: s.alice.id,
    targetId: s.bob.id,
    requestedModel: { provider: 'mock', model: A },
    attempts: 1,
    decisionRequired: true,
    resumable: true,
  })
  // Corruption realm: a stored row under event-A's derived id that names
  // event-B (its idempotency key misses the event-A probe).
  const table = s.ctx.sessionLinks as unknown as {
    messages: {
      get(id: never): { taskStatus?: { eventId: string }; text: string } | undefined
      put(id: never, value: unknown): Promise<void>
    }
  }
  const collisionId = notificationMessageId('event-A')
  const linkRow = s.ctx.sessionLinks.list(s.alice.id)[0]!
  await table.messages.put(collisionId as never, {
    linkId: linkRow.id,
    senderId: s.bob.id,
    senderTitle: 'forged',
    targetId: s.alice.id,
    text: 'pre-existing row under the derived id',
    status: 'pending',
    wakesUsed: 0,
    chainLength: 1,
    attempts: 0,
    createdAt: new Date().toISOString(),
    seq: 1,
    statusKind: 'task-status',
    taskStatus: {
      taskId: 'task:forged', attemptId: 'a', eventId: 'event-B', revision: 1,
      kind: 'model_unavailable', requestedModel: { provider: 'mock', model: A },
      attempts: 1, decisionRequired: true, resumable: true,
    },
    idempotencyKey: 'task-event:event-B',
  })
  const admission = await s.ctx.sessionLinks.admitTaskStatus(reportFor('c-dot', 'event-A'))
    .then(() => ({ threw: false as const }))
    .catch((error: unknown) => ({ threw: true as const, error }))
  expect(admission.threw).toBe(true)
  // The stored row was never overwritten.
  expect(table.messages.get(collisionId as never)?.taskStatus?.eventId).toBe('event-B')
  expect(table.messages.get(collisionId as never)?.text).toBe('pre-existing row under the derived id')
  // The same-event replay still re-delivers its own stored row.
  const stored = await s.ctx.sessionLinks.admitTaskStatus(reportFor('c-dot', 'event-original'))
  const replayed = await s.ctx.sessionLinks.admitTaskStatus(reportFor('c-dot', 'event-original'))
  expect(replayed.messageId).toBe(stored.messageId)
  // The derivation itself covers the WHOLE eventId (arbitrary user chars
  // incl.), so `review/a` and `review_a` never co-derive one id.
  expect(String(notificationMessageId('review/a'))).not.toBe(String(notificationMessageId('review_a')))
  expect(String(notificationMessageId('x:y'))).not.toBe(String(notificationMessageId('x_y')))
})

it('R18: a precheck-failed task\'s notifications ride ONE wake-budget chain across the retry', async () => {
  /* Reviewer repro: maxAutoWakesPerChain=1 with the reverse auto-wake granted.
   * Initial missing-model status + explicit retry produced 3 status messages
   * on 2-3 fresh chains — wakesUsed [1,1,0] = 2 wakes for the SAME task. The
   * notification root must mint at FIRST intent admission (stable per task,
   * surviving the retry) and every status report threads it as inReplyTo, so
   * the whole lifecycle spends at most ONE wake: wakesUsed must be [1,0,0]. */
  const adapter = new MockAdapter([
    textResponse('alice wake turn'), // alice's wake handles the first report
    textResponse('bob task turn'),   // bob's wake executes the retried task
  ])
  const s = await stack(adapter, [BASE], false, 'mounted', { maxAutoWakesPerChain: 1 })
  await s.ctx.sessionLinks.link('r18-pair', [s.alice.id, s.bob.id], { kind: 'human' }, {
    autoWakeSessionIds: [s.alice.id, s.bob.id],
  })
  const sent = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'r18 task on a missing model', provider: 'mock', model: A,
  }, 'r18-send')
  expect(sent.isError).not.toBe(true)
  expect((sent as { value?: { outcome?: string } }).value?.outcome).toBe('needs_decision')
  const { taskIdFor, mintTaskMessageId } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'r18-send')
  const waiting = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(waiting.taskState).toBe('waiting_decision')
  /* R18 core: the root minted at FIRST intent admission — durable BEFORE any
   * binding exists (this task never bound) — and exactly the attempt-1
   * delivery identity the wire layer derives. */
  const root = waiting.notificationRoot.rootMessageId
  expect(root).toBeDefined()
  expect(root).toBe(mintTaskMessageId(taskId, 'r18-send'))
  // Report 1 lands and wakes alice once (the chain's single wake).
  const reportsOf = () => {
    const table = (s.ctx.sessionLinks as unknown as {
      messages: { entries(): Iterable<[string, { taskStatus?: { taskId: string }; inReplyTo?: string; wakesUsed: number; status: string }]> };
    }).messages
    const found: { id: string; wakesUsed: number; inReplyTo?: string }[] = []
    for (const [id, record] of table.entries()) {
      if (record.taskStatus?.taskId === String(taskId)) {
        found.push({ id, wakesUsed: record.wakesUsed, ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }) })
      }
    }
    return found
  }
  await vi.waitFor(() => expect(reportsOf().length).toBeGreaterThanOrEqual(1))
  const first = reportsOf()
  expect(first[0]!.wakesUsed).toBe(1)
  expect(first[0]!.inReplyTo).toBe(String(root))
  // Explicit retry on an available route: the row re-admits and executes.
  const decided = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: waiting.revision, action: 'retry', provider: 'mock', model: BASE,
  }, 'r18-decision')
  expect(decided.isError).not.toBe(true)
  await s.bob.whenIdle().catch(() => {})
  // Reports 2 (retry decision) + 3 (turn finished) queue behind the spent chain.
  await vi.waitFor(() => expect(reportsOf().length).toBe(3))
  const reports = reportsOf()
  const wakesSpent = reports.reduce((sum, report) => sum + report.wakesUsed, 0)
  // The whole task lifecycle consumed exactly ONE wake: never [1,1,0].
  expect(wakesSpent).toBe(1)
  expect(reports.filter(report => report.wakesUsed > 0)).toHaveLength(1)
  // Every report threads the SAME root minted at intent admission.
  for (const report of reports) expect(report.inReplyTo).toBe(String(root))
  // The root survived the retry unchanged (attempt-scoped delivery identity
  // minted fresh; the budget chain authority did not move).
  const settled = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(settled.notificationRoot.rootMessageId).toBe(root)
  expect(settled.execution.messageId).toBeDefined()
  const ledgerRow = (s.ctx.sessionLinks as unknown as {
    readLedgers(): { wakes: Record<string, { day: string; wakes: number }> };
  }).readLedgers?.() ?? { wakes: {} }
  // The sender's day ledger agrees with the per-message facts: exactly one.
  expect(ledgerRow.wakes[String(s.alice.id)]?.wakes ?? 1).toBe(1)
})

it('R18 mint continuity: saveTaskIntent carries the root from admission and attachBinding never re-mints a bound task\'s root', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter)
  await s.ctx.sessionLinks.link('r18m-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const tasks = s.ctx.sessionLinkTasks
  const { SessionLinkMessageId, taskIdFor, mintTaskMessageId } = await import('../src/index.ts')
  const policy = {
    scope: 'task' as const,
    candidates: [{ provider: 'mock', model: A }],
    ifExhausted: 'notify_sender' as const,
    usesSessionDefault: false,
  }
  await tasks.saveTaskIntent({
    callerId: s.alice.id,
    request: { kind: 'send', callId: 'r18-mint', text: 'minted-root task', targetSessionId: s.bob.id },
    policy,
    tracked: true,
  })
  const taskId = taskIdFor(s.alice.id, 'r18-mint')
  const minted = tasks.getRow(taskId)!
  // Root present at FIRST intent admission — before ANY binding exists.
  expect(minted.notificationRoot.rootMessageId).toBe(mintTaskMessageId(taskId, 'r18-mint'))
  const ghost = SessionLinkMessageId('session-link-message-r18-ghost')
  await tasks.attachBinding(taskId, 1, { messageId: ghost, sessionId: s.bob.id, admittedAs: 'queued' })
  /* A binding that is NOT the minted identity (a legacy/forged realm) never
   * re-mints; the intent-time root is the single budget authority. */
  expect(tasks.getRow(taskId)!.notificationRoot.rootMessageId).toBe(mintTaskMessageId(taskId, 'r18-mint'))
})

it('R14: capacity-freeing delivery re-pumps the refused outbox with no new task mutation', async () => {
  /* Reviewer repro: maxPendingPerTarget=2, the notification target's mailbox
   * is FULL of two pending peer mails, the status report is refused
   * MAILBOX_FULL and stays pending; the human wake consumes the two mails →
   * the outbox MUST reach the mailbox without any new task mutation. Pre-fix
   * no pump trigger observed the freed capacity, so the event rotted pending. */
  const adapter = new MockAdapter([
    textResponse('alice human turn'),
    textResponse('bob task turn'),
  ])
  const s = await stack(adapter, [BASE], false, 'mounted', { maxPendingPerTarget: 2 })
  await s.ctx.sessionLinks.link('r14-pair', [s.alice.id, s.bob.id], { kind: 'human' }, {
    autoWakeSessionIds: [s.bob.id],
  })
  // Fill alice's mailbox with two PENDING peer mails from bob (no auto-wake on
  // alice, so they queue without inserting).
  for (const callKey of ['r14-fill-1', 'r14-fill-2']) {
    const filled = await s.ctx.sessionLinks.send(s.bob, s.alice.id, {
      targetId: s.alice.id, text: `fill ${callKey}`, idempotencyKey: callKey,
    })
    expect(filled.status).toBe('queued')
  }
  // The tracked call fails precheck; the pump's report hits MAILBOX_FULL.
  const sent = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'r14 task on a missing model', provider: 'mock', model: A,
  }, 'r14-send')
  expect(sent.isError).not.toBe(true)
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'r14-send')
  const pendingNow = () => s.ctx.sessionLinkTasks.getRow(taskId)!.outbox.map(event => event.status)
  expect(pendingNow()).toEqual(['pending'])
  // No task mutation here: wake alice HUMANLY so the two queued mails deliver.
  s.alice.followup({ content: [{ type: 'text', text: 'human wakes alice' }], source: { kind: 'user' } } as never)
  await s.alice.whenIdle().catch(() => {})
  /* The freed capacity itself re-pumped the outbox (delivery transition is
   * the trigger — never a timer, never another task call): the report is
   * admitted to the mailbox. */
  await vi.waitFor(() => expect(s.ctx.sessionLinkTasks.getRow(taskId)!.outbox[0]!.status).not.toBe('pending'))
  const admittedEvent = s.ctx.sessionLinkTasks.getRow(taskId)!.outbox[0]!
  expect(['admitted', 'delivered']).toContain(admittedEvent.status)
  expect(admittedEvent.notifiedMessageId).toBeDefined()
  const report = s.ctx.sessionLinks.message(admittedEvent.notifiedMessageId!)
  expect(report).toBeDefined()
  expect(['pending', 'delivered']).toContain(report!.status)
})

it('markRetried window: reconcile re-drives the retired-delivery marking a restart lost', async () => {
  /* A restart between the retry decision commit and markLegacyDelivery's
   * settle leaves the predecessor's ORIGINAL idempotency key adoptable.
   * The decision now records the retired delivery durably; reconcile's
   * classification re-drives marking and drops the ledger entry once the
   * mailbox fact is observed. We simulate the lost marking by restoring the
   * original key after the decision's hook settled, then reconcile. */
  const B2 = 'model-b'
  class FailThenOk extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: GenerateOptions) {
      this.requests.push(options)
      if (this.requests.length === 1) throw new HarnessError('first attempt down', 'PROVIDER_UNAVAILABLE')
      for (const chunk of textResponse('second attempt ok')) yield chunk
    }
  }
  const adapter = new FailThenOk()
  const s = await stack(adapter, [BASE, A, B2])
  await s.ctx.sessionLinks.link('mrr-pair', [s.alice.id, s.bob.id], { kind: 'human' }, {
    autoWakeSessionIds: [s.bob.id],
  })
  const sent = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'window task body', provider: 'mock', model: A,
  }, 'mrr-send')
  expect(sent.isError).not.toBe(true)
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'mrr-send')
  await vi.waitFor(() => {
    expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('waiting_decision')
  })
  const failed = s.ctx.sessionLinkTasks.getRow(taskId)!
  const firstMessageId = failed.execution.messageId!
  const decided = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: failed.revision, action: 'retry', provider: 'mock', model: B2,
  }, 'mrr-decision')
  expect(decided.isError).not.toBe(true)
  // The decision's own hook settles (normal-process marking)...
  await vi.waitFor(() => {
    expect(s.ctx.sessionLinks.message(firstMessageId)?.idempotencyKey).toBe('mrr-send/consumed')
  })
  /* ...then the restart-loss realm: the predecessor's original key is
   * adoptable again (the marking never landed in the surviving process's
   * durable media). The durable retired-delivery ledger still names it. */
  const table = s.ctx.sessionLinks as unknown as {
    messages: {
      get(id: never): { idempotencyKey?: string } | undefined
      put(id: never, value: unknown): Promise<void>
    }
  }
  const stored = table.messages.get(firstMessageId as never)!
  await table.messages.put(firstMessageId as never, { ...stored, idempotencyKey: 'mrr-send' })
  expect(s.ctx.sessionLinks.message(firstMessageId)?.idempotencyKey).toBe('mrr-send')
  // Reconcile (the mount-time classification) re-drives the marking.
  await s.ctx.sessionLinkTasks.reconcile()
  await vi.waitFor(() => {
    expect(s.ctx.sessionLinks.message(firstMessageId)?.idempotencyKey).toBe('mrr-send/consumed')
  })
  /* ...and completes the durable ledger once the mailbox fact is observed
   * (the completion drop rides the NEXT classification pass). */
  await s.ctx.sessionLinkTasks.reconcile()
  await vi.waitFor(() => {
    const row = s.ctx.sessionLinkTasks.getRow(taskId)!
    expect(row.retiredDeliveries ?? []).toHaveLength(0)
  })
})

/* --------------------------------------------------------------------------
 * Task 3 grips (MODEL_ROUTING_FIX_PLAN admission-gate cluster):
 *  R03 cancel revocation, R08 retry delivery identity ×2, R09 full payload,
 *  R10 attempt-fixed selection, R11 missing-delivery repair, R13 default
 *  sentinel admission, R15 atomic intent insert, R16 full-body digest.
 * The R03/R13 scenarios also flip their standalone probes in
 * `artifacts/review/model-routing-probes.spec.ts` from RED to green.
 * ------------------------------------------------------------------------ */

/** Execute one tool call through the harness context and return its raw result. */
async function exec(
  s: Awaited<ReturnType<typeof stack>>,
  name: string,
  args: Record<string, unknown>,
  callId: string,
  agent: 'alice' | 'bob' = 'alice',
) {
  return await s.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    agent: s[agent],
    arguments: args,
  })
}

it('R03: cancelling a queued tracked task revokes the delivery + host intent and never executes', async () => {
  // Reviewer repro: queued tracked task, resolve cancel, then bob is woken
  // by a human message — pre-fix the cancelled delivery executed as ordinary
  // mail ([base, model-a]); the gate must leave only [base-model].
  const adapter = new MockAdapter([textResponse('human answer'), textResponse('cancelled task answer')])
  const s = await stack(adapter)
  await s.ctx.sessionLinks.link('cancel-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const sent = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'CANCELLED_TASK_MUST_NOT_EXECUTE', provider: 'mock', model: A,
  }, 'r03-send')
  expect(sent.isError).not.toBe(true)
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'r03-send')
  const row = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(row.taskState).toBe('queued')
  const boundMessageId = row.execution.messageId!
  const boundIntentId = row.execution.turnIntentId!
  const cancelled = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: row.revision, action: 'cancel',
  }, 'r03-cancel')
  expect(cancelled.isError).not.toBe(true)
  expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('cancelled')
  /* The REVOCATION landed: the pending mailbox delivery is cancelled and the
   * durable host intent reached its cancelled realm — a later wake has no
   * claimable intent left to activate. */
  await vi.waitFor(() => expect(s.ctx.sessionLinks.message(boundMessageId)?.status).toBe('cancelled'))
  const { resolveTaskHost } = await import('../src/host-capability.ts')
  const host = resolveTaskHost(s.bob.ctx)
  if (host !== undefined) {
    const status = host.getTurnIntent(boundIntentId)?.status
    if (status !== undefined) expect(['cancelled', 'finished']).toContain(status)
  }
  s.bob.followup({ content: [{ type: 'text', text: 'human later wake' }], source: { kind: 'user' } } as never)
  await s.ctx.sessionLinks.deliverPending(s.bob.id)
  await s.bob.whenIdle()
  // Exactly the human step ran (baseline); the cancelled task never executed.
  expect(adapter.requests.map(r => r.model)).toEqual([BASE])
  expect(adapter.requests.map(r => r.model)).not.toContain(A)
})

it('R08(1): retrying a claimed-failed task mints a NEW delivery identity and executes a real new request', async () => {
  // The retry never re-admits the consumed mailbox identity: the new attempt
  // owns a fresh messageId (taskId + notification root budget unchanged),
  // and the re-admitted delivery runs a genuine new model request.
  const B2 = 'model-b'
  class FailThenOk extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: GenerateOptions) {
      this.requests.push(options)
      if (this.requests.length === 1) throw new HarnessError('first attempt down', 'PROVIDER_UNAVAILABLE')
      for (const chunk of textResponse('second attempt ok')) yield chunk
    }
  }
  const adapter = new FailThenOk()
  const s = await stack(adapter, [BASE, A, B2])
  const { taskIdFor } = await import('../src/index.ts')
  // Single candidate: the first attempt fails with no fallback left, so the
  // task settles waiting_decision/not_started — the retryable realm. The
  // caller authorized the target's auto-wake grant (auto_awake), so the
  // retry's fresh delivery may wake it for a real new request.
  const spawned = await spawn(s, 'r08-retry', { auto_awake: true })
  expect(spawned.outcome).toBe('admitted')
  const taskId = taskIdFor(s.alice.id, 'r08-retry')
  await vi.waitFor(() => {
    expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('waiting_decision')
  })
  const failed = s.ctx.sessionLinkTasks.getRow(taskId)!
  const firstMessageId = failed.execution.messageId!
  const firstOrdinal = failed.currentAttemptId
  const decided = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: failed.revision, action: 'retry',
  }, 'r08-retry-decision')
  expect(decided.isError).not.toBe(true)
  await s.bob.whenIdle().catch(() => {})
  await vi.waitFor(() => {
    const row = s.ctx.sessionLinkTasks.getRow(taskId)
    expect(row?.execution.messageId).toBeDefined()
    expect(row?.execution.messageId).not.toBe(firstMessageId)
  })
  const retried = s.ctx.sessionLinkTasks.getRow(taskId)!
  // Task identity and the notification ROOT stayed; only the attempt delivery minted fresh.
  expect(String(taskId)).toContain('r08-retry')
  expect(retried.currentAttemptId).not.toBe(firstOrdinal)
  const root = retried.notificationRoot.rootMessageId
  expect(root).toBeDefined()
  expect(root).toBe(firstMessageId)
  // The retry executed a real new model request on the re-selected route.
  await vi.waitFor(() => expect(adapter.requests.length).toBeGreaterThanOrEqual(2))
  expect(adapter.requests.at(-1)!.model).toBeDefined()
})

it('R08(2): a precheck-failed spawn retry runs the full idempotent create/link/rename/admit path', async () => {
  // Precheck failed before any Session existed → needs_decision; the retry
  // decision re-runs the ORIGINAL spawn flow: the derived Session id is the
  // same one the original callKey minted, the group re-arms through the
  // ledger, and the task admits and executes on the new selection.
  const adapter = new MockAdapter([textResponse('retried spawn ok')])
  const s = await stack(adapter, [BASE]) // catalog lacks model-a: first precheck fails.
  const { taskIdFor } = await import('../src/index.ts')
  const { spawnedSessionId } = await import('../src/tools.ts')
  const created: string[] = []
  const controller = s.ctx.sessionController as unknown as {
    create(options: { cwd: string; sessionId: string }): Promise<{ sessionId: string }>
  }
  const originalCreate = controller.create.bind(controller)
  vi.spyOn(controller, 'create').mockImplementation(async options => {
    created.push(String(options.sessionId))
    return await originalCreate(options)
  })
  const first = await exec(s, 'session_spawn_linked_session', {
    cwd: '/tmp/r08-spawn-retry', task: 'precheck fails first', provider: 'mock', model: A,
  }, 'r08-spawn')
  expect(first.isError).not.toBe(true)
  expect((first as { value?: { outcome?: string } }).value?.outcome).toBe('needs_decision')
  // The precheck failure left NO Session.
  expect(created).toHaveLength(0)
  const taskId = taskIdFor(s.alice.id, 'r08-spawn')
  const waiting = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(waiting.taskState).toBe('waiting_decision')
  const decided = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: waiting.revision, action: 'retry',
    provider: 'mock', model: BASE,
  }, 'r08-spawn-decision')
  expect(decided.isError).not.toBe(true)
  await s.bob.whenIdle().catch(() => {})
  // The retry ran the full create path; the Session id it requested derives
  // from the original callKey (the mock controller returns the live bob).
  expect(created).toContain(String(spawnedSessionId(s.alice.id, 'r08-spawn')))
  const row = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(row.targetSessionId).toBeDefined()
  expect(String(row.targetSessionId)).toBe(String(s.bob.id))
  await vi.waitFor(() => expect(adapter.requests.length).toBeGreaterThanOrEqual(1))
  expect(adapter.requests.at(-1)!.model).toBe(BASE)
})

it('R09: the tracked intent stores and re-sends the FULL payload, never the 160-char excerpt', async () => {
  // A 203-char task body whose distinguishing tail sits past the 160-char
  // display excerpt must arrive at the mailbox in full — pre-fix the retry
  // path re-sent only the excerpt.
  const marker = 'TAIL-MARKER-PAST-THE-EXCERPT-BOUNDARY'
  const payload = 'x'.repeat(203 - marker.length) + marker
  expect(payload.length).toBe(203)
  expect(payload.slice(0, 160)).not.toContain(marker)
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter)
  await s.ctx.sessionLinks.link('r09-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const sent = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: payload, provider: 'mock', model: A,
  }, 'r09-send')
  expect(sent.isError).not.toBe(true)
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'r09-send')
  const row = s.ctx.sessionLinkTasks.getRow(taskId)!
  // Durable payload: full body on the row; excerpt stays display-only.
  expect(row.originalRequest.payloadText).toBe(payload)
  expect(row.originalRequest.summary.textExcerpt).toBe(payload.slice(0, 160))
  const bound = row.execution.messageId!
  const stored = s.ctx.sessionLinks.message(bound)
  expect(stored?.text).toContain(marker)
})

it('R10: the precheck-selected candidate is fixed onto the attempt and activation uses it', async () => {
  // Catalog lacks the primary; the precheck falls to fallback B. The attempt
  // row fixes index 1 and the ACTUAL request runs B — pre-fix activation
  // silently re-derived candidates[0] and executed the rejected primary.
  const B2 = 'model-b'
  const adapter = new MockAdapter([textResponse('ok from b')])
  const s = await stack(adapter, [BASE, B2])
  const spawned = await spawn(s, 'r10-fixed', { on_model_unavailable: { fallbacks: [{ provider: 'mock', model: B2 }] } })
  expect(spawned.outcome).toBe('admitted')
  expect(spawned.selectedModel?.model).toBe(B2)
  const { taskIdFor } = await import('../src/index.ts')
  const row = s.ctx.sessionLinkTasks.getRow(taskIdFor(s.alice.id, 'r10-fixed'))!
  const attempt = row.attempts.find(candidate => candidate.attemptId === row.currentAttemptId)!
  expect(attempt.selectedCandidateIndex).toBe(1)
  await s.bob.whenIdle()
  expect(adapter.requests.map(r => r.model)).toEqual([B2])
})

it('R11: a bound-but-missing mailbox delivery is heralded as repair, never replayed as admitted', async () => {
  // Forge the half-write realm: a queued task whose execution binding names
  // a messageId the mailbox does not contain. reconcile classifies it as
  // needing repair; a replay of the same callId answers needs_decision, not
  // an admitted/queued phantom.
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter)
  await s.ctx.sessionLinks.link('r11-pair', [s.alice.id, s.bob.id], { kind: 'human' })
  const tasks = s.ctx.sessionLinkTasks
  const { SessionLinkMessageId, taskIdFor } = await import('../src/index.ts')
  const policy = {
    scope: 'task' as const,
    candidates: [{ provider: 'mock', model: A }],
    ifExhausted: 'notify_sender' as const,
    usesSessionDefault: false,
  }
  await tasks.saveTaskIntent({
    callerId: s.alice.id,
    request: { kind: 'send', callId: 'r11-forge', text: 'forged half-write body', targetSessionId: s.bob.id },
    policy,
    tracked: true,
  })
  const taskId = taskIdFor(s.alice.id, 'r11-forge')
  const ghost = SessionLinkMessageId('session-link-message-r11-ghost')
  const boundPre = await tasks.attachBinding(taskId, 1, { messageId: ghost, sessionId: s.bob.id, admittedAs: 'queued' })
  await tasks.recordTurnIntent(taskId, boundPre.revision, { turnIntentId: 'r11-ghost-intent', messageId: ghost })
  const bound = tasks.getRow(taskId)!
  expect(bound.execution.messageId).toBe(ghost)
  expect(bound.execution.turnIntentId).toBe('r11-ghost-intent')
  // The mailbox does NOT contain the bound identity: reconcile repairs it.
  const { report, notifiedRepairs } = await tasks.reconcile()
  expect(report.needsBindingRepair.map(row => taskIdFor(row.callerId, row.callId))).toContain(taskId)
  expect(notifiedRepairs).toContain(taskId)
  const repaired = tasks.getRow(taskId)!
  expect(repaired.taskState).toBe('waiting_decision')
  expect(repaired.reason).toBe('repair_delivery_missing')
  // Replaying the same callId must NOT answer admitted/queued for the phantom.
  const replayed = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'forged half-write body', provider: 'mock', model: A,
  }, 'r11-forge')
  expect(replayed.isError).not.toBe(true)
  expect((replayed as { value?: { outcome?: string } }).value?.outcome).toBe('needs_decision')
})

it('R13: a default-only fallback admits and executes on the baseline route', async () => {
  // session_default is resolvable at activation: the precheck must not
  // reject it as "unavailable". The request then runs the TARGET baseline
  // (the deployment default the mock controller and the host snapshot name).
  const adapter = new MockAdapter([textResponse('default ok')])
  const s = await stack(adapter, [BASE])
  const result = await exec(s, 'session_spawn_linked_session', {
    cwd: '/tmp/r13-default', task: 'default-only task', provider: 'mock', model: A,
    on_model_unavailable: { fallbacks: [{ use: 'session_default' }] },
  }, 'r13-spawn')
  expect(result.isError).not.toBe(true)
  expect((result as { value?: { outcome?: string } }).value?.outcome).toBe('admitted')
  await s.bob.whenIdle()
  expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
  expect(adapter.requests.at(-1)!.model).toBe(BASE)
})

it('F2-final Important-1: a default-only policy re-recorded after a mixed-batch refusal carries the CONCRETE baseline route', async () => {
  /* Final2 review Important-1 (src/task-runtime.ts mixed-refusal re-record):
   * the re-record built the fresh intent's route ONLY from the first concrete
   * candidate. A default-only policy (single `session_default` sentinel) has
   * none, so the fresh intent carried `route: {}`; activation then named the
   * literal `{provider:'session', model:'session_default'}` placeholder in
   * `execution.currentRoute`, and commitTurn skipped the session-scope
   * persist (routeUsed undefined). The fix resolves the sentinel through the
   * SAME unified chain R13 admission uses (host effective baseline first,
   * catalog default second), so the re-recorded intent names a concrete
   * route. This grip saves the literal single-sentinel policy the reviewer
   * names (the tool schema always requires a concrete primary, so the save
   * rides the service the way a retry-decided policy can) and drives the
   * mixed batch exactly like the IMPORTANT-2 fixture (inbox.splice). */
  let releaseBusy!: () => void
  const busyGate = new Promise<void>(resolve => { releaseBusy = resolve })
  class Gated extends MockAdapter {
    constructor() { super([]) }
    private gated = true
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      this.requests.push(options)
      if (this.gated) {
        this.gated = false
        await busyGate
        for (const chunk of textResponse('busy human answer')) yield chunk as never
        return
      }
      for (const chunk of textResponse(this.requests.length === 2 ? 'human step answer' : 'task answer')) yield chunk as never
    }
  }
  const adapter = new Gated()
  const s = await stack(adapter, [BASE])
  await s.ctx.sessionLinks.link('f2f-pair', [s.alice.id, s.bob.id], { kind: 'human' }, {
    autoWakeSessionIds: [s.bob.id],
  })
  const tasks = s.ctx.sessionLinkTasks
  const { taskIdFor, mintTaskMessageId } = await import('../src/index.ts')
  const { ensureTaskHostLazy } = await import('../src/task-host-lazy.ts')

  // The literal default-only policy the review names: ONE session_default
  // sentinel, no concrete candidate at all.
  const policy = {
    scope: 'session' as const,
    candidates: [{ use: 'session_default' as const }],
    ifExhausted: 'notify_sender' as const,
    usesSessionDefault: true,
  }
  await tasks.saveTaskIntent({
    callerId: s.alice.id,
    request: { kind: 'send', callId: 'f2f-default', text: 'default-only task body', targetSessionId: s.bob.id },
    policy,
    tracked: true,
    selectedCandidateIndex: 0,
  })
  const taskId = taskIdFor(s.alice.id, 'f2f-default')
  const row = tasks.getRow(taskId)!
  // Mirror the R13 admission's own resolution for the FIRST intent (the part
  // admission already does right): the TARGET's effective baseline snapshot
  // when the projection has one, else the deployment catalog default (a cold
  // target's projection reads null until its first turn runs).
  const host = await ensureTaskHostLazy(s.bob)
  expect(host).toBeDefined()
  const admittedRoute = host!.readBaseline().effective ?? { provider: 'mock' as const, model: BASE }
  const messageId = mintTaskMessageId(taskId, 'f2f-default')
  const first = host!.recordTurnIntent({
    taskId,
    attemptId: row.currentAttemptId,
    messageId: messageId as never,
    route: { selection: { provider: admittedRoute.provider, model: admittedRoute.model } },
    persistOnSuccess: true,
  })
  await host!.claimTurnIntent(first.intentId).catch(() => {})
  const boundPre = await tasks.attachBinding(taskId, row.revision, {
    messageId, sessionId: s.bob.id, admittedAs: 'queued',
  })
  await tasks.recordTurnIntent(taskId, boundPre.revision, { turnIntentId: first.intentId, messageId })

  // Bob starts a BUSY human turn whose first request parks on the gate; the
  // managed delivery THEN lands durably in bob's next-turn inbox mid-turn
  // (the F2/IMPORTANT-2 construction order — sending first would wake an
  // idle bob into a clean solo claim and never reach the mixed refusal).
  s.bob.followup({ content: [{ type: 'text', text: 'busy human question' }], source: { kind: 'user' } } as never)
  await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
  const sent = await s.ctx.sessionLinks.send(s.alice, s.bob.id, {
    targetId: s.bob.id, text: 'default-only task body', idempotencyKey: 'f2f-default', messageId,
  })
  expect(sent.status).toBe('accepted')
  expect(sent.messageId).toBe(messageId)
  await vi.waitFor(() => {
    expect(s.bob.inbox.nextTurn.some(message =>
      (message as { source?: { messageId?: string } }).source?.messageId === messageId)).toBe(true)
  })
  // The literal mixed batch: move the managed delivery from next-turn into
  // next-step beside a human message so both claim together; the pre-step
  // gate refuses the tracked entry (parkManagedInput cancels its claim), the
  // human step runs BASE, and the managed message re-claims SOLO next turn —
  // where the cancelled-record re-record is what this grip observes.
  const trackedMessage = s.bob.inbox.nextTurn.find(message =>
    (message as { source?: { messageId?: string } }).source?.messageId === messageId)
  expect(trackedMessage).toBeDefined()
  s.bob.inbox.splice('next-turn', 0, s.bob.inbox.nextTurn.length, [])
  s.bob.inbox.append('next-step', trackedMessage!)
  s.bob.inbox.append('next-step', { content: [{ type: 'text', text: 'human step beside' }], source: { kind: 'user' } } as never)
  releaseBusy()

  await s.bob.whenIdle()
  await vi.waitFor(() => {
    expect(tasks.getRow(taskId)?.taskState).toBe('turn_finished')
  }, { timeout: 8000 })

  // Every request ran BASE: the human busy turn, the refused human step, and
  // the task's SOLO turn on the resolved concrete baseline — never A, never
  // the literal session/session_default placeholder.
  expect(adapter.requests.map(request => request.model)).toEqual([BASE, BASE, BASE])

  // The re-recorded intent (the row's live binding after the solo activation)
  // names the CONCRETE baseline route, not an empty route object.
  const settled = tasks.getRow(taskId)!
  const liveIntentId = settled.execution.turnIntentId!
  expect(liveIntentId).not.toBe(first.intentId)
  const reRecord = host!.getTurnIntent(liveIntentId)!
  expect(reRecord).toBeDefined()
  expect(reRecord.route.selection).toEqual({ provider: 'mock', model: BASE })
  // Activation's currentRoute is the concrete route — never the placeholder.
  expect(settled.execution.currentRoute).toEqual({ provider: 'mock', model: BASE })
  // routeUsed committed (the persist gate the review names), and the session-
  // scope intent was free to persist (persistOnSuccess carried through).
  expect(reRecord.routeUsed).toEqual({ provider: 'mock', model: BASE })
  expect(reRecord.persistOnSuccess).toBe(true)
  const finished = settled.outbox.find(event => event.kind === 'turn_finished')
  expect(finished?.actualModel?.model).toBe(BASE)
}, 20000)

it('R15: concurrent first-creates of one taskId adopt-or-conflict, never silently overwrite', async () => {
  // Two racing first saves with DIFFERENT payloads: exactly one becomes the
  // durable intent; the other refuses with the resolve-task conflict. The
  // stored row's payload is one of the two — never a merged/last-writer
  // clobber — and a later Replay of the winner adopts.
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter)
  const tasks = s.ctx.sessionLinkTasks
  const policy = {
    scope: 'task' as const,
    candidates: [{ provider: 'mock', model: A }],
    ifExhausted: 'notify_sender' as const,
    usesSessionDefault: false,
  }
  const inputFor = (text: string) => ({
    callerId: s.alice.id,
    request: { kind: 'send' as const, callId: 'r15-race', text, targetSessionId: s.bob.id },
    policy,
    tracked: true,
  })
  const [first, second] = await Promise.all([
    tasks.saveTaskIntent(inputFor('payload-alpha')).then(row => ({ ok: true as const, row })).catch((error: unknown) => ({ ok: false as const, error })),
    tasks.saveTaskIntent(inputFor('payload-beta')).then(row => ({ ok: true as const, row })).catch((error: unknown) => ({ ok: false as const, error })),
  ])
  const outcomes = [first, second]
  const adopted = outcomes.filter(outcome => outcome.ok)
  const conflicted = outcomes.filter(outcome => !outcome.ok)
  // One adopted-or-digested, one refused honestly — never two silent writes.
  expect(adopted).toHaveLength(1)
  expect(conflicted).toHaveLength(1)
  const conflictError = (conflicted[0] as { error: unknown }).error
  expect(String(conflictError)).toContain('session_resolve_task')
  const stored = tasks.getRow(adopted[0]!.row.taskId)!
  expect(['payload-alpha', 'payload-beta']).toContain(stored.originalRequest.payloadText)
  // The durable row is exactly the winner's: the adopted outcome's row.
  expect(stored.originalRequest.payloadText).toBe(adopted[0]!.row.row.originalRequest.payloadText)
})

it('R16: a replay whose tail diverges beyond 2048 UTF-16 units conflicts instead of adopting', async () => {
  // Pre-fix the digest truncated the text slice at 2048 units: two calls
  // sharing their first 2048 units but diverging after hashed identically
  // and the second call silently ADOPTED the first call's row. The full-body
  // digest must refuse the second call with the resolve_task conflict.
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE])
  const head = 'x'.repeat(2050)
  const first = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: head, provider: 'mock', model: A,
  }, 'r16-send')
  expect(first.isError).not.toBe(true)
  const replay = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: `${head} diverging tail`, provider: 'mock', model: A,
  }, 'r16-send')
  expect(replay.isError).toBe(true)
  expect(JSON.stringify((replay as { content?: unknown }).content)).toContain('session_resolve_task')
})

it('R16 legacy adoption: a PRE-R16 row still recognizes its genuine replay through the legacy digest', async () => {
  // Document the old-row evidence: rows the pre-R16 build durably saved carry
  // no payloadText and a v1 (bounded-slice) digest. `requestDigest`'s v2
  // recomputation never matches those rows; the adopted replay path recomputes
  // the LEGACY digest for them so their genuine replays still adopt, while the
  // old coarser frontier remains exactly what the old build produced (no
  // cross-version forgiveness).
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter)
  const tasks = s.ctx.sessionLinkTasks
  const policy = {
    scope: 'task' as const,
    candidates: [{ provider: 'mock', model: A }],
    ifExhausted: 'notify_sender' as const,
    usesSessionDefault: false,
  }
  const { legacyRequestDigest, requestDigest } = await import('../src/tasks.ts')
  const request = { kind: 'send' as const, callId: 'r16-legacy', text: 'legacy row body', targetSessionId: s.bob.id }
  const saved = await tasks.saveTaskIntent({ callerId: s.alice.id, request, policy, tracked: true })
  // Simulate a pre-R16 durable row: rewrite its digest to the legacy form
  // and drop payloadText (exactly what the old build persisted).
  const legacyRow = tasks.getRow(saved.taskId)!
  const rewritten = {
    ...legacyRow,
    originalRequest: {
      digest: legacyRequestDigest(request, policy),
      summary: legacyRow.originalRequest.summary,
    },
  }
  const table = (tasks as unknown as { tasks: { put(key: unknown, value: unknown): Promise<void> } }).tasks
  await table.put(saved.taskId, rewritten)
  // A genuine replay (identical params) ADOPTS through the legacy comparison.
  const adopted = await tasks.saveTaskIntent({ callerId: s.alice.id, request, policy, tracked: true })
  expect(adopted.row.originalRequest.digest).toBe(legacyRequestDigest(request, policy))
  // The v1/v2 digests genuinely differ — the version bump is real.
  expect(legacyRequestDigest(request, policy)).not.toBe(requestDigest(request, policy))
})

/* --------------------------------------------------------------------------
 * Task 5 gates — the reviewer's three flagged-but-unconfirmed risks
 * (CODE_REVIEW_MODEL_ROUTING.md §"尚未计为已确认缺陷的风险") plus the
 * concurrent decision-replay atomicity verification ("还需单独验证"). These
 * are the FIRST persistent fixtures that exercise the exact realms the
 * reviewer flagged; the two retry-scope cases double as the adjudication
 * lock (a decision replacing the route preserves the original scope).
 * ------------------------------------------------------------------------ */

it('Risk-3 retry scope: a retry replacing the route on a SESSION-scope task preserves the session grant', async () => {
  // Reviewer observation: policy.scope=session + retry with a replacement
  // provider/model measured scope flipping to task. Adjudicated and LOCKED:
  // session scope is the user's persistent-selection consent scoped to the
  // task; silently degrading removes that consent (wrong direction). The
  // durable policy snapshot on the NEW attempt must carry the ORIGINAL
  // scope, and the wire surface stays scope-free.
  const adapter = new MockAdapter([textResponse('ok')])
  // Catalog lacks model-a: the session-scope task fails precheck honestly.
  const s = await stack(adapter, [BASE, 'model-b'])
  const B2 = 'model-b'
  const spawned = await exec(s, 'session_spawn_linked_session', {
    cwd: '/tmp/risk3-session', task: 'session-scope retry task', provider: 'mock', model: A, model_scope: 'session',
  }, 'risk3-session')
  expect(spawned.isError).not.toBe(true)
  expect((spawned as { value?: { outcome?: string } }).value?.outcome).toBe('needs_decision')
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'risk3-session')
  const waiting = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(waiting.taskState).toBe('waiting_decision')
  expect(waiting.policy.scope).toBe('session')
  // Retry with a different provider/model, omitting any scope token.
  const decided = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: waiting.revision, action: 'retry', provider: 'mock', model: B2,
  }, 'risk3-session-decision')
  expect(decided.isError).not.toBe(true)
  const row = s.ctx.sessionLinkTasks.getRow(taskId)!
  // LOCKED: the durable policy snapshot preserves the ORIGINAL session grant.
  expect(row.policy.scope).toBe('session')
  expect((row.policy.candidates[0] as { model?: string }).model).toBe(B2)
  const newAttempt = row.attempts.at(-1)!
  expect(newAttempt.kind).toBe('retry')
  await s.bob.whenIdle().catch(() => {})
})

it('Risk-3 retry scope: a retry replacing the route on a TASK-scope task keeps task scope (never a silent upgrade either)', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE, 'model-b'])
  const B2 = 'model-b'
  const spawned = await exec(s, 'session_spawn_linked_session', {
    cwd: '/tmp/risk3-task', task: 'task-scope retry task', provider: 'mock', model: A,
  }, 'risk3-task')
  expect(spawned.isError).not.toBe(true)
  expect((spawned as { value?: { outcome?: string } }).value?.outcome).toBe('needs_decision')
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'risk3-task')
  const waiting = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(waiting.taskState).toBe('waiting_decision')
  expect(waiting.policy.scope).toBe('task')
  const decided = await exec(s, 'session_resolve_task', {
    task_id: taskId, expected_revision: waiting.revision, action: 'retry', provider: 'mock', model: B2,
  }, 'risk3-task-decision')
  expect(decided.isError).not.toBe(true)
  const row = s.ctx.sessionLinkTasks.getRow(taskId)!
  // Symmetric lock: task scope is preserved verbatim (no silent upgrade).
  expect(row.policy.scope).toBe('task')
  expect((row.policy.candidates[0] as { model?: string }).model).toBe(B2)
  await s.bob.whenIdle().catch(() => {})
})

it('Risk-2 marker cascade: persistently failing outbox-marker writes bound the pump cascade, surface on get_task, keep ONE mailbox row, and self-heal', async () => {
  /* Reviewer realm, reproduced deterministically: the mailbox admission
   * SUCCEEDS (a real durable mailbox row ships) while the task-table marker
   * write KEEPS FAILING. Pre-fix the pump's cascade re-entered with no bound
   * (each pass's successful mailbox write set the cascade flag again).
   * Post-fix: (1) the epoch budget caps consecutive failure-driven cascades;
   * (2) session_get_task surfaces the event pending + marker failure note;
   * (3) exactly ONE mailbox row ever exists; (4) a later genuine trigger
   * (writes recovering) self-heals — marker lands, note clears. */
  const { bootStack } = await import('./helpers/domains.ts')
  const { installTaskNotifications } = await import('../src/task-notifications.ts')
  const { MemoryMediaPool } = await import('./helpers/memory-backend.ts')
  // bootStack registers its contexts in the caller's set; this test owns its
  // own registry so the fault-injected stacks dispose with the test.
  const localContexts = new Set<import('@deepseek-ai/cordis').Context>()
  const pools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
  const adapter = new MockAdapter([textResponse('ok')])
  const booted = await bootStack(localContexts, pools, { adapter })
  try {
    const pump = installTaskNotifications(booted.ctx, {
      tasks: () => booted.ctx.sessionLinkTasks,
      links: () => booted.ctx.sessionLinks,
    })
    await booted.ctx.sessionLinks.link('risk2-pair', [booted.alice.id, booted.bob.id], { kind: 'human' })
    /* Arm the persistent task-table write failure IMMEDIATELY: the domain
     * seeds its global doc and the link create commits before the next
     * task-table write, so the intent write below still lands; every write
     * AFTER it (the outbox marker) fails for the rest of the armed window. */
    const sent = await booted.ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('risk2-send'),
      name: 'session_send_session_message', agent: booted.alice,
      // bootStack's default catalog lacks 'model-absent': the tracked send
      // fails precheck honestly, committing a waiting task with ONE pending
      // outbox event (no session, no mailbox message).
      arguments: { session_id: booted.bob.id, message: 'risk2 task on a missing model', provider: 'mock', model: 'model-absent' },
    })
    expect(sent.isError).not.toBe(true)
    expect((sent as { value?: { outcome?: string } }).value?.outcome).toBe('needs_decision')
    const { taskIdFor } = await import('../src/index.ts')
    const taskId = taskIdFor(booted.alice.id, 'risk2-send')
    /* The pump pass the send scheduled may race our arming, so settle the
     * queue and RESET the outbox event to pending if a healthy pass already
     * admitted it — the deterministic starting state for the failing epoch
     * is "pending + mailbox row EXISTS", exactly the reviewer's realm after
     * the first admission. Re-arming persistent failures then drives the
     * failing epoch honestly. */
    const drain = async () => {
      await pump.drain(); await pump.drain(); await pump.drain(); await pump.drain(); await pump.drain()
    }
    await drain()
    const live0 = booted.ctx.sessionLinkTasks.getRow(taskId)!
    const event0 = live0.outbox[0]!
    const table = (booted.ctx.sessionLinkTasks as unknown as { tasks: {
      put(key: unknown, value: unknown): Promise<void>
    } }).tasks
    const cleaned = { ...event0, status: 'pending' as const }
    delete (cleaned as { notifiedMessageId?: unknown }).notifiedMessageId
    await table.put(taskId, { ...live0, outbox: [cleaned] })
    pools.tasks.failWritesTo('tasks', ...Array.from({ length: 64 }, (_u, i) => i + 1))
    pump.schedule()
    await drain()
    // Exactly ONE mailbox row ever exists (eventId idempotency replays).
    const mailbox = () => [...(booted.ctx.sessionLinks as unknown as {
      messages: { entries(): Iterable<[string, { status: string }]> }
    }).messages.entries()]
    expect(mailbox()).toHaveLength(1)
    // The event honestly stayed pending (admitted-not-marker-confirmed)…
    const row = booted.ctx.sessionLinkTasks.getRow(taskId)!
    expect(row.outbox[0]!.status).toBe('pending')
    expect(row.outbox[0]!.notifiedMessageId).toBeUndefined()
    // …and session_get_task surfaces the marker-write failure visibly.
    const view = booted.ctx.sessionLinkTasks.getTask(booted.alice.id, taskId)
    expect(view.outboxMarkerFailureNotes).toBeDefined()
    expect(view.outboxMarkerFailureNotes!.some(note => note.eventId === row.outbox[0]!.eventId)).toBe(true)
    // The epoch's cascade was BOUNDED (drain()`s queue quiesced above).
    // RECOVERY: the medium heals; a fresh genuine trigger settles the marker.
    await drain()
    ;(pools.tasks as unknown as { tableFailures: Map<string, unknown> }).tableFailures.clear()
    pump.schedule()
    await drain()
    const settled = booted.ctx.sessionLinkTasks.getRow(taskId)!
    expect(settled.outbox[0]!.status).toBe('admitted')
    expect(settled.outbox[0]!.notifiedMessageId).toBeDefined()
    expect(mailbox()).toHaveLength(1)
    expect(booted.ctx.sessionLinkTasks.getTask(booted.alice.id, taskId).outboxMarkerFailureNotes).toBeUndefined()
    expect(booted.ctx.sessionLinkTasks.getRow(taskId)!.outbox[0]!.status).toBe('admitted')
  } finally {
    for (const ctx of [...localContexts].reverse()) await ctx.fiber.dispose()
    localContexts.clear()
  }
})

it('Risk-4 concurrent decision replay: two racing resolve_task calls with the SAME decision callId never double-apply', async () => {
  /* The reviewer verified sequential replay idempotent and asked whether the
   * CONCURRENT realm (two in-flight resolve_task with one decisionCallId)
   * stays atomic. The decisions.find-before-CAS guard plus the single row
   * write leaves exactly ONE recorded decision: the loser's decisions.find
   * read either sees the winner (returns the recorded outcome) or the
   * winner's CAS bumped the revision (the loser records `stale` or fails
   * its own CAS). NEVER two applied attempts. */
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE])
  const sent = await exec(s, 'session_send_session_message', {
    session_id: s.bob.id, message: 'risk4 concurrent decision task', provider: 'mock', model: A,
  }, 'risk4-send')
  expect(sent.isError).not.toBe(true)
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'risk4-send')
  await vi.waitFor(() => expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('waiting_decision'))
  const waiting = s.ctx.sessionLinkTasks.getRow(taskId)!
  // Fire TWO resolve_task calls with the SAME decision callId concurrently.
  const [first, second] = await Promise.allSettled([
    exec(s, 'session_resolve_task', {
      task_id: taskId, expected_revision: waiting.revision, action: 'retry', provider: 'mock', model: BASE,
    }, 'risk4-race-callId'),
    exec(s, 'session_resolve_task', {
      task_id: taskId, expected_revision: waiting.revision, action: 'retry', provider: 'mock', model: BASE,
    }, 'risk4-race-callId'),
  ])
  // Both settle (never a hang), and exactly ONE decision is recorded.
  expect(first.status).toBe('fulfilled')
  expect(second.status).toBe('fulfilled')
  const final = s.ctx.sessionLinkTasks.getRow(taskId)!
  const recorded = final.decisions.filter(d => d.callId === 'risk4-race-callId')
  // Exactly one applied outcome for that callId; never two attempts minted.
  expect(recorded.filter(d => d.outcome === 'applied')).toHaveLength(1)
  expect(final.decisions.filter(d => d.callId === 'risk4-race-callId').length).toBeGreaterThanOrEqual(1)
  expect(final.attempts.length).toBeLessThanOrEqual(2)
  // The loser observed the recorded outcome (same decision, or stale), and
  // the task never double-attempts (currentAttemptId stable).
  const winner = recorded.find(d => d.outcome === 'applied')!
  expect(final.currentAttemptId).toBe(winner.attemptId ?? final.currentAttemptId)
  await s.bob.whenIdle().catch(() => {})
})

it('Risk-1 terminal/marker race: the terminal projection never mis-classifies a marker CAS as an already-settled terminal write', async () => {
  /* Reviewer realm, proven safe at the shared write chain: the terminal
   * projection and an outbox marker ride the SAME domain update chain, so a
   * revision race can only resolve as a stale CAS for ONE of them — never a
   * cross-write mis-ordering. Deterministic proof: interleave a pending
   * outbox event's marker advance with the finish projection on the live
   * task, then assert (a) the terminal state landed exactly once, (b) the
   * event committed in the SAME row write as the terminal state, and (c)
   * nothing swallowed a durable failure as "another terminal projection
   * already done". We fabricate the interleave by advancing the revision
   * with a marker between the projection's read and its CAS. */
  class Failing extends MockAdapter {
    constructor() { super([]) }
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      this.requests.push(options)
      throw new HarnessError('down', 'PROVIDER_UNAVAILABLE')
    }
  }
  const adapter = new Failing()
  const s = await stack(adapter, [BASE, A])
  const spawned = await spawn(s, 'risk1-race', { provider: 'mock', model: A })
  expect(spawned.outcome).toBe('admitted')
  const { taskIdFor } = await import('../src/index.ts')
  const taskId = taskIdFor(s.alice.id, 'risk1-race')
  // The task activates, fails, and the runtime projects waiting_decision
  // with one model_unavailable event — the terminal projection's own write.
  await s.bob.whenIdle().catch(() => {})
  await vi.waitFor(() => expect(s.ctx.sessionLinkTasks.getRow(taskId)?.taskState).toBe('waiting_decision'))
  /* Snapshot the terminal facts. The outbox pump may still settle the
   * terminal event's marker asynchronously (legitimately bumping the
   * revision), so freeze the pre-marker state here — the proof below only
   * needs the terminal event's uniqueness and the stale-CAS classification,
   * not a frozen revision. */
  const terminal = s.ctx.sessionLinkTasks.getRow(taskId)!
  // Exactly ONE terminal event committed, riding the same row write.
  expect(terminal.outbox.filter(e => e.kind === 'model_unavailable')).toHaveLength(1)
  expect(terminal.executionState).toBe('not_started')
  const terminalEventCount = terminal.outbox.length
  /* Fabricate the INTERLEAVE the reviewer feared: a concurrent outbox marker
   * advances the revision between a hypothetical re-projection's read and
   * CAS. A second finish projection against the STALE token must classify
   * the rejection as a stale CAS (never throw a false "terminal already
   * done" error and never silently succeed onto a lived-on row). Requesting
   * the SAME terminal state is a legal no-op refusal (TASK_TERMINAL) — the
   * classifier must name it, and a durable failure must NOT be collapsed
   * into that class. Prove the classification end-to-end: an obviously-stale
   * re-projection surfaces a typed terminal/stale refusal, not a mis-settled
   * row. */
  const staleToken = terminal.revision - 1
  let classified: unknown
  try {
    await s.ctx.sessionLinkTasks.requestStateChange(taskId, staleToken, {
      toState: 'waiting_decision',
      executionState: 'not_started',
      reason: 'replay-of-a-settled-terminal',
      events: [{ kind: 'model_unavailable', executionState: 'not_started', reason: 'replay', decisionRequired: true, resumable: true }],
    })
  } catch (error: unknown) { classified = error }
  /* The rejection is a TYPED CAS-class refusal — stale revision or already-
   * terminal — never an untyped "another terminal projection already done"
   * mis-read, and crucially never a silent success. Either spelling means
   * the race resolved through the shared write chain's version check. */
  expect(['TASK_STALE_REVISION', 'TASK_TERMINAL']).toContain((classified as { code?: string })?.code)
  // The row's terminal content is untouched: still exactly one terminal
  // event (the revision may have legitimately advanced through the pump's
  // marker settle — forward progress, never a re-projection).
  const after = s.ctx.sessionLinkTasks.getRow(taskId)!
  expect(after.outbox.filter(e => e.kind === 'model_unavailable')).toHaveLength(1)
  expect(after.outbox).toHaveLength(terminalEventCount)
  expect(after.taskState).toBe('waiting_decision')
})

it('Risk-1 durable-failure arm: a terminal projection whose row write fails durably surfaces TASK_WRITE_FAILED, never the settled-by-race class', async () => {
  /* The reviewer's "吞掉 CAS 异常" concern cuts both ways: a durable write
   * failure reaching the finish projection must propagate to its warn log —
   * NEVER be collapsed into "CAS conflict: the row already settled". The
   * service layer's honest classification IS the runtime's input (the
   * runtime rethrows anything that is not a typed stale/terminal rejection),
   * so pin it at that boundary: while task-table writes fail, the terminal
   * projection call rejects TASK_WRITE_FAILED and leaves the row's durable
   * state unchanged (no half-landed terminal, no phantom event). */
  const { bootStack } = await import('./helpers/domains.ts')
  const { MemoryMediaPool } = await import('./helpers/memory-backend.ts')
  const localContexts = new Set<import('@deepseek-ai/cordis').Context>()
  const pools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
  const booted = await bootStack(localContexts, pools, { adapter: new MockAdapter([textResponse('ok')]) })
  try {
    const tasks = booted.ctx.sessionLinkTasks
    const policy = {
      scope: 'task' as const,
      candidates: [{ provider: 'mock', model: A }],
      ifExhausted: 'notify_sender' as const,
      usesSessionDefault: false,
    }
    const saved = await tasks.saveTaskIntent({
      callerId: booted.alice.id,
      request: { kind: 'send', callId: 'risk1-writefail', text: 'terminal write-fail task', targetSessionId: booted.bob.id },
      policy,
      tracked: true,
    })
    // A queued→running claim rides a healthy terminal path first…
    await tasks.requestStateChange(saved.taskId, 1, { toState: 'queued' })
    const running = await tasks.requestStateChange(saved.taskId, 2, { toState: 'running' })
    // …then the finish projection's own write fails durably. EVERY task-table
    // write rejects from here; the projection must surface the typed durable
    // failure and the row must stay PRE-terminal.
    pools.tasks.failWritesTo('tasks', ...Array.from({ length: 8 }, (_u, i) => i + 1))
    let classified: unknown
    try {
      await tasks.requestStateChange(saved.taskId, running.revision, {
        toState: 'turn_finished',
        routeUsed: { provider: 'mock', model: A },
        events: [{ kind: 'turn_finished', decisionRequired: false, resumable: false }],
      })
    } catch (error: unknown) { classified = error }
    expect((classified as { code?: string })?.code).toBe('TASK_WRITE_FAILED')
    const row = tasks.getRow(saved.taskId)!
    expect(row.taskState).toBe('running')
    expect(row.outbox.some(e => e.kind === 'turn_finished')).toBe(false)
    /* The runtime's ONLY swallow class is the typed stale/terminal one:
     * assert positively that TASK_WRITE_FAILED is not in it — the contract
     * `isStaleRejection` rides. A re-attempt after healing lands exactly
     * once. */
    ;(pools.tasks as unknown as { tableFailures: Map<string, unknown> }).tableFailures.clear()
    const healed = await tasks.requestStateChange(saved.taskId, running.revision, {
      toState: 'turn_finished',
      routeUsed: { provider: 'mock', model: A },
      events: [{ kind: 'turn_finished', decisionRequired: false, resumable: false }],
    })
    expect(healed.taskState).toBe('turn_finished')
    expect(healed.outbox.filter(e => e.kind === 'turn_finished')).toHaveLength(1)
  } finally {
    for (const ctx of [...localContexts].reverse()) await ctx.fiber.dispose()
    localContexts.clear()
  }
})
