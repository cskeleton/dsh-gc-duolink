/**
 * The Session Link task runtime (MODEL_ROUTING_PLAN Task 4): the per-target-Agent
 * bridge between the durable task service (`ctx.sessionLinkTasks`, root context)
 * and the host task-execution capability. Every durable projection travels
 * through the task service CAS; this module owns ONLY the target-side execution
 * wiring:
 *
 *  - the claimed-message gate (`agent/inbox/claimed`): a delivered session-link
 *    message whose `source.messageId` matches a durable host turn intent (read
 *    through the capability, never an in-memory map) enters the TASK path:
 *    owner session + current attempt + not-cancelled/unlinked validated, the
 *    host lease claimed, and only THEN `queued → running` under CAS with
 *    `assertBindingDurable` first. Any refusal projects `waiting_decision` +
 *    ONE outbox event and the message runs UNMANAGED as an ordinary turn (no
 *    route freeze, no fake state);
 *  - the turn lifecycle: a committed assistant response while claimed triggers
 *    host `commitTurn` (with `persistOnSuccess = scope === 'session'` — the
 *    baseline CAS runs inside the host); `turn/end` finishes the host facts and
 *    projects `turn_finished` (+ ONE outbox event), the resumable
 *    waiting_decision path, or the terminal interrupted/cancelled path;
 *  - the fallback decision point: a SAME-step route-availability failure is
 *    classified from `payload.failure` (the adapter-normalized facts the loop
 *    carries) because this implementation deliberately raises no durable
 *    read-back: the host's own listener may not have had its synchronous
 *    append folded yet when the waterfall returns. A retryable failure with
 *    an uncommitted response and remaining candidates cancels the current
 *    intent, freezes `session_default` ONCE from the current effective
 *    baseline (never re-sampled), journals the failed route, re-records on
 *    the SAME messageId, claims the new intent, and returns
 *    `{ kind: 'retry' }` so the loop re-assembles that step's request with the
 *    fresh route. A committed response (or any tool dispatch — only possible
 *    after one) forbids auto-fallback (plan clause 5);
 *  - unload honesty: disposal cancels the live uncommitted claim; the durable
 *    host record then reads as cancelled (never implicitly executable);
 *  - withdrawal: explicit cancel (resolve_task from Task 5) and mid-flight
 *    unlink withdraw only NOT-YET-committed claims; running turns are never
 *    force-interrupted and committed baselines are never reverted.
 *
 * There are no timers and no `whenIdle` polling: every projection is driven by
 * host turn facts (`agent/inbox/claimed`, `agent/request`, `agent/request-error`,
 * `session/event`, `agent/assistant-stream`).
 * @module dsh-session-link/task-runtime
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  CATALOG_UNAVAILABLE,
  MODEL_NOT_FOUND,
} from './model-policy.ts'
import type { ModelRouteCandidate, ModelRouteSelection, ModelRoutingPolicy } from './model-policy.ts'
import { parkManagedInputLazy, resolveTaskHost } from './host-capability.ts'
import type {
  HostModelSelection,
  HostTaskHostCapability,
  HostTaskRoute,
  HostTurnLease,
} from './host-capability.ts'
import type { SessionLinkTaskService, TaskEventInput } from './tasks.ts'
import type { SessionLinkTaskAttempt, SessionLinkTaskRecordData } from './task-spec.ts'
import type { SessionLinkId, SessionLinkMessageId, SessionLinkTaskId } from './types.ts'

/** The host failure classes that authorize an automatic route switch (plan clause 3). */
const RETRYABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'RATE_LIMIT',
  'QUOTA_EXHAUSTED',
  'MODEL_UNAVAILABLE',
  'MODEL_NOT_FOUND',
  'EFFORT_UNSUPPORTED',
  'AUTH_INVALID',
  'FORBIDDEN_QUOTA',
  'TASK_ROUTE_UNAVAILABLE',
])

/** The exact reason string the baseline-persist CAS skip projects (plan §1 field name). */
export const PERSISTENT_SELECTION_SKIPPED = 'persistent_selection_skipped: human_selection_changed'

/** Outbox event reported when the candidate walk exhausted for one attempt. */
const CANDIDATES_EXHAUSTED_REASON = 'model_unavailable'

/** Everything needed to conceptually finish one claimed task turn. */
interface ActiveClaim {
  readonly taskId: SessionLinkTaskId
  readonly attemptId: string
  readonly policy: ModelRoutingPolicy
  /** Concrete candidates in policy order (session_default resolved by snapshot). */
  readonly candidates: readonly ModelRouteCandidate[]
  candidateIndex: number
  currentRoute: ModelRouteSelection
  /** Host intent the runtime currently holds the lease for (changes on fallback switches). */
  intentId: string
  lease: HostTurnLease
  /** Candidate results already journaled on the row when execution started. */
  resultsAtStart: number
  responseCommitted: boolean
  persistSkipReason?: 'human_selection_changed'
  /** Turn this claim owns on the target Agent. */
  readonly turn: number
  closed: boolean
  /** Pre-freeze effective baseline snapshot: the fallback resolver reads this
   * so the frozen task route parked in the fold can never misinform
   * `session_default` mid-run. Pure read snapshot; the durable baseline
   * ownership itself is fully the host's after Task 2. */
  displacedBaseline?: ModelRouteSelection | null
  /** The replayable identity the host record binds to (session-link message id). */
  readonly messageId: SessionLinkMessageId
  lastFailureCode?: string
  lastFailureMessage?: string
}

/** The per-Agent runtime wiring. */
interface AgentRuntime {
  active?: ActiveClaim
  /** Claimed session-link messages yet to activate, keyed by their owning turn: the
   * claimed event precedes the durable binding (brief 4d ordering), so the
   * first `agent/request` for that turn gates just-in-time. */
  claimedPending?: Map<number, SessionLinkMessageId>
  /**
   * IMPORTANT-2 (final review): a turn the pre-step gate REFUSED to activate
   * (mixed batch). Under the unified host owner, the original-owner yield is
   * durable-fact-driven (a finished/cancelled claim never yields), so the
   * human steps of this turn CANNOT inherit the task route; this marker now
   * only records the refusal for observability, never to own a restore.
   */
  mixedDeniedTurn?: number
  /** Seeded provider/model the Agent declared at creation, used as the baseline
   * fallback when the durable projection has not yet recorded one. */
  seededOptions?: { provider?: string; model?: string; reasoningEffort?: string }
  /** Outbox-pump trigger fired after every event-producing projection so a
   * runtime-committed event reaches the sender without waiting for an
   * unrelated tool call (CRITICAL-2). */
  schedulePump?: () => void
}

/* --------------------------------------------------------------------------
 * Pure helpers the wire layer shares
 * ------------------------------------------------------------------------ */

