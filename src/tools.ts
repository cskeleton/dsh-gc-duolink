/**
 * Model-facing Session Link tools over `ctx.sessionLinks`. Link creation is
 * always host-authorized at the service: the spawn tool requests
 * `grantedBy: { kind: 'session' }` from the exact live caller's own turn, and
 * broad UI management grants use `kind: 'human'`. The tools register in the
 * scope of top-level Agents whose preset the row config lists, never in the
 * global tool layer. Named exports preserve loader injection metadata.
 * @module dsh-session-link/tool-session-link
 */

import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'
import { SessionLinkError, SessionLinkMessageId, SessionLinkTaskId } from './index.ts'
import type { SessionLinkId, SessionLinkSendResult } from './index.ts'
import type {} from './index.ts'
import { resolveTaskHost } from './host-capability.ts'
import {
  checkCandidateRoutes,
  CATALOG_UNAVAILABLE,
  ModelRoutingError,
  normalizeModelRoutingParams,
  parseModelRoutingParams,
  projectModelCatalog,
  readModelCatalog,
  SessionListModelsParamsError,
} from './model-policy.ts'
import type { ModelCatalogLike, ModelRouteSelection, ModelRoutingPolicy } from './model-policy.ts'
import { installTaskNotifications } from './task-notifications.ts'
import type { TaskNotificationPump } from './task-notifications.ts'
import { ensureTaskHostLazy } from './task-host-lazy.ts'
import { installTaskRuntime, precheckFailureOf, requestedRouteOf } from './task-runtime.ts'
import { TaskInvariantError, taskIdFor } from './tasks.ts'
import type { CreateTaskIntentInput, SavedTaskIntent, TaskEventInput } from './tasks.ts'
import type { SessionLinkTaskRecordData } from './task-spec.ts'
import { mountPerPresetAgent, PresetScopeConfig, resolvePresets } from './scope.ts'

export const name = 'tool-session-link'
export const inject = ['tools', 'agents', 'sessions', 'sessionLinks', 'sessionController', 'sessionTitle']

/** Row configuration: which presets' top-level Agents receive the tools. */
export type Config = PresetScopeConfig
/** Loader-visible row schema. */
export const Config = PresetScopeConfig

/**
 * Read one tracked task row at render time so the result can carry the task's
 * scope and state labels. Absent the task service (untracked legacy paths) the
 * extra context is omitted, never invented.
 * @returns the policy scope of the tracked task, or undefined when unavailable.
 */
function scopeOfTask(ctx: Context, taskId: string | undefined): 'task' | 'session' | undefined {
  if (taskId === undefined) return undefined
  try {
    return taskServiceOf(ctx).getRow(SessionLinkTaskId(taskId))?.policy.scope
  } catch {
    return undefined
  }
}

/**
 * The structured sidecar block appended AFTER the byte-identical first text
 * segment: the tracked-task identity, state/scope/route labels, and the
 * inspect/decision pointers. JSON keeps the transcript readable on every
 * host level; the client renders a dedicated card from these fields.
 * NEVER becomes the first block (legacy replay of the first segment).
 */
function taskResultSidecar(
  ctx: Context,
  tool: 'session_spawn_linked_session' | 'session_send_session_message',
  value: Record<string, unknown>,
): { type: 'text'; text: string }[] {
  if (!('outcome' in value)) return []
  const outcome = value.outcome as 'admitted' | 'needs_decision'
  const taskId = value.taskId as string
  const sessionId = 'sessionId' in value ? value.sessionId as string | undefined : undefined
  const linkId = 'linkId' in value ? value.linkId as string | undefined : undefined
  const scope = scopeOfTask(ctx, taskId)
  /* The wire shape omits requestedModel on a needs_decision path (no route was
   * ever authorized); read it and scope from the stored task policy instead —
   * never invented, read straight from the durable row. */
  let requested = 'requestedModel' in value && value.requestedModel !== undefined && value.requestedModel !== null
    ? value.requestedModel as { provider: string; model: string; reasoningEffort?: string }
    : undefined
  if (requested === undefined) {
    try {
      const row = taskServiceOf(ctx).getRow(SessionLinkTaskId(taskId))
      if (row !== undefined) requested = requestedRouteOf(row.policy)
    } catch { /* the sidecar stays partial rather than blocking the result */ }
  }
  const requestedText = requested === undefined
    ? undefined
    : `${requested.provider}/${requested.model}${requested.reasoningEffort === undefined ? '' : ` (effort ${requested.reasoningEffort})`}`
  const selected = 'selectedModel' in value
    ? value.selectedModel as { provider: string; model: string; reasoningEffort?: string } | undefined
    : undefined
  const scopeText = scope === undefined ? '' : ` · scope ${scope === 'session' ? 'session (persistent)' : 'task (this turn only)'}`
  const routeLine = requestedText === undefined
    ? ''
    : ` · requested ${requestedText}${selected === undefined ? '' : ` → selected ${selected.provider}/${selected.model}${selected.reasoningEffort === undefined ? '' : ` (effort ${selected.reasoningEffort})`}`}`
  return [{
    type: 'text' as const,
    text: [
      '---',
      'Tracked-task status (host facts; admission is never execution success). Machine-readable JSON follows.',
      `Task: ${taskId} · state ${value.taskState as string}${outcome === 'needs_decision' ? ` (${value.executionState as string})` : ''}${scopeText}${routeLine}`,
      outcome === 'needs_decision'
        ? `Waiting for a decision: every authorized candidate failed the catalog precheck (reason: ${value.reason as string}). `
          + (sessionId === undefined
            ? 'No Session was created and nothing was admitted for this task; '
            : 'The bound Session shows above; ')
          + 'read session_get_task and take exactly one decision with session_resolve_task.'
        : `Delivery accepted (${value.status as string}); acceptance is delivery only, not task success. Inspect with session_get_task; the task state or route facts may still move.`,
      JSON.stringify({
        type: 'session-link/task-result',
        version: 1,
        tool,
        outcome,
        taskId,
        taskRevision: value.taskRevision,
        ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
        ...(value.status === undefined ? {} : { status: value.status }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(linkId === undefined ? {} : { linkId }),
        taskState: value.taskState,
        ...(scope === undefined ? {} : { scope }),
        ...(outcome === 'needs_decision'
          ? { executionState: value.executionState, reason: value.reason, attempts: value.attempts }
          : {}),
        ...(requested === undefined ? {} : { requestedModel: requested }),
        ...(selected === undefined ? {} : { selectedModel: selected }),
      }),
    ].join('\n'),
  }]
}

/** Require the exact live top-level calling Agent. */
function requireCaller(ctx: Context, exec: { agent?: Agent }): Agent {
  const agent = exec.agent
  if (agent === undefined || ctx.agents.get(agent.id) !== agent) {
    throw new Error('this tool requires the exact live calling agent on a top-level Session')
  }
  ctx.sessionLinks.assertOrdinaryTarget(agent.id, agent.session.header)
  return agent
}

/** The durable task service, resolved through cordis' service registry —
 * the SAME injection the production assembly publishes (the `dsh-session-link/tasks`
 * sub-plugin service registers `sessionLinkTasks` into the shared store), but
 * read WITHOUT a hard inject edge: this row must stay mounted on old hosts so
 * the untracked tools keep working while tracked parameters refuse honestly.
 * The removed test escape (`ctx.__sessionLinkTasks`) is never consulted. */
function taskServiceOf(ctx: Context): Context['sessionLinkTasks'] {
  const service = ctx.get('sessionLinkTasks') as Context['sessionLinkTasks'] | undefined
  if (service === undefined) {
    throw new Error('HOST_CAPABILITY_UNAVAILABLE: the task service is not mounted on this deployment')
  }
  return service
}

/** Human-facing label for one linked peer row. */
function peerLabel(ctx: Context, sessionId: SessionId): string {
  const session = ctx.sessions.get(sessionId)
  const title = session === undefined ? undefined : ctx.sessionTitle.get(session)?.title
  const running = ctx.agents.get(sessionId)?.status === 'running'
  return `${title ?? sessionId}${running ? '（运行中）' : ''}`
}

const sendOutputProperties = {
  messageId: { type: 'string', required: true },
  status: { type: 'string', required: true, enum: ['queued', 'accepted'], description: 'accepted = target Session durably records it; queued = durable in the mailbox only. Neither means the task was processed or completed.' },
} as const

/** The model-route projection the tracked-task wire shapes carry. */
const routeOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    reasoningEffort: { type: 'string' },
  },
} as const

/** The outbox-status vocabulary session_get_task reports (task row's own lifecycle). */
const taskOutboxStatusProperties = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eventId: { type: 'string', required: true },
    kind: {
      type: 'string',
      required: true,
      enum: ['model_fallback_selected', 'model_unavailable', 'turn_finished', 'interrupted', 'cancelled'],
    },
    revision: { type: 'number', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['pending', 'admitted', 'delivered', 'blocked'],
      description: 'admitted = the notification reached the mailbox; delivered = the peer Session durably recorded it; NEVER claimed from "in outbox".',
    },
    requestedModel: routeOutputSchema,
    actualModel: routeOutputSchema,
    executionState: { type: 'string', enum: ['not_started', 'partial', 'unknown'] },
    reason: { type: 'string' },
    attemptId: { type: 'string' },
    attempts: { type: 'number' },
    decisionRequired: { type: 'boolean', required: true },
    resumable: { type: 'boolean', required: true },
    notifiedMessageId: { type: 'string' },
    blockedReason: { type: 'string', description: 'The notificationBlocked refusal reason (unlinked/archived); present only while blocked.' },
  },
} as const

/** Attempt-history wire shape: immutable per-candidate results, append-only. */
const taskAttemptProperties = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attemptId: { type: 'string', required: true },
    ordinal: { type: 'number', required: true },
    kind: { type: 'string', required: true, enum: ['original', 'retry', 'continue'] },
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          route: { ...routeOutputSchema, required: true },
          outcome: { type: 'string', required: true, enum: ['selected', 'unavailable', 'failed'] },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    defaultFrozenRoute: routeOutputSchema,
  },
} as const

/** session_get_task output shape (Public Contract §2 read model). */
const getTaskOutputProperties = {
  taskId: { type: 'string', required: true },
  taskState: { type: 'string', required: true },
  revision: { type: 'number', required: true },
  expectedRevision: { type: 'number', required: true },
  executionState: { type: 'string', enum: ['not_started', 'partial', 'unknown'] },
  reason: { type: 'string' },
  callerId: { type: 'string', required: true },
  targetSessionId: { type: 'string' },
  execution: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: {
      messageId: { type: 'string' },
      sessionId: { type: 'string' },
      linkId: { type: 'string' },
      turnIntentId: { type: 'string' },
      currentlyExecuting: { type: 'boolean' },
    },
  },
  requestedModel: routeOutputSchema,
  currentRoute: routeOutputSchema,
  routeUsed: routeOutputSchema,
  attempts: { type: 'array', required: true, items: taskAttemptProperties },
  currentAttemptId: { type: 'string', required: true },
  latestIssue: {
    type: 'object',
    additionalProperties: false,
    properties: { code: { type: 'string' }, message: { type: 'string' } },
  },
  outbox: { type: 'array', required: true, items: taskOutboxStatusProperties },
  decisions: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        callId: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['retry', 'continue', 'cancel'] },
        attemptId: { type: 'string' },
        outcome: { type: 'string', required: true, enum: ['applied', 'stale', 'rejected'] },
        appliedRevision: { type: 'number', required: true },
        appliedAt: { type: 'string', required: true },
      },
    },
  },
  createdAt: { type: 'string', required: true },
  updatedAt: { type: 'string', required: true },
} as const

