import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionLinkError, SessionLinkId, SessionLinkMessageId } from '../src/index.ts'
import type { SessionLinkSummary } from '../src/index.ts'
import * as commandSessionLink from '../src/command.ts'
import { mountPerPresetAgent } from '../src/scope.ts'

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
  if (failures.length > 0) throw new AggregateError(failures, 'command-session-link test cleanup failed')
})

/** Minimal live Agent accepted by the command executor, keyed to its own registration scope like a loop Agent. */
function stubAgent(ctx: Context, id: string, status: AgentStatus = 'idle'): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  let current = status
  let scoped: Context | undefined
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: createInboxStub(),
    get ctx() {
      if (scoped === undefined) throw new Error('stub agent scope is not minted yet')
      return scoped
    },
    get status() { return current },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject() {},
    cancel() { current = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  scoped = createScope(ctx, agent).ctx
  return { agent, session }
}

/** In-memory Session Link seam covering exactly the commands the handler uses. */
class FakeLinks {
  readonly unlinked: SessionLinkId[] = []
  readonly wakeChanges: { linkId: SessionLinkId; autoWake: readonly SessionId[] }[] = []
  readonly granted: { name: string; memberIds: readonly SessionId[]; autoWake: readonly SessionId[] }[] = []
  readonly ordinaryTargets: SessionId[] = []

  constructor(private readonly links: SessionLinkSummary[]) {}

  list(memberId?: SessionId): SessionLinkSummary[] {
    return memberId === undefined
      ? this.links
      : this.links.filter(link => link.memberIds.includes(memberId))
  }

  link(
    name: string,
    memberIds: readonly SessionId[],
    _grant: unknown,
    options: { autoWakeSessionIds?: readonly SessionId[]; requireNewPair?: boolean } = {},
  ): Promise<{ id: SessionLinkId }> {
    if (options.requireNewPair === true
      && this.links.some(link => memberIds.every(member => link.memberIds.includes(member)))) {
      return Promise.reject(new SessionLinkError('already linked', 'LINK_ALREADY_LINKED'))
    }
    this.granted.push({ name, memberIds, autoWake: options.autoWakeSessionIds ?? [] })
    return Promise.resolve({ id: SessionLinkId(`session-link-new-${this.granted.length}`) })
  }

  assertOrdinaryTarget(sessionId: SessionId, _header: unknown): void {
    this.ordinaryTargets.push(sessionId)
  }

  inspectHeader(sessionId: SessionId): Promise<{ id: SessionId }> {
    if (!['session-alice', 'session-bob', 'session-eve'].includes(sessionId)) {
      return Promise.reject(new SessionLinkError(`找不到会话 ${sessionId}`, 'TARGET_NOT_FOUND'))
    }
    return Promise.resolve({ id: sessionId })
  }

  unlink(linkId: SessionLinkId): Promise<void> {
    this.unlinked.push(linkId)
    return Promise.resolve()
  }

  setMemberAutoWake(linkId: SessionLinkId, memberId: SessionId, on: boolean, _callerId?: SessionId): Promise<unknown> {
    const current = this.links.find(link => link.id === linkId)?.autoWakeSessionIds ?? []
    const autoWake = on ? [...new Set([...current, memberId])] : current.filter(member => member !== memberId)
    this.wakeChanges.push({ linkId, autoWake })
    return Promise.resolve()
  }