/** The first concrete route of a policy, for `requestedModel` wire projections. */
export function requestedRouteOf(policy: ModelRoutingPolicy): ModelRouteSelection {
  for (const candidate of policy.candidates) {
    if (!('use' in candidate)) return candidate
  }
  return { provider: 'session', model: 'session_default' }
}

/** Aggregate the recorded attempt outcomes into one needs_decision reason. */
function exhaustionReason(attempt: SessionLinkTaskAttempt): string {
  const seen = new Set<string>()
  for (const result of attempt.results) {
    if (result.code !== undefined) seen.add(result.code)
  }
  if (seen.has(CATALOG_UNAVAILABLE)) return 'catalog_unavailable'
  return CANDIDATES_EXHAUSTED_REASON
}

/**
 * The sync-precheck failure commitment (plan §3 wire `reason` + per-candidate
 * results) from the catalog precheck the admission layer just performed.
 * Concrete candidates only: the session-default sentinel is never catalog-
 * checked. A catalog-unavailable verdict poisons everything AFTER it — later
 * routes are unknown, so they are recorded with `catalog_unavailable` too.
 */
export function precheckFailureOf(
  policy: ModelRoutingPolicy,
  checks: readonly { ok: boolean; code?: string; message?: string; route: ModelRouteSelection }[],
): { reason: string; results: { route: ModelRouteSelection; code: string; message?: string }[] } {
  const results: { route: ModelRouteSelection; code: string; message?: string }[] = []
  let poisoned = false
  for (const candidate of policy.candidates) {
    if ('use' in candidate) continue
    const check = checks.find(entry => entry.route === candidate)
    if (check !== undefined && check.ok) continue
    const code = poisoned ? CATALOG_UNAVAILABLE : (check?.code ?? MODEL_NOT_FOUND)
    results.push({
      route: {
        provider: candidate.provider,
        model: candidate.model,
        ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
      },
      code,
      ...(poisoned ? {} : check?.message === undefined ? {} : { message: check.message }),
    })
    if (!poisoned && check?.code === CATALOG_UNAVAILABLE) poisoned = true
  }
  return {
    reason: results.length === 0
      ? CANDIDATES_EXHAUSTED_REASON
      : results.some(entry => entry.code === CATALOG_UNAVAILABLE) ? 'catalog_unavailable' : CANDIDATES_EXHAUSTED_REASON,
    results,
  }
}

/* --------------------------------------------------------------------------
 * The runtime
 * ------------------------------------------------------------------------ */

/** Live pair-membership probe the runtime shares with the task service. */
export interface TaskRuntimeLinksProbe {
  pairLinked(linkId: SessionLinkId, first: unknown, second: unknown): boolean
}

/** Resolve the durable task service lazily: the row context may evaluate it
 * before the task service fiber settles, so every call site re-resolves. */
export type TaskServiceResolver = () => SessionLinkTaskService

/**
 * Install the task runtime for one live top-level Agent in its own scope.
 * Mounted per Agent by the plugin row; disposal releases the live claim.
 * @param ctx - the Agent-scoped cordis context.
 * @param agent - the live Agent this runtime drives.
 * @param tasks - resolver for the durable task service (root context; shared domain).
 * @param links - live link-pair probe re-validated at activation.
 * @param options.host - injectable capability (tests); defaults to resolveTaskHost.
 * @param options.schedulePump - outbox-pump trigger the runtime calls after
 *   every event-producing projection (CRITICAL-2): runtime-committed events
 *   never wait for an unrelated tool call to reach the sender.
 * @param options.ensureHost - single-flight capability arming (F-C1b): the
 *   claimed gates call it when no capability resolves yet, so a cold target
 *   that became live without the row's arming is armed before claim instead
 *   of dropping the managed message onto the baseline.
 */
