import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionLinkService, { SESSION_LINK_LEDGER_KEY, SessionLinkError, SessionLinkId, SessionLinkMessageId, sessionLinkLedgersSchema } from '../src/index.ts'
import type { Config } from '../src/index.ts'
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
  if (failures.length > 0) throw new AggregateError(failures, 'session-link test cleanup failed')
})

interface Stack {
  readonly ctx: Context
  readonly links: SessionLinkService
  readonly alice: Agent
  readonly bob: Agent
  readonly root: SessionId
  readonly archived: SessionId[]
  readonly disposeLinks: () => Promise<void>
}

/** Mount the service over the in-memory storage domain with two live root Agents. */
async function stack(config?: Config, sharedPool?: MemoryMediaPool, controller?: object): Promise<Stack> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(sharedPool ?? new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const archived: SessionId[] = []
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived } as never)
  if (controller !== undefined) ctx.provide('sessionController', controller as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  const linkFiber = await ctx.plugin(SessionLinkService, config)
  const alice = await ctx.agentLoop.create(SessionId('session-alice'), { provider: 'mock', model: 'mock' })
  const bob = await ctx.agentLoop.create(SessionId('session-bob'), { provider: 'mock', model: 'mock' })
  return { ctx, links: ctx.sessionLinks, alice, bob, root: SessionId('session-alice'), archived, disposeLinks: () => linkFiber.dispose() }
}

/** Grant one two-member link between alice and bob. */
async function grantBoth(stack: Stack, options: { autoWake?: SessionId[] } = {}) {
  const granted = await stack.links.link('pair', [stack.alice.id, stack.bob.id], { kind: 'human' }, {
    ...(options.autoWake === undefined ? {} : { autoWakeSessionIds: options.autoWake }),
  })
  return granted.id
}

/**
 * Read every session-link mail body delivered to one Session, whether it is
 * still pending in the inbox or has already raced into claimed history: a
 * durable splice insertion is the receipt the service itself acknowledges.
 */
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

/** Read the durable source of the session-link mail delivered to one Session. */
function mailSource(agent: Agent): { kind?: string; senderId?: string; messageId?: string; inReplyTo?: string } | undefined {
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) {
        const source = (message as { source?: { kind?: string; senderId?: string; messageId?: string; inReplyTo?: string } }).source
        if (source?.kind === 'session-link-message') return source
      }
    }
  }
  return undefined
}

