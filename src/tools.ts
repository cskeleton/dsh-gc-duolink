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
import { SessionLinkError, SessionLinkMessageId } from './index.ts'
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
import { installTaskRuntime, precheckFailureOf, requestedRouteOf } from './task-runtime.ts'
import { taskIdFor } from './tasks.ts'
import type { CreateTaskIntentInput, SavedTaskIntent, TaskEventInput } from './tasks.ts'
import type { SessionLinkTaskRecordData } from './task-spec.ts'
import { mountPerPresetAgent, PresetScopeConfig, resolvePresets } from './scope.ts'

export const name = 'tool-session-link'
export const inject = ['tools', 'agents', 'sessions', 'sessionLinks', 'sessionController', 'sessionTitle']

/** Row configuration: which presets' top-level Agents receive the tools. */
export type Config = PresetScopeConfig
/** Loader-visible row schema. */
export const Config = PresetScopeConfig

/** Require the exact live top-level calling Agent. */
function requireCaller(ctx: Context, exec: { agent?: Agent }): Agent {
  const agent = exec.agent
  if (agent === undefined || ctx.agents.get(agent.id) !== agent) {
    throw new Error('this tool requires the exact live calling agent on a top-level Session')
  }
  ctx.sessionLinks.assertOrdinaryTarget(agent.id, agent.session.header)
  return agent
}

/** The durable task service, resolved through cordis' inject-gated accessor so a
 * stack without SessionLinkTaskService (e.g. legacy tool tests) yields undefined
 * instead of failing the whole tool mount. Tracked admission refuses honestly. */
function taskServiceOf(ctx: Context): Context['sessionLinkTasks'] {
  try {
    return ctx.sessionLinkTasks
  } catch {
    const escape = (ctx as unknown as { __sessionLinkTasks?: Context['sessionLinkTasks'] }).__sessionLinkTasks
    if (escape !== undefined) return escape
    throw new Error('HOST_CAPABILITY_UNAVAILABLE: the task service is not mounted on this deployment')
  }
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

/**
 * Register the four Session Link tools in each eligible top-level Agent's scope.
 * @param ctx - host context carrying the tool registry, link service, Session Controller, and title service.
 * @param config - presets whose top-level Agents receive the tools.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const tools = definitions(ctx)
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

    installTaskRuntime(agent.ctx, agent, () => taskServiceOf(rootCtx), {
      pairLinked: (linkId, first, second) =>
        rootCtx.sessionLinks.list(first as never).some(link =>
          String(link.id) === String(linkId) && link.memberIds.includes(second as never)),
    })
  }
}

/** The four tool definitions, bound to the row context's services. */
function definitions(ctx: Context): ToolDefinition[] {
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
      + 'not the peer\'s answer — do not assume the task ran or completed.',
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
      render: (args, value) => [{
        type: 'text',
        text: 'outcome' in value
          ? value.outcome === 'admitted'
            ? `task ${value.taskId} admitted: message ${value.messageId} ${value.status} for session ${args.session_id}`
              + ` (requested ${value.requestedModel.provider}/${value.requestedModel.model}${value.selectedModel === undefined ? '' : `, selected ${value.selectedModel.provider}/${value.selectedModel.model}`})`
            : `task ${value.taskId} needs a decision (${value.reason}); no routing admitted`
          : value.status === 'accepted'
            ? `message ${value.messageId} accepted by session ${args.session_id}`
            : `message ${value.messageId} queued for session ${args.session_id} (durable; awaits the peer's next turn)`,
      }],
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
      })
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
      + 'Returns the new Session id for session_list_links / session_send_session_message.',
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
      render: (_args, value) => [{
        type: 'text',
        text: 'outcome' in value
          ? value.outcome === 'admitted'
            ? `task ${value.taskId} admitted: session ${value.sessionId ?? ''} linked (${value.linkId ?? ''}); task message ${value.messageId} ${value.status}`
              + ` (requested ${value.requestedModel.provider}/${value.requestedModel.model}${value.selectedModel === undefined ? '' : `, selected ${value.selectedModel.provider}/${value.selectedModel.model}`})`
            : `task ${value.taskId} needs a decision (${value.reason}); no Session was created and nothing was sent`
          : `session ${value.sessionId} created and linked (${value.linkId}); task message ${value.messageId} ${value.status}`,
      }],
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
        })
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