export function installTaskRuntime(
  ctx: Context,
  agent: Agent,
  tasks: SessionLinkTaskService | TaskServiceResolver,
  links: TaskRuntimeLinksProbe,
  options: {
    host?: HostTaskHostCapability
    schedulePump?: () => void
    ensureHost?: () => Promise<HostTaskHostCapability | undefined>
  } = {},
): void {
  const resolveTasks = typeof tasks === 'function' ? tasks : () => tasks
  /** Fire-and-forget pump trigger for a just-committed projection. */
  const pumpNow = (): void => {
    try { options.schedulePump?.() } catch { /* the pump's own pass logs */ }
  }
  const runtime: AgentRuntime = {
    seededOptions: (() => {
      const options = (agent as unknown as { options?: { provider?: string; model?: string; reasoningEffort?: string } }).options
      return options === undefined ? undefined : { ...options }
    })(),
    schedulePump: pumpNow,
  }
  /**
   * The capability MUST be resolvable at mount on a capable host. The host
   * installs it on every controller-created/resumed Agent (Task 2 unified
   * ownership); the plugin's lazy factory only arms Agents the controller
   * never adopted (legacy/plugin-adopted path). Both paths publish the SAME
   * cordis-visible instance, so route ownership never splits. A host without
   * the factory yields undefined and the message stays unmanaged (legacy
   * honesty).
   */
  const cap = (): HostTaskHostCapability | undefined => options.host ?? resolveTaskHost(agent.ctx)
  /**
   * F-C1b backstop: arm the capability through the injected single flight when
   * a managed message arrived before any other path installed it. Returns the
   * capability when arming succeeded; a host that cannot fabricate one yields
   * undefined and the message stays unmanaged (legacy honesty).
   */
  const armHost = async (): Promise<HostTaskHostCapability | undefined> => {
    const current = cap()
    if (current !== undefined) return current
    if (options.ensureHost === undefined) return undefined
    return await options.ensureHost().catch(() => undefined)
  }

  /* ------------------------------------------------------------------
   * JIT activation listener (request-time, activation ONLY): the first
   * request of a turn that claimed session-link mail activates against the
   * durable binding. The runtime NEVER rewrites `agent/request` output or
   * `system-prompt/assemble` output — route ownership is the HOST's unified
   * task-host freeze, so two waterfalls can no longer compete over one turn
   * (R02). F2/IMPORTANT-2 mixed-batch honesty and the displaced-baseline
   * restore moved into the host capability, which is mounted for every
   * controller-created and plugin-adopted Agent.
   * ---------------------------------------------------------------- */
  ctx.on('agent/request', async (payload, next) => {
    // Just-in-time activation: the first request of a turn that claimed
    // session-link mail activates against the durable binding (which is
    // established by the caller's send chain by now, brief 4d). The pre-step
    // gate handles the mixed-batch refusal; this gate is strictly a JUST-IN-
    // TIME retry for a delivery whose binding landed between the claim and
    // the first request (the synchronous-wake race the brief allowed).
    if (runtime.active === undefined || runtime.active.closed) {
      const host = cap()
      const pending = runtime.claimedPending
      const messageId = pending?.get(payload.turn)
      if (host !== undefined && messageId !== undefined) {
        const record = host.getTurnIntentByMessageId(messageId as never)
        if (record !== undefined && (record.status === 'claimed' || record.status === 'started')) {
          // The activation needs the plugin row, which the caller's send chain
          // commits across the same microtask budget as this return waterfall;
          // retry briefly so the binding lands before the step's request.
          pending!.delete(payload.turn)
          for (let attempt = 0; attempt < 24; attempt += 1) {
            try {
              await activate(resolveTasks(), links, host, runtime, record.intentId, messageId, payload.turn)
            } catch { /* retried below */ }
            if (runtime.active !== undefined && !runtime.active.closed) break
            await new Promise<void>(resolve => setTimeout(resolve, 4))
          }
        }
      }
    }
    return await next()
  })


  /* ------------------------------------------------------------------
   * Claimed-message gate: the delivered session-link message just entered a
   * turn. The runtime activates ONLY against the durable binding (brief 4d):
   * a pre-bound delivery activates synchronously; a delivery whose binding
   * races the wake (planned ordering resolution) parks on its turn number and
   * is claimed just-in-time by the first `agent/request` of that turn.
   * ---------------------------------------------------------------- */
  ctx.on('agent/inbox/claimed', (payload: { agent: Agent; message: { source?: unknown }; turn: number }) => {
    if (agent.session.header.origin === 'subagent') return
    const host = cap()
    if (host === undefined) {
      /* F-C1b: a session-link message reached a claim before ANY path armed
       * this Agent (a cold target that became live between admission and
       * delivery, or a post-restart claim). Park the identity, arm the
       * capability through the single flight, and let the pre-step gate
       * (which awaits the same flight) manage the turn when arming
       * succeeds; a non-fabricating host leaves the message unmanaged, the
       * same legacy honesty a host without the capability always had. */
      const parkedId = messageIdOf(payload.message as { source?: unknown })
      if (parkedId === undefined) return
      const pending = runtime.claimedPending ?? new Map<number, SessionLinkMessageId>()
      runtime.claimedPending = pending
      pending.set(payload.turn, parkedId)
      void armHost()
      return
    }
    const record = hostRecordFor(payload.message as { source?: unknown }, host)
    const rawMessageId = record === undefined
      ? messageIdOf(payload.message as { source?: unknown })
      : record.messageId as unknown as SessionLinkMessageId
    if (rawMessageId === undefined) return
    /* IMPORTANT-2 re-activation: a CANCELLED record (the mixed refusal withdrew
     * the pre-claim's intent to unfreeze its human batch) is not a routing
     * denial — the durable task row behind it stays `queued`. Park the turn so
     * the PRE-STEP gate re-records the intent and activates the SOLO turn;
     * everything else about the claim lifecycle is unchanged. A record in any
     * other status parks exactly as before. */
    const messageId = (record?.status === 'cancelled'
      ? messageIdOf(payload.message as { source?: unknown }) ?? rawMessageId
      : rawMessageId) as SessionLinkMessageId

    /* F2 (Task-5 review) + IMPORTANT-2 (final review): the PRE-STEP gate
     * below is the ONLY control point that may activate a claimed delivery —
     * it sees the whole claimed batch and activates strictly into a SOLO
     * one. This claimed gate only ever PARKS the message; it never activates
     * inline. An inline activation here cannot know whether the batch is
     * mixed (the inbox claim emits per message, never exposing the rest of
     * the batch), and activating into a mixed batch freezes its human step
     * onto the task route — the exact hole the pre-step refusal exists to
     * close. The binding-race case (brief 4d: binding lands between claim
     * and the step) is covered by the same pre-step gate re-reading the
     * durable row, and by the JIT request gate as its retry. */
    const pending = runtime.claimedPending ?? new Map<number, SessionLinkMessageId>()
    runtime.claimedPending = pending
    pending.set(payload.turn, messageId)
  })

  /* Pre-step is the LAST control point before a step's request resolves, and
   * it carries the message→turn correlation payload.messages. Activation
   * happens there against the WHOLE claimed batch, and only into a SOLO one
   * — NEVER inside the agent/request waterfall (a session append inside that
   * waterfall is not a legal host contract).
   *
   * F2 (Task-5 review): a claimed batch that contains BOTH a tracked
   * delivery AND any message the task does not own (e.g. the human's waking
   * message, claimed as one atomic batch) REFUSES tracked activation into
   * the mixed turn — otherwise the whole turn (including the human step)
   * freezes onto the task route. Instead the tracked message is re-appended
   * durably to the NEXT-TURN queue behind the batch that carried it, and it
   * activates at its SOLO later turn; the human step of the mixed batch
   * runs on the session baseline. The task row stays `queued`; nothing
   * about the refusal blocks or fails it. This pre-step listener re-checks
   * by sender attribution, never trusts the parked ids alone, and only ever
   * activates a batch whose every session-link message belongs to the task
   * being activated (the solo case). */
  ctx.on('agent/pre-step', async (payload, next) => {
    if (runtime.active !== undefined && !runtime.active.closed) return await next()
    const pending = runtime.claimedPending
    if (pending === undefined || pending.size === 0) return await next()
    /* F-C1b: the claimed gate may have parked a managed message while no
     * capability existed yet; this gate is the LAST point before the step's
     * request resolves, so it awaits the same single-flight arming rather
     * than letting a managed delivery run the baseline. */
    const host = cap() ?? await armHost()
    if (host === undefined) return await next()
    const tracked: { message: UserMessage; record: NonNullable<ReturnType<typeof hostRecordFor>> }[] = []
    for (const message of payload.messages) {
      let record = hostRecordFor(message as { source?: unknown }, host)
      const mid = messageIdOf(message as { source?: unknown })
      if (mid === undefined) continue
      /* Mixed-refusal re-activation (IMPORTANT-2): the refusal cancelled the
       * pre-claim's intent so its human batch could unfreeze; the task row
       * still names the cancelled intent. Re-record a fresh intent against
       * the same row's policy, atomically rebind the row onto it, and re-park
       * the turn so the SOLO activation below claims the fresh intent — the
       * re-activated task never reuses a cancelled durable fact. */
      if (record !== undefined && record.status === 'cancelled') {
        const row = findRowByBinding(resolveTasks(), mid, record.intentId)
        if (row === undefined || !['queued', 'preparing'].includes(row.taskState)) continue
        const attempt = row.attempts.find(candidate => candidate.attemptId === row.currentAttemptId)
        const candidates = attempt?.candidates ?? row.policy.candidates
        const concrete = candidates.find((candidate): candidate is ModelRouteSelection => !('use' in candidate))
        const route: HostTaskRoute = concrete === undefined
          ? {}
          : { selection: { provider: concrete.provider, model: concrete.model, ...(concrete.reasoningEffort === undefined ? {} : { reasoningEffort: concrete.reasoningEffort }) } }
        const fresh = host.recordTurnIntent({
          taskId: taskIdOf(row),
          attemptId: row.currentAttemptId,
          messageId: mid as never,
          route,
          persistOnSuccess: row.policy.scope === 'session',
        })
        try {
          await resolveTasks().rebindTurnIntent(taskIdOf(row), row.revision, { from: record.intentId, to: fresh.intentId })
        } catch { /* a concurrent rebind won; read whoever the row now names */ }
        record = host.getTurnIntent(fresh.intentId) ?? record
      }
      if (record === undefined || (record.status !== 'claimed' && record.status !== 'started')) continue
      const messageId = record.messageId as unknown as SessionLinkMessageId
      if (![...pending.values()].includes(messageId)) {
        /* A cancelled-record re-activation earns the turn's park slot
         * honestly even when the claimed gate saw the earlier cancelled
         * record and parked nothing. */
        if (record.status === 'claimed') pending.set(payload.turn, messageId)
        else continue
      }
      tracked.push({ message, record })
    }
    if (tracked.length === 0) return await next()
    if (payload.messages.length > tracked.length) {
      /* Mixed batch refusal (F2 + IMPORTANT-2): re-append the tracked
       * messages behind everything this batch carries AND settle the parked
       * live claim the admission layer pre-claimed for each. A merely re-
       * queued message leaves its claim `started` on THIS turn, so the host's
       * durable yield keeps rewriting the batch's HUMAN steps onto the task
       * route — the exact freeze the refusal exists to prevent. The host owns
       * the transition end-to-end (`parkManagedInput`): re-queue the managed
       * input AND cancel the still-unstarted claim, closing the yield window;
       * the intent re-records when its SOLO later turn activates (admission
       * already treats re-send of a finished/cancelled message as a new
       * intent), and the task row stays honestly `queued` until then. */
      for (const { message } of tracked) {
        const parked = await parkManagedInputLazy(agent as never, message as never)
        if (!parked) agent.inbox.append('next-turn', message)
      }
      /* IMPORTANT-2 wake fix: the re-queue is host-owned (`parkManagedInput`)
       * and its wake travels through the host's own re-delivery send path;
       * the plugin never wakes manual inboxes. */
      /* IMPORTANT-2 (final review): the re-appended messages leave THIS
       * turn's batch, so they must leave THIS turn's parked claims too —
       * otherwise the human step's first agent/request of the same turn
       * finds the stale parked entry and activates the task into the human
       * turn, freezing it onto the task route. They re-park honestly when
       * the genuine next-turn claim fires. */
      for (const { record } of tracked) {
        const dropped = record.messageId as unknown as SessionLinkMessageId
        for (const [turn, parked] of [...pending.entries()]) {
          if (parked === dropped) pending.delete(turn)
        }
      }
      // IMPORTANT-2: marker only — the durable yield no longer yields this
      // turn (the parked claim just cancelled), so no restore owner is needed.
      runtime.mixedDeniedTurn = payload.turn
      const rest = payload.messages.filter(message => !tracked.some(entry => entry.message === message))
      const decision = await next()
      if (decision.kind === 'enter') return { ...decision, messages: rest }
      return decision
    }
    // Solo batch: every session-link message in it belongs to the single
    // first task this runtime activates; activate inline at pre-step, where
    // a session append is legal before the step's request resolves.
    const [{ record }] = tracked
    const messageId = record.messageId as unknown as SessionLinkMessageId
    for (const [turn, parked] of [...pending.entries()]) {
      if (parked === messageId) pending.delete(turn)
    }
    await activate(resolveTasks(), links, host, runtime, record.intentId, messageId, payload.turn)
      .catch(() => { /* activation paths project via their own CAS writes */ })
    return await next()
  })

  ctx.on('agent/assistant-stream', ({ frame }) => {
    const active = runtime.active
    if (active === undefined || active.closed) return
    if (frame.type !== 'end') return
    const end = frame as { outcome?: { kind?: string; eventType?: string } }
    // Only a committed assistant MESSAGE counts as the first committed
    // response: an assistant/attempt settle is the failed attempt's durable
    // accounting, not a response (plan clause 5's side-effect boundary).
    if (end.outcome?.kind === 'committed' && end.outcome.eventType === 'assistant/message') {
      active.responseCommitted = true
    }
  })
  ctx.on('session/event', (_session, event) => {
    const active = runtime.active
    if (active === undefined || active.closed) return
    const typed = event as { type: string; data: unknown }
    if (typed.type !== 'turn/end') return
    const data = typed.data as { turn: number; reason?: { kind: string; error?: { code?: string; message?: string } } }
    if (data.turn !== active.turn) return
    const host = cap()
    if (host === undefined) return
    // Mark the claim closed FIRST so a follow-up turn's request waterfall
    // never reads a stale runtime freeze before close lands.
    active.closed = true
    runtime.active = undefined
    // Do the capability close synchronously so the route freeze NEVER leaks
    // into the very next turn; retry commit/finish defensively past the
    // publish-cycle's reentry rejection the host's inner appends can hit.
    const snapshot = active
    // Project the task row INLINE (pure domain writes; never appends onto the
    // same session, so the emit publish cycle never blocks it) — the caller
    // resuming from `whenIdle()` observes turn_finished immediately. The host
    // lifecycle facts (turn commits, baseline CAS persist) are deferred behind
    // the publish boundary, where their session appends are legal.
    // Project inline from the claim's facts when the host finish is certain
    // NOT to inform the projection (the baseline-persist skip only matters
    // under session-scope policies; task-scope projections don't need host
    // CAS facts).
    const needsPersistOutcome = snapshot.policy.scope === 'session'
    if (!needsPersistOutcome) {
      void projectFinishTasks(snapshot, resolveTasks(), data.reason ?? { kind: 'completed' }, pumpNow)
        .catch(error => ctx.logger.warn(`task-runtime: finish projection for "${active.taskId}" failed: ${String(error)}`))
    }
    void (async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < 16; attempt += 1) {
        try {
          const outcome = await closeHost(snapshot, host)
          if (needsPersistOutcome) {
            snapshot.persistSkipReason = outcome.persistSkipReason ?? snapshot.persistSkipReason
            try {
              await projectFinishTasks(snapshot, resolveTasks(), data.reason ?? { kind: 'completed' }, pumpNow)
            } catch (error: unknown) {
              ctx.logger.warn(`task-runtime: finish projection for "${active.taskId}" failed: ${String(error)}`)
            }
          }
          return
        } catch (error: unknown) {
          lastError = error
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('cannot reenter') && !message.includes('reentrant')) break
          await new Promise<void>(resolve => setTimeout(resolve, 8))
        }
      }
      ctx.logger.warn(`task-runtime: host finish for "${active.taskId}" failed: ${String(lastError)}`)
    })().catch(error => ctx.logger.warn(`task-runtime: host close loop crashed: ${String(error)}`))
  })

  /* ------------------------------------------------------------------
   * Fallback decision point (same step only). The runtime classifies from the
   * failure the loop carries, not from a durable read-back. Exhausted or
   * non-retryable classes stay terminal: the resulting turn/end projects
   * waiting_decision (resumable, uncommitted) or interrupted (cancel).
   * ---------------------------------------------------------------- */
  ctx.on('agent/request-error', async (payload, next) => {
    const active = runtime.active
    if (active === undefined || active.closed || payload.turn !== active.turn) return await next()
    const failure = payload.failure as { code?: string; message?: string }
    active.lastFailureCode = failure.code
    active.lastFailureMessage = failure.message
    if (active.responseCommitted) return await next()
    if (failure.code === undefined || !RETRYABLE_FAILURE_CODES.has(failure.code)) return await next()
    const host = cap()
    if (host === undefined) return await next()
    /* R12: the host tracks output substance durably (any chunk observed, a
     * committed assistant/message, or a dispatched tool). When any is true
     * automatic fallback is BARRED — the user already saw partial output, so
     * a silent route switch is no longer honest; the terminal projection
     * surfaces partial/unknown. */
    const verdict = host.evaluateRetry(active.intentId)
    if (verdict.automaticFallbackAllowed === false) return await next()
    const switched = await switchCandidate(resolveTasks(), host, runtime, active)
    if (!switched) return await next()
    return { kind: 'retry' }
  })

  /* Disposal: release the live uncommitted claim so the durable record NEVER
   * reads as implicitly executable after unload. */
  ctx.effect(() => () => {
    const active = runtime.active
    if (active === undefined || active.closed) return
    active.closed = true
    runtime.active = undefined
    const host = cap()
    if (host === undefined) return
    void host.cancelTurnIntent(active.intentId, 'plugin unload').catch(() => {})
  }, 'task-runtime: release claim')
}

