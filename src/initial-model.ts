/** Catalog validation for a new Session's initial native model selection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

export interface InitialModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export class InitialModelError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'InitialModelError'
  }
}

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new InitialModelError('INVALID_MODEL_PARAMETERS', `${label} must be an object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new InitialModelError('INVALID_MODEL_PARAMETERS', `${label} contains an unknown field: ${String(key)}`)
    }
  }
  return value as Record<string, unknown>
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InitialModelError('INVALID_MODEL_PARAMETERS', `${label} must be a non-empty string`)
  }
  return value.trim()
}

/** Parse the tool's snake_case contract; omitted effort stays omitted. */
export function parseInitialModel(value: unknown): InitialModelSelection {
  const args = object(value, ['provider', 'model', 'reasoning_effort'], 'initial_model')
  const provider = nonempty(args.provider, 'initial_model.provider')
  const model = nonempty(args.model, 'initial_model.model')
  return {
    provider,
    model,
    ...(Object.hasOwn(args, 'reasoning_effort')
      ? { reasoningEffort: nonempty(args.reasoning_effort, 'initial_model.reasoning_effort') }
      : {}),
  }
}

function method(service: unknown, name: string): boolean {
  return service !== null && typeof service === 'object'
    && typeof (service as Record<string, unknown>)[name] === 'function'
}

/** Capability describes public bootstrap assembly, never execution success. */
export function hasInitialModelCapability(ctx: Context): boolean {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const presets = ctx.get('agentPresets')
  return method(sessions, 'prepare')
    && method(persistence, 'create') && method(persistence, 'open') && method(persistence, 'stat')
    && method(presets, 'resolve')
    && method(ctx.sessionController, 'create')
}

async function catalog(ctx: Context): Promise<ModelCatalog> {
  if (!method(ctx.sessionController, 'modelCatalog')) {
    throw new InitialModelError('MODEL_CATALOG_UNAVAILABLE', 'the host has no public model catalog')
  }
  let result: ModelCatalog
  try {
    result = await ctx.sessionController.modelCatalog()
  } catch {
    // Provider exceptions can contain authentication details; do not reflect them into tools.
    throw new InitialModelError('MODEL_CATALOG_UNAVAILABLE', 'the deployed model catalog could not be loaded')
  }
  if (!result || !Array.isArray(result.groups) || !Array.isArray(result.failures)
    || !Array.isArray(result.routableProviders) || !result.default) {
    throw new InitialModelError('MODEL_CATALOG_UNAVAILABLE', 'the host returned an invalid model catalog')
  }
  return result
}

/** Exact provider/model/effort lookup; metadata lookup makes no model request. */
export async function validateInitialModel(ctx: Context, selection: InitialModelSelection): Promise<InitialModelSelection> {
  const available = await catalog(ctx)
  if (available.failures.some(failure => failure.id === selection.provider)) {
    throw new InitialModelError('MODEL_CATALOG_UNAVAILABLE', `catalog lookup failed for provider ${selection.provider}`)
  }
  const group = available.groups.find(group => group.id === selection.provider)
  if (!group || !available.routableProviders.includes(selection.provider)) {
    throw new InitialModelError('MODEL_PROVIDER_UNAVAILABLE', `provider ${selection.provider} has no available model route`)
  }
  const model = group.models.find(model => model.id === selection.model)
  if (!model) {
    throw new InitialModelError('MODEL_UNAVAILABLE', `model ${selection.model} is not in provider ${selection.provider}'s catalog`)
  }
  if (selection.reasoningEffort !== undefined
    && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) {
    throw new InitialModelError('MODEL_EFFORT_UNSUPPORTED', `reasoning effort ${selection.reasoningEffort} is not supported by ${selection.provider}/${selection.model}`)
  }
  return { ...selection }
}

export interface InitialModelCatalog extends ModelCatalog {
  readonly initialModelSelection: boolean
  readonly description: string
}

/** Read the deployed directory, optionally filtering an exact provider. */
export async function listInitialModels(ctx: Context, params?: unknown): Promise<InitialModelCatalog> {
  const args = params === undefined ? {} : object(params, ['provider'], 'model catalog parameters')
  const provider = Object.hasOwn(args, 'provider') ? nonempty(args.provider, 'provider') : undefined
  const available = await catalog(ctx)
  return {
    ...available,
    groups: available.groups.filter(group => provider === undefined || group.id === provider),
    failures: available.failures.filter(failure => provider === undefined || failure.id === provider),
    routableProviders: available.routableProviders.filter(id => provider === undefined || id === provider),
    initialModelSelection: hasInitialModelCapability(ctx),
    description: 'Deployment model directory only. Catalog presence does not guarantee authentication or a successful model request. Initial selection applies only when creating a new Session.',
  }
}
