/** Initialize a new Session once, then hand every runtime decision to the native controller. */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, type SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { InitialModelSpawnRecord } from './spec.ts'
import { hasInitialModelCapability, type InitialModelSelection } from './initial-model.ts'

export interface InitialModelSpawnRequest {
  sessionId: SessionId
  cwd: string
  task: string
  title: string
  autoWake: boolean
  wakeCaller: boolean
  selection: InitialModelSelection
}

/** Full normalized payload, never a prefix of the task or model name. */
export function initialModelSpawnDigest(request: InitialModelSpawnRequest): string {
  return createHash('sha256').update(JSON.stringify([
    'initial-model-spawn-v1', request.sessionId, request.cwd, request.task, request.title,
    request.autoWake, request.wakeCaller, request.selection.provider, request.selection.model,
    request.selection.reasoningEffort ?? null,
  ])).digest('hex')
}

const flights = new WeakMap<object, Map<string, { digest: string; run: Promise<unknown> }>>()

/** Entire spawn runs once per key, outside the global mailbox chain. */
export async function initialModelSpawnFlight<T>(owner: object, key: string, digest: string, operation: () => Promise<T>): Promise<T> {
  let map = flights.get(owner)
  if (map === undefined) { map = new Map(); flights.set(owner, map) }
  const prior = map.get(key)
  if (prior !== undefined) {
    if (prior.digest !== digest) throw new Error('SPAWN_REPLAY_CONFLICT: an in-flight spawn has different parameters, including its initial_model mode')
    return await prior.run as T
  }
  const run = Promise.resolve().then(operation)
  map.set(key, { digest, run })
  try { return await run }
  finally { map.delete(key) }
}

function sameSelection(left: unknown, right: InitialModelSelection): boolean {
  if (left === null || typeof left !== 'object') return false
  const value = left as InitialModelSelection
  return value.provider === right.provider && value.model === right.model && value.reasoningEffort === right.reasoningEffort
}

function sameHeader(left: SessionHeader, right: SessionHeader): boolean {
  const a = left as unknown as Record<string, unknown>
  const b = right as unknown as Record<string, unknown>
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => a[key] === b[key])
}

async function readSeed(ctx: Context, record: InitialModelSpawnRecord, expected: SessionHeader, onlySeed: boolean): Promise<void> {
  const handle = await ctx.get('sessionPersistence')!.open(record.sessionId, 'read')
  try {
    if (!sameHeader(handle.header, expected) || handle.inheritedEventCount !== 0) throw new Error('INITIAL_MODEL_SESSION_CONFLICT: stored Session identity does not match this creation intent')
    ctx.sessionLinks.assertOrdinaryTarget(record.sessionId, handle.header)
    const { events } = await handle.read()
    if (events[0]?.type !== 'model/selection' || !sameSelection(events[0].data, record.selection)) throw new Error('INITIAL_MODEL_SEED_UNCONFIRMED: initial selection is missing or mismatched')
    if (onlySeed && (events.length !== 1 || ctx.agents.get(record.sessionId) !== undefined || ctx.sessions.get(record.sessionId) !== undefined)) {
      throw new Error('INITIAL_MODEL_SESSION_CONFLICT: an unconfirmed Session was already activated or changed')
    }
  } finally { await handle.close() }
}