/** session_resolve_task success output: the updated task view plus the decision outcome. */
const resolveTaskOutputProperties = {
  applied: { type: 'boolean', required: true },
  decision: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: {
      action: { type: 'string', required: true, enum: ['retry', 'continue', 'cancel'] },
      outcome: { type: 'string', required: true, enum: ['applied', 'stale', 'rejected'] },
      attemptId: { type: 'string' },
      appliedRevision: { type: 'number', required: true },
    },
  },
  task: { type: 'object', required: true, additionalProperties: false, properties: getTaskOutputProperties },
  stale: { type: 'boolean', description: 'True when expected_revision was stale: nothing mutated; the current view is returned for the caller to re-read.' },
  attemptId: { type: 'string' },
} as const

/** Model-routing input fields appended to both tracked tools (Public Contract §1). */
const ROUTING_PARAMETERS = {
  provider: {
    type: 'string',
    description: 'Provider of the requested model route. MUST be supplied together with model; never guess.',
  },
  model: {
    type: 'string',
    description: 'Model id of the requested route. MUST be supplied together with provider.',
  },
  reasoning_effort: {
    type: 'string',
    description: 'Reasoning effort for THIS route only. Omitted uses that route\'s own adapter default; an effort never transfers across candidates.',
  },
  model_scope: {
    type: 'string',
    enum: ['task', 'session'],
    description: 'task (default): this delivery\'s full target turn only. session: persist the route that SUCCEEDED this task as the target\'s long-term baseline (a mid-task human selection change always wins and is reported).',
  },
  on_model_unavailable: {
    type: 'object',
    additionalProperties: false,
    description: 'User-authorized ordered fallback policy for route-availability failures. Requires the primary model.',
    properties: {
      fallbacks: {
        type: 'array',
        required: true,
        description: 'Ordered candidates tried after the primary (at most 4; every entry must differ in route or effort). Session-default resolves the TARGET\'s long-term baseline at activation.',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                reasoning_effort: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                use: { type: 'string', required: true, enum: ['session_default'] },
              },
            },
          ],
        },
      },
      if_exhausted: {
        type: 'string',
        enum: ['notify_sender'],
        description: 'Terminal policy after every candidate failed; notify_sender (default and only value) reports to this Session for an explicit decision.',
      },
    },
  },
} as const

/** Tracked-task success wire shape (Public Contract §3). */
const trackedAdmittedProperties = {
  outcome: { type: 'string', required: true, enum: ['admitted'] },
  taskId: { type: 'string', required: true },
  taskRevision: { type: 'number', required: true },
  messageId: { type: 'string', required: true },
  status: { type: 'string', required: true, enum: ['queued', 'accepted'], description: 'Delivery outcome ONLY; never execution success.' },
  sessionId: { type: 'string' },
  linkId: { type: 'string' },
  taskState: { type: 'string', required: true },
  requestedModel: { ...routeOutputSchema, required: true },
  selectedModel: routeOutputSchema,
} as const

/** Tracked-task sync-precheck failure wire shape (Public Contract §3). */
const needsDecisionProperties = {
  outcome: { type: 'string', required: true, enum: ['needs_decision'] },
  taskId: { type: 'string', required: true },
  taskRevision: { type: 'number', required: true },
  taskState: { type: 'string', required: true, enum: ['waiting_decision'] },
  executionState: { type: 'string', required: true, enum: ['not_started'] },
  reason: { type: 'string', required: true },
  attempts: { type: 'number', required: true },
  sessionId: { type: 'string' },
  linkId: { type: 'string' },
} as const

/**
 * The Session one spawn call creates, derived from the caller and call id so
 * a replayed call adopts the same Session instead of creating another.
 * @param callerId - spawning Session.
 * @param callId - tool call identity.
 * @returns a stable `session-<uuid-shaped>` id.
 */
export function spawnedSessionId(callerId: SessionId, callId: string): SessionId {
  const hex = createHash('sha256').update(`${callerId}\0${callId}`).digest('hex')
  return brandString<SessionId>(`session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`)
}

/**
 * Model-facing refusal for a replayed spawn whose group a human removed.
 * @param callKey - the replayed call's identity.
 * @param sessionId - the Session the earlier attempt created.
 * @returns the explanation returned instead of relinking or re-sending.
 */
function unlinkedReplay(callKey: string, sessionId: SessionId): string {
  return `spawn call ${callKey} already created session ${sessionId}, and its link has since been removed. `
    + 'It is not relinked and its task is not re-sent; ask the human before linking it again.'
}

/** Message text of a thrown value for model-facing failure reports. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Model-facing text for a model-routing failure. The leading classification
 * code lets the calling model and Task 4's admission path distinguish
 * CATALOG_UNAVAILABLE (needs_decision-eligible) from parameter errors.
 */
function routingFailure(error: ModelRoutingError): string {
  return `${error.code}: ${error.message}`
}

const listModelsOutputProperties = {
  taskHost: {
    type: 'boolean',
    required: true,
    description: 'Whether this deployment exposes the host task-execution capability. When false, passing model routing parameters to session_spawn_linked_session or session_send_session_message fails with HOST_CAPABILITY_UNAVAILABLE; never guess routing support.',
  },
  deploymentDefault: {
    type: 'object',
    required: true,
    additionalProperties: false,
    description: 'Route new Sessions start from before any selection; may carry the default reasoning effort.',
    properties: {
      provider: { type: 'string', required: true },
      model: { type: 'string', required: true },
      reasoningEffort: { type: 'string' },
    },
  },
  providers: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        name: { type: 'string' },
        models: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string' },
              description: { type: 'string' },
              efforts: {
                type: 'array',
                required: true,
                description: 'Reasoning efforts THIS exact provider/model route accepts; never inherited from another route.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string' },
                    isDefault: { type: 'boolean', required: true, description: 'True for the effort this route uses when reasoning_effort is omitted.' },
                  },
                },
              },
              defaultEffort: { type: 'string', description: 'Effort applied when reasoning_effort is omitted for this route.' },
              isDeploymentDefault: { type: 'boolean', required: true, description: 'True for the deployment default provider+model route.' },
            },
          },
        },
        catalogError: { type: 'string', description: 'Set when this provider\'s catalog query failed: its models are UNKNOWN, not empty — the failure is never reported as an empty catalog.' },
      },
    },
  },
} as const

/** The outbox pump this row owns; trigger points call its `schedule()`. */
let pump: TaskNotificationPump | undefined

/** Trigger the task-notification pump after any mutation that may leave pending outbox work. */
function pumpSchedule(): void {
  pump?.schedule()
}

/**
 * Register the Session Link tools in each eligible top-level Agent's scope.
 * @param ctx - host context carrying the tool registry, link service, Session Controller, and title service.
 * @param config - presets whose top-level Agents receive the tools.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Task 5: the event-driven outbox pump. Installed BEFORE the first tool
  // registration so every tracked admission and runtime projection below can
  // schedule a pass; its own initial pass re-delivers pending work a prior
  // process left behind.
  pump = installTaskNotifications(ctx, {
    tasks: () => taskServiceOf(ctx),
    links: () => ctx.sessionLinks,
  })
  /* F-C1c (final review): classify the durable rows a prior process left
   * half-written. reconcile() is pure, safe, and idempotent — it NEVER
   * executes, wakes, or fabricates; needsBindingRepair rows drop to
   * waiting_decision with exactly one repair outbox event per task, and the
   * pump pass scheduled afterwards delivers those notices. A deployment
   * without the task service (legacy tool stacks) skips this silently. */
  void (async () => {
    let tasks: Context['sessionLinkTasks']
    try {
      tasks = taskServiceOf(ctx)
    } catch {
      return
    }
    try {
      const result = await tasks.reconcile()
      if (result.notifiedRepairs.length > 0) pumpSchedule()
    } catch (error: unknown) {
      ctx.logger.warn(`session-link: task reconcile at mount failed: ${reason(error)}`)
    }
  })()
  const tools = definitions(ctx, pumpSchedule)
  mountPerPresetAgent(ctx, resolvePresets(config), 'session-link-tools', ['tools'], (scoped) => {
    for (const tool of tools) scoped.tools.register(tool)
  })
  // The runtime's own listeners must bind the AGENT'S context (so the
  // scope-filtered agent events see it inside mountPerPresetAgent's carriers);
  // pairing is done by a detached listener keyed on each Agent the row follows.
  for (const agent of ctx.agents.list()) {
    contributeRuntime(ctx, agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    contributeRuntime(ctx, agent)
  })


  function contributeRuntime(rootCtx: Context, agent: Agent): void {
    /* F-C1b (final review): a cold target that becomes live (agent/created,
     * or the mount-time list above) with DURABLE managed work already naming
     * it is armed eagerly through the SAME single-flight lazy install the
     * admission path uses — concurrent arming joins one flight and never
     * duplicates the capability's listeners. Task-2 addition: an Agent that
     * shares a tracked link channel (an auto-wake grant names it, or a task
     * row does) is armed equally — the host's managed-input guard and the
     * claim freeze must exist BEFORE any managed mail can claim, so a
     * cancelled/orphaned delivery can never execute as ordinary mail (R04).
     * Agents with no durable binding and no channel stay unarmed until a
     * tracked admission or the runtime's own claim backstop (pre-step
     * `ensureHost`) arms them, so unrelated Agents keep a clean capability
     * surface. */
    void (async () => {
      let needsArm = false
      try {
        needsArm = taskServiceOf(rootCtx).listRows().some(row =>
          row.targetSessionId === agent.id && row.execution.messageId !== undefined)
      } catch { /* a deployment without the task service never arms eagerly */ }
      if (!needsArm) {
        try {
          needsArm = (rootCtx.sessionLinks.list(agent.id) as readonly unknown[]).length > 0
        } catch { /* no link service; the admission time arming still applies */ }
      }
      if (needsArm) await ensureTaskHostLazy(agent)
    })()
    installTaskRuntime(agent.ctx, agent, () => taskServiceOf(rootCtx), {
      pairLinked: (linkId, first, second) =>
        rootCtx.sessionLinks.list(first as never).some(link =>
          String(link.id) === String(linkId) && link.memberIds.includes(second as never)),
    }, {
      /* CRITICAL-2 (final review): runtime-written outbox events schedule the
       * outbox pump themselves — a sender never waits for an unrelated tool
       * call to see turn_finished / model_unavailable / interrupted /
       * cancelled / model_fallback_selected notifications. */
      schedulePump: pumpSchedule,
      /* F-C1b runtime-side fallback: if no path armed this Agent before a
       * managed claim arrived, the gate arms it on the spot (still the same
       * single flight) instead of letting the message run unmanaged. */
      ensureHost: () => ensureTaskHostLazy(agent),
    })
  }
}

