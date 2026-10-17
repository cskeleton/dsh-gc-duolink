import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionLinkService, { SESSION_LINK_LEDGER_KEY } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const contexts: Context[] = []
const directories: string[] = []
const caller = SessionId('placement-caller')
const child = SessionId('placement-child')
const callKey = 'placement-call'

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0).reverse()) {
    try { await ctx.fiber.dispose() } catch (error) { failures.push(error) }
  }
  for (const path of directories.splice(0)) {
    try { await rm(path, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'workspace placement cleanup failed')
})

async function fixture(pool = new MemoryMediaPool(), headers = new Map<SessionId, SessionHeader>()) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [...headers.values()].map(header => ({ header })) } as never)
  ctx.provide('sessions', {
    get: (id: SessionId) => headers.has(id) ? { header: headers.get(id) } : undefined,
    list: () => [...headers.values()].map(header => ({ header })),
  } as never)
  ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SessionLinkService)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', change => { changes.push(change) })
  return { ctx, pool, headers, changes, registry: ctx.workspaceRegistry, links: ctx.gcDuolink,
    place: (cwd: string, inherit = false) => ctx.gcDuolink.placeSpawnWorkspace(caller, callKey, cwd, inherit),
    receipt: () => ctx.gcDuolink['ledgers'].get(SESSION_LINK_LEDGER_KEY)!.spawns[`${caller}:${callKey}`]!.workspacePlacement,
  }
}

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'dsh-workspace-placement-'))
  directories.push(path)
  return await realpath(path)
}

function header(id: SessionId, cwd: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, delegationDepth: 0, cwd }
}

async function spawn(f: Awaited<ReturnType<typeof fixture>>, cwd: string, callerCwd = cwd) {
  f.headers.set(caller, header(caller, callerCwd))
  f.headers.set(child, header(child, cwd))
  await f.links.claimSpawnLink(caller, child, callKey, 'peer', false)
}

describe('spawn placement over the real Workspace registry and domain', () => {
  it('explicit unseen directories register and publish a Workspace and its Session membership', async () => {
    const f = await fixture()
    const cwd = await root()
    await spawn(f, cwd)
    expect(f.registry.list()).toEqual([])
    await f.place(cwd)
    const workspace = await f.registry.resolveByPath(cwd)
    expect(workspace?.sessionIds).toEqual([child])
    expect(f.receipt()).toEqual({ workspaceId: workspace!.id, completed: true })
    expect(f.changes.some(change => change.domain === 'workspace' && change.table === 'workspaces'
      && change.operation === 'put' && (change.value as { sessionIds: SessionId[] }).sessionIds.includes(child))).toBe(true)
    await f.place(cwd)
    expect(f.registry.list()).toHaveLength(1)
    expect(workspace?.sessionIds).toEqual([child])
  })

  it('omission inherits the caller membership and keeps both Sessions at the same level', async () => {
    const f = await fixture()
    const cwd = await root()
    await spawn(f, cwd)
    const workspace = await f.registry.create(cwd, 'Human title')
    await workspace.attachSession(caller)
    await f.place(cwd, true)
    expect(workspace.sessionIds).toEqual([child, caller])
    expect(workspace.title).toBe('Human title')
    expect(f.headers.get(child)?.parentSession).toBeUndefined()
    expect(f.registry.list()).toHaveLength(1)
  })

  it('omission preserves Ungrouped even if the same path has an unrelated Workspace', async () => {
    const f = await fixture()
    const cwd = await root()
    await spawn(f, cwd)
    const workspace = await f.registry.create(cwd)
    await f.place(cwd, true)
    expect(workspace.sessionIds).toEqual([])
    expect(f.receipt()).toEqual({ completed: true })
  })

  it('explicit child directories get their own registration, not the caller parent Workspace', async () => {
    const f = await fixture()
    const parent = await root()
    const cwd = join(parent, 'review')
    await mkdir(cwd)
    await spawn(f, cwd, parent)
    const workspace = await f.registry.create(parent)
    await workspace.attachSession(caller)
    await f.place(cwd)
    expect(workspace.sessionIds).toEqual([caller])
    expect((await f.registry.resolveByPath(cwd))?.sessionIds).toEqual([child])
    expect(f.registry.list()).toHaveLength(2)
  })

  it('symlink and dot-segment spellings reuse the existing canonical Workspace', async () => {
    const f = await fixture()
    const parent = await root()
    const cwd = join(parent, 'project')
    await mkdir(cwd)
    const alias = join(parent, 'alias')
    await symlink(cwd, alias)
    const spelled = `${alias}/../alias/.`
    await spawn(f, spelled)
    const workspace = await f.registry.create(cwd, 'Preserved title')
    await f.place(spelled)
    expect(workspace.sessionIds).toEqual([child])
    expect(workspace.title).toBe('Preserved title')
    expect(f.registry.list()).toHaveLength(1)
  })

  it('rejects an actual Session cwd mismatch instead of incorrectly grouping it', async () => {
    const f = await fixture()
    const cwd = await root()
    const other = join(cwd, 'other')
    await mkdir(other)
    await spawn(f, cwd)
    await expect(f.place(other)).rejects.toThrow('its cwd resolves to')
    expect((await f.registry.resolveByPath(other))?.sessionIds).toEqual([])
    expect(f.receipt()?.completed).toBe(false)
  })

  it('recovers a failed completion write across restart without duplicate membership', async () => {
    const f = await fixture()
    const cwd = await root()
    await spawn(f, cwd)
    f.pool.failWritesTo('ledgers', 2)
    await expect(f.place(cwd)).rejects.toThrow('injected write failure')
    const workspaceId = f.receipt()!.workspaceId!
    expect(f.registry.get(workspaceId)?.sessionIds).toEqual([child])
    expect(f.receipt()?.completed).toBe(false)
    await f.ctx.fiber.dispose()
    const restarted = await fixture(f.pool, f.headers)
    await restarted.place(cwd)
    expect(restarted.receipt()).toEqual({ workspaceId, completed: true })
    expect(restarted.registry.get(workspaceId)?.sessionIds).toEqual([child])
  })

  it('does not recreate a recorded Workspace deleted after an attachment failure', async () => {
    const f = await fixture()
    const cwd = await root()
    await spawn(f, cwd)
    const workspace = await f.registry.create(cwd)
    vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('attachment failed'))
    await expect(f.place(cwd)).rejects.toThrow('attachment failed')
    await f.registry.delete(workspace.id)
    await expect(f.place(cwd)).rejects.toThrow('will not be recreated')
    expect(f.registry.list()).toEqual([])
  })

  it.each(['detach', 'delete'] as const)('completed placement respects human %s after restart even before task admission', async action => {
    const f = await fixture()
    const cwd = await root()
    await spawn(f, cwd)
    await f.place(cwd)
    const workspace = f.registry.get(f.receipt()!.workspaceId!)!
    if (action === 'detach') await workspace.detachSession(child)
    else await f.registry.delete(workspace.id)
    await f.ctx.fiber.dispose()
    const restarted = await fixture(f.pool, f.headers)
    await restarted.place(cwd)
    expect(restarted.registry.list().every(candidate => !candidate.sessionIds.includes(child))).toBe(true)
    expect(restarted.registry.list()).toHaveLength(action === 'delete' ? 0 : 1)
  })
})
