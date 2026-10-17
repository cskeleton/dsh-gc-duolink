import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { bootstrapInitialModel, initialModelSpawnDigest, initialModelSpawnFlight, type InitialModelSpawnRequest } from '../src/model-spawn.ts'
import type { InitialModelSpawnRecord } from '../src/spec.ts'

let workspace: string
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'dsh-model-spawn-unit-')) })
afterEach(async () => { await rm(workspace, { recursive: true, force: true }) })
const callerId = SessionId('spawn-test-caller')
const callKey = 'spawn-test-call'

function fixture(failAt?: 'append' | 'flush' | 'close' | 'create' | 'activate') {
  const request: InitialModelSpawnRequest = {
    sessionId: SessionId('spawn-test-child'), cwd: workspace, task: 'a complete task', title: 'Spawn test',
    autoWake: true, wakeCaller: false, selection: { provider: 'proof', model: 'A', reasoningEffort: 'high' },
  }
  const ledger: { record?: InitialModelSpawnRecord } = {}
  const disk: { stored?: { header: SessionHeader; events: SessionEvent[]; inheritedEventCount: number } } = {}
  let consumedFailure = false
  const fail = (stage: string) => {
    if (stage === failAt && !consumedFailure) { consumedFailure = true; throw new Error(`injected ${stage} failure`) }
  }
  let sequence = 0
  const sessions = {
    get: vi.fn(() => undefined as unknown),
    prepare: vi.fn((id: ReturnType<typeof SessionId> | undefined, options: { meta: Partial<SessionHeader> }) => {
      const identity = id ?? SessionId(`detached-${++sequence}`)
      const header = {
        version: SESSION_FORMAT_VERSION, id: identity, createdAt: 1234, cwd: workspace,
        isSeeded: false, delegationDepth: 0, ...options.meta,
      } as SessionHeader
      return Session.create(identity, undefined, header)
    }),
  }
  const append = vi.fn(async (events: readonly SessionEvent[]) => {
    fail('append')
    disk.stored!.events.push(...structuredClone(events))
  })
  const flush = vi.fn(async () => { fail('flush') })
  const close = vi.fn(async () => { fail('close') })
  const handle = () => ({
    header: disk.stored!.header, inheritedEventCount: disk.stored!.inheritedEventCount,
    read: async () => ({ events: structuredClone(disk.stored!.events) }), append, flush, close,
  })
  const persistence = {
    stat: vi.fn(async () => disk.stored?.header),
    create: vi.fn(async (header: SessionHeader) => {
      fail('create')
      if (disk.stored) throw new Error('exclusive create collision')
      disk.stored = { header: structuredClone(header), events: [], inheritedEventCount: 0 }
      return handle()
    }),
    open: vi.fn(async () => {
      if (!disk.stored) throw new Error('missing Session')
      return handle()
    }),
  }
  const controller = {
    create: vi.fn(async () => { fail('activate'); return { sessionId: request.sessionId } }),
    submit: vi.fn(), selectModel: vi.fn(),
  }
  const agents = { get: vi.fn(() => undefined as unknown) }
  const gcDuolink = {
    initialModelSpawn: vi.fn(() => ledger.record && structuredClone(ledger.record)),
    reserveInitialModelSpawn: vi.fn(async (_caller: unknown, _key: unknown, intent: InitialModelSpawnRecord) => {
      if (ledger.record && ledger.record.digest !== intent.digest) throw new Error('INITIAL_MODEL_REPLAY_CONFLICT')
      ledger.record ??= structuredClone(intent)
      return structuredClone(ledger.record)
    }),
    confirmInitialModelSpawn: vi.fn(async (_caller: unknown, _key: unknown, digest: string, fact: 'headerCreated' | 'seedConfirmed') => {
      if (ledger.record?.digest !== digest) throw new Error('INITIAL_MODEL_REPLAY_CONFLICT')
      ledger.record[fact] = true
    }),
    spawnReplay: vi.fn(() => undefined),
    list: vi.fn(() => []),
    assertOrdinaryTarget: vi.fn(),
  }
  const services: Record<string, unknown> = {
    sessions, sessionPersistence: persistence, agentPresets: { resolve: vi.fn(async () => ({ id: 'standard' })) },
  }
  const ctx = { ...services, get: (name: string) => services[name], sessionController: controller, agents, gcDuolink } as unknown as Context
  const prime = (headerCreated: boolean, seedConfirmed = false) => {
    ledger.record = {
      ...request, digest: initialModelSpawnDigest(request), preset: 'standard', createdAt: 1234,
      headerCreated, seedConfirmed,
    }
    const header = sessions.prepare(request.sessionId, { meta: {
      cwd: request.cwd, agentPreset: 'standard', createdAt: 1234, isSeeded: false, delegationDepth: 0,
    } }).header
    disk.stored = { header, events: [], inheritedEventCount: 0 }
    if (seedConfirmed) {
      const detached = Session.create(request.sessionId, undefined, header)
      detached.append('model/selection', request.selection)
      disk.stored.events = [...detached.snapshotEvents()]
    }
  }
  const run = (value = request) => bootstrapInitialModel(ctx, callerId, callKey, value)
  return { ctx, request, ledger, disk, sessions, agents, persistence, controller, gcDuolink, services, append, flush, close, prime, run }
}

