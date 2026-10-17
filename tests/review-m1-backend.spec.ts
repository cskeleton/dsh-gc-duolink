import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionLinkService from '../src/index.ts'
import { frameSessionLinkText } from '../src/link.ts'
import type { SessionLinkMessageRecordData } from '../src/spec.ts'
import { SessionLinkId, SessionLinkMessageId } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

// Independent review regressions: desired behavior, not implementation snapshots.
const contexts: Context[] = []
const alice = SessionId('session-alice')
const bob = SessionId('session-bob')
const eve = SessionId('session-eve')
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
  ctx.provide('sessionController', { inspect: async (id: string) => ({ meta: { id, cwd: '/tmp' } }) } as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionLinkService, {})
  await ctx.agentLoop.create(alice, { provider: 'mock', model: 'mock' })
  const target = await ctx.agentLoop.create(bob, { provider: 'mock', model: 'mock' })
  return { ctx, service: ctx.gcDuolink, target }
}
async function mail(service: SessionLinkService, id: string, patch: Partial<SessionLinkMessageRecordData>) {
  await service['messages'].put(SessionLinkMessageId(id), {
    linkId: SessionLinkId('review-link'), senderId: alice, senderTitle: 'Alice', targetId: bob,
    text: 'review body', status: 'pending', wakesUsed: 0, chainLength: 1, attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z', ...patch,
  })
}

describe('M1 independent backend review', () => {
  it('does not attribute another pair\'s first-task wake debt to an unrelated owner', async () => {
    const { service } = await setup()
    await service.link('spawn pair', [alice, bob], { kind: 'session', sessionId: alice })
    const view = await service.activityView({ sessionId: eve, section: 'pending' })
    expect(view.summary.firstTaskWakeOwed).toBe(false)
  })

  it('shows pending messages in the actual delivery order for mixed generations', async () => {
    const { service } = await setup()
    const { id: linkId } = await service.link('pair', [alice, bob], { kind: 'human' })
    await mail(service, 'old', { linkId, createdAt: '2026-01-02T00:00:00.000Z' })
    await mail(service, 'new', { linkId, seq: 1, createdAt: '2026-01-01T00:00:00.000Z' })
    const deliveryOrder = service['pendingFor'](bob).map(([id]) => id)
    const view = await service.activityView({ sessionId: alice, section: 'pending' })
    expect(view.entries.map(entry => entry.messageId)).toEqual(deliveryOrder)
  })

  it('does not expose synthetic credential values in lastError', async () => {
    const { service } = await setup()
    const secret = 'SYNTHETIC_REVIEW_SECRET_NOT_A_REAL_CREDENTIAL'
    await mail(service, 'error', { status: 'failed', error: `Authorization: Bearer ${secret}; https://example.invalid/?api_key=${secret}` })
    const view = await service.activityView({ sessionId: alice, section: 'recent' })
    expect(view.entries[0]?.lastError ?? '').not.toContain(secret)
  })

  it('extracts only the body when a legitimate sender title contains a newline', async () => {
    const { service } = await setup()
    const messageId = SessionLinkMessageId('framed')
    const text = frameSessionLinkText({ senderTitle: 'Alice\nResearch', senderId: alice, messageId, text: 'actual body' })
    await mail(service, messageId, { text, senderTitle: 'Alice\nResearch', status: 'delivered' })
    const view = await service.activityView({ sessionId: bob, section: 'recent' })
    expect(view.entries[0]?.preview).toBe('actual body')
  })

  it('does not report missing idle wake permission as a running-target delivery blocker', async () => {
    const { service, target } = await setup()
    const { id: linkId } = await service.link('pair', [alice, bob], { kind: 'human' })
    await mail(service, 'running', { linkId })
    const descriptor = Object.getOwnPropertyDescriptor(target, 'status')
    Object.defineProperty(target, 'status', { configurable: true, value: 'running' })
    try {
      const view = await service.activityView({ sessionId: alice, section: 'pending' })
      expect(view.entries[0]?.blockingReasons).not.toContain('wake-unauthorized')
    } finally {
      if (descriptor) Object.defineProperty(target, 'status', descriptor)
      else Reflect.deleteProperty(target, 'status')
    }
  })

  it('preserves each real target queue when mixed-generation messages have multiple recipients', async () => {
    const { service } = await setup()
    const { id: linkId } = await service.link('trio', [alice, bob, eve], { kind: 'human' })
    // The legacy pairwise comparator is non-transitive. Sorting a superset
    // then filtering is NOT equivalent to sorting the target queue itself.
    await mail(service, 'a', { linkId, seq: 1, createdAt: '2026-01-04T00:00:00.000Z' })
    await mail(service, 'b', { linkId, seq: 2, createdAt: '2026-01-02T00:00:00.000Z' })
    await mail(service, 'd', { linkId, targetId: eve, createdAt: '2026-01-01T00:00:00.000Z' })
    await mail(service, 'c', { linkId, createdAt: '2026-01-03T00:00:00.000Z' })
    const expected = service['pendingFor'](bob).map(([id]) => id)
    const view = await service.activityView({ sessionId: alice, section: 'pending' })
    expect(view.entries.filter(entry => entry.targetId === bob).map(entry => entry.messageId)).toEqual(expected)
  })

  it.each([
    'request failed: password=SYNTHETIC_REREVIEW_SECRET',
    '{"api_key":"SYNTHETIC_REREVIEW_SECRET"}',
  ])('does not expose synthetic non-URL credentials: %s', async error => {
    const { service } = await setup()
    await mail(service, 'credential', { status: 'failed', error })
    const view = await service.activityView({ sessionId: alice, section: 'recent' })
    expect(view.entries[0]?.lastError ?? '').not.toContain('SYNTHETIC_REREVIEW_SECRET')
  })

  it.each([
    'https://example.invalid/?key=SYNTHETIC_REVIEW_R3_SECRET',
    JSON.stringify({ password: "prefix'SYNTHETIC_REVIEW_R3_SECRET" }),
    JSON.stringify({ token: 'prefix"SYNTHETIC_REVIEW_R3_SECRET' }),
  ])('does not expose synthetic credentials in query keys or valid quoted JSON: %s', async error => {
    const { service } = await setup()
    await mail(service, 'quoted-credential', { status: 'failed', error })
    const view = await service.activityView({ sessionId: alice, section: 'recent' })
    expect(view.entries[0]?.lastError ?? '').not.toContain('SYNTHETIC_REVIEW_R3_SECRET')
  })
})