/** Persist the sync-precheck failure and answer it. NO Session/mailbox message exists at this point. */
async function savePrecheckFailure(
  ctx: Context,
  intent: Omit<CreateTaskIntentInput, 'precheckFailure'>,
  policy: ModelRoutingPolicy,
  error: ModelRoutingError,
): Promise<NeedsDecisionWire> {
  const tasks = taskServiceOf(ctx)
  const precheck = error.code === CATALOG_UNAVAILABLE
    ? { reason: 'catalog_unavailable', results: [] as { route: ModelRouteSelection; code: string; message?: string }[] }
    : precheckFailureOf(policy, error instanceof PrecheckExhausted ? error.checks : [])
  const saved = await tasks.saveTaskIntent({ ...intent, precheckFailure: precheck })
  return needsDecisionResult(saved.row)
}

/** Internal carrier for an exhausted per-candidate precheck trail. */
class PrecheckExhausted extends ModelRoutingError {
  constructor(readonly checks: { ok: boolean; code?: string; message?: string; route: ModelRouteSelection }[]) {
    super('MODEL_NOT_FOUND', 'every authorized candidate failed the catalog precheck')
    this.name = 'PrecheckExhausted'
  }
}

/**
 * The sync catalog precheck for a tracked call: read the deployment catalog
 * once, walk the concrete candidates in policy order, and select the first
 * available route. `session_default` sentinels stay opaque (resolved at
 * activation, never sampled here).
 * @returns the selected route when one passes.
 * @throws {@link ModelRoutingError} CATALOG_UNAVAILABLE when the read fails,
 *   or {@link PrecheckExhausted} when every concrete candidate rejected.
 */
