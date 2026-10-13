import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  hasInitialModelCapability,
  listInitialModels,
  parseInitialModel,
  validateInitialModel,
} from '../src/initial-model.ts'

function fixture(overrides: Partial<ModelCatalog> = {}) {
  const catalog: ModelCatalog = {
    default: { provider: 'base', model: 'same-id', reasoningEffort: 'high' },
    routableProviders: ['base', 'target'],
    groups: [
      { id: 'base', name: 'Base', models: [{ id: 'same-id', name: 'Base model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] },
      { id: 'target', name: 'Target', models: [
        { id: 'same-id', name: 'Target model', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } },
        { id: 'plain', name: 'Plain' },
      ] },
    ],
    failures: [],
    ...overrides,
  }
  const services: Record<string, unknown> = {
    sessions: { prepare: vi.fn() },
    sessionPersistence: { create: vi.fn(), open: vi.fn(), stat: vi.fn() },
    agentPresets: { resolve: vi.fn() },
  }
  const controller = { modelCatalog: vi.fn(async () => catalog), create: vi.fn(), selectModel: vi.fn() }
  const ctx = { get: (name: string) => services[name], sessionController: controller } as unknown as Context
  return { ctx, catalog, services, controller }
}

describe('initial model parameters', () => {
  it('normalizes strings without inheriting or adding an effort', () => {
    expect(parseInitialModel({ provider: ' target ', model: ' same-id ' })).toEqual({ provider: 'target', model: 'same-id' })
    expect(parseInitialModel({ provider: 'target', model: 'same-id', reasoning_effort: ' low ' }))
      .toEqual({ provider: 'target', model: 'same-id', reasoningEffort: 'low' })
  })

  it.each([
    undefined, null, [], 'target', {},
    { provider: '', model: 'm' }, { provider: 'p', model: ' ' },
    { provider: 1, model: 'm' }, { provider: 'p' },
    { provider: 'p', model: 'm', reasoning_effort: undefined },
    { provider: 'p', model: 'm', reasoning_effort: '' },
    { provider: 'p', model: 'm', reasoningEffort: 'low' },
    { provider: 'p', model: 'm', model_scope: 'session' },
    Object.create({ provider: 'p', model: 'm' }),
  ])('rejects malformed input %j', value => {
    expect(() => parseInitialModel(value)).toThrow('INVALID_MODEL_PARAMETERS')
  })
})

describe('deployment model catalog', () => {
  it('validates the exact route and effort; performs no activation or model mutation', async () => {
    const { ctx, controller, services } = fixture()
    const selected = parseInitialModel({ provider: 'target', model: 'same-id', reasoning_effort: 'low' })
    expect(await validateInitialModel(ctx, selected)).toEqual(selected)
    await expect(validateInitialModel(ctx, { provider: 'target', model: 'same-id', reasoningEffort: 'high' }))
      .rejects.toThrow('MODEL_EFFORT_UNSUPPORTED')
    expect(controller.create).not.toHaveBeenCalled()
    expect(controller.selectModel).not.toHaveBeenCalled()
    expect((services.sessions as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled()
  })

  it('omits effort even when the caller default and selected route have defaults', async () => {
    const { ctx } = fixture()
    expect(await validateInitialModel(ctx, { provider: 'target', model: 'same-id' }))
      .toEqual({ provider: 'target', model: 'same-id' })
  })

  it('rejects missing provider/model and effort on a non-reasoning model', async () => {
    const { ctx } = fixture()
    await expect(validateInitialModel(ctx, { provider: 'unknown', model: 'same-id' })).rejects.toThrow('MODEL_PROVIDER_UNAVAILABLE')
    await expect(validateInitialModel(ctx, { provider: 'target', model: 'unknown' })).rejects.toThrow('MODEL_UNAVAILABLE')
    await expect(validateInitialModel(ctx, { provider: 'target', model: 'plain', reasoningEffort: 'low' }))
      .rejects.toThrow('MODEL_EFFORT_UNSUPPORTED')
  })

  it('keeps failed providers unavailable instead of accepting a stale group', async () => {
    const { ctx } = fixture({ failures: [{ id: 'target', name: 'Target', message: 'catalog authentication failed' }] })
    await expect(validateInitialModel(ctx, { provider: 'target', model: 'same-id' })).rejects.toThrow('MODEL_CATALOG_UNAVAILABLE')
    expect((await listInitialModels(ctx)).failures).toHaveLength(1)
  })

  it('reports metadata failure without reflecting sensitive provider exceptions', async () => {
    const { ctx, controller } = fixture()
    controller.modelCatalog.mockRejectedValue(new Error('secret-auth-detail'))
    await expect(validateInitialModel(ctx, { provider: 'target', model: 'same-id' }))
      .rejects.toThrow('MODEL_CATALOG_UNAVAILABLE: the deployed model catalog could not be loaded')
    await expect(listInitialModels(ctx)).rejects.not.toThrow('secret-auth-detail')
  })

  it('returns the deployment shape and explicit non-execution description', async () => {
    const { ctx, catalog } = fixture()
    const result = await listInitialModels(ctx)
    expect(result).toMatchObject(catalog)
    expect(result.initialModelSelection).toBe(true)
    expect(result.description).toContain('does not guarantee')
    expect(result).not.toHaveProperty('taskHost')
    expect(result).not.toHaveProperty('taskRouting')
    const filtered = await listInitialModels(ctx, { provider: ' target ' })
    expect(filtered.groups.map(group => group.id)).toEqual(['target'])
    expect(filtered.routableProviders).toEqual(['target'])
    expect(filtered.default).toEqual(catalog.default)
  })

  it.each([null, [], { provider: '' }, { provider: 3 }, { taskHost: true }])('rejects invalid directory arguments %j', async params => {
    const { ctx, controller } = fixture()
    await expect(listInitialModels(ctx, params)).rejects.toThrow('INVALID_MODEL_PARAMETERS')
    expect(controller.modelCatalog).not.toHaveBeenCalled()
  })

  it.each(['sessions', 'sessionPersistence', 'agentPresets'])('does not infer bootstrap capability from a catalog without %s', async service => {
    const { ctx, services } = fixture()
    delete services[service]
    expect(hasInitialModelCapability(ctx)).toBe(false)
    expect((await listInitialModels(ctx)).initialModelSelection).toBe(false)
    // Ordinary directory lookup still works when optional bootstrap services are absent.
    expect((await listInitialModels(ctx)).groups).toHaveLength(2)
  })

  it('requires each public bootstrap method and native create', () => {
    const { ctx, services, controller } = fixture()
    services.sessionPersistence = { create: vi.fn() }
    expect(hasInitialModelCapability(ctx)).toBe(false)
    services.sessionPersistence = { create: vi.fn(), open: vi.fn(), stat: vi.fn() }
    controller.create = undefined as unknown as typeof controller.create
    expect(hasInitialModelCapability(ctx)).toBe(false)
  })
})
