import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionLinkService from '../src/index.ts'
import { SessionLinkTaskService } from '../src/tasks.ts'
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
async function stack(): Promise<Stack> {
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
  await ctx.plugin(SessionLinkService)
  const alice = await ctx.agentLoop.create(SessionId('session-alice'), { provider: 'mock', model: 'mock' })
  const bob = await ctx.agentLoop.create(SessionId('session-bob'), { provider: 'mock', model: 'mock' })
  return { ctx, links: ctx.sessionLinks, alice, bob, listCalls, archived }
}

/** Mount the durable task service onto an existing link-service stack (same domain). */
async function ctx2TaskService(ctx: Context): Promise<{
  saveSpawn(callId: string): Promise<{ taskId: string; row: { taskState: string } }>
  saveSend(callId: string): Promise<{ taskId: string; row: { taskState: string } }>
}> {
  await ctx.plugin(SessionLinkTaskService, {})
  const tasks = ctx.sessionLinkTasks
  const policy = {
    scope: 'task' as const,
    candidates: [{ provider: 'deepseek-account', model: 'deepseek-chat' }],
    ifExhausted: 'notify_sender' as const,
    usesSessionDefault: false,
  }
  return {
    async saveSpawn(callId: string) {
      const saved = await tasks.saveTaskIntent({
        callerId: SessionId('session-alice'),
        request: {
          kind: 'spawn', callId, text: 'do the thing',
          spawn: { cwd: '/repo', autoAwake: true, targetSessionId: SessionId('session-bob') },
        },
        policy,
        tracked: true,
      })
      return { taskId: String(saved.taskId), row: { taskState: saved.row.taskState } }
    },
    async saveSend(callId: string) {
      const saved = await tasks.saveTaskIntent({
        callerId: SessionId('session-alice'),
        request: { kind: 'send', callId, text: 'ping', targetSessionId: SessionId('session-bob') },
        policy,
        tracked: true,
      })
      return { taskId: String(saved.taskId), row: { taskState: saved.row.taskState } }
    },
  }
}

describe('dsh-session-link remote surface', () => {
  it('linkFrom creates a human-granted pair with the peer wake flag', async () => {
    const s = await stack()
    const result = await s.links.linkFrom({ callerId: s.alice.id, peerId: s.bob.id, autoWake: true })
    expect(result.linkId).toMatch(/^session-link-/)
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

  it('taskView projects the caller- and target-visible tasks with honest persist labels', async () => {
    const s = await stack()
    const taskStack = await ctx2TaskService(s.ctx)
    const saved = await taskStack.saveSpawn('call-view-1')
    expect(saved.taskId).toBe(`task:${s.alice.id}:call-view-1`)
    const sent = await taskStack.saveSend('call-view-2')
    expect(sent.taskId).toBe(`task:${s.alice.id}:call-view-2`)
    const empty = await s.links.taskView({ sessionId: SessionId('session-carol') })
    expect(empty.tasks).toEqual([])
    const view = await s.links.taskView({ sessionId: s.alice.id })
    expect(view.pollIntervalMs).toBe(30000)
    expect(view.tasks).toHaveLength(2)
    const entry = view.tasks.find(item => item.taskId === `task:${s.alice.id}:call-view-1`)!
    expect(entry.taskState).toBe('preparing')
    expect(entry.scope).toBe('task')
    expect(entry.routePersisted).toBe(false)
    expect(entry.currentlyExecuting).toBe(false)
    expect(entry.requestedModel).toEqual({ provider: 'deepseek-account', model: 'deepseek-chat' })
    // The target sees the send that names it; a stranger does not.
    const bobView = await s.links.taskView({ sessionId: s.bob.id })
    expect(bobView.tasks).toHaveLength(1)
    expect(bobView.tasks[0]!.taskId).toBe(`task:${s.alice.id}:call-view-2`)
    // Malformed requests validate before reading state.
    await expect(s.links.taskView({ sessionId: 7 } as never)).rejects.toThrow()
    await expect(s.links.taskView({ sessionId: s.alice.id, extra: true } as never)).rejects.toThrow()
  })

  it('taskView reads as empty when the task service is not mounted', async () => {
    const s = await stack()
    const view = await s.links.taskView({ sessionId: s.alice.id })
    expect(view).toEqual({ pollIntervalMs: 30000, tasks: [] })
  })
})
