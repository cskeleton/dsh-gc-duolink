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
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'
import { SessionLinkError, SessionLinkMessageId } from './index.ts'
import type { SessionLinkId } from './index.ts'
import type {} from './index.ts'
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
 * Register the four Session Link tools in each eligible top-level Agent's scope.
 * @param ctx - host context carrying the tool registry, link service, Session Controller, and title service.
 * @param config - presets whose top-level Agents receive the tools.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const tools = definitions(ctx)
  mountPerPresetAgent(ctx, resolvePresets(config), 'session-link-tools', ['tools'], (scoped) => {
    for (const tool of tools) scoped.tools.register(tool)
  })
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: sendOutputProperties,
      },
      render: (args, value) => [{
        type: 'text',
        text: value.status === 'accepted'
          ? `message ${value.messageId} accepted by session ${args.session_id}`
          : `message ${value.messageId} queued for session ${args.session_id} (durable; awaits the peer's next turn)`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      const result = await ctx.sessionLinks.send(caller, brandString<SessionId>(args.session_id), {
        targetId: brandString<SessionId>(args.session_id),
        text: args.message,
        ...(args.in_reply_to === undefined ? {} : { inReplyTo: SessionLinkMessageId(args.in_reply_to) }),
        idempotencyKey: String(exec.callId),
        signal: exec.signal,
      })
      return { messageId: String(result.messageId), status: result.status }
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
      + 'auto_awake only decides whether LATER peer messages may wake it. '
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
        description: 'Whether later peer messages may wake this new Session automatically (subject to budgets). Defaults to false: later messages wait for its next turn. The initial task wakes it either way.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          linkId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['queued', 'accepted'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `session ${value.sessionId} created and linked (${value.linkId}); task message ${value.messageId} ${value.status}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller(ctx, exec)
      const cwd = args.cwd.trim()
      if (cwd === '') throw new Error('cwd must not be empty')
      if (!cwd.startsWith('/')) throw new Error(`cwd must be fully qualified, got ${JSON.stringify(args.cwd)}`)
      if (args.task.trim() === '') throw new Error('task must not be empty')
      const title = args.title === undefined || args.title.trim() === ''
        ? (relative('/', cwd) || cwd).split('/').filter(part => part !== '').at(-1) ?? 'linked-session'
        : args.title.trim()
      const callKey = String(exec.callId)
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
          ? await ctx.sessionLinks.claimSpawnLink(caller.id, sessionId, callKey, title, args.auto_awake === true)
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
  })]
}