/* --------------------------------------------------------------------------
 * Gate internals
 * ------------------------------------------------------------------------ */

/** The host intent a claimed message is managed by, when one exists. */
function hostRecordFor(
  message: { source?: unknown },
  host: HostTaskHostCapability,
): ReturnType<HostTaskHostCapability['getTurnIntentByMessageId']> {
  const source = (message as { source?: { kind?: string; messageId?: string } }).source
  if (source?.kind !== 'session-link-message' || source.messageId === undefined) return undefined
  return host.getTurnIntentByMessageId(source.messageId as never)
}

/** The durable row whose binding names this exact (messageId, intentId) pair. */
function findRowByBinding(
  tasks: SessionLinkTaskService,
  messageId: SessionLinkMessageId,
  intentId: string,
): SessionLinkTaskRecordData | undefined {
  return tasks.listRows().find(row => row.execution.messageId === messageId && row.execution.turnIntentId === intentId)
}

/**
 * Enter the TASK path: validate, claim, then `queued → running` strictly after
 * the host claim succeeded (the accepted-level binding is durable before the
 * task may execute). All refusal projections go through {@link projectWait}.
 */
async function activate(
  tasks: SessionLinkTaskService,
  links: TaskRuntimeLinksProbe,
  host: HostTaskHostCapability,
  runtime: AgentRuntime,
  intentId: string,
  messageId: SessionLinkMessageId,
  turn: number,
): Promise<void> {
  const row = findRowByBinding(tasks, messageId, intentId)
  if (row === undefined) return
  const taskId = taskIdOf(row)
  if (row.execution.turnIntentId !== intentId) {
    return
  }
  if (row.taskState === 'cancelled' || row.taskState === 'turn_finished' || row.taskState === 'failed') {
    return
  }

  // Execution re-validation: the pair must still hold the live grant. Not-yet-
  // started tracked tasks gain NO execution permission after unlink (brief 4f-iv).
  const linked = row.execution.linkId === undefined || row.targetSessionId === undefined
    ? true
    : links.pairLinked(row.execution.linkId, row.callerId, row.targetSessionId)
  if (!linked) {
    await projectWait(tasks, host, runtime, row, 'queue_denied_unlinked', 'not_started', false)
    return
  }

  let lease: HostTurnLease
  try {
    lease = await host.claimTurnIntent(intentId)
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'TASK_NOT_CLAIMABLE'
    // The admission layer PRE-CLAIMS the same intent right after recordTurnIntent
    // so the host's `agent/inbox/claimed` listener binds its per-turn lease even
    // when the mailbox synchronously wakes inside `send` (brief 4d). The host's
    // own claim may already be started for the very same turn we are activating;
    // reuse it instead of claiming a second time.
    const existing = host.getTurnIntent(intentId)
    if (code !== 'TASK_NOT_CLAIMABLE' || existing === undefined
      || (existing.status !== 'claimed' && existing.status !== 'started')) {
      await projectWait(tasks, host, runtime, row, `task_claim_failed:${code}`, 'not_started', true)
      return
    }
    lease = {
      intent: existing,
      route: existing.route.selection,
      release: () => { /* owned by the admission layer; the close path finishes it */ },
    }
  }
  const fresh = tasks.getRow(taskId)
  if (fresh === undefined || !['queued', 'preparing'].includes(fresh.taskState)) {
    lease.release()
    await host.cancelTurnIntent(intentId, 'task state changed during claim').catch(() => {})
    return
  }
  const attempt = fresh.attempts.find(candidate => candidate.attemptId === fresh.currentAttemptId)
  const candidates: readonly ModelRouteCandidate[] = attempt?.candidates ?? fresh.policy.candidates
  /* R10 (MODEL_ROUTING_FIX_PLAN Task 3): the sync precheck fixed its SELECTED
   * candidate onto the attempt row (selectedCandidateIndex). Activation
   * starts the walk at THAT index and re-validates the fixed candidate
   * against the durable host intent's route (the binding truth — its
   * selection IS the precheck's choice when the admission request truly
   * selected a concrete route); a fixed concrete route whose own candidate
   * disappeared from the row falls to the next candidate honestly rather
   * than silently re-deriving `candidates[0]` (the pre-fix behavior the
   * R10 review probe caught executing the rejected primary). A pre-R10 row
   * (absent index) keeps its pre-fix search from the first concrete route.
   * The host intent's recorded route is the authorized SELECTION for this
   * delivery — when it names a concrete entry the walk aligns its index to
   * it so `currentRoute` is the precheck's selection, not candidates[0]. */
  let candidateIndex = 0
  let currentRoute: ModelRouteSelection
  if (attempt?.selectedCandidateIndex !== undefined) {
    candidateIndex = Math.min(attempt.selectedCandidateIndex, candidates.length - 1)
    const fixed = candidates[candidateIndex]
    if (fixed !== undefined && !('use' in fixed)) {
      currentRoute = { provider: fixed.provider, model: fixed.model, ...(fixed.reasoningEffort === undefined ? {} : { reasoningEffort: fixed.reasoningEffort }) }
    } else {
      /* The fixed position is a default sentinel: the same unified-snapshot
       * chain the fallback switch resolves through reads the displaced
       * baseline; a R13 first-turn default resolves from that snapshot (the
       * host intent's recorded route selection authoritative FIRST). */
      const intentRoute = host.getTurnIntent(intentId)?.route.selection
      currentRoute = intentRoute === undefined
        ? { provider: 'session', model: 'session_default' }
        : { provider: intentRoute.provider, model: intentRoute.model, ...(intentRoute.reasoningEffort === undefined ? {} : { reasoningEffort: intentRoute.reasoningEffort }) }
    }
  } else {
    const intentRoute = host.getTurnIntent(intentId)?.route.selection
    const concrete = candidates.find((candidate): candidate is ModelRouteSelection => !('use' in candidate))
    if (intentRoute !== undefined && concrete !== undefined) {
      const aligned = candidates.findIndex(candidate => !('use' in candidate)
        && candidate.provider === intentRoute.provider && candidate.model === intentRoute.model)
      if (aligned !== -1) candidateIndex = aligned
    }
    currentRoute = intentRoute ?? concrete ?? { provider: 'session', model: 'session_default' }
  }
  // Snapshot the effective baseline BEFORE the frozen header displaces it:
  // the fallback resolver (`session_default`) reads this snapshot, never the
  // fold's lastUsed mid-run. Baseline ownership and its post-close restore
  // belong fully to the host; this snapshot reads only this claim's fallback
  // decision. The projection may read null while the Agent's own declared
  // route stands (nothing explicitly selected yet): fall back to the seeded
  // route.
  const baselineSnapshot = host.readBaseline().effective ?? (() => {
    const options = runtime.seededOptions
    const snap = options?.provider !== undefined && options.model !== undefined
      ? {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      }
      : null
    return snap
  })()
  runtime.active = {
    taskId,
    attemptId: fresh.currentAttemptId,
    policy: fresh.policy,
    candidates,
    candidateIndex,
    currentRoute,
    intentId,
    lease,
    resultsAtStart: attempt?.results.length ?? 0,
    responseCommitted: false,
    turn,
    closed: false,
    displacedBaseline: baselineSnapshot === null ? null : {
      provider: baselineSnapshot.provider,
      model: baselineSnapshot.model,
      ...(baselineSnapshot.reasoningEffort === undefined ? {} : { reasoningEffort: baselineSnapshot.reasoningEffort }),
    },
    messageId,
  }
  try {
    tasks.assertBindingDurable(taskId)
    await tasks.requestStateChange(taskId, fresh.revision, { toState: 'running', currentRoute })
  } catch (error: unknown) {
    runtime.active = undefined
    lease.release()
    await host.cancelTurnIntent(intentId, 'binding state projection failed').catch(() => {})
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'TASK_BINDING_INCOMPLETE'
    await projectWait(tasks, host, runtime, fresh, `admission_failed:${code}`, 'not_started', true)
  }
}