/** The tool definitions, bound to the row context's services; every tracked mutation schedules a pump pass. */
function definitions(ctx: Context, pumpSchedule: () => void): ToolDefinition[] {
  return [defineTool({
    name: 'session_list_links',
    description:
      'List the Session Link groups whose members this Session may peer-message, '
      + 'and the other ordinary top-level Sessions reachable through them. Links '
      + 'are created by the human in the UI or by session_spawn_linked_session. '
      + 'A link opens a message channel only; it does not share file history, '
      + 'model context, or permission overrides.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          links: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                linkId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                peers: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      sessionId: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                      autoWake: { type: 'boolean', required: true, description: 'Whether deliveries to this peer may wake it automatically.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.links.length === 0
          ? 'This Session belongs to no Session Link group.'
          : value.links.map(link =>
            `link ${link.linkId}「${link.name}」→ ${link.peers.map(peer => `${peer.label} <${peer.sessionId}>${peer.autoWake ? ' [auto-wake]' : ''}`).join(', ')}`,
          ).join('\n'),
      }],
    },
    // oxlint-disable-next-line typescript/require-await -- defineTool's execute must return a Promise even for a purely synchronous body.
    async execute(_args, exec) {
      const caller = requireCaller(ctx, exec)
      return {
        links: ctx.sessionLinks.list(caller.id).map(link => ({
          linkId: String(link.id),
          name: link.name,
          peers: link.memberIds
            .filter(member => member !== caller.id)
            .map(member => ({
              sessionId: String(member),
              label: peerLabel(ctx, member),
              autoWake: link.autoWakeSessionIds.includes(member),
            })),
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List session links', kind: 'other' }),
  }), defineTool({
    name: 'session_send_session_message',
    description:
      'Send one message to another ordinary top-level Session linked to this one, '
      + 'or reply to a message this Session received. Sender identity is derived from '
      + 'this Session, never accepted from arguments, and the target receives it as '
      + 'peer input attributed as non-human — it never gains human-tool authority. '
      + 'Delivery never interrupts the peer mid-turn: it runs as the peer\'s own '
      + 'next turn. A peer with an auto-wake grant may be woken; otherwise the '
      + 'message waits durably for the peer\'s next turn. Returns durable acceptance, '
      + 'not the peer\'s answer — do not assume the task ran or completed. '
      + 'MODEL ROUTING (optional, tracked-task path): provider + model MUST be '
      + 'supplied as a pair (never guessed; an exact model requires its provider); '
      + 'reasoning_effort applies to THIS route only and never transfers across '
      + 'candidates. model_scope defaults to task (this delivery\'s full target '
      + 'turn, every step included); session persists ONLY the route that actually '
      + 'succeeded as the target\'s long-term baseline (a mid-task human selection '
      + 'change always wins and is reported; a failed or interrupted task never '
      + 'persists anything). on_model_unavailable orders fallback candidates (at '
      + 'most 4; each must differ in route or effort; {use:"session_default"} '
      + 'resolves the TARGET\'s current baseline at activation, never this '
      + 'Session\'s and never re-sampled on replay); exhausting every candidate '
      + 'surfaces waiting_decision + a notification instead of a wrong silent '
      + 'retry, and the caller then decides exactly once (session_get_task / '
      + 'session_resolve_task). Tracking without these parameters keeps the '
      + 'untracked legacy shape; an old host without the task capability refuses '
      + 'tracked parameters with HOST_CAPABILITY_UNAVAILABLE while the other '
      + 'tools keep working.',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'The peer Session id, obtainable from session_list_links.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The complete self-contained message body for the peer.',
      },
      in_reply_to: {
        type: 'string',
        description: 'Message id of a session_link message this Session received, when replying.',
      },
      ...ROUTING_PARAMETERS,
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: sendOutputProperties },
          { type: 'object', additionalProperties: false, properties: trackedAdmittedProperties },
          { type: 'object', additionalProperties: false, properties: needsDecisionProperties },
        ],
      },
      render: (args, value) => [
        {
          type: 'text',
          text: 'outcome' in value
            ? value.outcome === 'admitted'
              ? `task ${value.taskId} admitted: message ${value.messageId} ${value.status} for session ${args.session_id}`
                + ` (requested ${value.requestedModel.provider}/${value.requestedModel.model}${value.selectedModel === undefined ? '' : `, selected ${value.selectedModel.provider}/${value.selectedModel.model}`})`
              : `task ${value.taskId} needs a decision (${value.reason}); no routing admitted`
            : value.status === 'accepted'
              ? `message ${value.messageId} accepted by session ${args.session_id}`
              : `message ${value.messageId} queued for session ${args.session_id} (durable; awaits the peer's next turn)`,
        },
        ...taskResultSidecar(ctx, 'session_send_session_message', value as Record<string, unknown>),
      ],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      const routing = parseModelRoutingParams(args)
      if (!routing.present) {
        const result = await ctx.sessionLinks.send(caller, brandString<SessionId>(args.session_id), {
          targetId: brandString<SessionId>(args.session_id),
          text: args.message,
          ...(args.in_reply_to === undefined ? {} : { inReplyTo: SessionLinkMessageId(args.in_reply_to) }),
          idempotencyKey: String(exec.callId),
          signal: exec.signal,
        })
        return { messageId: String(result.messageId), status: result.status }
      }
      const policy = normalizeModelRoutingParams(routing.params!)
      const targetId = brandString<SessionId>(args.session_id)
      return await trackedSend(ctx, caller, targetId, {
        text: args.message,
        ...(args.in_reply_to === undefined ? {} : { inReplyTo: SessionLinkMessageId(args.in_reply_to) }),
        callId: String(exec.callId),
        policy,
        signal: exec.signal,
      }, pumpSchedule)
    },
    presentCall: args => ({ card: 'generic', title: `Message session ${args.session_id}`, kind: 'other' }),
  }), defineTool({
    name: 'session_cancel_session_message',
    description:
      'Cancel one of this Session\'s still-pending peer messages. Cancellation is '
      + 'durable and prevents any later delivery; a message already recorded by the '
      + 'peer cannot be recalled. Returns the message\'s resulting state.',
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description: 'The mailbox message id returned by session_send_session_message or session_spawn_linked_session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['pending', 'delivered', 'cancelled', 'failed', 'revoked'],
            description: 'cancelled = never delivered; delivered = the peer already records it and cancellation no longer applies.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'cancelled'
          ? `message ${value.messageId} cancelled before delivery`
          : `message ${value.messageId} is ${value.status}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      const messageId = SessionLinkMessageId(args.message_id)
      await ctx.sessionLinks.cancel(caller, messageId)
      const record = ctx.sessionLinks.message(messageId)
      return { messageId: args.message_id, status: record?.status ?? 'cancelled' }
    },
    presentCall: args => ({ card: 'generic', title: `Cancel message ${args.message_id}`, kind: 'other' }),
  }), defineTool({
    name: 'session_spawn_linked_session',
    description:
      'Create a NEW independent top-level Session in a directory you choose, assign '
      + 'it one task, and link it to this Session bidirectionally. The new Session is '
      + 'a first-class conversation: the human can open it, chat in it, and it keeps '
      + 'running if this Session stops. This plugin does not request a separate '
      + 'human approval; the profile\'s existing tool policies still apply. '
      + 'The initial task starts the new Session right away unless the daily '
      + 'auto-wake budget is spent, in which case it waits durably (status queued). '
      + 'auto_awake decides whether LATER peer messages may wake the new Session; '
      + 'wake_caller decides whether its replies may wake this Session, defaulting to auto_awake. '
      + 'Both wake directions remain subject to daily, per-message, and reply-chain budgets. '
      + 'Replaying a call never expands an existing group\'s grants or re-enables a human-disabled flag. '
      + 'MODEL ROUTING (optional, tracked-task path): provider + model MUST be supplied as a '
      + 'pair (never guessed); reasoning_effort applies to THIS route only and never transfers. '
      + 'model_scope defaults to task (the spawned first task\'s full target turn only); session '
      + 'persists ONLY the route that actually succeeded as the new Session\'s long-term '
      + 'baseline. on_model_unavailable orders at most 4 fallback candidates (each must differ '
      + 'in route or effort; {use:"session_default"} resolves the TARGET\'s baseline at '
      + 'activation, then freezes onto the attempt). Exhaustion surfaces waiting_decision plus '
      + 'a notification instead of a wrong silent retry; the caller decides with '
      + 'session_get_task / session_resolve_task. An old host without the task capability '
      + 'refuses tracked parameters with HOST_CAPABILITY_UNAVAILABLE while the other three '
      + 'tools keep working. Returns the new Session id for session_list_links / '
      + 'session_send_session_message.',
    parameters: {
      cwd: {
        type: 'string',
        required: true,
        description: 'Fully qualified directory the new Session owns. It does not need to exist.',
      },
      task: {
        type: 'string',
        required: true,
        description: 'Complete self-contained task prompt the new Session starts with.',
      },
      title: {
        type: 'string',
        description: 'Human-facing title; defaults to a short name derived from the directory.',
      },
      auto_awake: {
        type: 'boolean',
        description: 'Whether later peer messages may wake this new Session automatically (subject to budgets). Defaults to false: later messages wait for its next turn. The initial task wakes it either way. When true, wake_caller also defaults to true.',
      },
      wake_caller: {
        type: 'boolean',
        description: 'Whether replies from the new Session may wake this calling Session, subject to wake budgets. Defaults to auto_awake; set false to opt out of return-direction wake. Only grants a new group; replay never changes existing authorization.',
      },
      ...ROUTING_PARAMETERS,
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              linkId: { type: 'string', required: true },
              messageId: { type: 'string', required: true },
              status: { type: 'string', required: true, enum: ['queued', 'accepted'] },
            },
          },
          { type: 'object', additionalProperties: false, properties: trackedAdmittedProperties },
          { type: 'object', additionalProperties: false, properties: needsDecisionProperties },
        ],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: 'outcome' in value
            ? value.outcome === 'admitted'
              ? `task ${value.taskId} admitted: session ${value.sessionId ?? ''} linked (${value.linkId ?? ''}); task message ${value.messageId} ${value.status}`
                + ` (requested ${value.requestedModel.provider}/${value.requestedModel.model}${value.selectedModel === undefined ? '' : `, selected ${value.selectedModel.provider}/${value.selectedModel.model}`})`
              : value.sessionId === undefined
                ? `task ${value.taskId} needs a decision (${value.reason}); no Session was created and nothing was sent`
                : `task ${value.taskId} needs a decision (${value.reason}); session ${value.sessionId} exists but the task was never admitted to it`
            : `session ${value.sessionId} created and linked (${value.linkId}); task message ${value.messageId} ${value.status}`,
        },
        ...taskResultSidecar(ctx, 'session_spawn_linked_session', value as Record<string, unknown>),
      ],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      const routing = parseModelRoutingParams(args)
      const cwd = args.cwd.trim()
      if (cwd === '') throw new Error('cwd must not be empty')
      if (!cwd.startsWith('/')) throw new Error(`cwd must be fully qualified, got ${JSON.stringify(args.cwd)}`)
      if (args.task.trim() === '') throw new Error('task must not be empty')
      const title = args.title === undefined || args.title.trim() === ''
        ? (relative('/', cwd) || cwd).split('/').filter(part => part !== '').at(-1) ?? 'linked-session'
        : args.title.trim()
      const callKey = String(exec.callId)
      if (routing.present) {
        const policy = normalizeModelRoutingParams(routing.params!)
        return await trackedSpawn(ctx, caller, {
          cwd,
          task: args.task,
          title,
          autoAwake: args.auto_awake === true,
          ...(args.wake_caller === undefined ? {} : { wakeCaller: args.wake_caller }),
          callKey,
          policy,
          signal: exec.signal,
        }, pumpSchedule)
      }
      // Earlier attempts of this call decide before anything is created or linked.
      const prior = ctx.sessionLinks.spawnReplay(caller.id, callKey)
      if (prior?.removed === true) throw new Error(unlinkedReplay(callKey, prior.sessionId))
      const sessionId = prior?.sessionId ?? (await ctx.sessionController.create({
        cwd,
        sessionId: spawnedSessionId(caller.id, callKey),
      })).sessionId
      // Link before any other step so a later failure never strands an unlinked Session.
      // A replay whose task is already stored keeps its group and goes straight to delivery.
      let linkId: SessionLinkId
      try {
        linkId = prior?.task === undefined
          ? await ctx.sessionLinks.claimSpawnLink(caller.id, sessionId, callKey, title, args.auto_awake === true, args.wake_caller ?? (args.auto_awake === true))
          : prior.linkId
      } catch (error: unknown) {
        if (error instanceof SessionLinkError && error.code === 'LINK_REVOKED') {
          throw new Error(unlinkedReplay(callKey, sessionId))
        }
        throw new Error(`session ${sessionId} was created in ${cwd} but could not be linked: ${reason(error)}. `
          + 'It holds no task; tell the human so they can link it with /session-link add or archive it.')
      }
      if (prior?.task === undefined) {
        try {
          await ctx.sessionController.rename({ sessionId, title })
        } catch (error: unknown) {
          // The title is cosmetic: the Session is linked and receives its task under its default title.
          ctx.logger.warn(`session-link: renaming spawned session "${sessionId}" failed: ${reason(error)}`)
        }
      }
      let result: Awaited<ReturnType<typeof ctx.sessionLinks.send>>
      try {
        result = await ctx.sessionLinks.send(caller, sessionId, {
          targetId: sessionId,
          text: args.task,
          idempotencyKey: callKey,
          signal: exec.signal,
        })
      } catch (error: unknown) {
        // A send failure means the task was never stored or was cancelled before delivery.
        throw new Error(`session ${sessionId} was created and linked (${linkId}), but its task was not delivered and will not be: `
          + `${reason(error)}. Resend the task with session_send_session_message; it still starts the new Session.`)
      }
      return {
        sessionId: String(sessionId),
        linkId: String(linkId),
        messageId: String(result.messageId),
        status: result.status,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Spawn session in ${args.cwd}`, kind: 'other' }),
  }), defineTool({
    name: 'session_list_models',
    description:
      'List the models this deployment can route linked-Session tasks to: providers, '
      + 'models, the reasoning efforts each exact provider/model route accepts with its '
      + 'own default, and the deployment default route. Use pair(provider, model) values '
      + 'from here for the model routing parameters of session_spawn_linked_session and '
      + 'session_send_session_message; provider/model must always be given together, an '
      + 'omitted effort means that route\'s own default, and effort lists never transfer '
      + 'across routes. The taskHost flag tells whether task-level model routing is '
      + 'available at all on this host; when false, do not pass routing parameters. '
      + 'A provider with catalogError failed to answer: its model list is unknown, not '
      + 'empty. Filter by provider, or by an exact model together with its provider.',
    parameters: {
      provider: {
        type: 'string',
        description: 'Narrow the catalog to one provider id.',
      },
      model: {
        type: 'string',
        description: 'Narrow to one exact model; requires provider.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: listModelsOutputProperties,
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `task-level model routing on this host: ${value.taskHost ? 'available' : 'UNAVAILABLE (do not pass model routing parameters)'}`,
          `deployment default: ${value.deploymentDefault.provider}/${value.deploymentDefault.model}`
            + `${value.deploymentDefault.reasoningEffort === undefined ? '' : ` (effort ${value.deploymentDefault.reasoningEffort})`}`,
          ...value.providers.map(provider =>
            provider.catalogError === undefined
              ? `${provider.id}${provider.name === undefined ? '' : `「${provider.name}」`}: ${
                provider.models.map(model =>
                  `${model.id}${model.isDeploymentDefault ? ' [default]' : ''}${
                    model.efforts.length === 0 ? '' : ` (efforts: ${model.efforts.map(effort => `${effort.id}${effort.isDefault ? '*' : ''}`).join(', ')})`}`
                ).join(', ') || 'no models match the filter'}`
              : `${provider.id}${provider.name === undefined ? '' : `「${provider.name}」`}: CATALOG QUERY FAILED — ${provider.catalogError} (models unknown, not absent)`,
          ),
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      if (args.model !== undefined && args.provider === undefined) {
        throw new Error('an exact model filter requires the provider parameter')
      }
      let catalog: ModelCatalogLike
      try {
        catalog = await readModelCatalog(() => ctx.sessionController.modelCatalog() as Promise<ModelCatalogLike>)
      } catch (error: unknown) {
        throw error instanceof ModelRoutingError ? new Error(routingFailure(error)) : error
      }
      try {
        return projectModelCatalog(catalog, {
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.model === undefined ? {} : { model: args.model }),
        }, resolveTaskHost(caller.ctx) !== undefined)
      } catch (error: unknown) {
        if (error instanceof SessionListModelsParamsError) throw new Error(error.message)
        throw error
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List available models', kind: 'other' }),
  }), defineTool({
    name: 'session_get_task',
    description:
      'Read the durable state of one tracked session_link task this Session sent or is the target of. '
      + 'Returns the task state, CAS revision token session_resolve_task requires, the execution binding '
      + '(message/turn-intent), the requested route and the route the task ran/is running on, the per-candidate '
      + 'attempt history, the latest issue, the outbox notification lifecycle (pending/admitted/delivered/blocked — '
      + 'admitted only claims the notification reached the mailbox, NEVER that this Session saw it), and the '
      + 'recorded decision outcomes. Read-only: no decision, no wake, no side effects. '
      + 'Both original parties keep read access after unlink; no third Session ever reads a task.',
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: 'The task identity session_spawn_linked_session / session_send_session_message returned.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: getTaskOutputProperties,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `task ${value.taskId}: ${value.taskState} (revision ${value.revision})`
          + `${value.routeUsed === undefined ? '' : `, ran on ${value.routeUsed.provider}/${value.routeUsed.model}`}`
          + `, outbox ${value.outbox.map(event => `${event.kind}:${event.status}`).join(', ') || 'empty'}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      const tasks = taskServiceOf(ctx)
      const view = tasks.getTask(caller.id, SessionLinkTaskId(args.task_id))
      return getTaskWire(tasks, view)
    },
    presentCall: args => ({ card: 'generic', title: `Read task ${args.task_id}`, kind: 'other' }),
  }), defineTool({
    name: 'session_resolve_task',
    description:
      'Take exactly ONE safe decision on a tracked task this Session originally sent, after reading it with '
      + 'session_get_task: retry (not_started only: reopens the ORIGINAL flow with the original task identity, '
      + 'possibly with a new model policy), continue (partial only, and only when the host exposes a resumable '
      + 'checkpoint — otherwise TASK_NOT_RESUMABLE; never silently becomes a from-scratch retry), or cancel '
      + '(closes a paused/queued/interrupted task; a RUNNING task answers TASK_RUNNING and stays under the '
      + 'target\'s own cancel controls). expected_revision must equal the task\'s current revision; a stale '
      + 'token returns the current state with a stale indicator and mutates nothing. The tool callId is the '
      + 'decision idempotency key: replaying the same call returns the recorded outcome, never re-applies it.',
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: 'The task identity session_get_task returned.',
      },
      expected_revision: {
        type: 'number',
        required: true,
        description: 'The exact revision session_get_task returned; a mismatch performs nothing.',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['retry', 'continue', 'cancel'],
        description: 'retry: not_started tasks re-open the original flow. continue: host-resumable partial only. cancel: close a paused/queued task.',
      },
      provider: { type: 'string', description: 'New primary route provider for retry/continue; omitted keeps the original policy.' },
      model: { type: 'string', description: 'New primary route model; MUST pair with provider.' },
      reasoning_effort: { type: 'string', description: 'Effort for the new primary route only.' },
      on_model_unavailable: ROUTING_PARAMETERS.on_model_unavailable,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: resolveTaskOutputProperties,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stale === true
          ? `task ${value.task.taskId}: decision STALE at revision ${value.task.revision}; re-read with session_get_task before resolving`
          : `task ${value.task.taskId}: ${value.decision.action} ${value.decision.outcome} (revision ${value.task.revision})`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      return await resolveTaskWire(ctx, caller, String(exec.callId), args, pumpSchedule)
    },
    presentCall: args => ({ card: 'generic', title: `Resolve task ${args.task_id} (${args.action})`, kind: 'other' }),
  })]
}

/* --------------------------------------------------------------------------
 * Tracked (model-routed) spawn/send admission. Legacy parameter-free calls
 * never reach these paths: the tool handlers above branch on
 * `parseModelRoutingParams(...).present`.
 *
 * Admission order per call (brief 4b/4d/4e): replay → capability →
 * saveTaskIntent → catalog precheck → create/link/rename (spawn) →
 * claimSpawnLink (original callKey) → mailbox admission → attachBinding →
 * host recordTurnIntent → task recordTurnIntent → (accepted upgrade).
 * A replay NEVER re-runs the precheck: the stored row is replayed verbatim.
 * ------------------------------------------------------------------------ */

interface WireRoute { provider: string; model: string; reasoningEffort?: string }
interface AdmittedWire {
  outcome: 'admitted'
  taskId: string
  taskRevision: number
  messageId: string
  status: 'queued' | 'accepted'
  sessionId?: string
  linkId?: string
  taskState: string
  requestedModel: WireRoute
  selectedModel?: WireRoute
}
interface NeedsDecisionWire {
  outcome: 'needs_decision'
  taskId: string
  taskRevision: number
  taskState: 'waiting_decision'
  executionState: 'not_started'
  reason: string
  attempts: number
  sessionId?: string
  linkId?: string
}
type TrackedWire = AdmittedWire | NeedsDecisionWire

/** The needs_decision wire shape, projected from one durable row. */
function needsDecisionResult(
  row: SessionLinkTaskRecordData,
  resolveLinkId?: (row: SessionLinkTaskRecordData) => SessionLinkId | undefined,
): NeedsDecisionWire {
  const linkId = row.execution.linkId ?? resolveLinkId?.(row)
  return {
    outcome: 'needs_decision',
    taskId: String(`task:${row.callerId}:${row.callId}`),
    taskRevision: row.revision,
    taskState: 'waiting_decision',
    executionState: 'not_started',
    reason: row.reason ?? 'model_unavailable',
    attempts: row.attempts.at(-1)?.results.length ?? 0,
    ...(row.targetSessionId === undefined ? {} : { sessionId: String(row.targetSessionId) }),
    ...(linkId === undefined ? {} : { linkId: String(linkId) }),
  }
}

/** The admitted wire shape for one successfully bound task. */
function admittedResult(
  row: SessionLinkTaskRecordData,
  result: SessionLinkSendResult,
  selectedModel: ModelRouteSelection | undefined,
): AdmittedWire {
  const requested = requestedRouteOf(row.policy)
  return {
    outcome: 'admitted',
    taskId: String(`task:${row.callerId}:${row.callId}`),
    taskRevision: row.revision,
    messageId: String(result.messageId),
    status: result.status,
    ...(row.execution.sessionId ?? row.targetSessionId) === undefined ? {} : { sessionId: String(row.execution.sessionId ?? row.targetSessionId) },
    ...(row.execution.linkId === undefined ? {} : { linkId: String(row.execution.linkId) }),
    taskState: row.taskState,
    requestedModel: {
      provider: requested.provider,
      model: requested.model,
      ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }),
    },
    ...(selectedModel === undefined ? {} : {
      selectedModel: {
        provider: selectedModel.provider,
        model: selectedModel.model,
        ...(selectedModel.reasoningEffort === undefined ? {} : { reasoningEffort: selectedModel.reasoningEffort }),
      },
    }),
  }
}

/**
 * Project one sync precheck failure into the {reason, results} the durable
 * waiting_decision row commits. F-review: a catalog POISONING must keep the
 * concrete per-candidate results the walk collected BEFORE the poisoned
 * provider (`precheckFailureOf` marks everything after the poison
 * catalog_unavailable and aggregates the reason); only a whole-catalog read
 * failure (no candidate was ever checked) commits the genuinely empty trail.
 */
function precheckFailureWire(
  policy: ModelRoutingPolicy,
  error: ModelRoutingError,
): { reason: string; results: { route: ModelRouteSelection; code: string; message?: string }[] } {
  if (error instanceof PrecheckExhausted) return precheckFailureOf(policy, error.checks)
  if (error.code === CATALOG_UNAVAILABLE) {
    return { reason: 'catalog_unavailable', results: [] as { route: ModelRouteSelection; code: string; message?: string }[] }
  }
  return precheckFailureOf(policy, [])
}

/** Internal carrier for an exhausted per-candidate precheck trail. */
class PrecheckExhausted extends ModelRoutingError {
  constructor(readonly checks: { ok: boolean; code?: string; message?: string; route: ModelRouteSelection }[]) {
    super('MODEL_NOT_FOUND', 'every authorized candidate failed the catalog precheck')
    this.name = 'PrecheckExhausted'
  }
}

/**
 * F-C1a honest refusal: the model binding could not be made durable before
 * the mailbox admission (capability unavailable for the target, or the host
 * intent record failed). The row drops `preparing → waiting_decision` /
 * `not_started` with ONE `model_unavailable` outbox event IN THE SAME CAS
 * and the caller receives the needs_decision wire shape — NO fake half-bound
 * bare admission ever reaches the mailbox, so a tracked task can never
 * silently execute on the deployment's default model.
 *
 * Reason vocabulary: `model_unavailable` — the same vocabulary family as the
 * sync catalog precheck (`model_unavailable` vs `catalog_unavailable`): the
 * route/capability for THIS task is unavailable; the catalog answered fine.
 */
async function failCapabilityAdmission(
  ctx: Context,
  taskId: ReturnType<typeof taskIdFor>,
  row: SessionLinkTaskRecordData,
  pumpSchedule: () => void,
  resolveLinkId?: (row: SessionLinkTaskRecordData) => SessionLinkId | undefined,
): Promise<NeedsDecisionWire> {
  const tasks = taskServiceOf(ctx)
  let settled = row
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const live = tasks.getRow(taskId) ?? settled
    if (live.taskState !== 'preparing') {
      settled = live
      break
    }
    try {
      settled = await tasks.requestStateChange(taskId, live.revision, {
        toState: 'waiting_decision',
        executionState: 'not_started',
        reason: 'model_unavailable',
        events: [{
          kind: 'model_unavailable',
          executionState: 'not_started',
          reason: 'model_unavailable',
          requestedModel: requestedRouteOf(live.policy),
          attempts: live.attempts.at(-1)?.results.length ?? 0,
          decisionRequired: true,
          resumable: true,
        }],
      })
      break
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'TASK_STALE_REVISION') {
        settled = tasks.getRow(taskId) ?? live
        continue
      }
      settled = tasks.getRow(taskId) ?? live
      break
    }
  }
  pumpSchedule()
  return needsDecisionResult(settled, resolveLinkId)
}

/**
 * The sync catalog precheck for a tracked call: read the deployment catalog
 * once, walk the concrete candidates in policy order, and select the first
 * available route. `session_default` sentinels stay opaque (resolved at
 * activation, never sampled here).
 *
 * R10/R13 (MODEL_ROUTING_FIX_PLAN Task 3): returns the selected route WITH
 * its index inside `policy.candidates`, so the admission can fix that fact
 * durably onto the attempt row and activation can start the walk from the
 * FIXED position instead of silently re-deriving from `candidates[0]`
 * (pre-fix that re-executed the rejected primary). R13: a policy with NO
 * catalog-available concrete route but at least one `session_default`
 * sentinel passes as `route: undefined` (default-resolvable at activation);
 * the precheck rejects only when a concrete route failed with no further
 * candidates to try.
 * @returns the selected route + candidate index (route undefined only for
 *   an R13 default-resolvable pass).
 * @throws {@link ModelRoutingError} CATALOG_UNAVAILABLE when the read fails,
 *   or {@link PrecheckExhausted} when every candidate is unavailable with
 *   no default to resolve.
 */
async function runPrecheck(
  ctx: Context,
  policy: ModelRoutingPolicy,
): Promise<{ route: ModelRouteSelection | undefined; index: number }> {
  let catalog: ModelCatalogLike
  try {
    catalog = await readModelCatalog(() => ctx.sessionController.modelCatalog() as Promise<ModelCatalogLike>)
  } catch (error: unknown) {
    if (error instanceof ModelRoutingError) throw error
    throw new ModelRoutingError(CATALOG_UNAVAILABLE, `the deployment model catalog cannot be read: ${reason(error)}`)
  }
  const outcome = checkCandidateRoutes(policy, catalog)
  if (outcome.selected !== undefined) {
    // The selected CHECK names the route; its index within the policy's own
    // candidates is the fact the attempt row fixes (R10). The check trail
    // preserves policy order, so the selected route is the first `ok`.
    for (const check of outcome.checks) {
      if (!check.ok) continue
      const index = policy.candidates.findIndex(candidate =>
        !('use' in candidate)
        && candidate.provider === check.route.provider
        && candidate.model === check.route.model
        && candidate.reasoningEffort === check.route.reasoningEffort)
      return { route: check.route, index: index === -1 ? 0 : index }
    }
  }
  /* R13: the default sentinel is resolvable at activation through the
   * unified baseline snapshot chain (Task 2), so a policy whose every
   * concrete candidate failed but which carries a default PASSES the
   * precheck as default-resolvable. The activation resolves and freezes the
   * baseline honestly; the exhaustion trail still names the concrete
   * failures when the default itself cannot resolve. */
  if (outcome.unresolvedDefaults > 0) {
    return { route: undefined, index: policy.candidates.findIndex(candidate => 'use' in candidate) }
  }
  throw new PrecheckExhausted([...outcome.checks])
}

/**
 * Resolve an R13 default-resolvable admission's route honestly: the TARGET's
 * effective baseline snapshot (Task 2's unified owner) or, when it shows no
 * explicit selection yet, the deployment default the catalog advertises.
 * A catalog that ALSO cannot answer refuses the admission as catalog-gone
 * (the needs_decision path records NO fabrication).
 */
async function resolveDefaultPrecheckRoute(
  ctx: Context,
  catalogDefault?: ModelRouteSelection,
): Promise<ModelRouteSelection | undefined> {
  try {
    const catalog = await readModelCatalog(() => ctx.sessionController.modelCatalog() as Promise<ModelCatalogLike>)
    return catalog.default ?? catalogDefault
  } catch {
    return catalogDefault
  }
}

/** The TARGET's own effective baseline snapshot, when the host carries one. */
function snapshotDefaultForHost(host: { readBaseline(): { effective: ModelRouteSelection | null } }):
  ModelRouteSelection | undefined {
  const effective = host.readBaseline().effective
  return effective === null ? undefined : effective
}

/**
 * R11: project one EXISTING durable row honestly at replay time. The row's
 * own committed facts answer; a `queued` claim whose delivery the mailbox
 * does NOT contain is NEVER reported — the half-write is heralded for repair
 * and the replay surfaces the needs_decision shape the caller resolves.
 */
async function replayTrackedRow(
  ctx: Context,
  caller: Agent,
  taskId: ReturnType<typeof taskIdFor>,
  existing: SessionLinkTaskRecordData,
): Promise<TrackedWire> {
  const tasks = taskServiceOf(ctx)
  if (existing.taskState === 'waiting_decision') return needsDecisionResult(existing)
  if (existing.execution.messageId !== undefined) {
    const message = ctx.sessionLinks.message(existing.execution.messageId)
    if (message === undefined) {
      /* The delivered-then-lost realm: the durable binding names a message
       * the mailbox does not hold. Project repair, never `queued`. */
      const heralded = await tasks.markDeliveryMissing(taskId, existing.execution.messageId)
      return needsDecisionResult(heralded ?? existing)
    }
    return admittedResult(existing, {
      messageId: existing.execution.messageId,
      status: message.status === 'delivered' ? 'accepted' : 'queued',
    }, undefined)
  }
  return needsDecisionResult(existing)
}


async function requireTaskHost(ctx: Context, caller: Agent): Promise<void> {
  let present: ReturnType<typeof resolveTaskHost>
  try {
    present = resolveTaskHost(caller.ctx)
  } catch {
    present = undefined
  }
  if (present !== undefined) return
  if ((await hostForTarget(ctx, caller.id)) === undefined) {
    throw new Error(
      'HOST_CAPABILITY_UNAVAILABLE: this host does not expose the task-execution capability; '
      + 'do not pass model routing parameters on this deployment',
    )
  }
}

/** Save-or-replay the durable intent: replays return the stored row as-is; a NON-replayed save may leave pending outbox work (sync precheck failure) and schedules a pump pass. */
async function saveIntent(
  ctx: Context,
  input: Parameters<Context['sessionLinkTasks']['saveTaskIntent']>[0],
  pumpSchedule: () => void,
): Promise<{ replayed: boolean; saved: SavedTaskIntent }> {
  const tasks = taskServiceOf(ctx)
  const taskId = taskIdFor(input.callerId, input.request.callId)
  const before = tasks.getRow(taskId)
  const saved = await tasks.saveTaskIntent(input)
  if (before === undefined) pumpSchedule()
  return { replayed: before !== undefined, saved }
}

/** The shared tracked send admission (existing linked target). */
async function trackedSend(
  ctx: Context,
  caller: Agent,
  targetId: SessionId,
  request: {
    text: string
    inReplyTo?: ReturnType<typeof SessionLinkMessageId>
    callId: string
    policy: ModelRoutingPolicy
    signal?: AbortSignal
  },
  pumpSchedule: () => void,
): Promise<TrackedWire> {
  const tasks = taskServiceOf(ctx)

  // Replay FIRST (brief 4b/4c): the stored digest/row answers every duplicate
  // call, never re-running the precheck against a changed catalog.
  const staleTaskId = taskIdFor(caller.id, request.callId)
  const existing = tasks.getRow(staleTaskId)
  if (existing !== undefined) {
    // saveTaskIntent enforces digest equality across replays; resolve conflicts honestly.
    await saveIntent(ctx, {
      callerId: caller.id,
      request: { kind: 'send', callId: request.callId, text: request.text, targetSessionId: targetId },
      policy: request.policy,
      tracked: true,
    }, pumpSchedule)
    return await replayTrackedRow(ctx, caller, staleTaskId, existing)
  }
  await requireTaskHost(ctx, caller)
  // Precheck races nothing: it runs only on FIRST sight so a later catalog
  // change never reroutes this same task (plan: replay never re-runs precheck).
  let precheck: { route: ModelRouteSelection | undefined; index: number } | undefined
  let precheckError: ModelRoutingError | undefined
  try {
    precheck = await runPrecheck(ctx, request.policy)
  } catch (error: unknown) {
    if (!(error instanceof ModelRoutingError)) throw error
    precheckError = error
  }
  const { saved } = await saveIntent(ctx, {
    callerId: caller.id,
    request: { kind: 'send', callId: request.callId, text: request.text, targetSessionId: targetId },
    policy: request.policy,
    tracked: true,
    ...(precheckError !== undefined ? { precheckFailure: precheckFailureWire(request.policy, precheckError) } : {}),
    ...(precheck === undefined || precheck.index === -1 ? {} : { selectedCandidateIndex: precheck.index }),
  }, pumpSchedule)
  const row = saved.row
  if (precheckError !== undefined) {
    return needsDecisionResult(row, (stored) => stored.targetSessionId === undefined
      ? undefined
      : ctx.sessionLinks.list(caller.id).find(link => link.memberIds.includes(stored.targetSessionId!))?.id)
  }
  const taskId = taskIdFor(caller.id, request.callId)
  // Host binding lands BEFORE the mailbox admission so a granted wake's
  // synchronous claim (inbox pick-up inside `send`) already sees the durable
  // intent (brief 4d): the SAME messageId drives both write chains by being
  // derived up front.
  const host = await hostForTarget(ctx, targetId)
  const messageId = mintTaskMessageId(taskId, request.callId)
  /* F-C1a (final review): when the durable model binding CANNOT be made
   * before the mailbox admission (capability unavailable for the target —
   * host.recordTurnIntent impossible), the task is NOT admitted as a bare
   * managed message. A bare admission would see the tracked delivery execute
   * as ordinary mail on the baseline model: a silent contract break. Instead
   * the row drops to waiting_decision/not_started with ONE model_unavailable
   * outbox event (reason vocabulary per the needs_decision contract) and the
   * caller receives the honest needs_decision shape. */
  if (host === undefined) {
    return await failCapabilityAdmission(ctx, taskId, row, pumpSchedule,
      stored => stored.targetSessionId === undefined
        ? undefined
        : ctx.sessionLinks.list(caller.id).find(link => link.memberIds.includes(stored.targetSessionId!))?.id)
  }
  /* R13: a default-resolvable precheck (route undefined) records the intent
   * against the TARGET's unified baseline snapshot — the Task-2 owner's
   * effective baseline when it carries one, else the deployment default —
   * never the sender's and never re-sampled later (activation freezes the
   * durable `defaultFrozenRoute`; this intent only carries the activation-
   * time resolution for the FIRST turn's route). A baseline that also
   * cannot answer refuses honestly below. */
  const selected = precheck?.route
    ?? await snapshotDefaultForHost(host) ?? await resolveDefaultPrecheckRoute(ctx)
  if (selected === undefined) {
    return await failCapabilityAdmission(ctx, taskId, row, pumpSchedule,
      stored => stored.targetSessionId === undefined
        ? undefined
        : ctx.sessionLinks.list(caller.id).find(link => link.memberIds.includes(stored.targetSessionId!))?.id)
  }
  let intentId: string | undefined
  try {
    const intent = host.recordTurnIntent({
      taskId,
      attemptId: row.currentAttemptId,
      messageId: messageId as unknown as MessageId,
      route: { selection: selected },
      persistOnSuccess: request.policy.scope === 'session',
    })
    await host.claimTurnIntent(intent.intentId).catch(() => { /* the gate claims it at activation */ })
    intentId = intent.intentId
  } catch {
    /* Host-side record failure is the same contract break: refuse honestly
     * instead of admitting a delivery whose route nothing enforces. */
    return await failCapabilityAdmission(ctx, taskId, row, pumpSchedule,
      stored => stored.targetSessionId === undefined
        ? undefined
        : ctx.sessionLinks.list(caller.id).find(link => link.memberIds.includes(stored.targetSessionId!))?.id)
  }
  // Attach the task binding BEFORE the mailbox admission: a granted wake's
  // synchronous delivery inside `send` claims the delivery and runs its first
  // request against this durable row — the row must exist and point at the
  // same message identity the mailbox is about to mint (brief 4d).
  const boundPre = await tasks.attachBinding(taskId, row.revision, {
    messageId,
    sessionId: targetId,
    ...(row.execution.linkId === undefined ? { linkId: ctx.sessionLinks.list(caller.id).find(link => link.memberIds.includes(targetId))?.id } : {}),
    admittedAs: 'queued',
  })
  if (host !== undefined && intentId !== undefined) {
    await tasks.recordTurnIntent(taskId, boundPre.revision, {
      turnIntentId: intentId,
      messageId,
    })
  }
  const sent = await ctx.sessionLinks.send(caller, targetId, {
    targetId,
    text: request.text,
    ...(request.inReplyTo === undefined ? {} : { inReplyTo: request.inReplyTo }),
    idempotencyKey: request.callId,
    messageId,
    signal: request.signal,
  })
  const boundRow = tasks.getRow(taskId) ?? boundPre
  let recorded = boundRow
  if (sent.status === 'accepted' && recorded.execution.turnIntentId !== undefined) {
    recorded = await tasks.attachBinding(taskId, recorded.revision, {
      messageId: sent.messageId,
      sessionId: targetId,
      admittedAs: 'accepted',
    }).catch(() => recorded)
  }
  return admittedResult(tasks.getRow(taskId) ?? recorded, sent, selected)
}

/** The tracked spawn admission (creates/links the target, then mirrors trackedSend). */
async function trackedSpawn(
  ctx: Context,
  caller: Agent,
  request: {
    cwd: string
    task: string
    title: string
    autoAwake: boolean
    wakeCaller?: boolean
    callKey: string
    policy: ModelRoutingPolicy
    signal?: AbortSignal
  },
  pumpSchedule: () => void,
): Promise<TrackedWire> {
  const tasks = taskServiceOf(ctx)

  const derived = spawnedSessionId(caller.id, request.callKey)
  // Replay FIRST (brief 4b/4c): replays return the stored row as-is and NEVER
  // re-run the precheck against a changed catalog.
  const staleTaskId = taskIdFor(caller.id, request.callKey)
  const existing = tasks.getRow(staleTaskId)
  if (existing !== undefined) {
    await saveIntent(ctx, {
      callerId: caller.id,
      request: {
        kind: 'spawn',
        callId: request.callKey,
        text: request.task,
        spawn: {
          cwd: request.cwd,
          title: request.title,
          autoAwake: request.autoAwake,
          ...(request.wakeCaller === undefined ? {} : { wakeCaller: request.wakeCaller }),
          targetSessionId: derived,
        },
        title: request.title,
      },
      policy: request.policy,
      tracked: true,
    }, pumpSchedule)
    return await replayTrackedRow(ctx, caller, staleTaskId, existing)
  }
  await requireTaskHost(ctx, caller)
  let precheck: { route: ModelRouteSelection | undefined; index: number } | undefined
  let precheckError: ModelRoutingError | undefined
  try {
    precheck = await runPrecheck(ctx, request.policy)
  } catch (error: unknown) {
    if (!(error instanceof ModelRoutingError)) throw error
    precheckError = error
  }
  const spawnIntent = {
    cwd: request.cwd,
    title: request.title,
    autoAwake: request.autoAwake,
    ...(request.wakeCaller === undefined ? {} : { wakeCaller: request.wakeCaller }),
    targetSessionId: derived,
  }
  const { saved } = await saveIntent(ctx, {
    callerId: caller.id,
    request: {
      kind: 'spawn',
      callId: request.callKey,
      text: request.task,
      spawn: spawnIntent,
      title: request.title,
    },
    policy: request.policy,
    tracked: true,
    ...(precheckError !== undefined ? { precheckFailure: precheckFailureWire(request.policy, precheckError) } : {}),
    ...(precheck === undefined || precheck.index === -1 ? {} : { selectedCandidateIndex: precheck.index }),
  }, pumpSchedule)
  const row = saved.row
  if (precheckError !== undefined) return needsDecisionResult(row)
  const taskId = taskIdFor(caller.id, request.callKey)
  const target = await ensureSpawnSession(ctx, caller, taskId, saved.row)
  const payload = saved.row.originalRequest.payloadText ?? request.task
  const admitted = await admitTrackedDelivery(ctx, caller, taskId, target, {
    payload,
    callKey: request.callKey,
    policy: request.policy,
    ...(precheck?.route === undefined ? {} : { digestCheckedSelection: precheck.route }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }, pumpSchedule)
  if ('refusal' in admitted) return { ...admitted.refusal, sessionId: String(target), linkId: String(admitted.linkId) }
  return admittedResult(tasks.getRow(taskId) ?? admitted.row, admitted.sent, admitted.selected)
}

/**
 * The ORIGINAL spawn's create/link/rename sequence, idempotent under the
 * spawn ledger (R08(2) reuses it for the precheck-failed retry: the durable
 * row's spawn intent re-derives the same Session, re-arms the same group,
 * and renames honestly — the replay ledger absorbs every repeat).
 */
async function ensureSpawnSession(
  ctx: Context,
  caller: Agent,
  taskId: ReturnType<typeof taskIdFor>,
  row: SessionLinkTaskRecordData,
): Promise<SessionId> {
  const spawn = row.spawn
  if (spawn === undefined) {
    // A send-kind row never re-creates; its target already exists.
    const target = row.targetSessionId ?? row.execution.sessionId
    if (target === undefined) throw new TaskInvariantError(`task "${taskId}" carries no spawn intent and no target`)
    return target
  }
  const created = await ctx.sessionController.create({ cwd: spawn.cwd, sessionId: spawn.targetSessionId })
  const target = created.sessionId
  try {
    await ctx.sessionLinks.claimSpawnLink(
      caller.id, target, spawn.callKey, spawn.title ?? row.originalRequest.summary.title ?? 'linked-session',
      spawn.autoAwake, spawn.wakeCaller ?? spawn.autoAwake,
    )
  } catch (error: unknown) {
    if (error instanceof SessionLinkError && error.code === 'LINK_REVOKED') {
      throw new Error(unlinkedReplay(spawn.callKey, target))
    }
    throw new Error(`session ${target} was created in ${spawn.cwd} but could not be linked: ${reason(error)}. `
      + 'It holds no task; tell the human so they can link it with /session-link add or archive it.')
  }
  const title = spawn.title ?? row.originalRequest.summary.title
  if (title !== undefined) {
    try {
      await ctx.sessionController.rename({ sessionId: target, title })
    } catch (error: unknown) {
      ctx.logger.warn(`session-link: renaming spawned session "${target}" failed: ${reason(error)}`)
    }
  }
  return target
}

interface AdmitTrackedInput {
  /** The FULL task body (durable payloadText) — never an excerpt. */
  readonly payload: string
  /** The attempt-scoped idempotency identity (`<callKey>` original; `<callKey>/attempt-<N>` retries). */
  readonly callKey: string
  readonly policy: ModelRoutingPolicy
  /** The digest-checked precheck selection when one ran; undefined resolves through R13/default. */
  readonly digestCheckedSelection?: ModelRouteSelection
  readonly signal?: AbortSignal
}

/**
 * The shared tracked admission tail (R08): host gate → intent record →
 * attachBinding → recordTurnIntent → mailbox send under the attempt-scoped
 * identity. Used by first-sight spawn and the retry re-admission alike; the
 * task row's `preparing` state and the attempt-scoped idempotency key make a
 * repeat safe (re-admission under the SAME key adopts the stored delivery).
 */
async function admitTrackedDelivery(
  ctx: Context,
  caller: Agent,
  taskId: ReturnType<typeof taskIdFor>,
  targetId: SessionId,
  input: AdmitTrackedInput,
  pumpSchedule: () => void,
): Promise<{ row: SessionLinkTaskRecordData; sent: SessionLinkSendResult; selected: ModelRouteSelection; linkId?: SessionLinkId }
  | { refusal: NeedsDecisionWire; linkId?: SessionLinkId }> {
  const tasks = taskServiceOf(ctx)
  const row = tasks.getRow(taskId)
  if (row === undefined) throw new TaskInvariantError(`task "${taskId}" is not durable`)
  const linkId = row.execution.linkId ?? ctx.sessionLinks.list(caller.id).find(link => link.memberIds.includes(targetId))?.id
  const host = await hostForTarget(ctx, targetId)
  if (host === undefined) {
    const refusal = await failCapabilityAdmission(ctx, taskId, row, pumpSchedule)
    return { refusal, ...(linkId === undefined ? {} : { linkId }) }
  }
  /* R13: default-resolvable or absent precheck selection resolves through
   * the unified snapshot chain (host baseline, then deployment default). */
  const selected = input.digestCheckedSelection
    ?? await snapshotDefaultForHost(host) ?? await resolveDefaultPrecheckRoute(ctx)
  if (selected === undefined) {
    const refusal = await failCapabilityAdmission(ctx, taskId, row, pumpSchedule)
    return { refusal, ...(linkId === undefined ? {} : { linkId }) }
  }
  /* R08: the new attempt's delivery identity derives from the CURRENT
   * attempt ordinal — attempt-scoped, never the consumed identity the
   * previous attempt's consumed mailbox row occupied. The ORIGINAL call's
   * key stays `<callKey>`; its notification ROOT binds at attachBinding and
   * rides the task row's `notificationRoot` thereafter, so the chain wake
   * budget never mints a second root. */
  const messageId = mintTaskMessageId(String(taskId) as never, input.callKey)
  /* Re-entrant admission: a racing copy of this same attempt admission may
   * have already recorded the intent (the durable identity is attempt-
   * scoped and deterministic); adopt it instead of recording a duplicate
   * the host rightfully refuses ("live claim exists"). The recorded
   * attemptId must match this admission's attempt — a stale same-key hold
   * belongs to a different attempt and stays an honest refusal below. */
  const attemptId = row.currentAttemptId
  let intentId: string | undefined
  const already = host.getTurnIntentByMessageId(messageId as unknown as MessageId)
  if (already !== undefined && already.attemptId === attemptId && already.taskId === taskId
    && (already.status === 'claimed' || already.status === 'started')) {
    intentId = already.intentId
  } else {
    try {
      const intent = host.recordTurnIntent({
        taskId,
        attemptId,
        messageId: messageId as unknown as MessageId,
        route: { selection: selected },
        persistOnSuccess: input.policy.scope === 'session',
      })
      await host.claimTurnIntent(intent.intentId).catch(() => { /* the gate claims it at activation */ })
      intentId = intent.intentId
    } catch {
      const refusal = await failCapabilityAdmission(ctx, taskId, row, pumpSchedule)
      return { refusal, ...(linkId === undefined ? {} : { linkId }) }
    }
  }
  /* The binding writes ride the row's own CAS: a pump/decision marker may
   * have advanced the revision past this function's entry read, so re-read
   * and retry the SAME deterministic identity — a second distinct binding
   * stays the honest refusal the service throws. */
  let boundPre: SessionLinkTaskRecordData | undefined
  for (let attempt = 0; attempt < 3 && boundPre === undefined; attempt += 1) {
    const live = tasks.getRow(taskId) ?? row
    if (live.execution.messageId === messageId
      && (live.execution.turnIntentId === undefined || live.execution.turnIntentId === intentId)) {
      boundPre = live
      break
    }
    try {
      boundPre = await tasks.attachBinding(taskId, live.revision, {
        messageId,
        sessionId: targetId,
        ...(linkId === undefined ? {} : { linkId }),
        admittedAs: 'queued',
      })
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'TASK_STALE_REVISION') continue
      throw error
    }
  }
  if (boundPre === undefined) throw new Error(`task "${taskId}" binding could not attach within three CAS retries`)
  if (intentId !== undefined && boundPre.execution.turnIntentId !== intentId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const live = tasks.getRow(taskId) ?? boundPre
      if (live.execution.turnIntentId === intentId) break
      try {
        await tasks.recordTurnIntent(taskId, live.revision, { turnIntentId: intentId, messageId })
        break
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'TASK_STALE_REVISION') continue
        throw error
      }
    }
  }
  const sent = await ctx.sessionLinks.send(caller, targetId, {
    targetId,
    text: input.payload,
    idempotencyKey: input.callKey,
    messageId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  const boundRow = tasks.getRow(taskId) ?? boundPre
  let recorded = boundRow
  if (sent.status === 'accepted' && recorded.execution.turnIntentId !== undefined) {
    recorded = await tasks.attachBinding(taskId, recorded.revision, {
      messageId: sent.messageId,
      sessionId: targetId,
      admittedAs: 'accepted',
    }).catch(() => recorded)
  }
  return {
    row: tasks.getRow(taskId) ?? recorded,
    sent,
    selected,
    ...(linkId === undefined ? {} : { linkId }),
  }
}

/** Resolve (or lazily install, single-flighted) the HOST capability of the
 * TARGET Session the runtime claims through. A capability-capable host exposes
 * it on `agent.ctx`; in stacks where the plugin row attaches it (tests,
 * capability-present deployments integrating the row), first resolution
 * creates and publishes it so later gate/freeze order matches a host-owned
 * mount. Hosts that can never satisfy the contract yield `undefined` and the
 * caller keeps the plain tool path for untracked calls or an honest
 * needs_decision/HOST_CAPABILITY_UNAVAILABLE refusal for tracked ones
 * (F-C1a: a tracked call NEVER admits a bare managed message). */
async function hostForTarget(ctx: Context, targetId: SessionId) {
  const agent = ctx.agents.get(targetId)
  if (agent === undefined) return undefined
  return await ensureTaskHostLazy(agent)
}

/** The Agent that owns one scoped runtime context, resolved through the registry. */
function ownerOfScope(ctx: Context, scoped: Context): Agent | undefined {
  const direct = ctx.agents.list().find(agent => agent.ctx === scoped)
  if (direct !== undefined) return direct
  // mountPerPresetAgent installs the runtime child plugin into a per-agent
  // cordis child context that `extend`s the Agent's own context two levels
  // deep; walk `parent` until an Agent's context is found.
  let cursor: Context | undefined = (scoped as unknown as { fiber?: { parent?: { ctx?: Context } } }).fiber?.parent?.ctx
  while (cursor !== undefined) {
    const found = ctx.agents.list().find(agent => agent.ctx === cursor)
    if (found !== undefined) return found
    cursor = (cursor as unknown as { fiber?: { parent?: { ctx?: Context } } }).fiber?.parent?.ctx
  }
  return undefined
}

/**
 * Derive the mailbox message identity one tracked ADMISSION will use
 * (R08(1)): deterministic per (attempt-scope, attempt idempotency key). The
 * original attempt passes its taskId + raw callId and mints the SAME value
 * every replay of that call answers; each retry attempt passes
 * `<callKey>/attempt-<N>` and mints a FRESH identity — the re-admission of
 * a delivered-task retry never reuses the consumed mailbox delivery its
 * predecessor owned, while the taskId + notification-root budget chain the
 * task row carries stay continuous across attempts.
 */
function mintTaskMessageId(taskScope: string, callKey: string): ReturnType<typeof SessionLinkMessageId> {
  const hex = createHash('sha256').update(`task-msg\0${taskScope}\0${callKey}`).digest('hex')
  return SessionLinkMessageId(`session-link-message-${hex.slice(0, 32)}`)
}

/** The attempt-scoped idempotency key: original = callId, retry = callId/attempt-N. */
function attemptCallKey(callId: string, ordinal: number): string {
  return ordinal === 1 ? callId : `${callId}/attempt-${ordinal}`
}

/* --------------------------------------------------------------------------
 * session_get_task / session_resolve_task wire projections
 * ------------------------------------------------------------------------ */

interface TaskWireRoute { provider: string; model: string; reasoningEffort?: string }

/** Project one stored route into the wire's exact optional-field shape. */
function routeWire(route: ModelRouteSelection | undefined): TaskWireRoute | undefined {
  if (route === undefined) return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

/** The session_get_task wire projection: read-only view of one stored task row. */
function getTaskWire(
  tasks: Context['sessionLinkTasks'],
  view: ReturnType<Context['sessionLinkTasks']['getTask']>,
) {
  const row = tasks.getRow(view.taskId)
  const outbox = row?.outbox.map(event => ({
    eventId: event.eventId,
    kind: event.kind,
    revision: event.revision,
    status: event.status,
    ...(event.requestedModel === undefined ? {} : { requestedModel: routeWire(event.requestedModel) }),
    ...(event.actualModel === undefined ? {} : { actualModel: routeWire(event.actualModel) }),
    ...(event.executionState === undefined ? {} : { executionState: event.executionState }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    ...(event.attempts === undefined ? {} : { attempts: event.attempts }),
    decisionRequired: event.decisionRequired,
    resumable: event.resumable,
    ...(event.notifiedMessageId === undefined ? {} : { notifiedMessageId: String(event.notifiedMessageId) }),
    ...(event.blockedReason === undefined ? {} : { blockedReason: event.blockedReason }),
  })) ?? []
  const decisions = row?.decisions.map(decision => ({
    callId: decision.callId,
    action: decision.action,
    ...(decision.attemptId === undefined ? {} : { attemptId: decision.attemptId }),
    outcome: decision.outcome,
    appliedRevision: decision.appliedRevision,
    appliedAt: decision.appliedAt,
  })) ?? []
  return {
    taskId: String(view.taskId),
    taskState: view.taskState,
    revision: view.revision,
    expectedRevision: view.expectedRevision,
    ...(view.executionState === undefined ? {} : { executionState: view.executionState }),
    ...(view.reason === undefined ? {} : { reason: view.reason }),
    callerId: String(view.callerId),
    ...(view.targetSessionId === undefined ? {} : { targetSessionId: String(view.targetSessionId) }),
    execution: {
      ...(view.boundMessageId === undefined ? {} : { messageId: String(view.boundMessageId) }),
      ...(row?.execution.sessionId === undefined ? {} : { sessionId: String(row.execution.sessionId) }),
      ...(view.boundLinkId === undefined ? {} : { linkId: String(view.boundLinkId) }),
      ...(row?.execution.turnIntentId === undefined ? {} : { turnIntentId: row.execution.turnIntentId }),
      ...(row?.execution.currentlyExecuting === undefined ? {} : { currentlyExecuting: row.execution.currentlyExecuting }),
    },
    ...(routeWire(row === undefined ? undefined : requestedRouteOf(row.policy)) === undefined
      ? {}
      : { requestedModel: routeWire(requestedRouteOf(row!.policy)) }),
    ...(view.currentRoute === undefined ? {} : { currentRoute: routeWire(view.currentRoute) }),
    ...(view.routeUsed === undefined ? {} : { routeUsed: routeWire(view.routeUsed) }),
    attempts: view.attempts.map(attempt => ({
      attemptId: attempt.attemptId,
      ordinal: attempt.ordinal,
      kind: attempt.kind,
      ...(attempt.defaultFrozenRoute === undefined ? {} : { defaultFrozenRoute: routeWire(attempt.defaultFrozenRoute) }),
      results: attempt.results.map(result => ({
        route: { provider: result.route.provider, model: result.route.model, ...(result.route.reasoningEffort === undefined ? {} : { reasoningEffort: result.route.reasoningEffort }) },
        outcome: result.outcome,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.message === undefined ? {} : { message: result.message }),
      })),
    })),
    currentAttemptId: view.currentAttemptId,
    ...(view.latestIssue === undefined ? {} : { latestIssue: view.latestIssue }),
    outbox,
    decisions,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  }
}

/**
 * The session_resolve_task wire driver: validate an optional replacement
 * policy through Task 2's parser (same strictness as the tracked tools),
 * call resolveTask with the tool callId as the decision idempotency key, and
 * re-admit an applied retry through the SAME tracked admission machinery.
 */
async function resolveTaskWire(
  ctx: Context,
  caller: Agent,
  decisionCallId: string,
  args: {
    task_id: string
    expected_revision: number
    action: 'retry' | 'continue' | 'cancel'
    provider?: string
    model?: string
    reasoning_effort?: string
    on_model_unavailable?: unknown
  },
  pumpSchedule: () => void,
) {
  const tasks = taskServiceOf(ctx)
  const taskId = SessionLinkTaskId(args.task_id)

  // Replacement policy (retry/continue only): runs the SAME Task 2 parse +
  // normalize strictness as the original tracked call; absent params keep
  // the original policy snapshot.
  let policy: ModelRoutingPolicy | undefined
  if (args.action !== 'cancel'
    && (args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined
      || args.on_model_unavailable !== undefined)) {
    const routing = parseModelRoutingParams({
      ...(args.provider === undefined ? {} : { provider: args.provider }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.reasoning_effort === undefined ? {} : { reasoning_effort: args.reasoning_effort }),
      ...(args.on_model_unavailable === undefined ? {} : { on_model_unavailable: args.on_model_unavailable }),
    })
    if (!routing.present || routing.params === undefined) {
      throw new Error('MODEL_PARAMS_INVALID: a replacement policy needs at least provider+model or on_model_unavailable')
    }
    policy = normalizeModelRoutingParams(routing.params)
  }

  const row = tasks.getRow(taskId)
  if (row === undefined) {
    throw new SessionLinkError(`task "${taskId}" not found`, 'MESSAGE_NOT_FOUND')
  }
  // Sender-only access guard: identical not-found shape third parties see.
  if (row.callerId !== caller.id) {
    throw new SessionLinkError('only the original sender Session may resolve a task', 'LINK_CALLER_NOT_MEMBER')
  }

  /* R11: a retry/reopen decision against a task whose bound delivery the
   * mailbox does NOT contain is heraled FIRST — the row's `queued`-projection
   * is a phantom the caller must not resolve blindly. The herald drops the
   * task into waiting_decision/not_started (retry's required realm) with the
   * missingDelivery reason; the stale token only re-reads after the mark. */
  if (args.action === 'retry' && row.execution.messageId !== undefined
    && ctx.sessionLinks.message(row.execution.messageId) === undefined) {
    await tasks.markDeliveryMissing(taskId, row.execution.messageId)
  }

  // continue: only the sender; the service enforces waiting_decision+partial
  // + a host-confirmed resumable checkpoint. today's host capability reports
  // EVERY turn intent non-resumable (pause/resume fail closed honestly — Task
  // 1); a future capability revision may flip this to true. The wire layer
  // surfaces the honest refusal as the clean TASK_NOT_RESUMABLE error before
  // any mutation, NEVER converting it to a silent from-scratch retry.
  let hostResumable: boolean | undefined
  if (args.action === 'continue') {
    hostResumable = false
    if (row.taskState === 'waiting_decision' && row.executionState === 'partial') {
      throw new SessionLinkError(
        `TASK_NOT_RESUMABLE: task "${taskId}" host does not expose a resumable checkpoint; continue is refused honestly — start a new remediation task instead of replaying unknown effects`,
        'TASK_NOT_RESUMABLE' as never,
      )
    }
  }

  /* A stale expected revision is a durably-recorded decision; the caller is
   * expected to re-read through session_get_task and retry with the task's
   * current revision (the outbox pump's marker CAS may have advanced it
   * between a get_task and this resolve). The wire driver NEVER re-reads
   * and promotes a caller's stale token — that would defeat the CAS guard
   * every other tool consumer relies on. */
  const resolved = await tasks.resolveTask({
    callerId: caller.id,
    taskId,
    decisionCallId,
    expectedRevision: args.expected_revision,
    action: args.action,
    ...(policy === undefined ? {} : { policy }),
    ...(hostResumable === undefined ? {} : { hostResumable }),
    targetArchived: row.targetSessionId === undefined
      ? undefined
      : ctx.workspaceRegistry !== undefined && ctx.workspaceRegistry.archivedSessionIds.includes(row.targetSessionId),
  })

  // The decision COMMITTED: any applied retry/continue may immediately
  // re-admit; any applied/stale outcome may leave outbox work. A stale or
  // rejected outcome mutates nothing beyond the durable record.
  pumpSchedule()

  if (resolved.outcome === 'stale') {
    return {
      applied: false,
      decision: {
        action: resolved.decision.action,
        outcome: 'stale' as const,
        ...(resolved.decision.attemptId === undefined ? {} : { attemptId: resolved.decision.attemptId }),
        appliedRevision: resolved.decision.appliedRevision,
      },
      task: getTaskWire(tasks, tasks.getTask(caller.id, taskId)),
      stale: true,
    }
  }
  if (resolved.outcome !== 'applied') {
    return {
      applied: false,
      decision: {
        action: resolved.decision.action,
        outcome: resolved.decision.outcome,
        ...(resolved.decision.attemptId === undefined ? {} : { attemptId: resolved.decision.attemptId }),
        appliedRevision: resolved.decision.appliedRevision,
      },
      task: getTaskWire(tasks, tasks.getTask(caller.id, taskId)),
    }
  }

  /* Applied retry: re-admit the ORIGINAL flow through the SAME tracked
   * machinery the original call used — one deterministic messageId (same
   * task identity semantics), a fresh candidate precheck only against the
   * (possibly new) policy, and NO new Session/text. The task row's
   * `preparing` state guarantees resolveTask's own precondition that the
   * task never executed; the ORIGINAL delivery was either never admitted
   * (precheck failure) or never claimed (mailbox alone may still hold it
   * pending) — tracked re-admission re-attaches the binding under the same
   * deterministic message identity the original task owns, so the mailbox
   * never holds a duplicate. */
  if (args.action === 'retry') {
    await reAdmitRetriedTask(ctx, caller, taskId, pumpSchedule).catch((error: unknown) => {
      // A pump pass that raced the decision may have flipped another outbox
      // marker past the revision the decision committed at; re-read and
      // re-admit ONCE at the live revision — the SAME deterministic
      // messageId + idempotency key still binds this exact flow.
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'TASK_STALE_REVISION') {
        return reAdmitRetriedTask(ctx, caller, taskId, pumpSchedule)
      }
      throw error
    })
  }

  return {
    applied: true,
    attemptId: resolved.decision.attemptId ?? resolved.row.currentAttemptId,
    decision: {
      action: resolved.decision.action,
      outcome: 'applied' as const,
      ...(resolved.decision.attemptId === undefined ? {} : { attemptId: resolved.decision.attemptId }),
      appliedRevision: resolved.decision.appliedRevision,
    },
    task: getTaskWire(tasks, tasks.getTask(caller.id, taskId)),
  }
}

/**
 * Re-admit a successfully retried task through the SAME tracked admission
 * machinery the original call used (R08). The retry binds a FRESH attempt-
 * scoped delivery identity (R08(1): the previous attempt's consumed mailbox
 * delivery is never adopted — the new messageId mints from the current
 * attempt ordinal, the task row's notificationRoot keeps the chain budget),
 * re-runs the candidate precheck against the DECIDED policy snapshot, and
 * re-arms the ORIGINAL spawn flow idempotently for a precheck-not-created
 * spawn (R08(2): the spawn intent's original callKey re-derives the same
 * Session, the ledger claim re-arms its group, and the rename honestly
 * repeats). The payload the retry admits is the durable `payloadText`
 * (R09) — the FULL body, recovered from the bound predecessor message for
 * pre-R09 rows — never the bounded textExcerpt the pre-fix path re-sent.
 */
async function reAdmitRetriedTask(
  ctx: Context,
  caller: Agent,
  taskId: SessionLinkTaskId,
  pumpSchedule: () => void,
): Promise<void> {
  const tasks = taskServiceOf(ctx)
  const row = tasks.getRow(taskId)
  if (row === undefined || row.taskState !== 'preparing') return
  const targetId = row.targetSessionId ?? row.spawn?.targetSessionId
  if (targetId === undefined) return

  // Apply the DECIDED policy snapshot (resolveTask already swapped it in).
  const policy = row.policy
  let precheck: { route: ModelRouteSelection | undefined; index: number } | undefined
  let precheckError: ModelRoutingError | undefined
  try {
    precheck = await runPrecheck(ctx, policy)
  } catch (error: unknown) {
    if (!(error instanceof ModelRoutingError)) throw error
    precheckError = error
  }
  if (precheckError !== undefined) {
    // Fresh precheck failure on the new policy: project waiting_decision with
    // a fresh model_unavailable event; the pump will deliver ONCE (the
    // original precheck-failure event was already delivered exactly once).
    const live = tasks.getRow(taskId)
    if (live !== undefined && live.taskState === 'preparing') {
      const failure = precheckFailureWire(policy, precheckError)
      try {
        await tasks.requestStateChange(taskId, live.revision, {
          toState: 'waiting_decision',
          executionState: 'not_started',
          reason: failure.reason,
          events: [{ kind: 'model_unavailable', executionState: 'not_started', reason: failure.reason, decisionRequired: true, resumable: true }],
        })
      } catch { /* concurrent transition */ }
      pumpSchedule()
    }
    return
  }

  /* R08(2): a precheck-failed spawn's retry runs the FULL create/link/rename
   * sequence the original admission ran (the derived Session it names is the
   * SAME one the original callKey mints — the replay ledger absorbs the
   * repeat); a send-kind retry's target already exists and re-arms through
   * the same path. */
  const target = await ensureSpawnSession(ctx, caller, taskId, row)

  /* R09: prefer the durable full payload; recover a pre-R09 row's body from
   * the bound predecessor message when the row only carries the excerpt. */
  const payload = row.originalRequest.payloadText ?? (() => {
    const bound = row.notificationRoot.rootMessageId ?? row.execution.messageId
    const text = bound === undefined ? undefined : ctx.sessionLinks.message(bound)?.text
    return text ?? row.originalRequest.summary.textExcerpt ?? ''
  })()

  const current = tasks.getRow(taskId) ?? row
  const attempt = current.attempts.find(candidate => candidate.attemptId === current.currentAttemptId)
  const ordinal = attempt?.ordinal ?? 1
  const admitted = await admitTrackedDelivery(ctx, caller, taskId, target, {
    payload,
    callKey: attemptCallKey(row.callId, ordinal),
    policy,
    ...(precheck?.route === undefined ? {} : { digestCheckedSelection: precheck.route }),
  }, pumpSchedule).catch(async error => {
    if (error instanceof SessionLinkError && error.code === 'LINK_ALREADY_LINKED') return
    throw error
  })
  if (admitted === undefined) return
  if ('refusal' in admitted) {
    pumpSchedule()
    return
  }
  pumpSchedule()
}
