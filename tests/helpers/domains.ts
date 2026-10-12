/**
 * Shared cross-stack backend moves for Task-5 suites: an AgentLoop test stack's
 * storage backends (session-link mailbox domain + session-link tasks domain)
 * can migrate onto a pristine Context by carrying their SHARED
 * `MemoryMediaPool`s, so a "restart" reopens the same durable media on a fresh
 * host. The per-stack wiring still lives in each suite (spawned-Session pool
 * adoption differs per suite).
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  installModelSelectionProjection,
  installTaskTurnIntentsProjection,
} from '@deepseek-ai/dsh-api-session-controller'
import SessionLinkService from '../../src/index.ts'
import * as toolPlugin from '../../src/tools.ts'
import * as tasksPlugin from '../../src/service-tasks.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './memory-backend.ts'
import { MockAdapter } from './mock-adapter.ts'

/** Pools one host's storage backends share; moving them simulates a restart. */
export interface BackendPools {
  readonly links: MemoryMediaPool
  readonly tasks: MemoryMediaPool
}

/**
 * The carry-all-services test stack Task-5 cross-context suites boot: two live
 * Agents over per-domain pooled backends, the link + task services, the tool
 * row, and the host projections/extension. Spawned Sessions adopt `bob`/`carol`
 * in pool order like the other e2e suites.
 */
export async function bootStack(
  contexts: Set<Context>,
  pools: BackendPools,
  options: {
    adapter?: MockAdapter
    links?: Record<string, number>
    modelCatalog?: () => Promise<unknown>
    archived?: readonly SessionId[]
    sessionIds?: { alice?: SessionId; bob?: SessionId; carol?: SessionId }
    /** Skip mounting the tool row (suites that control admission/pump manually). */
    noToolRow?: boolean
  } = {},
): Promise<{
  ctx: Context
  alice: Agent
  bob: Agent
  carol: Agent
  creates: readonly { cwd?: string; sessionId?: SessionId }[]
}> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('links-memory', new MemoryStorageBackend(pools.links))
  ctx.storage.backend.register('tasks-memory', new MemoryStorageBackend(pools.tasks))
  const linksFacility = new DomainFacility(ctx, { backend: 'links-memory', routes: {} })
  ctx.storage.mount('links', linksFacility)
  const tasksFacility = new DomainFacility(ctx, { backend: 'tasks-memory', routes: {} })
  ctx.storage.mount('tasks', tasksFacility)
  ctx.provide('storageDomain', {
    open: (spec: { name: string }) =>
      (spec.name === 'session_link' ? linksFacility : tasksFacility).open(spec as never),
  } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds: options.archived ?? [] } as never)
  installModelSelectionProjection(ctx)
  installTaskTurnIntentsProjection(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], options.adapter ?? new MockAdapter([]))
  await ctx.plugin(SessionLinkService, options.links ?? {})
  // R01: the task service mounts the production way (raw-loader sub-plugin +
  // cordis inject); the test escape hatch is gone.
  await ctx.plugin(tasksPlugin)
  const aliceId = options.sessionIds?.alice ?? SessionId('session-alice')
  const bobId = options.sessionIds?.bob ?? SessionId('session-bob')
  const carolId = options.sessionIds?.carol ?? SessionId('session-carol')
  const base = { provider: 'mock', model: 'base-model' }
  const alice = await ctx.agentLoop.create(aliceId, base)
  const bob = await ctx.agentLoop.create(bobId, base)
  const carol = await ctx.agentLoop.create(carolId, base)
  ctx.provide('sessionTitle', {
    get: (session: { id: SessionId }) => ({ title: `title-of-${session.id}` }),
  } as never)
  const pool = [bobId, carolId]
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
    rename: () => Promise.resolve({}),
    modelCatalog: options.modelCatalog ?? defaultCatalog,
  } as never)
  if (options.noToolRow !== true) await ctx.plugin(toolPlugin)
  return { ctx, alice, bob, carol, creates }
}

/** The deployment catalog the mock Session Controller reports by default. */
export function defaultCatalog(): Promise<unknown> {
  return Promise.resolve({
    default: { provider: 'mock', model: 'base-model' },
    routableProviders: ['mock'],
    groups: [{
      id: 'mock',
      name: 'Mock',
      models: ['base-model', 'model-a', 'model-b'].map(id => ({ id })),
    }],
    failures: [],
  })
}