/**
 * Commit one `waiting_decision` projection strictly once: the row's current
 * revision gates the CAS, so a concurrent transition simply drops this
 * projection instead of double-emitting an outbox event.
 */
async function projectWait(
  tasks: SessionLinkTaskService,
  host: HostTaskHostCapability,
  runtime: AgentRuntime,
  row: SessionLinkTaskRecordData,
  reason: string,
  executionState: 'not_started' | 'partial' | 'unknown',
  decisionRequired: boolean,
): Promise<void> {
  const active = runtime.active
  if (active !== undefined) {
    runtime.active = undefined
    try { await host.cancelTurnIntent(active.intentId, reason) } catch { /* best-effort */ }
  }
  const event: TaskEventInput = {
    kind: 'model_unavailable',
    executionState,
    reason,
    requestedModel: requestedRouteOf(row.policy),
    attempts: row.attempts.at(-1)?.results.length ?? 0,
    decisionRequired,
    resumable: false,
  }
  try {
    await tasks.requestStateChange(taskIdOf(row), row.revision, {
      toState: 'waiting_decision',
      executionState,
      reason,
      events: [event],
    })
    /* CRITICAL-2: this projection committed an outbox event; the sender
     * must not wait for an unrelated tool call before the notification. */
    runtime.schedulePump?.()
  } catch { /* CAS conflict: a concurrent projection already landed honestly */ }
}