async function runPrecheck(
  ctx: Context,
  policy: ModelRoutingPolicy,
): Promise<ModelRouteSelection> {
  let catalog: ModelCatalogLike
  try {
    catalog = await readModelCatalog(() => ctx.sessionController.modelCatalog() as Promise<ModelCatalogLike>)
  } catch (error: unknown) {
    if (error instanceof ModelRoutingError) throw error
    throw new ModelRoutingError(CATALOG_UNAVAILABLE, `the deployment model catalog cannot be read: ${reason(error)}`)
  }
  const outcome = checkCandidateRoutes(policy, catalog)
  if (outcome.selected !== undefined) {
    let selected: ModelRouteSelection | undefined
    for (const check of outcome.checks) {
      if (check.ok) { selected = check.route; break }
    }
    if (selected !== undefined) return selected
    return outcome.selected
  }
  throw new PrecheckExhausted([...outcome.checks])
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

/** Save-or-replay the durable intent: replays return the stored row as-is. */
async function saveIntent(
  ctx: Context,
  input: Parameters<Context['sessionLinkTasks']['saveTaskIntent']>[0],
): Promise<{ replayed: boolean; saved: SavedTaskIntent }> {
  const tasks = taskServiceOf(ctx)
  const taskId = taskIdFor(input.callerId, input.request.callId)
  const before = tasks.getRow(taskId)
  const saved = await tasks.saveTaskIntent(input)
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
    })
    if (existing.taskState === 'waiting_decision') return needsDecisionResult(existing)
    if (existing.execution.messageId !== undefined) {
      const message = ctx.sessionLinks.message(existing.execution.messageId)
      return admittedResult(existing, {
        messageId: existing.execution.messageId,
        status: message?.status === 'delivered' ? 'accepted' : 'queued',
      }, undefined)
    }
    return needsDecisionResult(existing)
  }
  await requireTaskHost(ctx, caller)
  // Precheck races nothing: it runs only on FIRST sight so a later catalog
  // change never reroutes this same task (plan: replay never re-runs precheck).
  let selected: ModelRouteSelection
  let precheckError: ModelRoutingError | undefined
  try {
    selected = await runPrecheck(ctx, request.policy)
  } catch (error: unknown) {
    if (!(error instanceof ModelRoutingError)) throw error
    precheckError = error
    selected = requestedRouteOf(request.policy)
  }
  const { saved } = await saveIntent(ctx, {
    callerId: caller.id,
    request: { kind: 'send', callId: request.callId, text: request.text, targetSessionId: targetId },
    policy: request.policy,
    tracked: true,
    ...(precheckError === undefined ? {} : {
      precheckFailure: precheckError.code === CATALOG_UNAVAILABLE
        ? { reason: 'catalog_unavailable', results: [] as { route: ModelRouteSelection; code: string; message?: string }[] }
        : precheckFailureOf(request.policy, precheckError instanceof PrecheckExhausted ? precheckError.checks : []),
    }),
  })
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
  const messageId = mintTaskMessageId(caller.id, request.callId)
  let intentId: string | undefined
  if (host !== undefined) {
    const intent = host.recordTurnIntent({
      taskId,
      attemptId: row.currentAttemptId,
      messageId: messageId as unknown as MessageId,
      route: { selection: selected },
      persistOnSuccess: request.policy.scope === 'session',
    })
    await host.claimTurnIntent(intent.intentId).catch(() => { /* the gate claims it at activation */ })
    intentId = intent.intentId
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
    })
    if (existing.taskState === 'waiting_decision') return needsDecisionResult(existing)
    if (existing.execution.messageId !== undefined) {
      const message = ctx.sessionLinks.message(existing.execution.messageId)
      return admittedResult(existing, {
        messageId: existing.execution.messageId,
        status: message?.status === 'delivered' ? 'accepted' : 'queued',
      }, undefined)
    }
    return needsDecisionResult(existing)
  }
  await requireTaskHost(ctx, caller)
  let selected: ModelRouteSelection
  let precheckError: ModelRoutingError | undefined
  try {
    selected = await runPrecheck(ctx, request.policy)
  } catch (error: unknown) {
    if (!(error instanceof ModelRoutingError)) throw error
    precheckError = error
    selected = requestedRouteOf(request.policy)
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
    ...(precheckError === undefined ? {} : {
      precheckFailure: precheckError.code === CATALOG_UNAVAILABLE
        ? { reason: 'catalog_unavailable', results: [] as { route: ModelRouteSelection; code: string; message?: string }[] }
        : precheckFailureOf(request.policy, precheckError instanceof PrecheckExhausted ? precheckError.checks : []),
    }),
  })
  const row = saved.row
  if (precheckError !== undefined) return needsDecisionResult(row)
  const taskId = taskIdFor(caller.id, request.callKey)
  const created = await ctx.sessionController.create({ cwd: request.cwd, sessionId: derived })
  const target = created.sessionId
  let linkId: SessionLinkId
  try {
    linkId = await ctx.sessionLinks.claimSpawnLink(
      caller.id, target, request.callKey, request.title,
      request.autoAwake, request.wakeCaller ?? request.autoAwake,
    )
  } catch (error: unknown) {
    if (error instanceof SessionLinkError && error.code === 'LINK_REVOKED') {
      throw new Error(unlinkedReplay(request.callKey, target))
    }
    throw new Error(`session ${target} was created in ${request.cwd} but could not be linked: ${reason(error)}. `
      + 'It holds no task; tell the human so they can link it with /session-link add or archive it.')
  }
  try {
    await ctx.sessionController.rename({ sessionId: target, title: request.title })
  } catch (error: unknown) {
    ctx.logger.warn(`session-link: renaming spawned session "${target}" failed: ${reason(error)}`)
  }
  const host = await hostForTarget(ctx, target)
  const messageId = mintTaskMessageId(caller.id, request.callKey)
  let intentId: string | undefined
  if (host !== undefined) {
    const intent = host.recordTurnIntent({
      taskId,
      attemptId: row.currentAttemptId,
      messageId: messageId as unknown as MessageId,
      route: { selection: selected },
      persistOnSuccess: request.policy.scope === 'session',
    })
    await host.claimTurnIntent(intent.intentId).catch(() => { /* the gate claims it at activation */ })
    intentId = intent.intentId
  }
  // Binding BEFORE the mailbox admission (same brief-4d ordering as send):
  // the spawned first-task wake claims the delivery synchronously inside
  // `send` and its first request must already see the durable row + intent.
  const boundPre = await tasks.attachBinding(taskId, row.revision, {
    messageId,
    sessionId: target,
    linkId,
    admittedAs: 'queued',
  })
  if (host !== undefined && intentId !== undefined) {
    await tasks.recordTurnIntent(taskId, boundPre.revision, {
      turnIntentId: intentId,
      messageId,
    })
  }
  let sent: SessionLinkSendResult
  try {
    sent = await ctx.sessionLinks.send(caller, target, {
      targetId: target,
      text: request.task,
      idempotencyKey: request.callKey,
      messageId,
      signal: request.signal,
    })
  } catch (error: unknown) {
    throw new Error(`session ${target} was created and linked (${linkId}), but its tracked task was not delivered and will not be: `
      + `${reason(error)}. Resend the task with session_send_session_message; it still starts the new Session.`)
  }
  let recorded = await tasks.getRow(taskId) ?? boundPre
  if (sent.status === 'accepted' && recorded.execution.turnIntentId !== undefined) {
    recorded = await tasks.attachBinding(taskId, recorded.revision, {
      messageId: sent.messageId,
      sessionId: target,
      admittedAs: 'accepted',
    }).catch(() => recorded)
  }
  return admittedResult(tasks.getRow(taskId) ?? recorded, sent, selected)
}

