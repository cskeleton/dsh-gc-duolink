/**
 * Session Link model-routing protocol (MODEL_ROUTING_PLAN Task 2): the public
 * parameter schema shared by `session_spawn_linked_session` and
 * `session_send_session_message`, the pure candidate-policy module, deployment
 * catalog typing with failure classification, and the `session_list_models`
 * discovery projection.
 *
 * This module is pure: it imports no host service, creates or mutates no
 * Session, and performs no model request. Catalog rows arrive as plain
 * arguments (structurally the Session Controller `modelCatalog()` Remote
 * result, typed example-only per peer-independence rules). Task 3 persists
 * policy snapshots; Task 4 wires the parameters into spawn/send admission.
 *
 * Snapshot semantics for `session_default` (late binding, plan Public
 * Contract §1): the sentinel is opaque at parameter-validation time and
 * resolves at the task's first activation against the TARGET Session's
 * long-term baseline — never the sender's model.
 * - Spawn precheck (Task 4) MAY resolve the default candidate against the
 *   baseline snapshot the host freezes at Session creation time
 *   (`snapshotBaselineForSpawn` in `./host-capability.ts`), so the first
 *   temporary request can never become the new Session's baseline.
 * - An already-existing Session resolves `session_default` at the execution
 *   boundary on each activation; precheck availability is not guaranteed.
 * - Replay MUST NOT re-sample: the route a default resolved into is frozen
 *   onto the decision attempt the first time it binds, and every replay or
 *   retry of that attempt reuses the frozen route.
 *
 * `@persistenceSecurity` The choice-security boundary of this module is a
 * hostile or sloppy model caller supplying routing parameters. All value
 * types here stay separate from storage schemas (durable schemas are Task
 * 3's `task-spec.ts`).
 * @module dsh-session-link/model-policy
 */

import { z } from 'zod'

/** Maximum user-supplied fallback entries; with the primary, 5 candidates max. */
export const MAX_CANDIDATE_FALLBACKS = 4

/** Maximum candidate attempts (primary + fallbacks) any decision may spend. */
export const MAX_CANDIDATE_ATTEMPTS = MAX_CANDIDATE_FALLBACKS + 1

/** The exhaustion strategy this period supports (and the parameter default). */
export const IF_EXHAUSTED_NOTIFY_SENDER = 'notify_sender'

/**
 * Stable machine-readable model-routing classification codes. They are
 * distinguishable from each other and from ordinary tool errors: Task 4 maps
 * `CATALOG_UNAVAILABLE` to `needs_decision`-eligible behavior while
 * `MODEL_PARAMS_INVALID` stays a plain tool error with NO task created.
 */
export type ModelRoutingErrorCode =
  | 'MODEL_PARAMS_INVALID'
  | 'CATALOG_UNAVAILABLE'
  | 'PROVIDER_NOT_FOUND'
  | 'MODEL_NOT_FOUND'
  | 'EFFORT_UNSUPPORTED'

export const MODEL_PARAMS_INVALID: ModelRoutingErrorCode = 'MODEL_PARAMS_INVALID'
export const CATALOG_UNAVAILABLE: ModelRoutingErrorCode = 'CATALOG_UNAVAILABLE'
export const PROVIDER_NOT_FOUND: ModelRoutingErrorCode = 'PROVIDER_NOT_FOUND'
export const MODEL_NOT_FOUND: ModelRoutingErrorCode = 'MODEL_NOT_FOUND'
export const EFFORT_UNSUPPORTED: ModelRoutingErrorCode = 'EFFORT_UNSUPPORTED'

/** Structured model-routing failure; never carries credentials or raw provider responses. */
export class ModelRoutingError extends Error {
  /**
   * @param code - stable classification; controls Task 4's task-creation behavior.
   * @param message - model-facing explanation without secrets.
   * @param details - non-secret context (provider/model ids) for the caller.
   */
  constructor(
    readonly code: ModelRoutingErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ModelRoutingError'
  }
}

/**
 * One concrete model route: provider + model + optional effort. The paired
 * key (`provider + ' ' + model`) is the deduplication identity; the effort
 * participates in candidate equality but never inherits across models —
 * an omitted effort means the selected model's own adapter/catalog default.
 */