/** Recover the stable task identity from a stored row. */
function taskIdOf(row: SessionLinkTaskRecordData): SessionLinkTaskId {
  return `task:${row.callerId}:${row.callId}` as SessionLinkTaskId
}

/* --------------------------------------------------------------------------
 * Candidate switching
 * ------------------------------------------------------------------------ */

/**
 * Switch one active claim to its next candidate INSIDE one step: journal the
 * failure of the CURRENT route, resolve session_default ONCE against the live
 * baseline (frozen onto the attempt, never re-sampled), cancel the current
 * intent, re-record on the SAME messageId, claim the new intent, and point
 * the runtime freeze at the fresh route. Returns false when no candidate
 * remains or any step fails (the failure then stays terminal).
 */
async function switchCandidate(
  tasks: SessionLinkTaskService,
  host: HostTaskHostCapability,
  runtime: AgentRuntime,
  active: ActiveClaim,
): Promise<boolean> {
  const nextIndex = active.candidateIndex + 1
  if (nextIndex >= active.candidates.length) return false
  const nextCandidate = active.candidates[nextIndex]
  if (nextCandidate === undefined) return false

  const row = tasks.getRow(active.taskId)
  if (row === undefined || row.taskState !== 'running') return false
  let revision = row.revision

  /* F1 (Task-5 review): resolve the next route FIRST so the fallback
   * notification can name it. The CURRENT route's failure journal and the
   * single `model_fallback_selected` outbox event ride the SAME CAS — the
   * runtime never emits the event without the failed-route fact landing
   * with it. One switch emits exactly one event: the revision-gated CAS
   * succeeds once per call, an eventId collision across switches is
   * impossible (each switch's eventId derives from its own revision), and
   * a CAS conflict simply drops the projection instead of double-emitting.
   * decisionRequired false — the task keeps executing its replacement
   * route; resumable false — the switch neither reopens nor suspends
   * anything (the task is ALREADY running its new route). turn_finished's
   * actualModel remains the route authority for the completed turn. */
  let nextRoute: ModelRouteSelection | undefined
  let newFreezeRoute: ModelRouteSelection | undefined
  if ('use' in nextCandidate) {
    /* `session_default` resolves the TARGET's long-term baseline AT
     * ACTIVATION (Public Contract §1), never the frozen task route the
     * claim's header parked into `lastUsed` (readBaseline at switch time
     * would read the TASK'S OWN route back). The activation-time snapshot
     * the claim recorded is the honest pre-task baseline; a COLD projection
     * (snapshot null — e.g. a fresh spawn target) falls back to the Agent's
     * SEEDED creation options — the SAME fallback activate() already
     * applies — instead of falsely exhausting the attempt. */
    const baseline = host.readBaseline()
    const seeded = runtime.seededOptions
    const seededRoute = seeded !== undefined && seeded.provider !== undefined && seeded.model !== undefined
      ? {
        provider: seeded.provider,
        model: seeded.model,
        ...(seeded.reasoningEffort === undefined ? {} : { reasoningEffort: seeded.reasoningEffort }),
      }
      : null
    const resolvedDefault = active.displacedBaseline === undefined
      ? baseline.effective ?? seededRoute
      : active.displacedBaseline ?? seededRoute
    if (resolvedDefault === null) return false
    nextRoute = resolvedDefault
    newFreezeRoute = nextRoute
  } else {
    nextRoute = {
      provider: nextCandidate.provider,
      model: nextCandidate.model,
      ...(nextCandidate.reasoningEffort === undefined ? {} : { reasoningEffort: nextCandidate.reasoningEffort }),
    }
  }
  const fallbackEvent: TaskEventInput = {
    kind: 'model_fallback_selected',
    ...(active.lastFailureCode === undefined ? {} : { reason: active.lastFailureCode }),
    requestedModel: requestedRouteOf(active.policy),
    actualModel: nextRoute,
    attempts: row.attempts.find(candidate => candidate.attemptId === active.attemptId)?.results.length ?? 0,
    decisionRequired: false,
    resumable: false,
  }

  // Journal the CURRENT route's outcome PLUS the fallback notification, in
  // one CAS; the freeze binds under a second CAS (its own revision).
  try {
    await tasks.appendCandidateResult(active.taskId, revision, {
      route: active.currentRoute,
      outcome: 'unavailable',
      ...(active.lastFailureCode === undefined ? {} : { code: active.lastFailureCode }),
      ...(active.lastFailureMessage === undefined ? {} : { message: active.lastFailureMessage }),
    }, [fallbackEvent])
    revision = (tasks.getRow(active.taskId) ?? row).revision
    /* CRITICAL-2: the model_fallback_selected event just committed; the
     * sender must not wait for an unrelated tool call before it flows. */
    runtime.schedulePump?.()
  } catch {
    return false
  }

  if (newFreezeRoute !== undefined) {
    try {
      await tasks.freezeDefaultRoute(active.taskId, revision, newFreezeRoute)
      revision = (tasks.getRow(active.taskId) ?? row).revision
    } catch {
      return false
    }
  }

  const previousIntentId = active.intentId
  const hostRecordSource = host.getTurnIntent(previousIntentId)
  const messageId = hostRecordSource?.messageId ?? (active.messageId as never)
  const attempt = currentAttempt(tasks, active)
  const route = routeForHost(nextRoute, active.candidates, nextIndex, attempt)
  /* Unified-owner switch (R02/Task 2): the HOST owns the route swap end-to-end
   * — it re-checks the durable output-substance flag barrier, journals the
   * failure on the old intent, records + claims the fresh intent on the SAME
   * messageId, and re-aims the live lease onto the fresh route under the same
   * turn BEFORE returning. The plugin-side cancel→record→claim order the old
   * code used produced a fresh intent whose live claim never bound to this
   * turn's lease (only the agent/inbox/claimed listener can bind one, and it
   * already fired for the original), so the retried same-step request fell
   * back to the pre-task baseline instead of the new route. The plugin keeps
   * ONLY the durable row rebind (below) after the host commits the fresh
   * intent. */
  let fresh: { intent: ReturnType<HostTaskHostCapability['getTurnIntent']> & object; intentId: string }
  try {
    fresh = await host.switchRoute({
      previousIntentId,
      route,
      persistOnSuccess: active.policy.scope === 'session',
      ...(active.lastFailureCode === undefined ? {} : {
        failure: { code: active.lastFailureCode, message: active.lastFailureMessage ?? '' } as never,
      }),
      taskId: active.taskId,
      attemptId: active.attemptId,
      messageId: messageId as never,
    })
  } catch {
    return false
  }
  /* The lease the runtime hands onward. The host already bound the fresh
   * intent to this turn's freeze; this lease wrapper only needs to RELEASE
   * honestly at close (the host's own turnLease owns the revoke). */
  const lease: HostTurnLease = {
    intent: fresh.intent as never,
    route: fresh.intent?.route.selection,
    release: () => { /* owned by the host's turnLease; the close path finishes it */ },
  }
  /* IMPORTANT-4 (final review): the durable row must reference the LIVE
   * intent, not the cancelled one — a post-restart fold would otherwise
   * read execution.turnIntentId pointing at a cancelled host fact. Rebind
   * in ONE atomic row write guarded on the intent being replaced; a
   * concurrent projection that already moved the intent rows this CAS out
   * honestly (the switch aborts after releasing the fresh claim; the
   * turn's close projection settles). */
  try {
    await tasks.rebindTurnIntent(active.taskId, revision, { from: previousIntentId, to: fresh.intentId })
  } catch {
    lease.release()
    await host.cancelTurnIntent(fresh.intentId, 'switch rebind lost the CAS').catch(() => {})
    return false
  }
  active.lease.release()
  active.lease = lease
  active.intentId = fresh.intentId
  active.currentRoute = nextRoute
  active.candidateIndex = nextIndex
  runtime.active = active
  return true
}