/** Resolve (or lazily install) the HOST capability of the TARGET Session the
 * runtime claims through. A capability-capable host exposes it on `agent.ctx`;
 * in stacks where the plugin row attaches it (tests, capability-present
 * deployments integrating the row), first resolution creates and publishes it
 * so later gate/freeze order matches a host-owned mount. Hosts that can never
 * satisfy the contract yield `undefined` and the caller keeps the plain tool
 * path for untracked calls or HOST_CAPABILITY_UNAVAILABLE for tracked ones. */
async function hostForTarget(ctx: Context, targetId: SessionId) {
  const agent = ctx.agents.get(targetId)
  if (agent === undefined) return undefined
  const existing = resolveTaskHost(agent.ctx)
  if (existing !== undefined) return existing
  try {
    const capability = await createTaskHostLazy(agent.ctx, agent)
    if (capability === undefined) return undefined
    // cordis' service accessor publishes through `Fiber.provide`;
    // defineProperty makes the value visible to every later
    // `resolveTaskHost(agent.ctx)` the plugin and the runtime call.
    Object.defineProperty(agent.ctx, 'taskHost', { value: capability, configurable: true })
    return capability
  } catch {
    return undefined
  }
}

/**
 * The capability factory, hosted outside the plugin's type surface because the
 * published `lib/types` declarations precede the host extension. Resolved
 * through the installed module's runtime namespace so the capability class is
 * the SAME identity any host-mounted capability the caller also resolved.
 */
async function createTaskHostLazy(
  ctx: Context,
  agent: Agent,
): Promise<ReturnType<typeof resolveTaskHost>> {
  const mod = await import('@deepseek-ai/dsh-api-session-controller') as Record<string, unknown>
  const factory = mod.createTaskHost as ((ctx: Context, agent: Agent) => ReturnType<typeof resolveTaskHost>) | undefined
  return factory === undefined ? undefined : factory(ctx, agent)
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
 * Derive the mailbox message identity a tracked admission will use: stable
 * across replay of the same (caller, callId) pair so the cloned Session's
 * re-admission re-uses the SAME identity, and unique per (caller, original
 * callId) so every task owns exactly one durable delivery identity.
 */
function mintTaskMessageId(callerId: SessionId, callId: string): ReturnType<typeof SessionLinkMessageId> {
  const hex = createHash('sha256').update(`task-msg\0${callerId}\0${callId}`).digest('hex')
  return SessionLinkMessageId(`session-link-message-${hex.slice(0, 32)}`)
}