export interface ModelRouteSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Late-binding candidate: resolve against the target Session's long-term
 * baseline at first activation (see module doc for the snapshot contract).
 * Exactly one may appear per policy; resolved routes freeze onto the attempt.
 */
export interface SessionDefaultCandidate {
  readonly use: 'session_default'
}

/** One ordered candidate: a concrete route or the session-default sentinel. */
export type ModelRouteCandidate = ModelRouteSelection | SessionDefaultCandidate

/**
 * Normalized model-routing policy produced by {@link normalizeModelRoutingParams}.
 * `candidates[0]` is the primary route; the rest are fallbacks in user-given
 * order. An omitted effort on any entry means that model's own default.
 */
export interface ModelRoutingPolicy {
  readonly scope: 'task' | 'session'
  readonly candidates: readonly ModelRouteCandidate[]
  readonly ifExhausted: typeof IF_EXHAUSTED_NOTIFY_SENDER
  /** True when any candidate is the session-default sentinel. */
  readonly usesSessionDefault: boolean
}

/* --------------------------------------------------------------------------
 * Public tool-parameter schema (zod, strict object + refinements).
 *
 * `modelRoutingParamsSchema` is the SINGLE validator Task 4 attaches to the
 * spawn/send tool parameters; `parseModelRoutingParams` runs it and maps
 * every violation to `MODEL_PARAMS_INVALID`. Zod remains inside this module:
 * Task 4 consumes the parsed value, never re-derives validation logic.
 * ------------------------------------------------------------------------ */

const nonEmptyString = z.string().refine(value => value.trim() !== '', {
  message: 'must be a non-empty string',
})

/**
 * Fallback entry: a concrete route or the session-default sentinel. Unknown
 * fields are rejected (strict); empty strings are rejected; the effort only
 * rides a concrete route — a `use`-sentinel carrying extra keys is invalid.
 */
const fallbackEntrySchema = z.union([
  z.strictObject({
    provider: nonEmptyString,
    model: nonEmptyString,
    reasoning_effort: nonEmptyString.optional(),
  }),
  z.strictObject({
    use: z.literal('session_default'),
  }),
])

const onModelUnavailableSchema = z.strictObject({
  fallbacks: z.array(fallbackEntrySchema).max(MAX_CANDIDATE_FALLBACKS, {
    message: `fallbacks accepts at most ${MAX_CANDIDATE_FALLBACKS} entries (with the primary, ${MAX_CANDIDATE_ATTEMPTS} candidates)`,
  }),
  if_exhausted: z.literal(IF_EXHAUSTED_NOTIFY_SENDER).optional(),
})

/**
 * The public model-routing parameters appended to
 * `session_spawn_linked_session` and `session_send_session_message`
 * (Public Contract §1). Strict: `provider`/`model` are a pair, no orphan
 * `reasoning_effort`, `model_scope`/`on_model_unavailable` require the
 * primary model, unknown fields and empty strings are rejected. When every
 * model parameter is omitted the schema no longer matches, so callers must
 * gate with {@link parseModelRoutingParams}'s `present` flag and stay on the
 * legacy path.
 */
export const modelRoutingParamsSchema = z.strictObject({
  provider: nonEmptyString,
  model: nonEmptyString,
  reasoning_effort: nonEmptyString.optional(),
  model_scope: z.union([z.literal('task'), z.literal('session')]).optional(),
  on_model_unavailable: onModelUnavailableSchema.optional(),
})

/** Parsed model-routing parameters (snake_case, exactly as the tool receives them). */
export type ModelRoutingParams = z.infer<typeof modelRoutingParamsSchema>

export interface ModelRoutingParamsParseResult {
  /** False when the caller supplied no model-routing parameter at all. */
  readonly present: boolean
  /** Set only when `present` and the parameters passed full validation. */
  readonly params?: ModelRoutingParams
}

/**
 * Parse raw tool arguments for the model-routing subset.
 * @param args - the tool call's argument object (or any plain record).
 * @returns `present: false` for a model-less call (legacy path), otherwise
 *   the validated parameters.
 * @throws {@link ModelRoutingError} code `MODEL_PARAMS_INVALID` as soon as
 *   ANY model-routing key is present but the subset fails schema/pairing
 *   validation; the message lists every violation.
 */
