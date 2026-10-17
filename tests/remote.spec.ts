import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionLinkService from '../src/index.ts'
import { frameSessionLinkText } from '../src/link.ts'
import { SESSION_LINK_LEDGER_KEY } from '../src/spec.ts'
import type { SessionLinkMessageRecordData } from '../src/spec.ts'
import { SessionLinkId, SessionLinkMessageId } from '../src/types.ts'
import type { Config as SessionLinkConfigShape } from '../src/types.ts'
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
  if (failures.length > 0) throw new AggregateError(failures, 'session-link remote test cleanup failed')
})

interface Stack {
  readonly ctx: Context
  readonly links: SessionLinkService
  readonly alice: Agent
  readonly bob: Agent
  readonly listCalls: { request: unknown; signal: AbortSignal }[]
  readonly archived: SessionId[]
}

/**
 * Mount the service over the in-memory storage domain with two live root
 * Agents and a stub Session Controller that knows exactly `session-alice` and
 * `session-bob` as ordinary Sessions and `session-sub` as a subagent-owned one.
 */
async function stack(config: SessionLinkConfigShape = {}): Promise<Stack> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const archived: SessionId[] = []
  const listCalls: { request: unknown; signal: AbortSignal }[] = []
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived } as never)
  ctx.provide('sessionController', {
    list: (request: unknown, signal: AbortSignal) => {
      listCalls.push({ request, signal })
      signal.throwIfAborted()
      return Promise.resolve({ items: [
        { sessionId: SessionId('session-alice'), running: false, blank: true,
          projections: { values: { title: 'Alice title' } } },
        { sessionId: SessionId('session-bob'), running: true, blank: false },
        { sessionId: SessionId('session-cold'), running: false, blank: false,
          projections: { values: { title: 'Cold title' } } },
        { sessionId: SessionId('session-sub'), running: false, blank: false, origin: 'subagent' },
      ] })
    },
    inspect: (sessionId: SessionId) => {
      if (sessionId === SessionId('session-alice') || sessionId === SessionId('session-bob')) {
        return Promise.resolve({ meta: { id: sessionId, cwd: '/tmp' } })
      }
      if (sessionId === SessionId('session-sub')) {
        return Promise.resolve({ meta: { id: sessionId, cwd: '/tmp', origin: 'subagent' } })
      }
      return Promise.reject(new Error(`session "${sessionId}" not found`))
    },
  } as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionLinkService, config)
  const alice = await ctx.agentLoop.create(SessionId('session-alice'), { provider: 'mock', model: 'mock' })
  const bob = await ctx.agentLoop.create(SessionId('session-bob'), { provider: 'mock', model: 'mock' })
  return { ctx, links: ctx.gcDuolink, alice, bob, listCalls, archived }
}