  message(_messageId: SessionLinkMessageId): undefined {
    return undefined
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly links: FakeLinks
  readonly row: Fiber
  /** Session id → bound preset, read by the stand-in preset registry when one is installed. */
  readonly presets: Map<string, string>
}

/** Mount the real command registry over a fake link seam with one linked pair. */
async function harness(options: {
  links?: SessionLinkSummary[]
  agentStatus?: AgentStatus
  /** Install a stand-in preset registry binding these Sessions to presets. */
  presets?: Record<string, string>
  config?: commandSessionLink.Config
} = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const links = new FakeLinks(options.links ?? [{
    id: SessionLinkId('session-link-pair'),
    name: 'pair',
    memberIds: [SessionId('session-alice'), SessionId('session-bob')],
    autoWakeSessionIds: [],
    revision: 1,
  }])
  ctx.provide('sessionLinks', links as never)
  const presets = new Map(Object.entries(options.presets ?? {}))
  if (options.presets !== undefined) {
    ctx.provide('agentPresets', {
      composedPreset: (agentCtx: Context) => {
        const owner = ctx.agents.list().find(candidate => candidate.ctx === agentCtx)
        return owner === undefined ? undefined : presets.get(owner.id)
      },
    } as never)
  }
  const row = ctx.plugin(commandSessionLink, options.config ?? {})
  await row.await()
  const { agent } = stubAgent(ctx, 'session-alice', options.agentStatus ?? 'idle')
  await ctx.agents.register(agent)
  const bob = stubAgent(ctx, 'session-bob', 'running')
  await ctx.agents.register(bob.agent)
  return { ctx, agent, links, row, presets }
}

/** Whether `/session-link` resolves for one Agent. */
async function hasCommand(ctx: Context, agent: Agent): Promise<boolean> {
  return await ctx.commands.execute(agent, '/session-link', [], new AbortController().signal) !== undefined
}

/** Dispatch one raw command line through the real registry. */
async function run(ctx: Context, agent: Agent, line: string) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error('session-link command was not registered')
  return execution
}

