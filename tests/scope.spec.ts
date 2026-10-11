/** Preset-scoped registration without the unpublished Harness testkit. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountPerPresetAgent, PresetScopeConfig, resolvePresets } from '../src/scope.ts'

// The scope module only needs this ownership predicate from the delivery service.
// Keep storage, decorators and Host service composition out of these unit tests.
vi.mock('../src/link.ts', () => ({
  subagentOwned: (_ctx: unknown, _id: unknown, header: { child?: boolean }) => header.child === true,
}))

function fixture(defaultId = 'coding', registryPresent = true) {
  type FakeAgent = ReturnType<typeof makeAgent>
  const agents = new Map<string, FakeAgent>()
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const effects: Array<() => void> = []
  const registry = {
    defaultId,
    composedPreset: (ctx: { preset?: string }) => ctx.preset,
  }
  const ctx = {
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    get: (name: string) => name === 'agentPresets' && registryPresent ? registry : undefined,
    on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler) },
    effect: (effect: () => () => void) => { effects.push(effect()) },
    logger: { warn: vi.fn() },
  }
  function makeAgent(id: string, preset?: string, child = false) {
    const dispose = vi.fn(async () => {})
    const scope = {
      preset,
      plugin: vi.fn((_definition: unknown) => ({ await: async () => {}, dispose })),
    }
    return { id, ctx: scope, session: { header: { child } }, dispose }
  }
  function add(id: string, preset?: string, child = false) {
    const agent = makeAgent(id, preset, child)
    agents.set(id, agent)
    return agent
  }
  function mount(config: PresetScopeConfig = {}) {
    mountPerPresetAgent(ctx as unknown as Context, resolvePresets(config), 'scope-test', ['tools'], () => {})
  }
  async function emit(name: string, ...args: unknown[]) {
    await handlers.get(name)?.(...args)
  }
  return { add, mount, emit, registry, agents, handlers, effects, ctx }
}

describe('preset scope configuration', () => {
  it('preserves omission as automatic mode through Loader schema resolution', () => {
    expect(resolvePresets()).toBeUndefined()
    expect(resolvePresets(PresetScopeConfig({}))).toBeUndefined()
  })

  it('preserves explicit lists including an empty list', () => {
    expect(resolvePresets({ presets: [] })).toEqual([])
    expect(resolvePresets({ presets: ['custom'] })).toEqual(['custom'])
    expect(resolvePresets(PresetScopeConfig({ presets: [] }))).toEqual([])
  })
})

describe('preset scope mounting', () => {
  it('automatically includes standard presets and the registry effective default only', () => {
    const f = fixture()
    const included = ['standard', 'ptc', 'cordis', 'coding'].map(id => f.add(id, id))
    const excluded = ['minimal', 'other'].map(id => f.add(id, id))
    const unbound = f.add('unbound')
    f.mount()
    for (const agent of included) expect(agent.ctx.plugin).toHaveBeenCalledOnce()
    for (const agent of [...excluded, unbound]) expect(agent.ctx.plugin).not.toHaveBeenCalled()
  })

  it('never enables minimal even when it is default or explicitly listed', () => {
    for (const config of [{}, { presets: ['minimal'] }]) {
      const f = fixture('minimal')
      const agent = f.add('minimal-agent', 'minimal')
      f.mount(config)
      expect(agent.ctx.plugin).not.toHaveBeenCalled()
    }
  })

  it('does not extend an explicit whitelist with the default or standard presets', () => {
    const f = fixture()
    const custom = f.add('custom', 'custom')
    const coding = f.add('coding', 'coding')
    const standard = f.add('standard', 'standard')
    f.mount({ presets: ['custom'] })
    expect(custom.ctx.plugin).toHaveBeenCalledOnce()
    expect(coding.ctx.plugin).not.toHaveBeenCalled()
    expect(standard.ctx.plugin).not.toHaveBeenCalled()
  })

  it('an explicit empty list disables all contributions', () => {
    const f = fixture()
    const agent = f.add('coding', 'coding')
    f.mount({ presets: [] })
    expect(agent.ctx.plugin).not.toHaveBeenCalled()
  })

  it('registers only the actual Host lifecycle events and follows preset switches', async () => {
    const f = fixture()
    f.mount()
    expect([...f.handlers.keys()]).toEqual(['agent/created', 'agent-preset/selected', 'agent/disposed'])
    const agent = f.add('session', 'coding')
    await f.emit('agent/created', { agent })
    expect(agent.ctx.plugin).toHaveBeenCalledOnce()
    await f.emit('agent-preset/selected', agent.id)
    expect(agent.ctx.plugin).toHaveBeenCalledOnce()
    agent.ctx.preset = 'minimal'
    await f.emit('agent-preset/selected', agent.id)
    expect(agent.dispose).toHaveBeenCalledOnce()
    agent.ctx.preset = 'standard'
    await f.emit('agent-preset/selected', agent.id)
    expect(agent.ctx.plugin).toHaveBeenCalledTimes(2)
  })

  it('reads the current effective default when a new agent or selection is evaluated', async () => {
    const f = fixture('coding')
    const existing = f.add('old', 'coding')
    f.mount()
    f.registry.defaultId = 'custom'
    const created = f.add('new', 'custom')
    await f.emit('agent/created', { agent: created })
    expect(created.ctx.plugin).toHaveBeenCalledOnce()
    // No invented default-change event: existing agents are reconciled on selection.
    expect(existing.dispose).not.toHaveBeenCalled()
    await f.emit('agent-preset/selected', existing.id)
    expect(existing.dispose).toHaveBeenCalledOnce()
  })

  it('excludes child-owned and stale agent objects', async () => {
    const f = fixture()
    const child = f.add('child', 'coding', true)
    const stale = f.add('stale', 'coding')
    f.agents.delete(stale.id)
    f.mount()
    await f.emit('agent/created', { agent: stale as unknown as Agent })
    expect(child.ctx.plugin).not.toHaveBeenCalled()
    expect(stale.ctx.plugin).not.toHaveBeenCalled()
  })

  it('retains the headless fallback only in automatic mode', () => {
    for (const config of [{}, { presets: [] }, { presets: ['coding'] }]) {
      const f = fixture('coding', false)
      const agent = f.add('session')
      const child = f.add('child', undefined, true)
      f.mount(config)
      expect(agent.ctx.plugin).toHaveBeenCalledTimes('presets' in config ? 0 : 1)
      expect(child.ctx.plugin).not.toHaveBeenCalled()
    }
  })

  it('disposes owned registrations on unload but does not dispose an already removed agent twice', async () => {
    const f = fixture()
    const retained = f.add('retained', 'coding')
    const removed = f.add('removed', 'coding')
    f.mount()
    await f.emit('agent/disposed', { agent: removed })
    for (const effect of f.effects) effect()
    expect(retained.dispose).toHaveBeenCalledOnce()
    expect(removed.dispose).not.toHaveBeenCalled()
  })
})