/** The host route handed to one re-record: current selection + the remaining cycle. */
function routeForHost(
  selection: ModelRouteSelection,
  candidates: readonly ModelRouteCandidate[],
  fromIndex: number,
  attempt: SessionLinkTaskAttempt | undefined,
): HostTaskRoute {
  const remaining: HostModelSelection[] = []
  for (let index = fromIndex; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (candidate === undefined) continue
    if ('use' in candidate) {
      if (attempt?.defaultFrozenRoute !== undefined) remaining.push(attempt.defaultFrozenRoute)
      continue
    }
    remaining.push(candidate)
  }
  return {
    selection,
    ...(remaining.length === 0 ? {} : { candidateCycle: remaining }),
  }
}

/** The row's current attempt, re-read from the service. */
function currentAttempt(tasks: SessionLinkTaskService, active: ActiveClaim): SessionLinkTaskAttempt | undefined {
  return tasks.getRow(active.taskId)?.attempts.find(candidate => candidate.attemptId === active.attemptId)
}

/* --------------------------------------------------------------------------
 * Turn close
 * ------------------------------------------------------------------------ */

/** The session-link mailbox identity of one claimed message, when one exists. */
function messageIdOf(message: { source?: unknown }): SessionLinkMessageId | undefined {
  const source = (message as { source?: { kind?: string; messageId?: string } }).source
  return source?.kind === 'session-link-message' && source.messageId !== undefined
    ? (source.messageId as SessionLinkMessageId)
    : undefined
}