export function parseModelRoutingParams(args: unknown): ModelRoutingParamsParseResult {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const keys = ['provider', 'model', 'reasoning_effort', 'model_scope', 'on_model_unavailable']
  if (!keys.some(key => record[key] !== undefined)) return { present: false }
  const subset: Record<string, unknown> = {}
  for (const key of keys) if (record[key] !== undefined) subset[key] = record[key]
  const parsed = modelRoutingParamsSchema.safeParse(subset)
  if (parsed.success) return { present: true, params: parsed.data }
  const violations = parsed.error.issues
    .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
  throw new ModelRoutingError(
    MODEL_PARAMS_INVALID,
    `invalid model routing parameters (${violations}). provider and model must be supplied `
    + 'together, reasoning_effort never stands alone, model_scope and on_model_unavailable '
    + 'require the primary model, and unknown fields or empty strings are rejected.',
  )
}

/**
 * Normalize validated parameters into the ordered candidate policy.
 * Order is primary first, then fallbacks in user-given order. Duplicate
 * candidates — same provider+model+effort, or a repeated session-default
 * sentinel — are REJECTED as invalid input BEFORE the fallback limit is
 * enforced; nothing is silently deduplicated. No effort is inherited across
 * candidates: an omitted effort stays undefined and later resolves to that
 * model's own adapter default.
 * @param params - parameters that already passed {@link modelRoutingParamsSchema}.
 * @returns the immutable policy snapshot Task 3 persists and Task 4 executes.
 * @throws {@link ModelRoutingError} code `MODEL_PARAMS_INVALID` on duplicate
 *   candidates or an over-long fallback list.
 */
export function normalizeModelRoutingParams(params: ModelRoutingParams): ModelRoutingPolicy {
  const primary: ModelRouteSelection = {
    provider: params.provider,
    model: params.model,
    ...(params.reasoning_effort === undefined ? {} : { reasoningEffort: params.reasoning_effort }),
  }
  const candidates: ModelRouteCandidate[] = [primary]
  let usesSessionDefault = false
  const seen = new Set<string>([routeKey(primary)])
  for (const [index, fallback] of (params.on_model_unavailable?.fallbacks ?? []).entries()) {
    if ('use' in fallback) {
      if (usesSessionDefault) {
        throw new ModelRoutingError(
          MODEL_PARAMS_INVALID,
          `duplicate session_default fallback at index ${index}: the session-default candidate may appear at most once`,
        )
      }
      usesSessionDefault = true
      candidates.push({ use: 'session_default' })
      continue
    }
    const route: ModelRouteSelection = {
      provider: fallback.provider,
      model: fallback.model,
      ...(fallback.reasoning_effort === undefined ? {} : { reasoningEffort: fallback.reasoning_effort }),
    }
    const key = routeKey(route)
    if (seen.has(key)) {
      throw new ModelRoutingError(
        MODEL_PARAMS_INVALID,
        `duplicate candidate ${route.provider}/${route.model}`
        + `${route.reasoningEffort === undefined ? '' : ` (effort ${route.reasoningEffort})`}`
        + ` at fallback index ${index}: every candidate must differ in provider, model, or effort`,
      )
    }
    seen.add(key)
    candidates.push(route)
  }
  if (candidates.length > MAX_CANDIDATE_ATTEMPTS) {
    // The schema already bounds fallbacks; keep the invariant checked so a
    // caller bypassing the schema can never build an unbounded cycle.
    throw new ModelRoutingError(
      MODEL_PARAMS_INVALID,
      `too many candidates: ${candidates.length} exceeds the ${MAX_CANDIDATE_ATTEMPTS}-candidate bound`,
    )
  }
  return {
    scope: params.model_scope ?? 'task',
    candidates,
    ifExhausted: params.on_model_unavailable?.if_exhausted ?? IF_EXHAUSTED_NOTIFY_SENDER,
    usesSessionDefault,
  }
}

/** Deduplication identity of one candidate: exact provider, model, and effort.
 * The NUL separator cannot appear inside any component, so distinct triples
 * can never collide (a space-joined key would conflate e.g. `a b/c` with `a/b c`). */
