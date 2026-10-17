import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult, ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionLinkService, { SessionLinkId } from '../src/index.ts'
import * as toolPlugin from '../src/tools.ts'
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
  if (failures.length > 0) throw new AggregateError(failures, 'tool-session-link test cleanup failed')
})

const SIGNAL = new AbortController().signal
let callCounter = 0

interface Stack {
  readonly ctx: Context
  readonly alice: Agent
  readonly bob: Agent
  /** Every Session Controller create request, in order. */
  readonly creates: readonly { cwd?: string; sessionId?: SessionId }[]
}

/**
 * Boot the REAL tool plugin body over a real ToolRuntime and SessionLinkService,
 * with two live root Agents and stand-ins only for the Session Controller and
 * title service the spawn path consults.
 */
async function stack(options: {
  links?: Record<string, number>
  /** Runs after both Agents exist and before the tool row mounts. */
  beforeTools?: (alice: Agent, bob: Agent) => void
  rename?: () => Promise<unknown>
  /** Further live Sessions handed out to spawn calls with new ids, after bob. */
  extraSessions?: SessionId[]
  /** Storage medium, shared to inject write failures. */
  pool?: MemoryMediaPool
  workspaceRegistry?: object
  callerCwd?: string
} = {}): Promise<Stack> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(options.pool ?? new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspace = { id: WorkspaceId('workspace-test'), sessionIds: [] as SessionId[], attachSession: vi.fn(async () => {}) }
  ctx.provide('workspaceRegistry', options.workspaceRegistry ?? {
    archivedSessionIds: [] as readonly SessionId[], list: () => [],
    create: vi.fn(async () => workspace), get: () => workspace,
  } as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionLinkService, options.links ?? {})
  const alice = await ctx.agentLoop.create(SessionId('session-alice'), { provider: 'mock', model: 'mock' },
    options.callerCwd === undefined ? {} : { cwd: options.callerCwd })
  const bob = await ctx.agentLoop.create(SessionId('session-bob'), { provider: 'mock', model: 'mock' })
  for (const id of options.extraSessions ?? []) await ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
  ctx.provide('sessionTitle', {
    get: (session: { id: SessionId }) => ({ title: `title-of-${session.id}` }),
  } as never)
  // Requested ids adopt like the real controller: a repeated id returns its first Session; new ids take the next pool member.
  const pool = [bob.id, ...(options.extraSessions ?? [])]
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
    rename: options.rename ?? (() => Promise.resolve({})),
  } as never)
  options.beforeTools?.(alice, bob)
  await ctx.plugin(toolPlugin)
  // Agents that existed before the row mount their scoped tools asynchronously.
  for (const agent of [alice, bob]) {
    if (agent.session.header.origin === 'subagent') continue
    await vi.waitFor(() => { expect(ctx.tools.get('gc_duolink_list_links', agent)).toBeDefined() })
  }
  return { ctx, alice, bob, creates }
}

