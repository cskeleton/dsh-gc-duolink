/**
 * F2 regression (MODEL_ROUTING_PLAN Task 5 review item): a turn whose claimed
 * batch contains BOTH a human message AND a tracked session-link delivery must
 * NOT freeze the whole turn on the task route. Refusing tracked activation
 * into the mixed batch keeps the human step on the session baseline; the
 * queued task activates at its OWN later turn and runs on its own route.
 *
 * Requires DSH_SOURCE_ROOT; run under `DSH_SOURCE_ROOT=… pnpm exec vitest run`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult, ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionLinkService, { taskIdFor } from '../src/index.ts'
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
  if (failures.length > 0) throw new AggregateError(failures, 'mixed-batch test cleanup failed')
})

const BASE = 'base-model'
const MODEL_A = 'model-a'
const SIGNAL = new AbortController().signal

function humanMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  } as never
}

function call(ctx: Context, name: string, args: unknown, agent: Agent, callId: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId(callId), name, arguments: args, agent })
}

function succeeded(result: ToolExecutionResult): ToolExecutionSuccess {
  if (result.isError) throw new Error(`tool call failed unexpectedly: ${JSON.stringify(result.content)}`)
  return result
}

describe('task-runtime F2: mixed claimed batches never inherit the task route', () => {
  it('a tracked delivery and a human message activate on their own turns; no tracked batch ever freezes a human step', async () => {
    /* Task-4 review F2 fix: every tracked delivery activates into a SOLO
     * claim batch. The pre-step gate enforces it durably: a claim batch
     * whose messages are not all session-link deliveries of the one task
     * being activated REFUSES tracked activation; the task's message goes
     * to the NEXT turn's queue, and the task row stays `queued` until its
     * own solo turn claims it. Empirically the production inbox paths never
     * co-claim a tracked delivery with a human message (the mailbox inserts
     * peer mail as the next-TURN head; a waking human message opens its own
     * turn first), but the guard must hold if any future path ever produces
     * that interleave — the invariant is what ships, never the
     * mixed-batch-freeze hack. */
    const adapter = new MockAdapter([
      textResponse('busy human answer'),
      textResponse(`task answer on ${MODEL_A}`),
      textResponse('final baseline answer'),
    ])
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const s = await bootStack(contexts, pools, { adapter })
    // auto-wake so the tracked delivery rides the busy-follow insertion.
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    const tasks = s.ctx.sessionLinkTasks

    // Bob RUNNING his own human question; the tracked send and the human
    // follow-up both arrive while the turn runs.
    s.bob.followup(humanMessage('busy human question'))
    await vi.waitFor(() => { expect(s.bob.status).toBe('running') })
    const sent = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'tracked delivery',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-mixed-1')).value as { status: string; messageId: string }
    expect(sent.status).toBe('accepted')
    const taskId = taskIdFor(s.alice.id, 'call-mixed-1')
    s.bob.followup(humanMessage('human follow-up while busy'))
    await s.bob.whenIdle()
    await vi.waitFor(() => {
      expect(tasks.getRow(taskId)?.taskState).toBe('turn_finished')
    }, { timeout: 5000 })
    // A final human turn must see the restored baseline.
    s.bob.followup(humanMessage('final check'))
    await s.bob.whenIdle()

    const models = adapter.requests.map(request => request.model)
    // Invariant order: the busy human turn BASE, the task's own solo turn
    // MODEL_A, the human turns BASE again.
    expect(models[0]).toBe(BASE)
    expect(models[1]).toBe(MODEL_A)
    expect(models[2]).toBe(BASE)
    expect(models.every((model, index) => model === (index === 1 ? MODEL_A : BASE))).toBe(true)
    const finished = tasks.getRow(taskId)?.outbox.find(event => event.kind === 'turn_finished')
    expect(finished?.actualModel?.model).toBe(MODEL_A)
  }, 20000)
})

describe('task-runtime IMPORTANT-2: a refused mixed batch leaves no stale parked claim', () => {
  it('the human step of a refused mixed batch never freezes, and the task activates cleanly at its own next turn', async () => {
    /* IMPORTANT-2 (final review): the pre-step mixed gate re-appends tracked
     * messages to next-turn; the OLD code also left their ids parked in
     * runtime.claimedPending keyed by THIS turn — so the human step's first
     * agent/request of the same turn found the stale entry and JIT-activated
     * the task onto the human step. This test constructs the literal mixed
     * claimed batch (Task 5's inbox.splice shape): the tracked delivery is
     * moved from next-turn into next-step beside a human message while the
     * target's first turn is gated mid-flight, so both claim together at the
     * next step boundary. Assert BASE → BASE → MODEL_A (the old bug surfaced
     * as BASE → MODEL_A at the human step). */
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
        for (const chunk of textResponse(this.requests.length === 2 ? 'human step answer' : `task answer on ${MODEL_A}`)) yield chunk as never
      }
    }
    const adapter = new Gated()
    const pools: BackendPools = { links: new MemoryMediaPool(), tasks: new MemoryMediaPool() }
    const s = await bootStack(contexts, pools, { adapter })
    await s.ctx.sessionLinks.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    const tasks = s.ctx.sessionLinkTasks

    // Bob starts a BUSY human turn whose first request parks on the gate.
    s.bob.followup(humanMessage('busy human question'))
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    // The tracked delivery lands durably in bob's next-turn inbox mid-turn.
    const sent = succeeded(await call(s.ctx, 'session_send_session_message', {
      session_id: s.bob.id,
      message: 'tracked delivery',
      provider: 'mock',
      model: MODEL_A,
    }, s.alice, 'call-mixed-stale-1')).value as { status: string; messageId: string }
    expect(sent.status).toBe('accepted')
    const taskId = taskIdFor(s.alice.id, 'call-mixed-stale-1')
    await vi.waitFor(() => {
      expect(s.bob.inbox.nextTurn.some(message =>
        (message as { source?: { messageId?: string } }).source?.messageId === sent.messageId)).toBe(true)
    })
    // Construct the literal mixed batch the review names: move the delivered
    // tracked message OUT of next-turn and INTO next-step beside a human
    // message, so the next step boundary claims BOTH in one batch.
    const trackedMessage = s.bob.inbox.nextTurn.find(message =>
      (message as { source?: { messageId?: string } }).source?.messageId === sent.messageId)
    expect(trackedMessage).toBeDefined()
    s.bob.inbox.splice('next-turn', 0, s.bob.inbox.nextTurn.length, [])
    s.bob.inbox.append('next-step', trackedMessage!)
    s.bob.inbox.append('next-step', humanMessage('human step beside the tracked message'))
    releaseBusy()

    // Turn 1 (BASE busy) closes; the MIXED batch claims as the steer step of
    // the SAME turn — the gate must refuse the tracked entry, run the human
    // step on BASE, and re-park the tracked delivery for its own SOLO later
    // turn on MODEL_A.
    await s.bob.whenIdle()
    await vi.waitFor(() => {
      expect(tasks.getRow(taskId)?.taskState).toBe('turn_finished')
    }, { timeout: 8000 })
    const models = adapter.requests.map(request => request.model)
    expect(models).toEqual([BASE, BASE, MODEL_A])
    const finished = tasks.getRow(taskId)?.outbox.find(event => event.kind === 'turn_finished')
    expect(finished?.actualModel?.model).toBe(MODEL_A)
  }, 20000)
})