function routeKey(route: ModelRouteSelection): string {
  return `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
}

/* --------------------------------------------------------------------------
 * Deployment catalog (structural type of the `modelCatalog()` Remote result).
 * ------------------------------------------------------------------------ */

/** One adapter-owned reasoning effort for an exact model route. */
export interface ModelCatalogEffort {
  readonly id: string
  readonly name?: string
  readonly description?: string
}

/** Reasoning metadata for one exact model route; `defaultEffort` is that model's own default. */
export interface ModelCatalogReasoning {
  readonly efforts: readonly ModelCatalogEffort[]
  readonly defaultEffort?: string
}

/** One model inside its provider group. */
export interface ModelCatalogModelEntry {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly reasoning?: ModelCatalogReasoning
}

/** One provider and its successfully read model catalog. */
export interface ModelCatalogProviderGroup {
  readonly id: string
  readonly name?: string
  readonly models: readonly ModelCatalogModelEntry[]
}

/**
 * One provider whose catalog query failed. The failure is reported PER
 * PROVIDER and must never masquerade as an empty catalog: entries of the
 * failed provider are unknown, not absent.
 */
export interface ModelCatalogProviderFailure {
  readonly id: string
  readonly name?: string
  readonly message: string
}

/** Deployment model catalog as the Session Controller `modelCatalog()` Remote reports it. */
export interface ModelCatalogLike {
  readonly default: ModelRouteSelection
  readonly routableProviders?: readonly string[]
  readonly groups: readonly ModelCatalogProviderGroup[]
  readonly failures: readonly ModelCatalogProviderFailure[]
}

/** Reads the deployment catalog; the only I/O the policy layer ever needs. */
export type ModelCatalogReader = () => Promise<ModelCatalogLike>

/**
 * Read the deployment catalog with failure classification: a throwing reader
 * is a `CATALOG_UNAVAILABLE` condition (the catalog cannot be consulted), NOT
 * "model not found". A missing provider/model inside a SUCCESSFULLY READ
 * catalog is `PROVIDER_NOT_FOUND`/`MODEL_NOT_FOUND` (Task 4 must keep this
 * distinction — catalog failure is `needs_decision`-eligible; a wrong id is
 * a parameter-class error that never triggers fallback).
 * @param read - the catalog reader (e.g. `sessionController.modelCatalog`).
 * @returns the catalog as reported, per-provider failures included.
 * @throws {@link ModelRoutingError} code `CATALOG_UNAVAILABLE` when the read fails.
 */
export async function readModelCatalog(read: ModelCatalogReader): Promise<ModelCatalogLike> {
  try {
    return await read()
  } catch (error: unknown) {
    throw new ModelRoutingError(
      CATALOG_UNAVAILABLE,
      `the deployment model catalog cannot be read right now: ${error instanceof Error ? error.message : String(error)}. `
      + 'This is a catalog failure, not evidence that a model does not exist; '
      + 'do not treat it as an empty catalog or fall back on it.',
    )
  }
}

/** Locate one provider group and record whether its query failed. */
function providerEntry(catalog: ModelCatalogLike, provider: string):
  { kind: 'group'; group: ModelCatalogProviderGroup } | { kind: 'failed' } | { kind: 'absent' } {
  const group = catalog.groups.find(entry => entry.id === provider)
  if (group !== undefined) return { kind: 'group', group }
  return catalog.failures.some(entry => entry.id === provider) ? { kind: 'failed' } : { kind: 'absent' }
}

/**
 * Validate one candidate route against its TARGET catalog entry: the effort
 * is checked against THAT route's own advertised effort list, never
 * against an inherited or deployment-wide list; an omitted effort passes and
 * means the model's own default.
 * @param catalog - a successfully read catalog.
 * @param route - the concrete route to validate (effort optional).
 * @throws {@link ModelRoutingError} `CATALOG_UNAVAILABLE` when the route's
 *   provider group failed to load inside this catalog, `PROVIDER_NOT_FOUND`
 *   or `MODEL_NOT_FOUND` when the catalog read succeeded but lacks the id,
 *   and `EFFORT_UNSUPPORTED` when the route advertises an effort list that
 *   excludes the requested effort.
 */
export function validateCandidateAgainstCatalog(catalog: ModelCatalogLike, route: ModelRouteSelection): void {
  const entry = providerEntry(catalog, route.provider)
  if (entry.kind === 'failed') {
    throw new ModelRoutingError(
      CATALOG_UNAVAILABLE,
      `the catalog for provider "${route.provider}" failed to load, so route `
      + `${route.provider}/${route.model} cannot be checked; this is not proof the model does not exist`,
      { provider: route.provider, model: route.model },
    )
  }
  if (entry.kind === 'absent') {
    throw new ModelRoutingError(
      PROVIDER_NOT_FOUND,
      `provider "${route.provider}" is not in the deployment catalog (and its query did not fail)`,
      { provider: route.provider },
    )
  }
  const model = entry.group.models.find(candidate => candidate.id === route.model)
  if (model === undefined) {
    throw new ModelRoutingError(
      MODEL_NOT_FOUND,
      `model "${route.model}" is not advertised by provider "${route.provider}"`,
      { provider: route.provider, model: route.model },
    )
  }
  if (route.reasoningEffort === undefined) return
  if (model.reasoning === undefined) return
  const efforts = model.reasoning.efforts
  // An adapter exposing reasoning metadata with an EMPTY effort list declares
  // no selectable efforts; a non-empty list is authoritative for this route.
  if (efforts.length === 0 || efforts.some(effort => effort.id === route.reasoningEffort)) return
  throw new ModelRoutingError(
    EFFORT_UNSUPPORTED,
    `reasoning effort "${route.reasoningEffort}" is not supported by ${route.provider}/${route.model}; `
    + `this route advertises: ${efforts.map(effort => effort.id).join(', ')}`
    + `${model.reasoning.defaultEffort === undefined ? '' : ` (default ${model.reasoning.defaultEffort})`}`,
    { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
  )
}

export type CandidateAvailability =
  | { readonly ok: true; readonly route: ModelRouteSelection }
  | { readonly ok: false; readonly code: ModelRoutingErrorCode; readonly message: string; readonly route: ModelRouteSelection }

export interface CandidateCheckResult {
  /** The first catalog-available candidate, in policy order, when one exists. */
  readonly selected?: ModelRouteSelection
  /** Per-candidate outcome in the same order they were checked. */
  readonly checks: readonly CandidateAvailability[]
  /** Sentinel candidates skipped during a catalog precheck, in policy order. */
  readonly unresolvedDefaults: number
}

/**
 * Admission-style candidate precheck over a successfully read catalog. Only
 * concrete routes are checked; session-default sentinels stay opaque and are
 * SKIPPED (they resolve at first activation per the module's snapshot
 * contract — a precheck must not fix or re-sample them). Selection follows
 * policy order and stops at the first available route, keeping candidate
 * attempts bounded by construction. A rejection of one candidate NEVER
 * mutates the policy, never invents candidates, and never inherits an
 * effort from a rejected route.
 * @param policy - the normalized policy snapshot.
 * @param catalog - a successfully read catalog ({@link readModelCatalog}).
 * @param options.limit - optional bound on concrete candidates checked.
 * @returns the selected route plus the per-candidate classification trail.
 */
export function checkCandidateRoutes(
  policy: ModelRoutingPolicy,
  catalog: ModelCatalogLike,
  options: { limit?: number } = {},
): CandidateCheckResult {
  const checks: CandidateAvailability[] = []
  const bound = Math.max(0, Math.min(options.limit ?? policy.candidates.length, policy.candidates.length))
  let checked = 0
  let unresolvedDefaults = 0
  for (const candidate of policy.candidates) {
    if ('use' in candidate) {
      unresolvedDefaults += 1
      continue
    }
    if (checked >= bound) break
    checked += 1
    try {
      validateCandidateAgainstCatalog(catalog, candidate)
      checks.push({ ok: true, route: candidate })
      return { selected: candidate, checks, unresolvedDefaults }
    } catch (error: unknown) {
      if (error instanceof ModelRoutingError) {
        checks.push({ ok: false, code: error.code, message: error.message, route: candidate })
        if (error.code === CATALOG_UNAVAILABLE) {
          // A provider-level catalog failure poisons the precheck: further
          // candidates cannot be trusted as checked, so stop consulting.
          break
        }
        continue
      }
      throw error
    }
  }
  return { checks, unresolvedDefaults }
}

/* --------------------------------------------------------------------------
 * `session_list_models` discovery projection (Task 2 tool output).
 * ------------------------------------------------------------------------ */

/** One effort as the discovery tool reports it. */
export interface SessionModelListEffort {
  readonly id: string
  readonly name?: string
  readonly isDefault: boolean
}

/** One discovered model with its own effort list and default. */
export interface SessionModelListModel {
  readonly id: string
  readonly name?: string
  readonly description?: string
  // Freshly built (non-readonly) arrays so the value satisfies the tool
  // output-schema inference, which types arrays as mutable.
  readonly efforts: SessionModelListEffort[]
  readonly defaultEffort?: string
  /** True for the deployment default route. */
  readonly isDeploymentDefault: boolean
}

/** One provider group in the discovery answer. */
export interface SessionModelListProvider {
  readonly id: string
  readonly name?: string
  readonly models: SessionModelListModel[]
  /** Non-secret failure detail when this provider's catalog query failed. */
  readonly catalogError?: string
}

/** The `session_list_models` canonical output value. */
export interface SessionModelListView {
  /**
   * Whether the deployment exposes the host task-execution capability
   * (`resolveTaskHost` in `./host-capability.ts` returning a capability);
   * when false, routing parameters on spawn/send are rejected with
   * `HOST_CAPABILITY_UNAVAILABLE` — the LLM must not guess this.
   */
  readonly taskHost: boolean
  readonly deploymentDefault: ModelRouteSelection
  readonly providers: SessionModelListProvider[]
}

export class SessionListModelsParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionListModelsParamsError'
  }
}

/**
 * Project a successfully read catalog into the `session_list_models` output.
 * Provider-level query failures are carried on their provider entry as
 * `catalogError` and NEVER turn into an empty provider list; a whole-catalog
 * read failure never reaches this function (the tool classifies it as
 * `CATALOG_UNAVAILABLE`). Only catalog-declared ids, names, and effort
 * metadata are projected — never credentials or raw provider responses.
 * @param catalog - catalog from {@link readModelCatalog}.
 * @param filter - optional provider/model narrowing; an exact `model` filter
 *   REQUIRES `provider` and yields an empty providers list when the pair is
 *   absent (a filter is a projection, never an error signal).
 * @param taskHost - whether {@link import('./host-capability.ts').resolveTaskHost}
 *   found the capability for the calling Agent's context.
 */
export function projectModelCatalog(
  catalog: ModelCatalogLike,
  filter: { provider?: string; model?: string } = {},
  taskHost = false,
): SessionModelListView {
  if (filter.model !== undefined && filter.provider === undefined) {
    throw new SessionListModelsParamsError('an exact model filter requires the provider parameter')
  }
  const sameRoute = (route: ModelRouteSelection, provider: string, model: string): boolean =>
    route.provider === provider && route.model === model
  const providers: SessionModelListProvider[] = []
  for (const group of catalog.groups) {
    if (filter.provider !== undefined && group.id !== filter.provider) continue
    const models = group.models
      .filter(model => filter.model === undefined || model.id === filter.model)
      .map(model => ({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.description === undefined ? {} : { description: model.description }),
        efforts: (model.reasoning?.efforts ?? [])
          .map(effort => ({
            id: effort.id,
            ...(effort.name === undefined ? {} : { name: effort.name }),
            isDefault: model.reasoning?.defaultEffort === effort.id,
          })),
        ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
        isDeploymentDefault: sameRoute(catalog.default, group.id, model.id),
      }))
    providers.push({ id: group.id, ...(group.name === undefined ? {} : { name: group.name }), models })
  }
  for (const failure of catalog.failures) {
    if (filter.provider !== undefined && failure.id !== filter.provider) continue
    providers.push({
      id: failure.id,
      ...(failure.name === undefined ? {} : { name: failure.name }),
      models: [],
      catalogError: `catalog_unavailable: ${failure.message}`,
    })
  }
  providers.sort((a, b) => a.id.localeCompare(b.id))
  return { taskHost, deploymentDefault: catalog.default, providers }
}