/** Invoke one registered tool through the real registry execution path. */
function call(ctx: Context, name: string, args: unknown, agent?: Agent, callId?: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(callId ?? `call-${++callCounter}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Require one execution to have succeeded and return it for value narrowing at the call site. */
function succeeded(result: ToolExecutionResult): ToolExecutionSuccess {
  if (result.isError) throw new Error(`tool call failed unexpectedly: ${text(result)}`)
  return result
}

/** Read the mailbox record a send produced, through the registered service. */
function mailOf(stack: Stack, messageId: string) {
  return stack.ctx.gcDuolink.message(messageId as never)
}

async function grantBoth(stack: Stack): Promise<void> {
  await stack.ctx.gcDuolink.link('pair', [stack.alice.id, stack.bob.id], { kind: 'human' })
}

describe('dsh-tool-session-link', () => {
  it('omitted cwd inherits the exact caller directory and Workspace, as a peer', async () => {
    const attach = vi.fn(async () => {})
    const workspace = { id: WorkspaceId('caller-workspace'), sessionIds: [SessionId('session-alice')], attachSession: attach }
    const registry = { archivedSessionIds: [], list: () => [workspace], get: () => workspace, create: vi.fn() }
    const s = await stack({ workspaceRegistry: registry, callerCwd: '/tmp/caller-project' })
    const result = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', { task: 'review' }, s.alice)).value as { sessionId: string }
    expect(s.creates[0]?.cwd).toBe('/tmp/caller-project')
    expect(attach).toHaveBeenCalledExactlyOnceWith(result.sessionId)
    expect(registry.create).not.toHaveBeenCalled()
    expect(s.bob.session.header.parentSession).toBeUndefined()
  })

  it('omitted cwd preserves Ungrouped even when an unrelated Workspace uses that directory', async () => {
    const workspace = { id: WorkspaceId('unrelated'), sessionIds: [], attachSession: vi.fn() }
    const registry = { archivedSessionIds: [], list: () => [workspace], get: () => workspace, create: vi.fn() }
    const s = await stack({ workspaceRegistry: registry, callerCwd: '/tmp/caller-project' })
    succeeded(await call(s.ctx, 'gc_duolink_spawn_session', { task: 'review' }, s.alice))
    expect(s.creates[0]?.cwd).toBe('/tmp/caller-project')
    expect(workspace.attachSession).not.toHaveBeenCalled()
    expect(registry.create).not.toHaveBeenCalled()
  })

  it('refuses omission without a caller cwd before creating or linking', async () => {
    const s = await stack()
    const result = await call(s.ctx, 'gc_duolink_spawn_session', { task: 'review' }, s.alice)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('this Session has no working directory')
    expect(s.creates).toEqual([])
    expect(s.ctx.gcDuolink.list()).toEqual([])
  })

  it('inherits a caller directory ending in a space without changing its spelling', async () => {
    const s = await stack({ callerCwd: '/tmp/caller project ' })
    succeeded(await call(s.ctx, 'gc_duolink_spawn_session', { task: 'review' }, s.alice))
    expect(s.creates[0]?.cwd).toBe('/tmp/caller project ')
  })

  it('same-call inherited/explicit races have one winner even when the cwd is identical', async () => {
    const s = await stack({ callerCwd: '/tmp/caller-project' })
    const results = await Promise.all([
      call(s.ctx, 'gc_duolink_spawn_session', { task: 'review' }, s.alice, 'placement-mode-race'),
      call(s.ctx, 'gc_duolink_spawn_session', { task: 'review', cwd: '/tmp/caller-project' }, s.alice, 'placement-mode-race'),
    ])
    expect(results.filter(result => result.isError)).toHaveLength(1)
    expect(text(results.find(result => result.isError)!)).toContain('SPAWN_REPLAY_CONFLICT')
    expect(s.creates).toHaveLength(1)
    expect([...s.ctx.gcDuolink['messages'].entries()]).toHaveLength(1)
  })

  it.each(['', '   ', 'relative/path', null])('rejects explicit invalid cwd without falling back to the caller: %j', async cwd => {
    const s = await stack({ callerCwd: '/tmp/caller-project' })
    expect((await call(s.ctx, 'gc_duolink_spawn_session', { cwd, task: 'review' }, s.alice)).isError).toBe(true)
    expect(s.creates).toEqual([])
  })

  it('placement failure keeps the linked Session, admits no task, and retries placement once', async () => {
    const attach = vi.fn().mockRejectedValueOnce(new Error('workspace storage offline')).mockResolvedValue(undefined)
    const workspace = { id: WorkspaceId('new-workspace'), sessionIds: [], attachSession: attach }
    const registry = { archivedSessionIds: [], list: () => [], get: () => workspace, create: vi.fn(async () => workspace) }
    const s = await stack({ workspaceRegistry: registry })
    const args = { cwd: '/tmp/explicit-project', task: 'review' }
    const first = await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'placement-retry')
    expect(first.isError).toBe(true)
    expect(text(first)).toContain('SPAWN_WORKSPACE_FAILED')
    expect(text(first)).toContain(s.bob.id)
    expect([...s.ctx.gcDuolink['messages'].entries()]).toEqual([])
    expect(s.ctx.gcDuolink.list()).toHaveLength(1)
    const next = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'placement-retry')).value as { status: string }
    expect(next.status).toBe('accepted')
    expect(s.creates).toHaveLength(1)
    expect(registry.create).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledTimes(2)
    await s.bob.whenIdle()
    succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'placement-retry'))
    expect(attach).toHaveBeenCalledTimes(2)
    expect([...s.ctx.gcDuolink['messages'].entries()]).toHaveLength(1)
  })

  it('completed placement is not repeated when a rejected first task is corrected', async () => {
    const attach = vi.fn(async () => {})
    const workspace = { id: WorkspaceId('new-workspace'), sessionIds: [], attachSession: attach }
    const registry = { archivedSessionIds: [], list: () => [], get: () => workspace, create: vi.fn(async () => workspace) }
    const s = await stack({ workspaceRegistry: registry, links: { maxMessageBytes: 700 } })
    const args = { cwd: '/tmp/explicit-project', task: 'x'.repeat(800) }
    expect((await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'placed-refused')).isError).toBe(true)
    succeeded(await call(s.ctx, 'gc_duolink_spawn_session', { ...args, task: 'short task' }, s.alice, 'placed-refused'))
    expect(attach).toHaveBeenCalledTimes(1)
    expect(registry.create).toHaveBeenCalledTimes(1)
  })
  it('registers the four tools in each top-level Agent scope, not the global layer', async () => {
    const { ctx, alice } = await stack()
    const names = ctx.tools.schemas(alice).map(schema => schema.name)
    expect(names).toContain('gc_duolink_list_links')
    expect(names).toContain('gc_duolink_send_message')
    expect(names).toContain('gc_duolink_cancel_message')
    expect(names).toContain('gc_duolink_spawn_session')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('gc_duolink_list_links')
  })

  it('never mounts the tools into a subagent-owned Agent', async () => {
    const { ctx, alice, bob } = await stack({
      beforeTools: (alice) => {
        Object.defineProperty(alice.session, 'header', { value: { ...alice.session.header, origin: 'subagent' } })
      },
    })
    expect(ctx.tools.get('gc_duolink_list_links', bob)).toBeDefined()
    expect(ctx.tools.get('gc_duolink_list_links', alice)).toBeUndefined()
  })

  it('cannot be reached without a calling Agent', async () => {
    const s = await stack()
    await grantBoth(s)
    const result = await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.bob.id,
      message: 'no caller',
    })
    expect(result.isError).toBe(true)
    expect(s.ctx.gcDuolink.list(s.alice.id)[0]).toBeDefined()
  })

  it('lists only the caller’s links with peer ids and auto-wake flags', async () => {
    const s = await stack()
    await grantBoth(s)
    const result = succeeded(await call(s.ctx, 'gc_duolink_list_links', {}, s.alice))
      .value as { links: { peers: { sessionId: string; autoWake: boolean }[] }[] }
    const links = result.links
    expect(links.length).toBe(1)
    expect(links[0]!.peers.length).toBe(1)
    expect(links[0]!.peers[0]!.sessionId).toBe(s.bob.id)
    expect(links[0]!.peers[0]!.autoWake).toBe(false)
  })

  it('sends with the caller-derived sender identity, never an argument-supplied one', async () => {
    const s = await stack()
    await grantBoth(s)
    const result = succeeded(await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.bob.id,
      message: 'hello from alice',
      sender_id: 'session-eve',
    }, s.alice)).value as { messageId: string; status: string }
    expect(result.status).toBe('queued')
    const record = mailOf(s, result.messageId)
    expect(record?.senderId).toBe(s.alice.id)
    expect(record?.text).toContain('hello from alice')
    expect(record?.text).toContain('非本机人类直接输入')
  })

  it('keys durable idempotency to the call id so a resumed call replays its first admission', async () => {
    const s = await stack()
    await grantBoth(s)
    const callId = ToolCallId('call-idempotency')
    const run = async (): Promise<{ value: { messageId: string } }> =>
      ({ value: succeeded(await s.ctx.tools.execute({
        signal: SIGNAL,
        callId,
        name: 'gc_duolink_send_message',
        arguments: { session_id: s.bob.id, message: 'once only' },
        agent: s.alice,
      })).value as { messageId: string } })
    const first = await run()
    const second = await run()
    expect(second.value.messageId).toBe(first.value.messageId)
  })

  it('send exposes boolean wake, persists false, and refuses escalation under the same tool call id', async () => {
    const s = await stack()
    await s.ctx.gcDuolink.link('pair', [s.alice.id, s.bob.id], { kind: 'human' }, { autoWakeSessionIds: [s.bob.id] })
    const args = { session_id: s.bob.id, message: 'information only', wake: false }
    const first = succeeded(await call(s.ctx, 'gc_duolink_send_message', args, s.alice, 'quiet-tool-call'))
      .value as { messageId: string; status: string }
    expect(first.status).toBe('queued')
    const replay = succeeded(await call(s.ctx, 'gc_duolink_send_message', { ...args, wake: true }, s.alice, 'quiet-tool-call')).value
    expect(replay).toEqual(first)
    expect(mailOf(s, first.messageId)).toMatchObject({ wake: false, status: 'pending', wakesUsed: 0 })
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    const next = succeeded(await call(s.ctx, 'gc_duolink_send_message', { session_id: s.bob.id, message: 'authorized wake', wake: true }, s.alice))
      .value as { messageId: string; status: string }
    expect(next.status).toBe('accepted')
    expect(mailOf(s, next.messageId)).toMatchObject({ wake: true, wakesUsed: 1 })
    expect(mailOf(s, first.messageId)).toMatchObject({ wake: false, status: 'delivered', wakesUsed: 0 })
  })

  it.each(['false', 0, null, {}, []])('rejects a non-boolean send wake value before admitting mail: %j', async wake => {
    const s = await stack()
    await grantBoth(s)
    const result = await call(s.ctx, 'gc_duolink_send_message', { session_id: s.bob.id, message: 'invalid intent', wake }, s.alice)
    expect(result.isError).toBe(true)
    expect([...s.ctx.gcDuolink['messages'].entries()]).toEqual([])
  })

  it.each([
    { model: 'retired' }, { provider: 'retired' }, { reasoning_effort: 'high' },
    { initial_model: { provider: 'mock', model: 'mock' } },
  ])('continues rejecting retired send model parameters alongside valid wake:false: %j', async modelArgs => {
    const s = await stack()
    await grantBoth(s)
    const result = await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.bob.id, message: 'invalid selection', wake: false, ...modelArgs,
    }, s.alice)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('MODEL_PARAMETERS_REMOVED')
    expect([...s.ctx.gcDuolink['messages'].entries()]).toEqual([])
  })

  it.each([true, false])('does not accept a spawn wake=%s argument or create a target', async wake => {
    const s = await stack()
    const result = await call(s.ctx, 'gc_duolink_spawn_session', { cwd: '/tmp/tool-session-link-spawn-test', task: 'work', wake }, s.alice)
    expect(result.isError).toBe(true)
    expect(s.creates).toEqual([])
    expect(s.ctx.gcDuolink.list()).toEqual([])
    expect([...s.ctx.gcDuolink['messages'].entries()]).toEqual([])
  })

  it('cancels a pending message through the tool and reports delivered when too late', async () => {
    const s = await stack()
    await grantBoth(s)
    const sent = succeeded(await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.bob.id,
      message: 'cancel me',
    }, s.alice)).value as { messageId: string }
    const cancelled = succeeded(await call(s.ctx, 'gc_duolink_cancel_message', {
      message_id: sent.messageId,
    }, s.alice)).value as { status: string }
    expect(cancelled.status).toBe('cancelled')
    expect(mailOf(s, sent.messageId)?.status).toBe('cancelled')
  })

  it('spawn links the caller to a new session and admits the task message', async () => {
    const s = await stack()
    const execution = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test',
      task: 'review the report',
      title: 'reviewer',
    }, s.alice)
    const result = succeeded(execution).value as { sessionId: string; linkId: string; messageId: string; status: string }
    expect(result.sessionId).toBe(s.bob.id)
    expect(text(execution)).toContain('linked')
    const links = s.ctx.gcDuolink.list(s.alice.id)
    expect(links.length).toBe(1)
    expect(links[0]!.memberIds).toContain(s.bob.id)
    expect(mailOf(s, result.messageId)?.text).toContain('review the report')
    // The initial task wakes the new Session without an auto-wake grant.
    expect(result.status).toBe('accepted')
    expect(mailOf(s, result.messageId)?.wakesUsed).toBe(1)
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
    expect(links[0]!.autoWakeSessionIds).toEqual([])
    await s.bob.whenIdle()
    const reply = await call(s.ctx, 'gc_duolink_send_message', {
      session_id: result.sessionId,
      message: 'follow-up',
    }, s.alice)
    expect(reply.isError).toBe(false)
  })

  it('spawn with auto_awake grants a wake for the initial task and later messages', async () => {
    const s = await stack()
    const result = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'work promptly', auto_awake: true,
    }, s.alice)).value as { messageId: string; status: string }
    expect(result.status).toBe('accepted')
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
    expect(s.ctx.gcDuolink.list(s.alice.id)[0]!.autoWakeSessionIds).toEqual([s.bob.id, s.alice.id])
    expect(mailOf(s, result.messageId)?.wakesUsed).toBe(1)
    await s.bob.whenIdle()
    const reply = succeeded(await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.alice.id, message: 'finished', in_reply_to: result.messageId,
    }, s.bob)).value as { messageId: string; status: string }
    expect(reply.status).toBe('accepted')
    expect(mailOf(s, reply.messageId)?.wakesUsed).toBe(1)
    expect(s.alice.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
  })

  it.each([
    [true, false, true, false],
    [false, true, false, true],
    [false, undefined, false, false],
  ])('spawn supports independent auto_awake=%s wake_caller=%s', async (autoAwake, wakeCaller, peer, caller) => {
    const s = await stack()
    succeeded(await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'work', auto_awake: autoAwake,
      ...(wakeCaller === undefined ? {} : { wake_caller: wakeCaller }),
    }, s.alice))
    expect(s.ctx.gcDuolink.list()[0]!.autoWakeSessionIds).toEqual([
      ...(peer ? [s.bob.id] : []), ...(caller ? [s.alice.id] : []),
    ])
  })

  it.each([
    { name: 'caller opt-out', wakeCaller: false, limits: {} },
    { name: 'reply-chain budget', wakeCaller: true, limits: { maxAutoWakesPerChain: 1 } },
  ])('return messages stay queued under $name without waking the idle caller', async ({ wakeCaller, limits }) => {
    const s = await stack({ links: limits })
    const task = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'work', auto_awake: true, wake_caller: wakeCaller,
    }, s.alice)).value as { messageId: string; status: string }
    expect(task.status).toBe('accepted')
    await s.bob.whenIdle()
    const reply = succeeded(await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.alice.id, message: 'reply', in_reply_to: task.messageId,
    }, s.bob)).value as { messageId: string; status: string }
    expect(reply.status).toBe('queued')
    expect(mailOf(s, reply.messageId)?.wakesUsed).toBe(0)
    expect(s.alice.status).toBe('idle')
    expect(s.alice.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('spawn replay never widens an old group or restores a human-disabled return wake', async () => {
    const s = await stack()
    const args = { cwd: '/tmp/tool-session-link-spawn-test', task: 'work', auto_awake: true }
    const first = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'return-replay')).value as { linkId: string }
    await s.bob.whenIdle()
    await s.ctx.gcDuolink.setMemberAutoWake(SessionLinkId(first.linkId), s.alice.id, false, s.alice.id)
    const prior = s.ctx.gcDuolink.list()[0]
    succeeded(await call(s.ctx, 'gc_duolink_spawn_session', { ...args, wake_caller: true }, s.alice, 'return-replay'))
    expect(s.ctx.gcDuolink.list()[0]).toEqual(prior)
    expect(s.creates).toHaveLength(1)
  })

  it('replaying a spawn call adopts its Session, group, and task instead of creating new ones', async () => {
    const s = await stack({ extraSessions: [SessionId('session-charlie')] })
    const args = { cwd: '/tmp/tool-session-link-spawn-test', task: 'once' }
    const first = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-replay')).value
    await s.bob.whenIdle()
    const replay = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-replay')).value
    expect(replay).toEqual(first)
    // The replay is answered from the recorded call: nothing is created or linked again.
    expect(s.creates).toHaveLength(1)
    expect(s.ctx.gcDuolink.list(s.alice.id)).toHaveLength(1)
    // A different call is a different spawn.
    const other = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-other')).value as { sessionId: string }
    expect(other.sessionId).toBe('session-charlie')
    expect(s.creates[1]!.sessionId).not.toBe(s.creates[0]!.sessionId)
  })

  it('a replayed spawn never relinks a group the human removed', async () => {
    const s = await stack()
    const args = { cwd: '/tmp/tool-session-link-spawn-test', task: 'once' }
    const first = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-unlinked')).value as { linkId: string }
    await s.bob.whenIdle()
    await s.ctx.gcDuolink.unlink(SessionLinkId(first.linkId))
    const replay = await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-unlinked')
    expect(replay.isError).toBe(true)
    expect(text(replay)).toContain('not relinked')
    expect(s.ctx.gcDuolink.list()).toEqual([])
    expect(s.creates).toHaveLength(1)
  })

  it('a replayed spawn whose task was refused re-sends into the recorded group without creating again', async () => {
    const s = await stack({ links: { maxMessageBytes: 700 } })
    const refused = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'x'.repeat(800),
    }, s.alice, 'call-spawn-refused')
    expect(refused.isError).toBe(true)
    const linkId = s.ctx.gcDuolink.list(s.alice.id)[0]!.id
    const replay = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'short task',
    }, s.alice, 'call-spawn-refused')).value as { linkId: string; status: string }
    expect(replay).toMatchObject({ linkId: String(linkId), status: 'accepted' })
    expect(s.creates).toHaveLength(1)
    expect(s.ctx.gcDuolink.list(s.alice.id)).toHaveLength(1)
  })

  it('a spawn call recorded by an earlier version is answered from its first task', async () => {
    const s = await stack()
    // 0.3.0 created the Session under a random id and admitted the task under the call id.
    const { id: linkId } = await s.ctx.gcDuolink.link('legacy', [s.alice.id, s.bob.id], { kind: 'session', sessionId: s.alice.id })
    const task = await s.ctx.gcDuolink.send(s.alice, s.bob.id, { targetId: s.bob.id, text: 'legacy task', idempotencyKey: 'call-spawn-legacy' })
    await s.bob.whenIdle()
    const args = { cwd: '/tmp/tool-session-link-spawn-test', task: 'legacy task' }
    const replay = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-legacy')).value
    expect(replay).toEqual({ sessionId: s.bob.id, linkId: String(linkId), messageId: String(task.messageId), status: task.status })
    expect(s.creates).toHaveLength(0)
    await s.ctx.gcDuolink.unlink(linkId)
    const afterUnlink = await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-legacy')
    expect(afterUnlink.isError).toBe(true)
    expect(text(afterUnlink)).toContain('not relinked')
    expect(s.creates).toHaveLength(0)
    expect(s.ctx.gcDuolink.list()).toEqual([])
  })

  it('resending a refused first task through the send tool still starts the new Session', async () => {
    const s = await stack({ links: { maxMessageBytes: 700 } })
    const refused = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'x'.repeat(800),
    }, s.alice)
    expect(refused.isError).toBe(true)
    const resent = succeeded(await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.bob.id, message: 'the task, shorter',
    }, s.alice)).value as { status: string }
    expect(resent.status).toBe('accepted')
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
  })

  it('spawn keeps the link and delivers the task when renaming fails', async () => {
    const s = await stack({ rename: () => Promise.reject(new Error('title store offline')) })
    const result = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'work', title: 'reviewer',
    }, s.alice)).value as { linkId: string; status: string }
    expect(result.status).toBe('accepted')
    expect(s.ctx.gcDuolink.list(s.alice.id).map(link => String(link.id))).toEqual([result.linkId])
  })

  it('spawn reports the linked Session when its task cannot be admitted', async () => {
    const s = await stack({ links: { maxMessageBytes: 200 } })
    const result = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/tool-session-link-spawn-test', task: 'x'.repeat(400),
    }, s.alice)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`session ${s.bob.id} was created and linked`)
    expect(text(result)).toContain('gc_duolink_send_message')
    expect(s.ctx.gcDuolink.list(s.alice.id)[0]!.memberIds).toContain(s.bob.id)
  })

  it('tools refuse a caller that became subagent-owned before creating any link', async () => {
    const s = await stack()
    Object.defineProperty(s.alice.session, 'header', { value: { ...s.alice.session.header, origin: 'subagent' } })
    const result = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/forbidden-subagent-spawn', task: 'work',
    }, s.alice)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent')
    expect(s.ctx.gcDuolink.list()).toEqual([])
  })

  it('spawn rejects relative cwd and empty tasks before creating anything', async () => {
    const s = await stack()
    const relative = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: 'relative/path',
      task: 'work',
    }, s.alice)
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('fully qualified')
    const empty = await call(s.ctx, 'gc_duolink_spawn_session', {
      cwd: '/tmp/somewhere',
      task: '   ',
    }, s.alice)
    expect(empty.isError).toBe(true)
    expect(s.ctx.gcDuolink.list(s.alice.id).length).toBe(0)
  })

  it('send rejects an unlinked target with the stable Session Link error', async () => {
    const s = await stack()
    const result = await call(s.ctx, 'gc_duolink_send_message', {
      session_id: s.bob.id,
      message: 'no grant here',
    }, s.alice)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('share no link grant')
  })

  it('a spawn whose task is stored but whose wake write fails reports queued, and its replay delivers that task once', async () => {
    const pool = new MemoryMediaPool()
    const s = await stack({ pool })
    // Spawn intent, placement intent/receipt, then the first task's wake claim.
    pool.failWritesTo('ledgers', 4)
    const args = { cwd: '/tmp/tool-session-link-spawn-test', task: 'stored task' }
    const first = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-wake-fail')).value as { messageId: string; status: string }
    expect(first.status).toBe('queued')
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    const replay = succeeded(await call(s.ctx, 'gc_duolink_spawn_session', args, s.alice, 'call-spawn-wake-fail')).value as { messageId: string; status: string }
    expect(replay).toMatchObject({ messageId: first.messageId, status: 'accepted' })
    expect(s.bob.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
    await s.bob.whenIdle()
    const copies = s.bob.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => (message as { source?: { messageId?: string } }).source?.messageId !== undefined))
    expect(copies).toHaveLength(1)
    expect(s.creates).toHaveLength(1)
  })

  it('send tool refuses a Session messaging itself', async () => {
    const s = await stack()
    await grantBoth(s)
    const result = await call(s.ctx, 'gc_duolink_send_message', { session_id: s.alice.id, message: 'me' }, s.alice)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('itself')
  })
})