describe('dsh-session-link remote surface', () => {
  it('linkFrom creates a human-granted pair with the peer wake flag', async () => {
    const s = await stack()
    const result = await s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: true })
    expect(result.linkId).toMatch(/^gc-duolink-/)
    const summary = s.links.list(s.alice.id).find(link => link.id === result.linkId)
    expect(summary?.name).toBe('互联-bob')
    expect(summary?.memberIds).toEqual([s.alice.id, s.bob.id])
    expect(summary?.autoWakeSessionIds).toEqual([s.bob.id])
    // Both members see the same group.
    expect(s.links.list(s.bob.id).map(link => link.id)).toContain(result.linkId)
  })

  it.each([
    [true, true], [true, false], [false, true], [false, false],
  ])('linkFrom atomically grants peer=%s caller=%s for human GUI requests', async (autoWake, autoWakeCaller) => {
    const s = await stack()
    const { linkId } = await s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake, autoWakeCaller })
    const group = s.links.list().find(link => link.id === linkId)!
    expect(group.autoWakeSessionIds).toEqual([
      ...(autoWake ? [s.bob.id] : []), ...(autoWakeCaller ? [s.alice.id] : []),
    ])
    expect(group.revision).toBe(1)
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: true, autoWakeCaller: true }))
      .rejects.toMatchObject({ code: 'LINK_ALREADY_LINKED' })
    expect(s.links.list()[0]).toEqual(group)
  })

  it('linkFrom rejects self-links, duplicates, unknown peers, and subagent-owned peers', async () => {
    const s = await stack()
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: s.alice.id, autoWake: false }))
      .rejects.toMatchObject({ code: 'LINK_SELF' })
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: SessionId('session-missing'), autoWake: false }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: SessionId('session-sub'), autoWake: false }))
      .rejects.toMatchObject({ code: 'TARGET_OWNED_BY_SUBAGENT' })
    await s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false })
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false }))
      .rejects.toMatchObject({ code: 'LINK_ALREADY_LINKED' })
    // A failed validation leaves the catalog unchanged.
    expect(s.links.list(s.alice.id).length).toBe(1)
  })

  it('linkFrom validates the calling Session like the peer', async () => {
    const s = await stack()
    await expect(s.links.linkFrom({ callerId: SessionId('session-missing'), peerId: s.bob.id, autoWake: false }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(s.links.linkFrom({ callerId: SessionId('session-sub'), peerId: s.bob.id, autoWake: false }))
      .rejects.toMatchObject({ code: 'TARGET_OWNED_BY_SUBAGENT' })
    s.archived.push(s.alice.id)
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false }))
      .rejects.toMatchObject({ code: 'TARGET_ARCHIVED' })
    expect(s.links.list()).toEqual([])
  })

  it('concurrent linkFrom requests for one pair create exactly one group', async () => {
    const s = await stack()
    const results = await Promise.allSettled([
      s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false }),
      s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: true }),
      s.links.linkFrom({ callerId: s.bob.id, peerId: s.alice.id, autoWake: false }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')
      .map(result => (result as PromiseRejectedResult).reason)).toEqual([
      expect.objectContaining({ code: 'LINK_ALREADY_LINKED' }),
      expect.objectContaining({ code: 'LINK_ALREADY_LINKED' }),
    ])
    expect(s.links.list()).toHaveLength(1)
  })

  it('unlinkFrom requires caller membership and deletes the catalog entry', async () => {
    const s = await stack()
    const { linkId } = await s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false })
    await expect(s.links.unlinkFrom({ callerId: SessionId('session-eve'), linkId }))
      .rejects.toMatchObject({ code: 'LINK_CALLER_NOT_MEMBER' })
    await s.links.unlinkFrom({ callerId: s.alice.id, linkId })
    expect(s.links.list()).toEqual([])
  })

  it('setAutoWakeFrom toggles one peer without touching other members', async () => {
    const s = await stack()
    const eve = await s.ctx.agentLoop.create(SessionId('session-eve'), { provider: 'mock', model: 'mock' })
    const { id: linkId } = await s.links.link('trio', [s.alice.id, s.bob.id, eve.id], { kind: 'human' }, {
      autoWakeSessionIds: [eve.id],
    })
    await s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId, peerId: s.alice.id, on: true })
    expect(s.links.list(s.alice.id)[0]?.autoWakeSessionIds).toEqual([eve.id, s.alice.id])
    await s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId, peerId: s.alice.id, on: false })
    expect(s.links.list(s.alice.id)[0]?.autoWakeSessionIds).toEqual([eve.id])
    await expect(s.links.setAutoWakeFrom({ callerId: SessionId('session-eve-x'), linkId, peerId: s.bob.id, on: true }))
      .rejects.toMatchObject({ code: 'LINK_CALLER_NOT_MEMBER' })
    await expect(s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId, peerId: SessionId('session-eve-x'), on: true }))
      .rejects.toMatchObject({ code: 'LINK_TARGET_NOT_MEMBER' })
    await s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId, peerId: s.bob.id, on: true })
    let summary = s.links.list(s.alice.id).find(link => link.id === linkId)
    expect(summary?.autoWakeSessionIds).toEqual([eve.id, s.bob.id])
    await s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId, peerId: eve.id, on: false })
    summary = s.links.list(s.alice.id).find(link => link.id === linkId)
    expect(summary?.autoWakeSessionIds).toEqual([s.bob.id])
  })

  it('concurrent symmetric setAutoWakeFrom requests preserve both flags', async () => {
    const s = await stack()
    const { linkId } = await s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false })
    await Promise.all([
      s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId, peerId: s.bob.id, on: true }),
      s.links.setAutoWakeFrom({ callerId: s.bob.id, linkId, peerId: s.alice.id, on: true }),
    ])
    expect(s.links.list()[0]!.autoWakeSessionIds.slice().sort()).toEqual([s.alice.id, s.bob.id].sort())
  })

  it('view returns public title projections and flags without activating cold Sessions', async () => {
    const s = await stack()
    await s.links.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    s.archived.push(s.bob.id)
    const controller = new AbortController()
    const view = await s.links.view(controller.signal)
    expect(view.pollIntervalMs).toBe(30000)
    expect(view.links).toEqual(s.links.list())
    expect(view.sessions).toEqual([
      { id: s.alice.id, title: 'Alice title', running: false, archived: false, ordinary: true, blank: true },
      { id: s.bob.id, title: String(s.bob.id), running: true, archived: true, ordinary: true, blank: false },
      { id: 'session-cold', title: 'Cold title', running: false, archived: false, ordinary: true, blank: false },
      { id: 'session-sub', title: 'session-sub', running: false, archived: false, ordinary: false, blank: false },
    ])
    expect(s.listCalls).toEqual([{ request: {}, signal: controller.signal }])
    expect(s.ctx.agents.get(SessionId('session-cold'))).toBeUndefined()
  })

  it('view exposes complete catalogs after a group is deleted', async () => {
    const s = await stack()
    const { id } = await s.links.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    expect((await s.links.view()).links).toHaveLength(1)
    await s.links.unlink(id)
    expect((await s.links.view()).links).toEqual([])
  })

  it('view refuses aborted reads before calling the Session Controller', async () => {
    const s = await stack()
    const controller = new AbortController()
    controller.abort(new Error('cancelled view'))
    await expect(s.links.view(controller.signal)).rejects.toThrow('cancelled view')
    expect(s.listCalls).toHaveLength(0)
  })

  it('Remote mutations validate nested request JSON before accessing state', async () => {
    const s = await stack()
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: 'yes' } as never))
      .rejects.toThrow()
    await expect(s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: false, extra: true } as never))
      .rejects.toThrow()
    await expect(s.links.unlinkFrom({ callerId: s.alice.id, linkId: 42 } as never)).rejects.toThrow()
    await expect(s.links.setAutoWakeFrom({ callerId: s.alice.id, linkId: 'x', peerId: s.bob.id, on: 1 } as never))
      .rejects.toThrow()
    expect(s.links.list()).toEqual([])
  })
})

