/**
 * Pure suite for the Session Link model-routing protocol (MODEL_ROUTING_PLAN
 * Task 2): parameter schema strictness, candidate normalization, catalog
 * failure classification, effort validation per target route, session_default
 * late-binding handling, and the discovery projection. No real model
 * requests, no Session mutation, no DSH_SOURCE_ROOT; the catalog reader is
 * mocked in-process.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_UNAVAILABLE,
  checkCandidateRoutes,
  EFFORT_UNSUPPORTED,
  IF_EXHAUSTED_NOTIFY_SENDER,
  MAX_CANDIDATE_ATTEMPTS,
  MAX_CANDIDATE_FALLBACKS,
  MODEL_NOT_FOUND,
  MODEL_PARAMS_INVALID,
  modelRoutingParamsSchema,
  ModelRoutingError,
  normalizeModelRoutingParams,
  parseModelRoutingParams,
  projectModelCatalog,
  PROVIDER_NOT_FOUND,
  readModelCatalog,
  SessionListModelsParamsError,
  validateCandidateAgainstCatalog,
} from '../src/model-policy.ts'
import type {
  ModelCatalogLike,
  ModelRoutingParams,
  ModelRoutingPolicy,
} from '../src/model-policy.ts'

/** Catalog fixture: two healthy providers, one provider-level query failure. */
function catalog(): ModelCatalogLike {
  return {
    default: { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'medium' },
    routableProviders: ['deepseek-account', 'openai'],
    groups: [
      {
        id: 'deepseek-account',
        name: 'DeepSeek Account',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'medium',
          } },
        ],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-5', reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } },
        ],
      },
    ],
    failures: [{ id: 'anthropic', name: 'Anthropic', message: 'credentials not configured' }],
  }
}

/** Validated parameters helper: runs the same schema the tool will run. */
function params(input: Record<string, unknown>): ModelRoutingParams {
  const parsed = modelRoutingParamsSchema.safeParse(input)
  if (!parsed.success) throw new Error(`fixture invalid: ${parsed.error.message}`)
  return parsed.data
}

function policy(input: Record<string, unknown>): ModelRoutingPolicy {
  return normalizeModelRoutingParams(params(input))
}