describe('dsh-command-session-link', () => {
  it('lists the caller’s links with peer status and wake flags', async () => {
    const { ctx, agent } = await harness()
    const done = await run(ctx, agent, '/session-link')
    expect(done.result.kind).toBe('success')
    expect(done.result.text).toContain('session-link-pair')
    expect(done.result.text).toContain('session-bob')
    expect(done.result.text).toContain('运行中')
    expect(done.result.text).toContain('auto-wake 关')
  })

  it('explains the empty state instead of pretending links exist', async () => {
    const { ctx, agent } = await harness({ links: [] })
    const done = await run(ctx, agent, '/session-link list')
    expect(done.result.kind).toBe('success')
    expect(done.result.text).toContain('不属于任何会话互联组')
  })

  it('turns auto-wake on for a linked peer', async () => {
    const { ctx, agent, links } = await harness()
    const done = await run(ctx, agent, '/session-link wake session-bob on')
    expect(done.result.kind).toBe('success')
    expect(links.wakeChanges.length).toBe(1)
    expect(links.wakeChanges[0]!.autoWake).toEqual([SessionId('session-bob')])
  })

  it('turns auto-wake off for a linked peer', async () => {
    const { ctx, agent, links } = await harness({
      links: [{
        id: SessionLinkId('session-link-pair'),
        name: 'pair',
        memberIds: [SessionId('session-alice'), SessionId('session-bob')],
        autoWakeSessionIds: [SessionId('session-bob')],
        revision: 2,
      }],
    })
    const done = await run(ctx, agent, '/session-link wake session-bob off')
    expect(done.result.kind).toBe('success')
    expect(links.wakeChanges[0]!.autoWake).toEqual([])
  })

  it('refuses wake changes for unlinked or self sessions', async () => {
    const { ctx, agent } = await harness()
    const self = await run(ctx, agent, '/session-link wake session-alice on')
    expect(self.result.kind).toBe('error')
    const stranger = await run(ctx, agent, '/session-link wake session-eve on')
    expect(stranger.result.kind).toBe('error')
    expect(stranger.result.text).toContain('不在同一互联组')
  })

  it('revokes one of the caller’s links by id', async () => {
    const { ctx, agent, links } = await harness()
    const done = await run(ctx, agent, '/session-link revoke session-link-pair')
    expect(done.result.kind).toBe('success')
    expect(links.unlinked).toEqual([SessionLinkId('session-link-pair')])
  })

  it('refuses to revoke a link the caller does not belong to', async () => {
    const { ctx, agent, links } = await harness()
    const done = await run(ctx, agent, '/session-link revoke session-link-other')
    expect(done.result.kind).toBe('error')
    expect(links.unlinked.length).toBe(0)
  })

  it('reports grammar errors with usage instead of guessing', async () => {
    const { ctx, agent } = await harness()
    const done = await run(ctx, agent, '/session-link wake session-bob')
    expect(done.result.kind).toBe('error')
    expect(done.result.text).toContain('Usage')
  })

  it('links an existing ordinary session to the caller with human grant', async () => {
    const { ctx, agent, links } = await harness({ links: [] })
    const done = await run(ctx, agent, '/session-link add session-eve')
    expect(done.result.kind).toBe('success')
    expect(done.result.text).toContain('session-link-new-1')
    expect(links.granted.length).toBe(1)
    expect(links.granted[0]!.memberIds).toEqual([SessionId('session-alice'), SessionId('session-eve')])
    expect(links.granted[0]!.autoWake).toEqual([])
    expect(links.ordinaryTargets).toEqual([SessionId('session-alice'), SessionId('session-eve')])
  })

  it('links with the wake flag enabling auto-wake for the peer', async () => {
    const { ctx, agent, links } = await harness({ links: [] })
    const done = await run(ctx, agent, '/session-link add session-eve wake')
    expect(done.result.kind).toBe('success')
    expect(links.granted[0]!.autoWake).toEqual([SessionId('session-eve')])
  })

  it('refuses to link the caller to itself or an unknown session', async () => {
    const { ctx, agent, links } = await harness({ links: [] })
    const self = await run(ctx, agent, '/session-link add session-alice')
    expect(self.result.kind).toBe('error')
    const missing = await run(ctx, agent, '/session-link add session-ghost')
    expect(missing.result.kind).toBe('error')
    expect(missing.result.text).toContain('找不到会话')
    expect(links.granted.length).toBe(0)
  })

  it('refuses to link a session already linked to the caller', async () => {
    const { ctx, agent, links } = await harness()
    const done = await run(ctx, agent, '/session-link add session-bob')
    expect(done.result.kind).toBe('error')
    expect(done.result.text).toContain('已与本会话互联')
    expect(links.granted.length).toBe(0)
  })

  it('mounts only into Agents bound to a listed preset and follows a later selection', async () => {
    const { ctx, agent, presets } = await harness({ presets: { 'session-alice': 'minimal', 'session-bob': 'standard' } })
    const bob = ctx.agents.get(SessionId('session-bob'))!
    expect(await hasCommand(ctx, agent)).toBe(false)
    expect(await hasCommand(ctx, bob)).toBe(true)
    presets.set('session-alice', 'ptc')
    ctx.emit('agent-preset/selected', agent.id, 'ptc')
    await vi.waitFor(async () => { expect(await hasCommand(ctx, agent)).toBe(true) })
    presets.set('session-bob', 'minimal')
    ctx.emit('agent-preset/selected', bob.id, 'minimal')
    await vi.waitFor(async () => { expect(await hasCommand(ctx, bob)).toBe(false) })
  })

  it('honors a configured preset list', async () => {
    const { ctx, agent } = await harness({
      presets: { 'session-alice': 'custom', 'session-bob': 'standard' },
      config: { presets: ['custom'] },
    })
    expect(await hasCommand(ctx, agent)).toBe(true)
    expect(await hasCommand(ctx, ctx.agents.get(SessionId('session-bob'))!)).toBe(false)
  })

  it('withdraws the command from every Agent when the row unloads', async () => {
    const { ctx, agent, row } = await harness()
    expect(await hasCommand(ctx, agent)).toBe(true)
    await row.dispose()
    expect(await hasCommand(ctx, agent)).toBe(false)
  })

  it('an unavailable scoped service never blocks Agent creation', async () => {
    const { ctx } = await harness()
    mountPerPresetAgent(ctx, ['standard'], 'probe', ['serviceThatDoesNotExist'], () => {})
    const { agent } = stubAgent(ctx, 'session-carol')
    await ctx.agents.register(agent)
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })
})