async function bootstrapFailure(ctx: Context, sessionId: SessionId, callerId: SessionId, callKey: string, stage: string, error: unknown): Promise<never> {
  const state = await ctx.get('sessionPersistence')!.stat(sessionId).catch(() => undefined)
  const priorDelivery = ctx.sessionLinks.spawnReplay(callerId, callKey)?.task
  const linked = ctx.sessionLinks.list(callerId).some(link => link.memberIds.includes(sessionId))
  throw new Error(`INITIAL_MODEL_SPAWN_FAILED (${stage}): sessionId=${sessionId}, sessionExists=${state === undefined ? 'unknown-or-no' : 'yes'}, linked=${linked}, taskStored=${priorDelivery !== undefined}, taskDelivery=${priorDelivery?.status ?? 'not-dispatched'}. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

/** Public prepare/append/persistence/create only. Failures retain data and never send a task. */
export async function bootstrapInitialModel(ctx: Context, callerId: SessionId, callKey: string, request: InitialModelSpawnRequest, signal?: AbortSignal): Promise<InitialModelSpawnRecord> {
  signal?.throwIfAborted()
  if (!hasInitialModelCapability(ctx)) throw new Error('INITIAL_MODEL_CAPABILITY_UNAVAILABLE: public native bootstrap services are not mounted; no Session or task was created')
  const digest = initialModelSpawnDigest(request)
  const prior = ctx.sessionLinks.initialModelSpawn(callerId, callKey)
  let preset = prior?.preset
  if (prior?.seedConfirmed !== true) {
    try {
      const resolved = await ctx.get('agentPresets')!.resolve(preset)
      if (resolved.broken !== undefined) throw new Error(`INITIAL_MODEL_PRESET_UNAVAILABLE: preset ${resolved.id} is unavailable`)
      preset = resolved.id
    } catch (error) {
      if (prior === undefined) throw error
      return await bootstrapFailure(ctx, prior.sessionId, callerId, callKey, 'preset', error)
    }
  }
  const record = await ctx.sessionLinks.reserveInitialModelSpawn(callerId, callKey, {
    sessionId: request.sessionId, cwd: request.cwd, digest, preset: preset!, title: request.title,
    autoWake: request.autoWake, wakeCaller: request.wakeCaller, selection: request.selection,
    createdAt: prior?.createdAt ?? Date.now(), headerCreated: false, seedConfirmed: false,
  })
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: record.sessionId, cwd: record.cwd, agentPreset: record.preset,
    createdAt: record.createdAt, isSeeded: false, delegationDepth: 0,
  }
  ctx.sessionLinks.assertOrdinaryTarget(record.sessionId, header)
  const replay = ctx.sessionLinks.spawnReplay(callerId, callKey)
  if (replay?.removed) throw new Error(`INITIAL_MODEL_LINK_REVOKED: session ${record.sessionId} was unlinked; replay will not restore it`)
  let stage = 'seed'
  try {
    if (record.seedConfirmed) {
      // Verify only the original fact. Human model selections and later request headers are retained.
      await readSeed(ctx, record, header, false)
    } else {
      if (ctx.agents.get(record.sessionId) !== undefined || ctx.sessions.get(record.sessionId) !== undefined) throw new Error('INITIAL_MODEL_SESSION_CONFLICT: unconfirmed Session is live')
      signal?.throwIfAborted()
      await mkdir(record.cwd, { recursive: true })
      const existing = await ctx.get('sessionPersistence')!.stat(record.sessionId)
      if (existing !== undefined && !record.headerCreated) throw new Error('INITIAL_MODEL_SESSION_CONFLICT: existing ID has no confirmed plugin ownership; no repair or activation attempted. A crash between Session creation and ownership confirmation can leave an empty orphan Session. Preserve it for human inspection; this call will not overwrite or remove it')
      const handle = existing === undefined
        ? await ctx.get('sessionPersistence')!.create(header)
        : await ctx.get('sessionPersistence')!.open(record.sessionId, 'write')
      try {
        if (!sameHeader(handle.header, header) || handle.inheritedEventCount !== 0) throw new Error('INITIAL_MODEL_SESSION_CONFLICT: stored identity differs')
        if (!record.headerCreated) await ctx.sessionLinks.confirmInitialModelSpawn(callerId, callKey, digest, 'headerCreated')
        const { events } = await handle.read()
        if (events.length === 0) {
          const detached = ctx.sessions.prepare(record.sessionId, { meta: header })
          detached.append('model/selection', record.selection)
          await handle.append(detached.snapshotEvents(), { signal })
        } else if (events.length !== 1 || events[0]?.type !== 'model/selection' || !sameSelection(events[0].data, record.selection)) {
          throw new Error('INITIAL_MODEL_SESSION_CONFLICT: unconfirmed Session contains other events; no repair attempted')
        }
        stage = 'flush'
        await handle.flush()
        stage = 'close'
      } finally { await handle.close() }
      stage = 'verify'
      await readSeed(ctx, record, header, true)
      await ctx.sessionLinks.confirmInitialModelSpawn(callerId, callKey, digest, 'seedConfirmed')
    }
    stage = 'activate'
    signal?.throwIfAborted()
    // A delivered/queued receipt replays through the original send recovery path.
    if (ctx.sessionLinks.spawnReplay(callerId, callKey)?.task !== undefined) return { ...record, headerCreated: true, seedConfirmed: true }
    // The native observation owns any later preset selection, just as it owns model selection.
    const created = await ctx.sessionController.create({ sessionId: record.sessionId, cwd: record.cwd })
    if (created.sessionId !== record.sessionId) throw new Error('INITIAL_MODEL_SESSION_CONFLICT: native controller returned another identity')
    return { ...record, headerCreated: true, seedConfirmed: true }
  } catch (error) {
    return await bootstrapFailure(ctx, record.sessionId, callerId, callKey, stage, error)
  }
}