describe('native initial model bootstrap failures and ownership', () => {
  it('distinguishes inherited Workspace semantics while preserving old explicit-directory digests', async () => {
    const f = fixture()
    const explicit = initialModelSpawnDigest(f.request)
    expect(initialModelSpawnDigest({ ...f.request, inheritWorkspace: false })).toBe(explicit)
    expect(initialModelSpawnDigest({ ...f.request, inheritWorkspace: true })).not.toBe(explicit)
    await f.run()
    await expect(f.run({ ...f.request, inheritWorkspace: true })).rejects.toThrow('INITIAL_MODEL_REPLAY_CONFLICT')
  })
  it('an already aborted request neither reserves an intent nor creates or activates a Session', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before spawn'))
    await expect(bootstrapInitialModel(f.ctx, callerId, callKey, f.request, controller.signal))
      .rejects.toThrow('cancelled before spawn')
    expect(f.gcDuolink.reserveInitialModelSpawn).not.toHaveBeenCalled()
    expect(f.persistence.create).not.toHaveBeenCalled()
    expect(f.sessions.prepare).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(f.controller.submit).not.toHaveBeenCalled()
  })

  it('passes cancellation to append and retains a durable seed without activation if cancelled after flush', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.flush.mockImplementationOnce(async () => { controller.abort(new Error('cancelled after flush')) })
    await expect(bootstrapInitialModel(f.ctx, callerId, callKey, f.request, controller.signal))
      .rejects.toThrow(/INITIAL_MODEL_SPAWN_FAILED \(activate\).*cancelled after flush/)
    expect(f.append).toHaveBeenCalledWith(expect.any(Array), { signal: controller.signal })
    expect(f.ledger.record?.seedConfirmed).toBe(true)
    expect(f.disk.stored?.events).toHaveLength(1)
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(f.controller.submit).not.toHaveBeenCalled()
  })

  it.each(['create', 'append', 'flush', 'close'] as const)('%s failure never activates or sends a task and can recover without duplicate seed', async fault => {
    const f = fixture(fault)
    await expect(f.run()).rejects.toThrow(`injected ${fault} failure`)
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(f.controller.submit).not.toHaveBeenCalled()
    expect(f.ledger.record?.seedConfirmed).toBe(false)
    await expect(f.run()).resolves.toMatchObject({ headerCreated: true, seedConfirmed: true })
    expect(f.disk.stored?.events).toHaveLength(1)
    expect(f.disk.stored?.events[0]).toMatchObject({ type: 'model/selection', data: f.request.selection })
    expect(f.controller.create).toHaveBeenCalledTimes(1)
    expect(f.controller.submit).not.toHaveBeenCalled()
  })

  it('native controller create failure retains confirmed seed and does not dispatch; retry does not append', async () => {
    const f = fixture('activate')
    await expect(f.run()).rejects.toThrow(/INITIAL_MODEL_SPAWN_FAILED \(activate\).*taskStored=false.*taskDelivery=not-dispatched/)
    expect(f.ledger.record?.seedConfirmed).toBe(true)
    const events = structuredClone(f.disk.stored?.events)
    await f.run()
    expect(f.append).toHaveBeenCalledTimes(1)
    expect(f.disk.stored?.events).toEqual(events)
    expect(f.controller.submit).not.toHaveBeenCalled()
  })

  it('replay failure reports an earlier accepted task instead of denying delivery', async () => {
    const f = fixture()
    f.prime(true, true)
    f.disk.stored!.events = []
    f.gcDuolink.spawnReplay.mockReturnValue({ task: { status: 'accepted' } } as never)
    f.gcDuolink.list.mockReturnValue([{ memberIds: [f.request.sessionId] }] as never)
    await expect(f.run()).rejects.toThrow(/linked=true.*taskStored=true.*taskDelivery=accepted/)
    expect(f.controller.create).not.toHaveBeenCalled()
  })

  it('a spawn intent without an actual group is reported as unlinked', async () => {
    const f = fixture('activate')
    f.gcDuolink.spawnReplay.mockReturnValue({ sessionId: f.request.sessionId } as never)
    await expect(f.run()).rejects.toThrow(/linked=false.*taskStored=false/)
  })

  it('confirmed receipt replay does not resolve or restore the original preset', async () => {
    const f = fixture()
    f.prime(true, true)
    const detached = Session.create(f.request.sessionId, undefined, f.disk.stored!.header)
    detached.append('model/selection', f.request.selection)
    detached.append('agent-preset/selected', { agentPreset: 'later-preset' } as never)
    f.disk.stored!.events = [...detached.snapshotEvents()]
    f.gcDuolink.spawnReplay.mockReturnValue({ task: { status: 'accepted' } } as never)
    const resolve = (f.services.agentPresets as { resolve: ReturnType<typeof vi.fn> }).resolve
    resolve.mockRejectedValue(new Error('original preset removed'))
    await f.run()
    expect(resolve).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(f.disk.stored!.events.at(-1)?.data).toEqual({ agentPreset: 'later-preset' })
  })

  it('a missing preset during partial recovery reports the existing Session and no task', async () => {
    const f = fixture()
    f.prime(true)
    const resolve = (f.services.agentPresets as { resolve: ReturnType<typeof vi.fn> }).resolve
    resolve.mockRejectedValue(new Error('preset unavailable'))
    await expect(f.run()).rejects.toThrow(/INITIAL_MODEL_SPAWN_FAILED \(preset\).*sessionExists=yes.*taskStored=false/)
    expect(f.persistence.create).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
  })

  it('existing ID without confirmed plugin ownership is never opened for repair or activated', async () => {
    const f = fixture()
    f.prime(false)
    await expect(f.run()).rejects.toThrow(/existing ID has no confirmed plugin ownership.*empty orphan Session.*human inspection/)
    expect(f.persistence.open).not.toHaveBeenCalled()
    expect(f.persistence.create).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
  })

  it('only an owned empty Session can receive a missing seed', async () => {
    const f = fixture()
    f.prime(true)
    await f.run()
    expect(f.persistence.create).not.toHaveBeenCalled()
    expect(f.persistence.open).toHaveBeenCalledWith(f.request.sessionId, 'write')
    expect(f.append).toHaveBeenCalledTimes(1)
    expect(f.ledger.record?.seedConfirmed).toBe(true)
  })

  it.each(['unknown-event', 'later-selection', 'different-header', 'inherited-events', 'live-agent', 'live-session'] as const)('rejects unconfirmed %s without writing or activating', async state => {
    const f = fixture()
    f.prime(true)
    if (state === 'unknown-event') f.disk.stored!.events.push({ type: 'extension/unknown', seq: 0, time: 1234, data: {} } as unknown as SessionEvent)
    if (state === 'later-selection') {
      const detached = Session.create(f.request.sessionId, undefined, f.disk.stored!.header)
      detached.append('model/selection', f.request.selection)
      detached.append('model/selection', { provider: 'proof', model: 'C' })
      f.disk.stored!.events = [...detached.snapshotEvents()]
    }
    if (state === 'different-header') f.disk.stored!.header = { ...f.disk.stored!.header, cwd: join(workspace, 'other') }
    if (state === 'inherited-events') f.disk.stored!.inheritedEventCount = 1
    if (state === 'live-agent') f.agents.get.mockReturnValue({})
    if (state === 'live-session') f.sessions.get.mockReturnValue({})
    const before = structuredClone(f.disk.stored)
    await expect(f.run()).rejects.toThrow('INITIAL_MODEL_SESSION_CONFLICT')
    expect(f.disk.stored).toEqual(before)
    expect(f.append).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(f.controller.submit).not.toHaveBeenCalled()
  })

  it('confirmed replay preserves later human C selection even when the Session is live', async () => {
    const f = fixture()
    f.prime(true, true)
    const detached = Session.create(f.request.sessionId, f.disk.stored!.events, f.disk.stored!.header)
    detached.append('model/selection', { provider: 'proof', model: 'C', reasoningEffort: 'low' })
    f.disk.stored!.events = [...detached.snapshotEvents()]
    f.agents.get.mockReturnValue({})
    f.sessions.get.mockReturnValue(detached)
    const before = structuredClone(f.disk.stored!.events)
    await f.run()
    expect(f.disk.stored!.events).toEqual(before)
    expect(f.persistence.open).toHaveBeenCalledWith(f.request.sessionId, 'read')
    expect(f.append).not.toHaveBeenCalled()
    expect(f.controller.selectModel).not.toHaveBeenCalled()
  })

  it('unmounted capability rejects before reserving an intent or creating a Session', async () => {
    const f = fixture()
    delete f.services.sessionPersistence
    await expect(f.run()).rejects.toThrow('INITIAL_MODEL_CAPABILITY_UNAVAILABLE')
    expect(f.gcDuolink.reserveInitialModelSpawn).not.toHaveBeenCalled()
    expect(f.sessions.prepare).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
  })

  it('changed replay payload is rejected before repairing the old owned Session', async () => {
    const f = fixture()
    f.prime(true)
    await expect(f.run({ ...f.request, autoWake: false })).rejects.toThrow('INITIAL_MODEL_REPLAY_CONFLICT')
    expect(f.persistence.open).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
  })
})

