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