describe('model-policy parameter schema', () => {
  it('rejects a half pair: provider without model and model without provider', () => {
    expect(modelRoutingParamsSchema.safeParse({ provider: 'deepseek-account' }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({ model: 'deepseek-chat' }).success).toBe(false)
  })

  it('rejects an orphan reasoning_effort with no primary route', () => {
    expect(modelRoutingParamsSchema.safeParse({ reasoning_effort: 'high' }).success).toBe(false)
  })

  it('rejects model_scope and on_model_unavailable without the primary model', () => {
    expect(modelRoutingParamsSchema.safeParse({ model_scope: 'session' }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({
      on_model_unavailable: { fallbacks: [] },
    }).success).toBe(false)
  })

  it('rejects empty and whitespace-only strings', () => {
    expect(modelRoutingParamsSchema.safeParse({ provider: '', model: 'm' }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({ provider: 'p', model: '   ' }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({ provider: 'p', model: 'm', reasoning_effort: '' }).success).toBe(false)
  })

  it('rejects unknown fields at every level', () => {
    expect(modelRoutingParamsSchema.safeParse({ provider: 'p', model: 'm', temperature: 1 }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({
      provider: 'p', model: 'm',
      on_model_unavailable: { fallbacks: [], retry: true },
    }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({
      provider: 'p', model: 'm',
      on_model_unavailable: { fallbacks: [{ provider: 'p2', model: 'm2', timeout: 3 }] },
    }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({
      provider: 'p', model: 'm',
      on_model_unavailable: { fallbacks: [{ use: 'session_default', reasoning_effort: 'low' }] },
    }).success).toBe(false)
  })

  it('rejects a fifth fallback and unknown if_exhausted strategies', () => {
    const fallbacks = Array.from({ length: MAX_CANDIDATE_FALLBACKS + 1 }, (_, index) => ({
      provider: `p${index}`, model: `m${index}`,
    }))
    expect(modelRoutingParamsSchema.safeParse({
      provider: 'p', model: 'm', on_model_unavailable: { fallbacks },
    }).success).toBe(false)
    expect(modelRoutingParamsSchema.safeParse({
      provider: 'p', model: 'm',
      on_model_unavailable: { fallbacks: [], if_exhausted: 'use_default_model' },
    }).success).toBe(false)
  })

  it('accepts a fully specified primary with sentinels and concrete fallbacks', () => {
    const parsed = modelRoutingParamsSchema.safeParse({
      provider: 'deepseek-account', model: 'deepseek-reasoner', reasoning_effort: 'high',
      model_scope: 'session',
      on_model_unavailable: { fallbacks: [{ use: 'session_default' }, { provider: 'openai', model: 'gpt-5' }] },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('parseModelRoutingParams gating', () => {
  it('reports absent when no model-routing key is supplied, even alongside legacy args', () => {
    expect(parseModelRoutingParams({ cwd: '/tmp/x', task: 'do it' })).toEqual({ present: false })
    expect(parseModelRoutingParams({ session_id: 'session-x', message: 'hi' })).toEqual({ present: false })
    expect(parseModelRoutingParams({})).toEqual({ present: false })
  })

  it('parses a complete routing subset out of a full tool argument object', () => {
    const result = parseModelRoutingParams({
      cwd: '/tmp/x', task: 'do it',
      provider: 'deepseek-account', model: 'deepseek-chat',
      on_model_unavailable: { fallbacks: [] },
    })
    expect(result.present).toBe(true)
    expect(result.params?.provider).toBe('deepseek-account')
    expect(result.params?.model_scope).toBeUndefined()
  })

  it('throws MODEL_PARAMS_INVALID the moment any routing key is malformed', () => {
    try {
      parseModelRoutingParams({ cwd: '/tmp/x', task: 'do it', provider: 'deepseek-account' })
      expect.unreachable('must throw')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ModelRoutingError)
      expect((error as ModelRoutingError).code).toBe(MODEL_PARAMS_INVALID)
      expect((error as ModelRoutingError).message).toContain('model')
    }
    expect(() => parseModelRoutingParams({ reasoning_effort: 'high' })).toThrowError(ModelRoutingError)
  })
})

describe('normalizeModelRoutingParams candidate building', () => {
  it('orders primary first then fallbacks in user-given order', () => {
    const normalized = policy({
      provider: 'deepseek-account', model: 'deepseek-reasoner',
      on_model_unavailable: { fallbacks: [
        { provider: 'openai', model: 'gpt-5' },
        { use: 'session_default' },
        { provider: 'deepseek-account', model: 'deepseek-chat', reasoning_effort: 'low' },
      ] },
    })
    expect(normalized.candidates).toEqual([
      { provider: 'deepseek-account', model: 'deepseek-reasoner' },
      { provider: 'openai', model: 'gpt-5' },
      { use: 'session_default' },
      { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'low' },
    ])
    expect(normalized.scope).toBe('task')
    expect(normalized.ifExhausted).toBe(IF_EXHAUSTED_NOTIFY_SENDER)
    expect(normalized.usesSessionDefault).toBe(true)
    expect(normalized.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATE_ATTEMPTS)
  })

  it('never inherits an effort across candidates: omitted effort stays undefined', () => {
    const normalized = policy({
      provider: 'deepseek-account', model: 'deepseek-reasoner', reasoning_effort: 'high',
      on_model_unavailable: { fallbacks: [{ provider: 'openai', model: 'gpt-5' }] },
    })
    expect(normalized.candidates[0]).toEqual({
      provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high',
    })
    // The fallback declares no effort; normalization must not copy the primary's.
    expect(normalized.candidates[1]).toEqual({ provider: 'openai', model: 'gpt-5' })
  })

  it('rejects duplicate concrete candidates by provider+model+effort identity', () => {
    const attempt = (fallbacks: unknown[]): ModelRoutingError => {
      try {
        policy({ provider: 'deepseek-account', model: 'deepseek-chat', on_model_unavailable: { fallbacks } })
        expect.unreachable('must throw')
      } catch (error: unknown) {
        return error as ModelRoutingError
      }
    }
    expect(attempt([{ provider: 'deepseek-account', model: 'deepseek-chat' }]).code).toBe(MODEL_PARAMS_INVALID)
    expect(attempt([{ provider: 'openai', model: 'gpt-5' }, { provider: 'openai', model: 'gpt-5' }]).code).toBe(MODEL_PARAMS_INVALID)
    expect(attempt([
      { provider: 'openai', model: 'gpt-5', reasoning_effort: 'high' },
      { provider: 'openai', model: 'gpt-5', reasoning_effort: 'high' },
    ]).code).toBe(MODEL_PARAMS_INVALID)
    // Same provider+model with a DIFFERENT effort is a distinct candidate.
    const distinct = policy({
      provider: 'openai', model: 'gpt-5', reasoning_effort: 'minimal',
      on_model_unavailable: { fallbacks: [{ provider: 'openai', model: 'gpt-5', reasoning_effort: 'high' }] },
    })
    expect(distinct.candidates).toHaveLength(2)
    // The dedup key is NUL-separated and collision-proof: primary
    // {provider:'open mock', model:'a'} plus fallback {provider:'open',
    // model:'mock a'} would collide under a visible-separator key
    // ('open mock a' on both sides) but are honestly DISTINCT triples.
    const noCollision = policy({
      provider: 'open mock', model: 'a',
      on_model_unavailable: { fallbacks: [{ provider: 'open', model: 'mock a' }] },
    })
    expect(noCollision.candidates).toHaveLength(2)
  })

  it('rejects a repeated session_default sentinel', () => {
    try {
      policy({
        provider: 'deepseek-account', model: 'deepseek-chat',
        on_model_unavailable: { fallbacks: [{ use: 'session_default' }, { use: 'session_default' }] },
      })
      expect.unreachable('must throw')
    } catch (error: unknown) {
      expect((error as ModelRoutingError).code).toBe(MODEL_PARAMS_INVALID)
    }
  })

  it('bounds candidate attempts at the primary plus four fallbacks', () => {
    expect(MAX_CANDIDATE_ATTEMPTS).toBe(5)
    const fallbacks = Array.from({ length: MAX_CANDIDATE_FALLBACKS }, (_, index) => ({
      provider: `p${index}`, model: `m${index}`,
    }))
    const normalized = policy({ provider: 'p', model: 'm', on_model_unavailable: { fallbacks } })
    expect(normalized.candidates).toHaveLength(MAX_CANDIDATE_ATTEMPTS)
  })
})

describe('catalog reading and failure classification', () => {
  it('classifies a throwing catalog read as CATALOG_UNAVAILABLE, never model-not-found', async () => {
    const failure = await readModelCatalog(() => Promise.reject(new Error('remote transport down'))).catch(error => error)
    expect(failure).toBeInstanceOf(ModelRoutingError)
    expect(failure.code).toBe(CATALOG_UNAVAILABLE)
    expect(failure.code).not.toBe(MODEL_NOT_FOUND)
    expect(failure.message).toContain('catalog')
    expect(failure.message).not.toContain('not in the deployment catalog')
  })

  it('returns a successful read untouched, per-provider failures included', async () => {
    const read = await readModelCatalog(() => Promise.resolve(catalog()))
    expect(read.groups).toHaveLength(2)
    expect(read.failures.map(entry => entry.id)).toEqual(['anthropic'])
  })

  it('keeps a spying read free of model requests: the reader is the only I/O', async () => {
    const spy = vi.fn(() => Promise.resolve(catalog()))
    await readModelCatalog(spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('validateCandidateAgainstCatalog per-target-route rules', () => {
  it('distinguishes PROVIDER_NOT_FOUND from a provider-level catalog failure', () => {
    const missing = () => validateCandidateAgainstCatalog(catalog(), { provider: 'moonshot', model: 'k2' })
    expect(missing).toThrowError(ModelRoutingError)
    expect(missing).toThrowError(expect.objectContaining({ code: PROVIDER_NOT_FOUND }))

    const failed = () => validateCandidateAgainstCatalog(catalog(), { provider: 'anthropic', model: 'claude-4' })
    expect(failed).toThrowError(expect.objectContaining({ code: CATALOG_UNAVAILABLE }))
  })

  it('distinguishes MODEL_NOT_FOUND inside a healthy provider group', () => {
    expect(() => validateCandidateAgainstCatalog(catalog(), { provider: 'openai', model: 'gpt-4' }))
      .toThrowError(expect.objectContaining({ code: MODEL_NOT_FOUND }))
  })

  it('validates effort against the target route catalog entry, never an inherited one', () => {
    // high is valid on the reasoner...
    expect(() => validateCandidateAgainstCatalog(
      catalog(), { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    )).not.toThrow()
    // ...but the same effort id is NOT inherited onto gpt-5's own list.
    expect(() => validateCandidateAgainstCatalog(
      catalog(), { provider: 'openai', model: 'gpt-5', reasoningEffort: 'medium' },
    )).toThrowError(expect.objectContaining({ code: EFFORT_UNSUPPORTED }))
  })

  it('omitted effort passes and an effort-free model entry accepts an explicit effort', () => {
    expect(() => validateCandidateAgainstCatalog(catalog(), { provider: 'openai', model: 'gpt-5' })).not.toThrow()
    // deepseek-chat exposes no reasoning metadata: the adapter owns effort acceptance.
    expect(() => validateCandidateAgainstCatalog(
      catalog(), { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'low' },
    )).not.toThrow()
  })
})

describe('checkCandidateRoutes ordered precheck', () => {
  it('selects the primary when it is available and checks nothing else', () => {
    const result = checkCandidateRoutes(policy({
      provider: 'deepseek-account', model: 'deepseek-reasoner', reasoning_effort: 'low',
      on_model_unavailable: { fallbacks: [{ provider: 'openai', model: 'gpt-5' }] },
    }), catalog())
    expect(result.selected).toEqual({
      provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'low',
    })
    expect(result.checks).toHaveLength(1)
  })

  it('walks fallbacks in order after the primary fails, with per-candidate classification', () => {
    const result = checkCandidateRoutes(policy({
      provider: 'deepseek-account', model: 'not-a-model',
      on_model_unavailable: { fallbacks: [
        { provider: 'moonshot', model: 'k2' },
        { provider: 'openai', model: 'gpt-5', reasoning_effort: 'high' },
        { provider: 'deepseek-account', model: 'deepseek-chat' },
      ] },
    }), catalog())
    expect(result.selected).toEqual({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' })
    expect(result.checks.map(check => check.ok ? 'ok' : check.code)).toEqual([
      MODEL_NOT_FOUND, PROVIDER_NOT_FOUND, 'ok',
    ])
    // Selection stopped at the first available route; the fourth candidate was never consulted.
    expect(result.checks).toHaveLength(3)
  })

  it('exhausts candidates without selection when every concrete route fails', () => {
    const result = checkCandidateRoutes(policy({
      provider: 'moonshot', model: 'k2',
      on_model_unavailable: { fallbacks: [{ provider: 'openai', model: 'gpt-4' }] },
    }), catalog())
    expect(result.selected).toBeUndefined()
    expect(result.checks.map(check => check.ok ? 'ok' : check.code)).toEqual([PROVIDER_NOT_FOUND, MODEL_NOT_FOUND])
  })

  it('keeps session_default opaque at precheck: skipped, counted, never re-sampled', () => {
    const withDefaultFirst = checkCandidateRoutes(policy({
      provider: 'deepseek-account', model: 'not-a-model',
      on_model_unavailable: { fallbacks: [{ use: 'session_default' }, { provider: 'openai', model: 'gpt-5' }] },
    }), catalog())
    // The sentinel is skipped; the concrete fallback after it still selects.
    expect(withDefaultFirst.unresolvedDefaults).toBe(1)
    expect(withDefaultFirst.selected).toEqual({ provider: 'openai', model: 'gpt-5' })

    const onlyDefault = checkCandidateRoutes(policy({
      provider: 'moonshot', model: 'k2',
      on_model_unavailable: { fallbacks: [{ use: 'session_default' }] },
    }), catalog())
    // Nothing concrete available, and the default does NOT resolve at precheck time.
    expect(onlyDefault.selected).toBeUndefined()
    expect(onlyDefault.unresolvedDefaults).toBe(1)
    expect(onlyDefault.checks).toHaveLength(1)
  })

  it('stops consulting further candidates after a provider-level catalog failure', () => {
    const result = checkCandidateRoutes(policy({
      provider: 'anthropic', model: 'claude-4',
      on_model_unavailable: { fallbacks: [{ provider: 'openai', model: 'gpt-5' }] },
    }), catalog())
    expect(result.selected).toBeUndefined()
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({ ok: false, code: CATALOG_UNAVAILABLE })
  })

  it('bounds the number of concrete candidates checked', () => {
    const fallbacks = [
      { provider: 'moonshot', model: 'k2' },
      { provider: 'openai', model: 'gpt-4' },
      { use: 'session_default' },
      { provider: 'deepseek-account', model: 'not-a-model' },
    ] as const
    const result = checkCandidateRoutes(policy({
      provider: 'moonshot', model: 'k1',
      on_model_unavailable: { fallbacks: [...fallbacks] },
    }), catalog(), { limit: 2 })
    expect(result.checks).toHaveLength(2)
    expect(result.selected).toBeUndefined()
  })
})

describe('projectModelCatalog discovery output', () => {
  it('reports effort metadata, per-model defaults, and the deployment default route', () => {
    const view = projectModelCatalog(catalog(), {}, false)
    expect(view.taskHost).toBe(false)
    expect(view.deploymentDefault).toEqual({
      provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'medium',
    })
    const deepseek = view.providers.find(provider => provider.id === 'deepseek-account')
    const reasoner = deepseek?.models.find(model => model.id === 'deepseek-reasoner')
    expect(reasoner?.defaultEffort).toBe('medium')
    expect(reasoner?.efforts.map(effort => `${effort.id}:${effort.isDefault}`)).toEqual([
      'low:false', 'medium:true', 'high:false',
    ])
    const gpt = view.providers.find(provider => provider.id === 'openai')?.models[0]
    expect(gpt?.defaultEffort).toBeUndefined()
    expect(gpt?.efforts.map(effort => effort.isDefault)).toEqual([false, false])
    // The deployment default model itself is flagged; nothing receives inherited effort.
    const chat = deepseek?.models.find(model => model.id === 'deepseek-chat')
    expect(chat?.isDeploymentDefault).toBe(true)
    expect(chat?.efforts).toEqual([])
    expect(reasoner?.isDeploymentDefault).toBe(false)
  })

  it('reports provider-level query failure per provider, never as an empty catalog', () => {
    const view = projectModelCatalog(catalog(), {}, true)
    const failed = view.providers.find(provider => provider.id === 'anthropic')
    expect(failed?.models).toEqual([])
    expect(failed?.catalogError).toContain('catalog_unavailable')
    expect(failed?.catalogError).toContain('credentials not configured')
    // A failure entry stands next to healthy providers instead of hiding them.
    expect(view.providers.map(provider => provider.id)).toEqual(['anthropic', 'deepseek-account', 'openai'])
    expect(view.taskHost).toBe(true)
  })

  it('filters by provider, and by exact model only with its provider', () => {
    const only = projectModelCatalog(catalog(), { provider: 'openai' })
    expect(only.providers.map(provider => provider.id)).toEqual(['openai'])
    const exact = projectModelCatalog(catalog(), { provider: 'deepseek-account', model: 'deepseek-reasoner' })
    expect(exact.providers).toHaveLength(1)
    expect(exact.providers[0]?.models.map(model => model.id)).toEqual(['deepseek-reasoner'])
    // An absent exact pair is an empty projection, not an error and not a fallback trigger.
    const absent = projectModelCatalog(catalog(), { provider: 'openai', model: 'nope' })
    expect(absent.providers).toEqual([{ id: 'openai', name: 'OpenAI', models: [] }])
    expect(() => projectModelCatalog(catalog(), { model: 'deepseek-chat' }))
      .toThrowError(SessionListModelsParamsError)
  })

  it('exposes the task-host capability flag from the caller, defaulting to false', () => {
    expect(projectModelCatalog(catalog()).taskHost).toBe(false)
    expect(projectModelCatalog(catalog(), {}, true).taskHost).toBe(true)
  })
})