describe('spawn payload digest and single flight', () => {
  it('hashes the full task suffix and each independent wake grant', () => {
    const { request } = fixture()
    const task = 'same prefix '.repeat(1000)
    const a = { ...request, task: `${task} A` }
    expect(initialModelSpawnDigest(a)).toBe(initialModelSpawnDigest({ ...a, selection: { ...a.selection } }))
    for (const changed of [
      { ...a, task: `${task} B` }, { ...a, autoWake: false }, { ...a, wakeCaller: true },
      { ...a, selection: { ...a.selection, reasoningEffort: 'low' } },
    ]) expect(initialModelSpawnDigest(changed)).not.toBe(initialModelSpawnDigest(a))
  })

  it('runs same-key same-digest callers once and rejects a concurrent different digest', async () => {
    const owner = {}
    let release!: (result: string) => void
    const gate = new Promise<string>(resolve => { release = resolve })
    const operation = vi.fn(() => gate)
    const first = initialModelSpawnFlight(owner, 'key', 'digest-A', operation)
    const second = initialModelSpawnFlight(owner, 'key', 'digest-A', operation)
    await expect(initialModelSpawnFlight(owner, 'key', 'digest-B', operation)).rejects.toThrow('SPAWN_REPLAY_CONFLICT')
    expect(operation).toHaveBeenCalledTimes(1)
    release('shared result')
    expect(await Promise.all([first, second])).toEqual(['shared result', 'shared result'])
    await expect(initialModelSpawnFlight(owner, 'key', 'digest-B', async () => 'later retry')).resolves.toBe('later retry')
  })

  it('releases a failed flight so a corrected operation can retry', async () => {
    const owner = {}
    await expect(initialModelSpawnFlight(owner, 'key', 'digest', async () => { throw new Error('temporary failure') })).rejects.toThrow('temporary failure')
    await expect(initialModelSpawnFlight(owner, 'key', 'digest', async () => 'recovered')).resolves.toBe('recovered')
  })
})