describe('gcDuolink/cancelMessageFrom', () => {
  it.each(['sender', 'target'] as const)('allows the original %s to cancel pending ordinary mail', async participant => {
    const s = await stack()
    await s.links.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const sent = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'cancel this queue' })
    const before = s.links.message(sent.messageId)!
    const wakes = s.links['ledgers'].get(SESSION_LINK_LEDGER_KEY)
    const sessionId = participant === 'sender' ? s.alice.id : s.bob.id
    await expect(s.links.cancelMessageFrom({ sessionId, messageId: sent.messageId }))
      .resolves.toEqual({ messageId: sent.messageId, outcome: 'cancelled', status: 'cancelled' })
    expect(s.links.message(sent.messageId)).toEqual({ ...before, status: 'cancelled' })
    expect(s.links['ledgers'].get(SESSION_LINK_LEDGER_KEY)).toEqual(wakes)
    expect((await s.links.activityView({ sessionId, section: 'pending' })).entries).toEqual([])
    expect((await s.links.activityView({ sessionId, section: 'recent' })).entries[0])
      .toMatchObject({ status: 'cancelled', canCancel: false })
    await expect(s.links.cancelMessageFrom({ sessionId, messageId: sent.messageId }))
      .resolves.toEqual({ messageId: sent.messageId, outcome: 'already_terminal', status: 'cancelled' })
  })

  it('rejects even a third group member without exposing or changing the message', async () => {
    const s = await stack()
    const eve = await s.ctx.agentLoop.create(SessionId('session-eve'), { provider: 'mock', model: 'mock' })
    await s.links.link('trio', [s.alice.id, s.bob.id, eve.id], { kind: 'human' })
    const sent = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'private queue' })
    const before = s.links.message(sent.messageId)
    const write = vi.spyOn(s.links['messages'], 'put')
    await expect(s.links.cancelMessageFrom({ sessionId: eve.id, messageId: sent.messageId }))
      .rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
    await expect(s.links.cancelMessageFrom({ sessionId: s.alice.id, messageId: SessionLinkMessageId('missing') }))
      .rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
    expect(write).not.toHaveBeenCalled()
    expect(s.links.message(sent.messageId)).toEqual(before)
  })

  it.each(['delivered', 'cancelled', 'failed', 'revoked'] as const)('reports the existing %s terminal state without a write', async status => {
    const s = await stack()
    const { id: linkId } = await s.links.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const messageId = SessionLinkMessageId('terminal-message')
    const record = {
      linkId, senderId: s.alice.id, senderTitle: 'alice', targetId: s.bob.id, text: 'terminal',
      status, wakesUsed: 1, chainLength: 1, attempts: 2, createdAt: new Date().toISOString(),
    }
    await s.links['messages'].put(messageId, record)
    const write = vi.spyOn(s.links['messages'], 'put')
    await expect(s.links.cancelMessageFrom({ sessionId: s.bob.id, messageId }))
      .resolves.toEqual({ messageId, outcome: 'already_terminal', status })
    expect(write).not.toHaveBeenCalled()
    expect(s.links.message(messageId)).toEqual(record)
  })

  it.each([
    { statusKind: 'task-status' }, { statusKind: null }, { statusKind: false }, { statusKind: 42 },
    { statusKind: { legacy: true } }, { taskStatus: null }, { taskStatus: { taskId: 'legacy-task' } },
  ])('keeps legacy report markers read-only even when the marker is not a string: %j', async markers => {
    const s = await stack()
    const { id: linkId } = await s.links.link('pair', [s.alice.id, s.bob.id], { kind: 'human' })
    const messageId = SessionLinkMessageId('legacy-message')
    const record = {
      linkId, senderId: s.alice.id, senderTitle: 'alice', targetId: s.bob.id, text: 'legacy report',
      status: 'pending' as const, wakesUsed: 0, chainLength: 1, attempts: 0,
      createdAt: new Date().toISOString(), ...markers,
    }
    await s.links['messages'].put(messageId, record)
    const write = vi.spyOn(s.links['messages'], 'put')
    for (const sessionId of [s.alice.id, s.bob.id]) {
      await expect(s.links.cancelMessageFrom({ sessionId, messageId }))
        .rejects.toMatchObject({ code: 'LEGACY_TASK_MESSAGE_BLOCKED' })
    }
    expect(write).not.toHaveBeenCalled()
    expect(s.links.message(messageId)).toEqual(record)
  })

  it('strictly validates malformed requests before reading or mutating the mailbox', async () => {
    const s = await stack()
    const read = vi.spyOn(s.links['messages'], 'get')
    const write = vi.spyOn(s.links['messages'], 'put')
    for (const request of [
      undefined, null, [], {}, { sessionId: '', messageId: 'message' },
      { sessionId: 42, messageId: 'message' }, { sessionId: s.alice.id, messageId: '' },
      { sessionId: s.alice.id, messageId: 42 }, { sessionId: s.alice.id },
      { sessionId: s.alice.id, messageId: 'message', extra: true },
    ]) await expect(s.links.cancelMessageFrom(request as never)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})

describe('gcDuolink/activityView', () => {
  const aliceId = SessionId('session-alice')
  const bobId = SessionId('session-bob')
  const eveId = SessionId('session-eve')
  const coldId = SessionId('session-cold')

  /** Write one mailbox row directly; tests own every field the defaults do not cover. */
  const mail = (s: Stack, id: string, record: Record<string, unknown>) =>
    s.links['messages'].put(SessionLinkMessageId(id), {
      linkId: SessionLinkId('session-link-01'),
      senderTitle: 'Sender',
      text: 'hello',
      status: 'pending',
      wakesUsed: 0,
      chainLength: 1,
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...record,
    } as SessionLinkMessageRecordData)

  it('projects both directions in enqueue order with previews and summary counters', async () => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-out', { linkId, senderId: aliceId, targetId: bobId, status: 'delivered', seq: 1,
      createdAt: '2026-01-01T00:00:01.000Z', text: 'hi\nthere' })
    await mail(s, 'm-in', { linkId, senderId: bobId, targetId: aliceId, seq: 2,
      createdAt: '2026-01-01T00:00:02.000Z' })
    await mail(s, 'm-other', { linkId, senderId: eveId, targetId: bobId, seq: 3,
      createdAt: '2026-01-01T00:00:03.000Z' })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(view.total).toBe(2)
    expect(view.entries.map(entry => entry.messageId)).toEqual([SessionLinkMessageId('m-in'), SessionLinkMessageId('m-out')])
    expect(view.entries[0]).toMatchObject({
      direction: 'inbound', senderId: bobId, targetId: aliceId, status: 'pending', seq: 2,
      preview: 'hello', canCancel: true, blockingReasons: ['wake-unauthorized'],
    })
    expect(view.entries[1]).toMatchObject({ direction: 'outbound', status: 'delivered', preview: 'hi there' })
    expect(view.entries[1]!.blockingReasons).toEqual([])
    expect(view.entries[1]!.canCancel).toBe(false)
    expect(view.summary).toMatchObject({ pendingInbound: 1, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0 })
    expect(view.summary.wake).toMatchObject({ used: 0, limit: 12, day: new Date().toISOString().slice(0, 10) })
    const reset = Date.parse(view.summary.wake.resetsAt)
    expect(view.summary.wake.resetsAt.endsWith('T00:00:00.000Z')).toBe(true)
    expect(reset).toBeGreaterThan(Date.now())
    expect(reset).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000)
    expect(view.summary.targets).toEqual([expect.objectContaining({ id: bobId, live: true, archived: false })])
    expect(Date.parse(view.sampledAt)).not.toBeNaN()
    expect(view.nextCursor).toBeUndefined()
  })

  it('keeps history readable after its group is revoked', async () => {
    const s = await stack()
    const { id: linkId } = await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    await mail(s, 'm-in', { linkId, senderId: bobId, targetId: aliceId, seq: 1 })
    await s.links.unlink(linkId)
    // Revocation tombstones the unheld pending row; it remains readable history.
    const recent = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(recent.total).toBe(1)
    expect(recent.entries[0]).toMatchObject({ direction: 'inbound', status: 'revoked', blockingReasons: [] })
    // A still-pending row whose group is gone reports the revocation as its blocker.
    await mail(s, 'm-orphan', { linkId: SessionLinkId('session-link-gone'), senderId: bobId, targetId: aliceId, seq: 2 })
    const pending = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(pending.total).toBe(1)
    expect(pending.entries[0]!.blockingReasons).toEqual(['link-revoked'])
    expect(pending.summary.pendingInbound).toBe(1)
  })

  it('pages pending in delivery order and recent back-to-front over mixed generations', async () => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    // A pre-0.4.0 row carries no seq; a clock regression left its timestamp
    // after the sequenced rows. Delivery compares mixed generations by
    // timestamp, so the pending projection must read m-old last — never the
    // display order that lists unsequenced rows first.
    await mail(s, 'm-old', { linkId, senderId: aliceId, targetId: bobId, createdAt: '2026-01-02T00:00:00.000Z' })
    await mail(s, 'm-1', { linkId, senderId: aliceId, targetId: bobId, seq: 1, createdAt: '2026-01-01T00:00:01.000Z' })
    await mail(s, 'm-2', { linkId, senderId: aliceId, targetId: bobId, seq: 2, createdAt: '2026-01-01T00:00:02.000Z' })
    await mail(s, 'm-3', { linkId, senderId: aliceId, targetId: bobId, seq: 3, createdAt: '2026-01-01T00:00:03.000Z' })
    const first = await s.links.activityView({ sessionId: aliceId, section: 'pending', limit: 2 })
    expect(first.total).toBe(4)
    expect(first.entries.map(entry => entry.messageId)).toEqual([SessionLinkMessageId('m-1'), SessionLinkMessageId('m-2')])
    expect(first.nextCursor).toBeDefined()
    const second = await s.links.activityView({ sessionId: aliceId, section: 'pending', limit: 2, cursor: first.nextCursor })
    expect(second.total).toBe(4)
    expect(second.entries.map(entry => entry.messageId)).toEqual([SessionLinkMessageId('m-3'), SessionLinkMessageId('m-old')])
    expect(second.nextCursor).toBeUndefined()
    // The paged order is the exact ground truth delivery would execute.
    const expected = (s.links as never as { pendingFor(id: SessionId): [SessionLinkMessageId, unknown][] })
      .pendingFor(bobId).map(([id]) => id)
    expect([...first.entries, ...second.entries].map(entry => entry.messageId)).toEqual(expected)
    // A queue change under an open page chain invalidates its cursor instead
    // of silently skipping or repeating rows.
    await mail(s, 'm-new', { linkId, senderId: aliceId, targetId: bobId, seq: 4, createdAt: '2026-01-01T00:00:04.000Z' })
    await expect(s.links.activityView({ sessionId: aliceId, section: 'pending', limit: 2, cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' })
    // Cursors never cross sections.
    await expect(s.links.activityView({ sessionId: aliceId, section: 'recent', limit: 2, cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' })
    // Recent keeps its documented display order — unsequenced rows last,
    // newest sequenced back-to-front — which claims nothing about delivery.
    const recent = await s.links.activityView({ sessionId: aliceId, section: 'recent', limit: 3 })
    expect(recent.entries.map(entry => entry.messageId)).toEqual([
      SessionLinkMessageId('m-new'), SessionLinkMessageId('m-3'), SessionLinkMessageId('m-2')])
    const rest = await s.links.activityView({ sessionId: aliceId, section: 'recent', limit: 3, cursor: recent.nextCursor })
    expect(rest.entries.map(entry => entry.messageId)).toEqual([
      SessionLinkMessageId('m-1'), SessionLinkMessageId('m-old')])
    expect(rest.nextCursor).toBeUndefined()
    // A recent cursor is likewise refused on the pending section.
    await expect(s.links.activityView({ sessionId: aliceId, section: 'pending', limit: 2, cursor: recent.nextCursor }))
      .rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' })
  })

  it('rejects malformed cursors and out-of-shape requests', async () => {
    const s = await stack()
    await expect(s.links.activityView({ sessionId: aliceId, section: 'pending', cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' })
    await expect(s.links.activityView({ sessionId: aliceId, section: 'recent',
      cursor: Buffer.from('{"v":2}', 'utf8').toString('base64url') }))
      .rejects.toMatchObject({ code: 'ACTIVITY_CURSOR_INVALID' })
    await expect(s.links.activityView({ sessionId: aliceId, section: 'future' } as never)).rejects.toThrow()
    await expect(s.links.activityView({ sessionId: aliceId, section: 'pending', limit: 0 })).rejects.toThrow()
    await expect(s.links.activityView({ sessionId: aliceId, section: 'pending', limit: 51 })).rejects.toThrow()
    await expect(s.links.activityView({ sessionId: aliceId, section: 'pending', extra: 1 } as never)).rejects.toThrow()
  })

  it('scopes the wake summary to the current UTC day', async () => {
    const s = await stack()
    const today = new Date().toISOString().slice(0, 10)
    await s.links['ledgers'].put(SESSION_LINK_LEDGER_KEY, {
      spawns: {}, initialModelSpawns: {},
      wakes: { [aliceId]: { day: today, wakes: 2 }, [bobId]: { day: '2020-01-01', wakes: 5 } },
    })
    const asAlice = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(asAlice.summary.wake).toMatchObject({ used: 2, limit: 12, day: today })
    const asBob = await s.links.activityView({ sessionId: bobId, section: 'recent' })
    expect(asBob.summary.wake.used).toBe(0)
  })

  it('derives the wake-budget blocker from the cross-group reply chain', async () => {
    const s = await stack({ maxAutoWakesPerChain: 1 })
    await s.ctx.agentLoop.create(eveId, { provider: 'mock', model: 'mock' })
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' }, { autoWakeSessionIds: [bobId] })
    await s.links.link('trio', [aliceId, bobId, eveId], { kind: 'human' }, { autoWakeSessionIds: [bobId] })
    const pair = s.links.list().find(link => link.memberIds.length === 2)!
    const trio = s.links.list().find(link => link.memberIds.length === 3)!
    await mail(s, 'm-root', { linkId: pair.id, senderId: aliceId, targetId: bobId, status: 'delivered',
      wakesUsed: 1, seq: 1, createdAt: '2026-01-01T00:00:01.000Z' })
    await mail(s, 'm-next', { linkId: trio.id, senderId: aliceId, targetId: bobId,
      inReplyTo: SessionLinkMessageId('m-root'), seq: 2, createdAt: '2026-01-01T00:00:02.000Z' })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]!.blockingReasons).toEqual(['wake-budget'])
  })

  it('reports the spawn-granted first-task wake instead of an authorization blocker', async () => {
    const s = await stack()
    await s.links.link('spawned', [aliceId, bobId], { kind: 'session', sessionId: aliceId })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-first', { linkId, senderId: aliceId, targetId: bobId, seq: 1 })
    const asBob = await s.links.activityView({ sessionId: bobId, section: 'pending' })
    expect(asBob.entries[0]).toMatchObject({ direction: 'inbound', blockingReasons: ['unknown'] })
    expect(asBob.summary.firstTaskWakeOwed).toBe(true)
    // The granter itself is owed nothing.
    const asAlice = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(asAlice.summary.firstTaskWakeOwed).toBe(false)
  })

  it('projects explicit no-wake intent for idle and cold targets without suggesting a grant or budget fix', async () => {
    const s = await stack()
    const { id: liveLink } = await s.links.link('live', [aliceId, bobId], { kind: 'human' })
    const { id: coldLink } = await s.links.link('cold', [aliceId, coldId], { kind: 'human' })
    await mail(s, 'm-quiet-idle', { linkId: liveLink, senderId: aliceId, targetId: bobId, wake: false, seq: 1 })
    await mail(s, 'm-quiet-cold', { linkId: coldLink, senderId: aliceId, targetId: coldId, wake: false, seq: 2 })
    let view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-quiet-idle'))!.blockingReasons)
      .toEqual(['wake-not-requested'])
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-quiet-cold'))!.blockingReasons)
      .toEqual(['cold-target', 'wake-not-requested'])
    await s.links.setMemberAutoWake(liveLink, bobId, true)
    await s.links.setMemberAutoWake(coldLink, coldId, true)
    await s.links['ledgers'].put(SESSION_LINK_LEDGER_KEY, {
      spawns: {}, initialModelSpawns: {},
      wakes: { [bobId]: { day: new Date().toISOString().slice(0, 10), wakes: 6 } },
    })
    view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-quiet-idle'))!.blockingReasons)
      .toEqual(['wake-not-requested'])
    Object.defineProperty(s.bob, 'status', { configurable: true, value: 'running' })
    view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-quiet-idle'))!.blockingReasons).toEqual([])
    await mail(s, 'm-quiet-held', { linkId: coldLink, senderId: aliceId, targetId: coldId, wake: false, inserted: true, seq: 3 })
    view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-quiet-held'))!.blockingReasons)
      .toEqual(['delivery-unverified'])
  })

  it('strips both exact old and new frames while preserving their stored bodies', async () => {
    const s = await stack()
    const { id: linkId } = await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const oldId = SessionLinkMessageId('m-old-frame')
    const newId = SessionLinkMessageId('m-new-frame')
    const oldBody = '[会话消息] 来自会话「Sender」（session-bob）的协作消息，非本机人类直接输入。\n'
      + `消息 ID：${oldId}。如需回复，调用 gc_duolink_send_message，session_id 填 session-bob，in_reply_to 填 ${oldId}。\n旧正文`
    const newBody = frameSessionLinkText({ senderTitle: 'Sender', senderId: bobId, messageId: newId, text: '新正文' })
    await mail(s, oldId, { linkId, senderId: bobId, targetId: aliceId, text: oldBody, seq: 1 })
    await mail(s, newId, { linkId, senderId: bobId, targetId: aliceId, text: newBody, seq: 2 })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(view.entries.map(entry => entry.preview)).toEqual(['新正文', '旧正文'])
    expect(s.links.message(oldId)?.text).toBe(oldBody)
    expect(s.links.message(newId)?.text).toBe(newBody)
  })

  it('keeps legacy report markers out of entries and counts them separately', async () => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-live', { linkId, senderId: bobId, targetId: aliceId, seq: 1 })
    await mail(s, 'm-legacy-a', { linkId, senderId: bobId, targetId: aliceId, seq: 2, statusKind: 'task-report' })
    await mail(s, 'm-legacy-b', { linkId, senderId: bobId, targetId: aliceId, seq: 3, taskStatus: { state: 'done' } })
    const pending = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(pending.entries.map(entry => entry.messageId)).toEqual([SessionLinkMessageId('m-live')])
    expect(pending.total).toBe(1)
    expect(pending.summary.pendingInbound).toBe(1)
    expect(pending.summary.legacyBlocked).toBe(2)
    const recent = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(recent.entries.map(entry => entry.messageId)).toEqual([SessionLinkMessageId('m-live')])
  })

  it('coexists archived and cold-target blockers on one entry', async () => {
    const s = await stack()
    await s.links.link('coldy', [aliceId, coldId], { kind: 'human' }, { autoWakeSessionIds: [coldId] })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-cold', { linkId, senderId: aliceId, targetId: coldId, seq: 1 })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries[0]!.blockingReasons).toEqual(['cold-target'])
    s.archived.push(coldId)
    const archivedView = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(archivedView.entries[0]!.blockingReasons).toEqual(['archived', 'cold-target'])
    expect(archivedView.summary.targets).toEqual([
      expect.objectContaining({ id: coldId, live: false, running: false, archived: true }),
    ])
  })

  it('strips delivery frames, flattens control runs, and reports a fixed error summary', async () => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    const framed = '[会话消息] 来自会话「Sender」（session-bob）的协作消息，非本机人类直接输入。\n'
      + '消息 ID：m-framed。如需回复，调用 gc_duolink_send_message，session_id 填 session-bob，in_reply_to 填 m-framed。\n'
      + `line one\nline two\t${'x'.repeat(200)}`
    const rawError = `boom\n${'y'.repeat(300)}`
    await mail(s, 'm-framed', { linkId, senderId: bobId, targetId: aliceId, seq: 1, text: framed,
      status: 'failed', error: rawError })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    const entry = view.entries[0]!
    expect(entry.preview.startsWith('line one line two')).toBe(true)
    expect(entry.preview).not.toContain('会话消息')
    expect(entry.preview).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(entry.preview).toHaveLength(160)
    expect(entry.preview.endsWith('...')).toBe(true)
    // The view reports only that a delivery error happened: no fragment of the
    // original error is projected, so its shape cannot leak a credential.
    expect(entry.lastError).toBe('delivery error (details withheld)')
    expect(entry.lastError).not.toContain('boom')
    expect(entry.lastError!.length).toBeLessThanOrEqual(200)
    expect(entry.lastError).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    // The durable record keeps its original error and body verbatim.
    const stored = s.links['messages'].get(SessionLinkMessageId('m-framed'))!
    expect(stored.error).toBe(rawError)
    expect(stored.text).toBe(framed)
    expect(entry.blockingReasons).toEqual([])
    expect(entry.canCancel).toBe(false)
  })

  it.each([
    'Authorization: Bearer SYNTHETIC_REMOTE_SECRET',
    'request failed: password=SYNTHETIC_REMOTE_SECRET',
    '{"api_key":"SYNTHETIC_REMOTE_SECRET"}',
    'https://example.invalid/?key=SYNTHETIC_REMOTE_SECRET',
    JSON.stringify({ password: "prefix'SYNTHETIC_REMOTE_SECRET" }),
    JSON.stringify({ token: 'prefix"SYNTHETIC_REMOTE_SECRET' }),
    'opaque SYNTHETIC_REMOTE_SECRET without any known shape',
  ])('never concatenates arbitrary original error text into lastError: %s', async error => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-secret', { linkId, senderId: bobId, targetId: aliceId, seq: 1, status: 'failed', error })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(view.entries[0]!.lastError).toBe('delivery error (details withheld)')
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC_REMOTE_SECRET')
    // Projection is read-only: the record keeps the original text.
    expect(s.links['messages'].get(SessionLinkMessageId('m-secret'))!.error).toBe(error)
  })

  it('restricts entries to one counterparty while counters stay session-wide', async () => {
    const s = await stack()
    await s.ctx.agentLoop.create(eveId, { provider: 'mock', model: 'mock' })
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    await s.links.link('eve-pair', [aliceId, eveId], { kind: 'human' })
    const pair = s.links.list().find(link => link.memberIds.includes(bobId))!
    const evePair = s.links.list().find(link => link.memberIds.includes(eveId))!
    await mail(s, 'm-bob-out', { linkId: pair.id, senderId: aliceId, targetId: bobId, seq: 1 })
    await mail(s, 'm-bob-in', { linkId: pair.id, senderId: bobId, targetId: aliceId, seq: 2 })
    await mail(s, 'm-eve-in', { linkId: evePair.id, senderId: eveId, targetId: aliceId, seq: 3 })
    const withBob = await s.links.activityView({ sessionId: aliceId, section: 'recent', peerId: bobId })
    expect(withBob.total).toBe(2)
    expect(withBob.entries.map(entry => entry.messageId)).toEqual([
      SessionLinkMessageId('m-bob-in'), SessionLinkMessageId('m-bob-out')])
    expect(withBob.summary.targets.map(target => target.id)).toEqual([bobId])
    expect(withBob.summary.pendingInbound).toBe(2)
    expect(withBob.summary.pendingOutbound).toBe(1)
  })

  it('serves an empty view for an unknown Session without consulting the catalog', async () => {
    const s = await stack()
    const view = await s.links.activityView({ sessionId: SessionId('session-nobody'), section: 'recent' })
    expect(view.total).toBe(0)
    expect(view.entries).toEqual([])
    expect(view.nextCursor).toBeUndefined()
    expect(view.summary).toMatchObject({
      pendingInbound: 0, pendingOutbound: 0, legacyBlocked: 0, firstTaskWakeOwed: false, targets: [],
    })
    expect(s.listCalls).toHaveLength(0)
  })

  it('never writes the domain or consults the Session Controller while observing', async () => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-in', { linkId, senderId: bobId, targetId: aliceId, seq: 1 })
    const spies = (['links', 'messages', 'ledgers'] as const).map(name =>
      vi.spyOn(s.links[name], 'put'))
    await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    await s.links.activityView({ sessionId: aliceId, section: 'recent', peerId: bobId })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(s.listCalls).toHaveLength(0)
  })

  it('never lists wake conditions for a running target or a possibly-held message', async () => {
    const s = await stack()
    // No wake grant at all: an idle target would report wake-unauthorized.
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    await mail(s, 'm-running', { linkId, senderId: aliceId, targetId: bobId, seq: 1 })
    const bob = s.ctx.agents.get(bobId)!
    Object.defineProperty(bob, 'status', { configurable: true, value: 'running' })
    // A running target admits pending mail as follow-ups; wake authorization
    // and budget are not its blockers, so no blocker is claimed.
    let view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-running'))!.blockingReasons).toEqual([])
    // Idle again: the wake blocker returns.
    Object.defineProperty(bob, 'status', { configurable: true, value: 'idle' })
    view = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(view.entries.find(entry => entry.messageId === SessionLinkMessageId('m-running'))!.blockingReasons)
      .toEqual(['wake-unauthorized'])
    // A cold target that may already hold the message (the intent marker was
    // recorded before delivery) reports only the unverified receipt — cold
    // residency and fresh wake conditions no longer apply to it.
    await s.links.link('coldy', [aliceId, coldId], { kind: 'human' })
    const coldLinkId = s.links.list().find(link => link.memberIds.includes(coldId))!.id
    await mail(s, 'm-held', { linkId: coldLinkId, senderId: aliceId, targetId: coldId, seq: 2, inserted: true })
    const held = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(held.entries.find(entry => entry.messageId === SessionLinkMessageId('m-held'))!.blockingReasons)
      .toEqual(['delivery-unverified'])
    // A cold target that was never handed the message lists cold residency
    // and the wake conditions a later admission would face.
    await mail(s, 'm-cold-idle', { linkId: coldLinkId, senderId: aliceId, targetId: coldId, seq: 3 })
    const coldIdle = await s.links.activityView({ sessionId: aliceId, section: 'pending' })
    expect(coldIdle.entries.find(entry => entry.messageId === SessionLinkMessageId('m-cold-idle'))!.blockingReasons)
      .toEqual(['cold-target', 'wake-unauthorized'])
  })

  it('never strips a lookalike frame that is not this record own frame', async () => {
    const s = await stack()
    await s.links.link('pair', [aliceId, bobId], { kind: 'human' })
    const linkId = s.links.list()[0]!.id
    // A human pastes a frame quoting another message id; it is body text.
    const lookalike = '[会话消息] 来自会话「Sender」（session-bob）的协作消息，非本机人类直接输入。\n'
      + '消息 ID：m-other。如需回复，调用 gc_duolink_send_message，session_id 填 session-bob，in_reply_to 填 m-other。\n'
      + 'quoted body'
    await mail(s, 'm-quote', { linkId, senderId: bobId, targetId: aliceId, seq: 1, text: lookalike })
    const view = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(view.entries[0]!.preview).toContain('会话消息')
    expect(view.entries[0]!.preview).toContain('quoted body')
    // A newline inside the sender title still strips exactly this record's frame.
    const titled = frameSessionLinkText({
      senderTitle: '第一行\n第二行', senderId: bobId,
      messageId: SessionLinkMessageId('m-titled'), text: '真实正文',
    })
    await mail(s, 'm-titled', {
      linkId, senderId: bobId, targetId: aliceId, seq: 2, senderTitle: '第一行\n第二行', text: titled,
    })
    const titledView = await s.links.activityView({ sessionId: aliceId, section: 'recent' })
    expect(titledView.entries[0]!.preview).toBe('真实正文')
  })
})


describe('gcDuolink/extendChainWakeFrom strict boundary', () => {
  it('rejects malformed confirmations before any mailbox read or write', async () => {
    const s = await stack()
    const valid = { sessionId: s.alice.id, messageId: SessionLinkMessageId('message'), additional: 4, expectedExtra: 0, requestId: 'intent' }
    const read = vi.spyOn(s.links['messages'], 'get')
    const writes = (['messages', 'ledgers'] as const).map(name => vi.spyOn(s.links[name], 'put'))
    for (const request of [
      null, undefined, [], {},
      ...[0, -1, 1.5, 101, '4', Infinity, NaN].map(additional => ({ ...valid, additional })),
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0'].map(expectedExtra => ({ ...valid, expectedExtra })),
      ...['', 'x'.repeat(129), 42].map(requestId => ({ ...valid, requestId })),
      { ...valid, sessionId: '' }, { ...valid, messageId: '' }, { ...valid, privileged: true },
    ]) await expect(s.links.extendChainWakeFrom(request as never)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
  })
})
