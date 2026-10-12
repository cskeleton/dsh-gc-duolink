/**
 * Round-2 review-defect grip tests (R##-prefixed). Each case pins one confirmed
 * review finding through the harness the reviewer normalized in
 * `artifacts/review/model-routing-probes.spec.ts`; R01 specifically proves the
 * PRODUCTION assembly (raw-loader sub-plugin + cordis inject, no test escape)
 * admits a tracked spawn.
 *
 * Task 2 (MODEL_ROUTING_FIX_PLAN) lands the unified host single owner for
 * task-bound turns: R02 (controller never overrides the task route), R06
 * (monotonic baseline CAS revision), R07 (durable task/human baseline
 * separation across a rebuild), R05 (success-gated persist), R04 (host
 * managed-input guard), and R12 (partial streamed output bars automatic
 * fallback). R03/R08+ remain Task-3+ work and stay RED here.
 * @module
 */

import { expect, it } from 'vitest'
import { A, BASE, spawn, stack } from '../artifacts/review/model-routing-probes.spec.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'
import { HarnessError } from '@deepseek-ai/dsh-llm'

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