describe('dsh-session-link', () => {
  it('rejects sends between Sessions that share no grant', async () => {
    const s = await stack()
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'hi' }))
      .rejects.toMatchObject({ code: 'LINK_TARGET_NOT_MEMBER' })
  })

  it('delivers to a running target as a queued follow-up turn and marks it accepted', async () => {
    const s = await stack()
    await grantBoth(s)
    // A running target: enqueue a wake so the driver claims work.
    s.bob.followup(createUserMessage({
      content: [{ type: 'text', text: 'work' }],
      source: { kind: 'user' },
    }))
    expect(s.bob.status).toBe('running')
    const result = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'hello bob' })
    expect(result.status).toBe('accepted')
    expect(s.links.message(result.messageId)?.status).toBe('delivered')
    expect(mailTexts(s.bob).some(text => text.includes('hello bob'))).toBe(true)
    const source = mailSource(s.bob)
    expect(source?.kind).toBe('session-link-message')
    expect(source?.senderId).toBe(s.alice.id)
  })

  it('queues for an idle target without auto-wake and delivers on its next turn', async () => {
    const s = await stack()
    await grantBoth(s)
    expect(s.bob.status).toBe('idle')
    const result = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'deferred' })
    expect(result.status).toBe('queued')
    expect(s.links.message(result.messageId)?.status).toBe('pending')
    // A human turn on bob admits the deferred inbox without a peer wake.
    s.bob.followup(createUserMessage({
      content: [{ type: 'text', text: 'human ping' }],
      source: { kind: 'user' },
    }))
    await s.links.deliverPending(s.bob.id)
    await s.bob.whenIdle()
    expect(s.links.message(result.messageId)?.status).toBe('delivered')
    expect(mailTexts(s.bob).some(text => text.includes('deferred'))).toBe(true)
  })

  it('wakes an idle target with an auto-wake grant within budgets', async () => {
    const s = await stack()
    await grantBoth(s, { autoWake: [s.bob.id] })
    const result = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'wake up' })
    expect(result.status).toBe('accepted')
    const record = s.links.message(result.messageId)
    expect(record?.status).toBe('delivered')
    expect(record?.wakesUsed).toBe(1)
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
    s.bob.cancel({ kind: 'user' }, { keepInbox: true })
    // The per-message budget is spent: a duplicate restart cannot wake twice.
    await s.links.deliverPending(s.bob.id)
    const after = s.links.message(result.messageId)
    expect(after?.wakesUsed).toBe(1)
  })

  it('replays an idempotency key to the original admission without a second delivery', async () => {
    const s = await stack()
    await grantBoth(s, { autoWake: [s.bob.id] })
    const first = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'once', idempotencyKey: 'key-1' })
    const second = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'twice', idempotencyKey: 'key-1' })
    expect(second.messageId).toBe(first.messageId)
    const delivered = mailTexts(s.bob).filter(text => text.includes('once'))
    expect(delivered.length).toBe(1)
  })

  it('threads replies and enforces that inReplyTo names a received message', async () => {
    const s = await stack()
    await grantBoth(s)
    s.bob.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    const incoming = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'question' })
    const reply = await s.links.send(s.bob, s.alice.id, {
      targetId: s.alice.id,
      text: 'answer',
      inReplyTo: incoming.messageId,
    })
    const record = s.links.message(reply.messageId)
    expect(record?.inReplyTo).toBe(incoming.messageId)
    expect(record?.chainLength).toBe(2)
    await expect(s.links.send(s.alice, s.bob.id, {
      targetId: s.bob.id,
      text: 'forged',
      inReplyTo: incoming.messageId,
    })).rejects.toMatchObject({ code: 'MESSAGE_NOT_REPLYABLE' })
  })

  it('tombstones pending mail when the grant is revoked and blocks new sends', async () => {
    const s = await stack()
    const linkId = await grantBoth(s)
    const result = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'pending forever' })
    expect(s.links.message(result.messageId)?.status).toBe('pending')
    await s.links.unlink(linkId)
    expect(s.links.message(result.messageId)?.status).toBe('revoked')
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'after revoke' }))
      .rejects.toMatchObject({ code: 'LINK_TARGET_NOT_MEMBER' })
    // Recovery must never resurrect the tombstone.
    await s.links.deliverPending(s.bob.id)
    expect(mailTexts(s.bob).some(text => text.includes('pending forever'))).toBe(false)
  })

  it('cancels durable pending mail so retries cannot resurrect it', async () => {
    const s = await stack()
    await grantBoth(s)
    const result = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'never runs' })
    await s.links.cancel(s.alice, result.messageId)
    expect(s.links.message(result.messageId)?.status).toBe('cancelled')
    await s.links.deliverPending(s.bob.id)
    expect(s.links.message(result.messageId)?.status).toBe('cancelled')
    expect(mailTexts(s.bob).length).toBe(0)
    await expect(s.links.cancel(s.bob, SessionLinkMessageId('session-link-message-none')))
      .rejects.toBeInstanceOf(SessionLinkError)
  })

  it('never marked the sender human: peer mail carries the dedicated source kind', async () => {
    const s = await stack()
    await grantBoth(s)
    s.bob.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'inspect source' })
    const kinds: string[] = []
    for (const event of s.bob.session.snapshotEvents()) {
      if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted) kinds.push(message.source.kind)
      }
    }
    expect(kinds).toContain('session-link-message')
    expect(kinds.filter(kind => kind === 'user').length).toBe(1) // only the human wake above
  })

  it('rejects oversized bodies and enforces the per-target pending bound', async () => {
    const s = await stack({ maxPendingPerTarget: 2 })
    await grantBoth(s)
    await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'one' })
    await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'two' })
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'three' }))
      .rejects.toMatchObject({ code: 'MAILBOX_FULL' })
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'x'.repeat(20 * 1024) }))
      .rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
  })

  it('recovers a restart: pending mail survives in the reopened domain and delivers', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(undefined, pool)
    await grantBoth(first)
    const result = await first.links.send(first.alice, first.bob.id, { targetId: first.bob.id, text: 'survive restart' })
    expect(first.links.message(result.messageId)?.status).toBe('pending')

    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] as readonly SessionId[] } as never)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionLinkService)
    const bob = await ctx.agentLoop.create(SessionId('session-bob'), { provider: 'mock', model: 'mock' })
    await ctx.sessionLinks.deliverPending(bob.id)
    expect(ctx.sessionLinks.message(result.messageId)?.status).toBe('pending')
    // The target starts a human turn: deferred mail delivers as a follow-up behind it.
    bob.followup(createUserMessage({ content: [{ type: 'text', text: 'human turn' }], source: { kind: 'user' } }))
    await ctx.sessionLinks.deliverPending(bob.id)
    expect(ctx.sessionLinks.message(result.messageId)?.status).toBe('delivered')
    expect(mailTexts(bob).some(text => text.includes('survive restart'))).toBe(true)
  })

  it('recovery never resumes cold targets or spends an idle target wake grant', async () => {
    const pool = new MemoryMediaPool()
    const first = await stack(undefined, pool)
    const linkId = await grantBoth(first)
    const queued = await first.links.send(first.alice, first.bob.id, { targetId: first.bob.id, text: 'deferred recovery' })
    await first.links.setAutoWake(linkId, [first.bob.id])
    const resumes: SessionId[] = []
    const restarted = await stack(undefined, pool, {
      resolveAgent: (id: SessionId) => {
        resumes.push(id)
        return Promise.reject(new Error('recovery must not resolve a cold target'))
      },
    })
    await restarted.links.deliverPending(restarted.bob.id)
    expect(resumes).toEqual([])
    expect(restarted.bob.status).toBe('idle')
    expect(restarted.links.message(queued.messageId)).toMatchObject({ status: 'pending', wakesUsed: 0 })
    restarted.bob.followup(createUserMessage({ content: [{ type: 'text', text: 'human turn' }], source: { kind: 'user' } }))
    await restarted.links.deliverPending(restarted.bob.id)
    expect(restarted.links.message(queued.messageId)).toMatchObject({ status: 'delivered', wakesUsed: 0 })
  })

  it('refuses linked subagent senders and targets', async () => {
    const s = await stack()
    await grantBoth(s)
    Object.defineProperty(s.bob.session, 'header', { value: { ...s.bob.session.header, origin: 'subagent' } })
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'not ordinary' }))
      .rejects.toMatchObject({ code: 'TARGET_OWNED_BY_SUBAGENT' })
    await expect(s.links.send(s.bob, s.alice.id, { targetId: s.alice.id, text: 'not ordinary' }))
      .rejects.toMatchObject({ code: 'TARGET_OWNED_BY_SUBAGENT' })
  })

  it('counts sender framing toward the message byte limit', async () => {
    const s = await stack({ maxMessageBytes: 20 })
    await grantBoth(s)
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'short' }))
      .rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
  })

  it('returns the configured UI polling interval and rejects invalid intervals', async () => {
    const s = await stack({ uiPollIntervalMs: 1000 }, undefined, { list: () => Promise.resolve({ items: [] }) })
    expect((await s.links.view()).pollIntervalMs).toBe(1000)
    await expect(stack({ uiPollIntervalMs: 999 })).rejects.toThrow('uiPollIntervalMs')
    await expect(stack({ uiPollIntervalMs: 2147483648 })).rejects.toThrow('uiPollIntervalMs')
  })

  it('rejects every mailbox mutation after the service has disposed', async () => {
    const s = await stack()
    const linkId = await grantBoth(s)
    const sent = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'pending' })
    await s.disposeLinks()
    await expect(s.links.link('new', [s.alice.id, s.bob.id], { kind: 'human' })).rejects.toMatchObject({ code: 'DISPOSED' })
    await expect(s.links.unlink(linkId)).rejects.toMatchObject({ code: 'DISPOSED' })
    await expect(s.links.setAutoWake(linkId, [s.bob.id])).rejects.toMatchObject({ code: 'DISPOSED' })
    await expect(s.links.cancel(s.alice, sent.messageId)).rejects.toMatchObject({ code: 'DISPOSED' })
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'after disposal' }))
      .rejects.toMatchObject({ code: 'DISPOSED' })
  })

  it('acknowledges an existing durable receipt when the target has since been archived', async () => {
    const pool = new MemoryMediaPool()
    const s = await stack(undefined, pool)
    await grantBoth(s, { autoWake: [s.bob.id] })
    const flush = s.ctx.sessions.flush.bind(s.ctx.sessions)
    const mock = vi.spyOn(s.ctx.sessions, 'flush').mockImplementation(async session => {
      await flush(session)
      s.archived.push(s.bob.id)
      pool.failNextWrites = 1
    })
    // A stored message never throws for a later delivery failure; it stays queued.
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'already received' }))
      .resolves.toMatchObject({ status: 'queued' })
    mock.mockRestore()
    const receiptId = mailSource(s.bob)?.messageId
    if (receiptId === undefined) throw new Error('expected a durable mailbox receipt')
    const id = SessionLinkMessageId(receiptId)
    await s.links.deliverPending(s.bob.id)
    expect(s.links.message(id)?.status).toBe('delivered')
    expect(mailTexts(s.bob)).toHaveLength(1)
  })

  it.each(['cancelled', 'failed', 'revoked'] as const)('never reports accepted for an idempotency replay of a %s message', async status => {
    const pool = new MemoryMediaPool()
    const s = await stack(undefined, pool)
    await grantBoth(s)
    const first = await s.links.send(s.alice, s.bob.id, {
      targetId: s.bob.id, text: 'terminal replay', idempotencyKey: 'terminal-key',
    })
    const record = s.links.message(first.messageId)
    if (record === undefined) throw new Error('expected an admitted mailbox record')
    await s.disposeLinks()
    const messages = pool.media.get('session_link')?.tables.get('messages')
    if (messages === undefined) throw new Error('expected the persisted messages table')
    messages.set(String(first.messageId), { ...record, status })
    const reopened = await stack(undefined, pool)
    // A terminal message will never be delivered, so its replay throws rather than reporting queued.
    await expect(reopened.links.send(reopened.alice, reopened.bob.id, {
      targetId: reopened.bob.id, text: 'must not re-admit', idempotencyKey: 'terminal-key',
    })).rejects.toMatchObject({ code: 'MESSAGE_UNDELIVERABLE' })
    expect(reopened.links.message(first.messageId)?.status).toBe(status)
    expect(mailTexts(reopened.bob)).toEqual([])
  })

  it('setAutoWake toggles the wake subset without touching membership or pending mail', async () => {
    const s = await stack()
    const linkId = await grantBoth(s)
    const queued = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'quiet' })
    expect(s.links.message(queued.messageId)?.status).toBe('pending')
    const updated = await s.links.setAutoWake(linkId, [s.bob.id])
    expect(updated.record.autoWakeSessionIds).toEqual([s.bob.id])
    expect(updated.record.revision).toBe(2)
    expect(updated.record.memberIds).toContain(s.bob.id)
    // Membership untouched: the earlier message stays pending, a later one wakes.
    expect(s.links.message(queued.messageId)?.status).toBe('pending')
    const woken = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'wake now' })
    expect(woken.status).toBe('accepted')
    await expect(s.links.setAutoWake(linkId, [SessionId('session-eve')]))
      .rejects.toMatchObject({ code: 'LINK_TARGET_NOT_MEMBER' })
    await expect(s.links.setAutoWake(SessionLinkId('session-link-missing'), []))
      .rejects.toMatchObject({ code: 'LINK_NOT_FOUND' })
  })

  it('a spawn grant owes its spawned member one wake that survives a refused first task', async () => {
    const s = await stack({ maxMessageBytes: 400 })
    await s.links.link('spawned', [s.alice.id, s.bob.id], { kind: 'session', sessionId: s.alice.id })
    await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'x'.repeat(800) }))
      .rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
    const resent = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'the task' })
    expect(resent.status).toBe('accepted')
    expect(s.links.message(resent.messageId)?.wakesUsed).toBe(1)
    await s.bob.whenIdle()
    // The debt is paid: later messages follow the group's auto-wake grant, which is off.
    const later = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'later' })
    expect(later.status).toBe('queued')
  })

  it('the owed first wake never applies to the spawning member or a human grant', async () => {
    const s = await stack()
    await s.links.link('spawned', [s.alice.id, s.bob.id], { kind: 'session', sessionId: s.alice.id })
    const toSpawner = await s.links.send(s.bob, s.alice.id, { targetId: s.alice.id, text: 'reply' })
    expect(toSpawner.status).toBe('queued')
    const human = await stack()
    await grantBoth(human)
    expect((await human.links.send(human.alice, human.bob.id, { targetId: human.bob.id, text: 'hi' })).status).toBe('queued')
  })

  it('an owed first wake still respects the daily wake budget and stays owed', async () => {
    const s = await stack({ maxAutoWakesPerSessionPerDay: 1 })
    await grantBoth(s, { autoWake: [s.bob.id] })
    expect((await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'spend' })).status).toBe('accepted')
    await s.bob.whenIdle()
    const eve = await s.ctx.agentLoop.create(SessionId('session-eve'), { provider: 'mock', model: 'mock' })
    await s.links.link('spawned', [eve.id, s.bob.id], { kind: 'session', sessionId: eve.id })
    const task = await s.links.send(eve, s.bob.id, { targetId: s.bob.id, text: 'task' })
    expect(task.status).toBe('queued')
    expect(s.links.message(task.messageId)?.status).toBe('pending')
  })

  it('concurrent toggles for different members keep both flags', async () => {
    const s = await stack()
    const linkId = await grantBoth(s)
    await Promise.all([
      s.links.setMemberAutoWake(linkId, s.bob.id, true, s.alice.id),
      s.links.setMemberAutoWake(linkId, s.alice.id, true, s.bob.id),
    ])
    expect(s.links.list()[0]!.autoWakeSessionIds.slice().sort()).toEqual([s.alice.id, s.bob.id].sort())
    await expect(s.links.setMemberAutoWake(linkId, s.bob.id, false, SessionId('session-outsider')))
      .rejects.toMatchObject({ code: 'LINK_CALLER_NOT_MEMBER' })
  })

  it('claims one group per spawn call even under concurrent attempts', async () => {
    const s = await stack()
    const [first, second] = await Promise.all([
      s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-x', 'spawned', false),
      s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-x', 'spawned', false),
    ])
    expect(second).toBe(first)
    expect(s.links.list()).toHaveLength(1)
    expect(s.links.list()[0]!.memberIds).toEqual([s.alice.id, s.bob.id])
    expect(s.links.spawnReplay(s.alice.id, 'call-x')).toEqual({ sessionId: s.bob.id, linkId: first, removed: false })
    await s.links.unlink(first)
    expect(s.links.spawnReplay(s.alice.id, 'call-x')?.removed).toBe(true)
    await expect(s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-x', 'spawned', false))
      .rejects.toMatchObject({ code: 'LINK_REVOKED' })
    expect(s.links.list()).toEqual([])
  })

  it('reads ledger rows written before the spawn ledger existed', () => {
    // Storage parses every stored row through this schema; a 0.3.0/0.3.1 row has no `spawns`.
    const legacy = sessionLinkLedgersSchema.parse({ idempotency: { 'session-alice:k': 'm' }, wakes: {} })
    expect(legacy.spawns).toEqual({})
    expect(legacy.idempotency).toEqual({ 'session-alice:k': 'm' })
  })

  describe('storage write failures', () => {
    it('a failed spawn record write grants nothing, and a later removal survives restart and replay', async () => {
      const pool = new MemoryMediaPool()
      const s = await stack(undefined, pool)
      pool.failWritesTo('ledgers', 1)
      await expect(s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-a', 'spawned', false)).rejects.toThrow('injected')
      // The call record commits first, so its failure leaves no group behind.
      expect(s.links.list()).toEqual([])
      const linkId = await s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-a', 'spawned', false)
      await s.links.unlink(linkId)
      await s.disposeLinks()
      const restarted = await stack(undefined, pool)
      await expect(restarted.links.claimSpawnLink(restarted.alice.id, restarted.bob.id, 'call-a', 'spawned', false))
        .rejects.toMatchObject({ code: 'LINK_REVOKED' })
      expect(restarted.links.list()).toEqual([])
      expect(restarted.links.spawnReplay(restarted.alice.id, 'call-a')?.removed).toBe(true)
    })

    it('a group write that fails after its call record completes on replay under the recorded id', async () => {
      const pool = new MemoryMediaPool()
      const s = await stack(undefined, pool)
      pool.failWritesTo('links', 1)
      await expect(s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-b', 'spawned', false)).rejects.toThrow('injected')
      expect(s.links.list()).toEqual([])
      const recorded = s.links.spawnReplay(s.alice.id, 'call-b')
      expect(recorded?.removed).toBe(false)
      await s.disposeLinks()
      const restarted = await stack(undefined, pool)
      const linkId = await restarted.links.claimSpawnLink(restarted.alice.id, restarted.bob.id, 'call-b', 'spawned', false)
      expect(linkId).toBe(recorded!.linkId)
      expect(restarted.links.list().map(link => link.id)).toEqual([linkId])
    })

    it('an unlink whose removal mark fails keeps the group; one whose delete fails still blocks replay', async () => {
      const pool = new MemoryMediaPool()
      const s = await stack(undefined, pool)
      const linkId = await s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-c', 'spawned', false)
      pool.failWritesTo('ledgers', 1)
      await expect(s.links.unlink(linkId)).rejects.toThrow('injected')
      expect(s.links.list().map(link => link.id)).toEqual([linkId])
      expect(await s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-c', 'spawned', false)).toBe(linkId)
      pool.failWritesTo('links', 1)
      await expect(s.links.unlink(linkId)).rejects.toThrow('injected')
      expect(s.links.spawnReplay(s.alice.id, 'call-c')?.removed).toBe(true)
      await expect(s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-c', 'spawned', false))
        .rejects.toMatchObject({ code: 'LINK_REVOKED' })
      await s.links.unlink(linkId)
      expect(s.links.list()).toEqual([])
    })

    it('a message keyed only in the pre-0.3.3 idempotency ledger is still found', async () => {
      const s = await stack()
      await grantBoth(s)
      const earlier = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'legacy' })
      await s.links['ledgers'].put(SESSION_LINK_LEDGER_KEY, {
        idempotency: { 'session-alice:legacy-key': String(earlier.messageId) }, wakes: {}, spawns: {},
      })
      const retry = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'legacy', idempotencyKey: 'legacy-key' })
      expect(retry.messageId).toBe(earlier.messageId)
      expect(s.links.spawnReplay(s.alice.id, 'legacy-key')?.task?.messageId).toBe(earlier.messageId)
    })

    it('a 0.3.2 spawn record without intent reads its missing group as removed', async () => {
      const s = await stack()
      await s.links['ledgers'].put(SESSION_LINK_LEDGER_KEY, {
        idempotency: {}, wakes: {},
        spawns: { 'session-alice:call-old': { sessionId: s.bob.id, linkId: SessionLinkId('session-link-gone') } },
      })
      expect(s.links.spawnReplay(s.alice.id, 'call-old')?.removed).toBe(true)
      await expect(s.links.claimSpawnLink(s.alice.id, s.bob.id, 'call-old', 'spawned', false))
        .rejects.toMatchObject({ code: 'LINK_REVOKED' })
    })

    it('an idempotency key commits with its message, so a retry never delivers the task twice', async () => {
      const pool = new MemoryMediaPool()
      const s = await stack(undefined, pool)
      await grantBoth(s, { autoWake: [s.bob.id] })
      // No separate idempotency write exists to fail; a failed message write admits nothing.
      pool.failWritesTo('messages', 1)
      await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'once', idempotencyKey: 'k1' }))
        .rejects.toThrow('injected')
      const first = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'once', idempotencyKey: 'k1' })
      const retry = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'once', idempotencyKey: 'k1' })
      expect(retry.messageId).toBe(first.messageId)
      expect(mailTexts(s.bob).filter(text => text.endsWith('once'))).toHaveLength(1)
    })

    it('a ledger write failure after the message is stored never yields a second copy of the task', async () => {
      const pool = new MemoryMediaPool()
      const s = await stack(undefined, pool)
      await grantBoth(s, { autoWake: [s.bob.id] })
      // 0.3.2 wrote the idempotency entry here; 0.3.3 only writes the wake counter.
      pool.failWritesTo('ledgers', 1)
      await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'dup', idempotencyKey: 'k3' }))
        .resolves.toMatchObject({ status: 'queued' })
      const retry = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'dup', idempotencyKey: 'k3' })
      await s.bob.whenIdle()
      const stored = [...s.links['messages'].entries()].filter(([, record]) => record.text.endsWith('dup'))
      expect(stored.map(([id]) => id)).toEqual([retry.messageId])
      expect(mailTexts(s.bob).filter(text => text.endsWith('dup'))).toHaveLength(1)
    })

    it('a retry after a failed delivery leg delivers the stored message once instead of admitting another', async () => {
      const pool = new MemoryMediaPool()
      const s = await stack(undefined, pool)
      await grantBoth(s, { autoWake: [s.bob.id] })
      // Write 1 stores the message; write 2 records its wake and fails before the target is woken.
      pool.failWritesTo('messages', 2)
      await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'task', idempotencyKey: 'k2' }))
        .resolves.toMatchObject({ status: 'queued' })
      expect(mailTexts(s.bob)).toEqual([])
      const retry = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'task', idempotencyKey: 'k2' })
      expect(retry.status).toBe('accepted')
      const stored = [...s.links['messages'].entries()].filter(([, record]) => record.idempotencyKey === 'k2')
      expect(stored.map(([id]) => id)).toEqual([retry.messageId])
      expect(mailTexts(s.bob).filter(text => text.endsWith('task'))).toHaveLength(1)
    })
  })

  describe('delivery contract', () => {
    it('never reports accepted while flushes fail, and confirms once after they recover', async () => {
      const s = await stack()
      await grantBoth(s, { autoWake: [s.bob.id] })
      const flush = vi.spyOn(s.ctx.sessions, 'flush').mockRejectedValue(new Error('disk offline'))
      const first = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'durable?', idempotencyKey: 'f1' })
      expect(first.status).toBe('queued')
      const retry = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'durable?', idempotencyKey: 'f1' })
      expect(retry).toEqual({ messageId: first.messageId, status: 'queued' })
      expect(s.links.message(first.messageId)?.status).toBe('pending')
      flush.mockRestore()
      const recovered = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'durable?', idempotencyKey: 'f1' })
      expect(recovered).toEqual({ messageId: first.messageId, status: 'accepted' })
      expect(mailTexts(s.bob).filter(text => text.endsWith('durable?'))).toHaveLength(1)
    })

    it('a cancel request cannot mark a message the live target already holds', async () => {
      const s = await stack()
      await grantBoth(s, { autoWake: [s.bob.id] })
      const flush = vi.spyOn(s.ctx.sessions, 'flush').mockRejectedValue(new Error('disk offline'))
      const sent = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'held' })
      flush.mockRestore()
      await s.links.cancel(s.alice, sent.messageId)
      expect(s.links.message(sent.messageId)?.status).toBe('delivered')
    })

    it('aborting while the message is being written cancels it and never wakes the target', async () => {
      const s = await stack()
      await grantBoth(s, { autoWake: [s.bob.id] })
      const abort = new AbortController()
      const table = s.links['messages']
      const put = table.put.bind(table)
      const spy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => {
        await put(key, value)
        abort.abort(new Error('caller stopped'))
      })
      await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'stop me', signal: abort.signal }))
        .rejects.toThrow('caller stopped')
      spy.mockRestore()
      const [[messageId]] = [...table.entries()]
      expect(s.links.message(messageId)?.status).toBe('cancelled')
      await s.links.deliverPending(s.bob.id)
      expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(mailTexts(s.bob)).toEqual([])
    })

    it('aborting while a cold target resumes cancels the message before the target is woken', async () => {
      const abort = new AbortController()
      let created: Agent | undefined
      let ctxRef: Context | undefined
      const controller = {
        resolveAgent: async (sessionId: SessionId) => {
          abort.abort(new Error('caller stopped'))
          created = await ctxRef!.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
          return { agent: created }
        },
      }
      const s = await stack(undefined, undefined, controller)
      ctxRef = s.ctx
      const cold = SessionId('session-cold')
      await s.links.link('cold', [s.alice.id, cold], { kind: 'human' }, { autoWakeSessionIds: [cold] })
      await expect(s.links.send(s.alice, cold, { targetId: cold, text: 'later', signal: abort.signal }))
        .rejects.toThrow('caller stopped')
      expect(created).toBeDefined()
      expect(created!.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(mailTexts(created!)).toEqual([])
      expect([...s.links['messages'].entries()].map(([, record]) => record.status)).toEqual(['cancelled'])
    })

    it('aborting while the inserted marker persists cancels before handoff', async () => {
      const s = await stack()
      await grantBoth(s, { autoWake: [s.bob.id] })
      const abort = new AbortController()
      const table = s.links['messages']
      const put = table.put.bind(table)
      const spy = vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
        await put(key, value)
        if (value.inserted === true) abort.abort(new Error('caller stopped at handoff'))
      })
      await expect(s.links.send(s.alice, s.bob.id, {
        targetId: s.bob.id, text: 'stop at marker', signal: abort.signal,
      })).rejects.toThrow('caller stopped at handoff')
      spy.mockRestore()
      const [[, record]] = [...table.entries()]
      expect(record).toMatchObject({ status: 'cancelled', inserted: false, wakesUsed: 0 })
      expect(mailTexts(s.bob)).toEqual([])
      expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    })

    it('an inserted-marker write failure returns the wake so a retry can wake the target', async () => {
      const s = await stack({ maxAutoWakesPerSessionPerDay: 1, maxAutoWakesPerMessage: 1 })
      await grantBoth(s, { autoWake: [s.bob.id] })
      const table = s.links['messages']
      const put = table.put.bind(table)
      let failMarker = true
      const spy = vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
        if (failMarker && value.inserted === true) {
          failMarker = false
          throw new Error('inserted marker unavailable')
        }
        await put(key, value)
      })
      const first = await s.links.send(s.alice, s.bob.id, {
        targetId: s.bob.id, text: 'retry marker', idempotencyKey: 'marker-retry',
      })
      expect(first.status).toBe('queued')
      expect(s.links.message(first.messageId)?.inserted).not.toBe(true)
      expect(s.links.message(first.messageId)?.wakesUsed).toBe(0)
      expect(mailTexts(s.bob)).toEqual([])
      const retry = await s.links.send(s.alice, s.bob.id, {
        targetId: s.bob.id, text: 'retry marker', idempotencyKey: 'marker-retry',
      })
      spy.mockRestore()
      expect(retry).toEqual({ messageId: first.messageId, status: 'accepted' })
      expect(mailTexts(s.bob).filter(text => text.endsWith('retry marker'))).toHaveLength(1)
    })

    it('a waking message is delivered after mail that was queued before it', async () => {
      const s = await stack()
      const linkId = await grantBoth(s)
      expect((await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'first-task' })).status).toBe('queued')
      await s.links.setMemberAutoWake(linkId, s.bob.id, true)
      expect((await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'second-task' })).status).toBe('accepted')
      const order = mailTexts(s.bob).map(text => text.split('\n').at(-1))
      expect(order).toEqual(['first-task', 'second-task'])
    })

    it('frames the message id, sender id, and reply instructions into model-visible text', async () => {
      const s = await stack()
      await grantBoth(s, { autoWake: [s.bob.id] })
      const sent = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'please review' })
      const root = process.env.DSH_SOURCE_ROOT!
      const { serialize } = await import(`${root}/packages/llm/llm-deepseek/src/serialize.ts`)
      const { resolveAdapterOptions } = await import(`${root}/packages/llm/llm-deepseek/src/config.ts`)
      const { options } = await import(`${root}/packages/llm/llm-deepseek/tests/helpers.ts`)
      const received = s.bob.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      expect(received).toHaveLength(1)
      const body = JSON.stringify(serialize(options({ messages: received }), resolveAdapterOptions({}), received, new Map(), () => undefined))
      expect(body).toContain(String(sent.messageId))
      expect(body).toContain(String(s.alice.id))
      expect(body).toContain('in_reply_to')
      expect(body).toContain('please review')
      // The id the model reads is the one a reply must name.
      await s.bob.whenIdle()
      const reply = await s.links.send(s.bob, s.alice.id, { targetId: s.alice.id, text: 'done', inReplyTo: sent.messageId })
      expect(s.links.message(reply.messageId)?.chainLength).toBe(2)
    })

    it('counts the frame against the byte limit', async () => {
      const s = await stack({ maxMessageBytes: 300 })
      await grantBoth(s)
      await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'x' }))
        .rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
    })

    it('refuses a Session sending to itself', async () => {
      const s = await stack()
      await grantBoth(s)
      await expect(s.links.send(s.alice, s.alice.id, { targetId: s.alice.id, text: 'me' }))
        .rejects.toMatchObject({ code: 'LINK_SELF' })
      expect([...s.links['messages'].entries()]).toEqual([])
    })

    it('unloading waits for an in-flight send before closing storage', async () => {
      const s = await stack()
      await grantBoth(s)
      const table = s.links['messages']
      const put = table.put.bind(table)
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => {
        entered.resolve()
        await gate.promise
        await put(key, value)
      })
      const sending = s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'in flight' })
      await entered.promise
      const unloading = s.disposeLinks()
      gate.resolve()
      await expect(sending).resolves.toMatchObject({ status: 'queued' })
      await unloading
    })
  })

  describe('independent review findings', () => {
    it('a message handed to a now-cold target is neither cancelled nor revoked', async () => {
      const s = await stack()
      const cold = SessionId('session-cold')
      const { id: linkId } = await s.links.link('cold', [s.alice.id, cold], { kind: 'human' })
      const messageId = SessionLinkMessageId('session-link-message-held')
      await s.links['messages'].put(messageId, {
        linkId, senderId: s.alice.id, senderTitle: 'alice', targetId: cold, text: 'held', status: 'pending',
        wakesUsed: 1, chainLength: 1, attempts: 0, createdAt: new Date().toISOString(), seq: 1, inserted: true,
      })
      await s.links.cancel(s.alice, messageId)
      expect(s.links.message(messageId)?.status).toBe('pending')
      await s.links.unlink(linkId)
      expect(s.links.message(messageId)?.status).toBe('pending')
    })

    it('delivers by admission sequence even when timestamps disagree', async () => {
      const s = await stack()
      const linkId = await grantBoth(s)
      const at = new Date().toISOString()
      const earlier = new Date(Date.now() - 60_000).toISOString()
      const base = { linkId, senderId: s.alice.id, senderTitle: 'alice', targetId: s.bob.id, status: 'pending' as const, wakesUsed: 0, chainLength: 1, attempts: 0 }
      await s.links['messages'].put(SessionLinkMessageId('session-link-message-b'), { ...base, text: 'second', createdAt: earlier, seq: 2 })
      await s.links['messages'].put(SessionLinkMessageId('session-link-message-a'), { ...base, text: 'first', createdAt: at, seq: 1 })
      s.bob.followup(createUserMessage({ content: [{ type: 'text', text: 'human ping' }], source: { kind: 'user' } }))
      await s.links.deliverPending(s.bob.id)
      expect(mailTexts(s.bob)).toEqual(['first', 'second'])
    })

    it('a reply chain keeps its wake budget when it moves to another group', async () => {
      const s = await stack({ maxAutoWakesPerChain: 1 })
      const first = await s.links.link('g1', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
      await s.links.link('g2', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.alice.id] })
      const opening = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'opening' })
      expect(opening.status).toBe('accepted')
      await s.bob.whenIdle()
      await s.links.unlink(first.id)
      const reply = await s.links.send(s.bob, s.alice.id, { targetId: s.alice.id, text: 'reply', inReplyTo: opening.messageId })
      expect(reply.status).toBe('queued')
      expect(s.links.message(reply.messageId)?.wakesUsed).toBe(0)
    })

    it('a cancel that lands while the wake is claimed returns the day budget', async () => {
      const s = await stack({ maxAutoWakesPerSessionPerDay: 1 })
      await grantBoth(s, { autoWake: [s.bob.id] })
      const abort = new AbortController()
      const table = s.links['ledgers']
      const put = table.put.bind(table)
      const spy = vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => {
        await put(key, value)
        abort.abort(new Error('caller stopped'))
      })
      await expect(s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'stop', signal: abort.signal }))
        .rejects.toThrow('caller stopped')
      spy.mockRestore()
      expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      // The returned wake is still available to the next message.
      expect((await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'next' })).status).toBe('accepted')
    })

    it('in_reply_to only names a message that was delivered', async () => {
      const s = await stack()
      await grantBoth(s)
      const queued = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'not yet seen' })
      expect(queued.status).toBe('queued')
      await expect(s.links.send(s.bob, s.alice.id, { targetId: s.alice.id, text: 'reply', inReplyTo: queued.messageId }))
        .rejects.toMatchObject({ code: 'MESSAGE_NOT_REPLYABLE' })
    })

    it('admission numbers messages monotonically', async () => {
      const s = await stack()
      await grantBoth(s)
      const a = await s.links.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'a' })
      const b = await s.links.send(s.bob, s.alice.id, { targetId: s.alice.id, text: 'b' })
      expect(s.links.message(b.messageId)!.seq! - s.links.message(a.messageId)!.seq!).toBe(1)
    })
  })
})