/**
 * Host-side finish facts: commit + finish the intent so durable host state
 * matches the task projection. The caller may retry this independently:
 * session-append reentrancy never blocks beyond the publish boundary.
 */
async function closeHost(
  active: ActiveClaim,
  host: HostTaskHostCapability,
): Promise<{ routeUsed?: ModelRouteSelection; persistSkipReason?: 'human_selection_changed' }> {
  let routeUsed: ModelRouteSelection | undefined
  let persistSkipReason: 'human_selection_changed' | undefined
  try {
    const outcome = await host.commitTurn(active.intentId)
    routeUsed = outcome.routeUsed === undefined ? undefined : {
      provider: outcome.routeUsed.provider,
      model: outcome.routeUsed.model,
      ...(outcome.routeUsed.reasoningEffort === undefined ? {} : { reasoningEffort: outcome.routeUsed.reasoningEffort }),
    }
    if (outcome.persist?.attempted === true && !outcome.persist.committed
      && outcome.persist.reason === 'human_selection_changed') {
      persistSkipReason = 'human_selection_changed'
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('cannot reenter') || message.includes('reentrant')) throw error
  }
  try { await host.finishTurn(active.intentId) } catch { /* already finished */ }
  return {
    ...(routeUsed === undefined ? {} : { routeUsed }),
    ...(persistSkipReason === undefined ? {} : { persistSkipReason }),
  }
}

/**
 * Project the task row state + ONE outbox event from the claim's own facts
 * (pure domain writes, no session appends): `turn_finished` on committed
 * response, `cancelled` on user/host cancel pre-response, `waiting_decision`
 * on terminal route failure. This NEVER blocks on host's own finish — it may
 * run while host lifecycle records are still deferred.
 */
async function projectFinishTasks(
  active: ActiveClaim,
  tasks: SessionLinkTaskService,
  reason: { kind: string; error?: { code?: string; message?: string } },
  schedulePump?: () => void,
): Promise<void> {
  const row = tasks.getRow(active.taskId)
  if (row === undefined) return
  const attempt = row.attempts.find(candidate => candidate.attemptId === active.attemptId)
  let revision = row.revision
  /** CRITICAL-2: every successful event-committing projection below pumps. */
  const pumped = (committed: boolean): void => {
    if (committed) {
      try { schedulePump?.() } catch { /* the pump's own pass logs */ }
    }
  }

  // Plan clause 5: the turn closed with a committed response only counts as
  // finished when it DIDN'T also end through a request failure after the
  // commit, and it DIDN'T end through user/host cancellation — the latter is
  // interrupted honestly below, not a finished turn.
  if (active.responseCommitted && reason.kind !== 'error' && reason.kind !== 'aborted') {
    const routeUsed = active.currentRoute
    if (attempt !== undefined) {
      const selectedAlready = attempt.results.some(entry => entry.outcome === 'selected'
        && entry.route.provider === routeUsed.provider && entry.route.model === routeUsed.model)
      if (!selectedAlready) {
        try {
          await tasks.appendCandidateResult(active.taskId, revision, { route: routeUsed, outcome: 'selected' })
          revision = (tasks.getRow(active.taskId) ?? row).revision
        } catch { /* never blocks the finish projection */ }
      }
    }
    try {
      await tasks.requestStateChange(active.taskId, revision, {
        toState: 'turn_finished',
        routeUsed,
        events: [{
          kind: 'turn_finished',
          requestedModel: requestedRouteOf(active.policy),
          actualModel: routeUsed,
          attempts: (attempt?.results.length ?? 0) + 1,
          decisionRequired: false,
          resumable: false,
          ...(active.persistSkipReason === undefined ? {} : { reason: PERSISTENT_SELECTION_SKIPPED }),
        }],
      })
      pumped(true)
    } catch { /* CAS conflict: state already landed */ }
    return
  }

  // User/host cancel of the target turn: NOT_STARTED (no committed response)
  // → cancelled; partial response → interrupted (honestly projected, never
  // auto-resumed). External effects are never rewound.
  const cancelled = reason.kind !== 'error' && reason.kind !== 'completed'
  if (cancelled) {
    const partial = active.responseCommitted
    const event: TaskEventInput = partial
      ? {
        kind: 'interrupted',
        executionState: 'partial',
        reason: `turn_cancelled:${reason.kind}`,
        requestedModel: requestedRouteOf(active.policy),
        attempts: attempt?.results.length ?? 0,
        decisionRequired: false,
        resumable: false,
      }
      : {
        kind: 'cancelled',
        executionState: 'not_started',
        reason: `turn_cancelled:${reason.kind}`,
        requestedModel: requestedRouteOf(active.policy),
        attempts: attempt?.results.length ?? 0,
        decisionRequired: false,
        resumable: false,
      }
    try {
      await tasks.requestStateChange(active.taskId, revision, {
        toState: partial ? 'interrupted' : 'cancelled',
        ...(partial ? { executionState: 'partial' } : {}),
        events: [event],
      })
      pumped(true)
    } catch { /* concurrently projected */ }
    return
  }

  if (attempt !== undefined && active.lastFailureCode !== undefined
    && !attempt.results.some(result => result.code === active.lastFailureCode && result.outcome === 'unavailable')) {
    try {
      await tasks.appendCandidateResult(active.taskId, revision, {
        route: active.currentRoute,
        outcome: 'unavailable',
        code: active.lastFailureCode,
        ...(active.lastFailureMessage === undefined ? {} : { message: active.lastFailureMessage }),
      })
      revision = (tasks.getRow(active.taskId) ?? row).revision
    } catch { /* fall through to the waiting_decision projection */ }
  }
  const finalRow = tasks.getRow(active.taskId) ?? row
  const finalAttempt = finalRow.attempts.find(candidate => candidate.attemptId === active.attemptId) ?? attempt
  const reasonString = finalAttempt === undefined ? CANDIDATES_EXHAUSTED_REASON : exhaustionReason(finalAttempt)
  // Plan clause 5 honesty: a committed response marks partial progression —
  // never auto-resume unknown external effects; `unknown` when neither a
  // committed response nor a no-effect guarantee applies.
  const executionState: 'not_started' | 'partial' | 'unknown' = active.responseCommitted ? 'partial' : 'not_started'
  try {
    await tasks.requestStateChange(active.taskId, revision, {
      toState: 'waiting_decision',
      executionState,
      reason: reasonString,
      events: [{
        kind: 'model_unavailable',
        executionState,
        reason: reasonString,
        requestedModel: requestedRouteOf(active.policy),
        attempts: finalAttempt?.results.length ?? 0,
        decisionRequired: true,
        // The host offers no pause/checkpoint → resume happens ONLY via the
        // sender's explicit retry decision against a not-started task.
        resumable: !active.responseCommitted,
      }],
    })
    pumped(true)
  } catch { /* CAS conflict: the row already settled */ }
}
