/**
 * Turn-scoped linked-session projection for the `session_spawn_linked_session` card.
 *
 * This Definition publishes the link a settled spawn call created against its
 * Turn, so the card renders as a turn-level element through ui-chat's
 * `conversation.chat.turnTail` list seat. The result text is the model-visible
 * surface of the Host tool, which the conversation contract freezes, so the
 * card narrows the linked Session's identity from that text; Session-log
 * replay reproduces the card with no Host change. A link the human operator
 * makes through the panel or the `/session-link` command runs no tool call, so
 * it produces no card.
 */
import type {
  ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionLinkId, SessionLinkMessageId } from '../types.ts'

/** Wire Tool name whose settled result announces one spawned-and-linked Session. */
export const SPAWN_LINKED_SESSION_TOOL = 'session_spawn_linked_session'

/** Immutable linked-session facts published against one Turn. */
export interface SessionLinkTurnData {
  readonly created: readonly LinkedSpawn[]
}

/** One settled `session_spawn_linked_session` result the card renders. */
export interface LinkedSpawn {
  /** Sequence of the settling `tool/result`, for the closing-boundary filter. */
  readonly seq: number
  /** The call that settled it, for the row key. */
  readonly callId: string
  /** Session the spawn created and linked. */
  readonly sessionId: SessionId
  /** Group the spawn joined. */
  readonly linkId: SessionLinkId
  /** Task message recorded for the spawn; never claims delivery or execution. */
  readonly messageId: SessionLinkMessageId
  /** Admission state the Host announced at creation time. */
  readonly delivery: 'queued' | 'accepted'
  /** Model configured at spawn time, without claiming the model ran or remains current. */
  readonly initialModel?: InitialSessionModel
}

/** Lightweight projection of the optional versioned spawn sidecar. */
export interface InitialSessionModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** `session_spawn_linked_session` results settled in this Turn, in settlement order. */
    'session-link-external-created': SessionLinkTurnData
  }
}

/**
 * Turn-tail owner currency this row reads: the closing Turn with its sequence.
 *
 * Structurally equal to ui-chat's `TurnTailOwnerProps`; the fields are named
 * locally so this package keeps its existing dependency set.
 */
export interface SessionLinkTurnOwner {
  readonly turn: TurnLocation
  readonly seq: number
}

/** The spawn result's text shape, published by the Host tool's renderer. */
const RESULT_PATTERN = /^session (\S+) created and linked \((\S+)\); task message (\S+) (queued|accepted)$/

/** Optional metadata never prevents a legacy successful spawn from rendering. */
function initialSessionModel(text: string | undefined): InitialSessionModel | undefined {
  if (text === undefined) return undefined
  let data: unknown
  try { data = JSON.parse(text) } catch { return undefined }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const sidecar = data as Record<string, unknown>
  if (sidecar.type !== 'session-link/initial-model' || sidecar.version !== 1) return undefined
  if (typeof sidecar.initialModel !== 'object' || sidecar.initialModel === null || Array.isArray(sidecar.initialModel)) return undefined
  const model = sidecar.initialModel as Record<string, unknown>
  if (typeof model.provider !== 'string' || model.provider.trim().length === 0
    || typeof model.model !== 'string' || model.model.trim().length === 0) return undefined
  if (model.reasoningEffort !== undefined
    && (typeof model.reasoningEffort !== 'string' || model.reasoningEffort.trim().length === 0)) return undefined
  return {
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort as string }),
  }
}

/** First text attributes the spawn; only the second text may add initial model metadata. */
function linkedSpawn(content: readonly { type: string; text?: string }[]): Pick<LinkedSpawn, 'sessionId' | 'linkId' | 'messageId' | 'delivery' | 'initialModel'> | undefined {
  const texts = content.filter(block => block.type === 'text')
  const text = texts[0]?.text
  if (text === undefined) return undefined
  const match = RESULT_PATTERN.exec(text)
  if (match === null) return undefined
  const initialModel = initialSessionModel(texts[1]?.text)
  return {
    sessionId: match[1] as SessionId,
    linkId: match[2] as SessionLinkId,
    messageId: match[3] as SessionLinkMessageId,
    delivery: match[4] as 'queued' | 'accepted',
    ...(initialModel === undefined ? {} : { initialModel }),
  }
}

/**
 * Select the links one Turn created, for the Turn-tail list entry to render.
 *
 * The bounded sequence is the Turn's own end: a Turn whose last text response
 * precedes a spawn settlement still owns that link when it ends on a failed
 * request or a user stop. A Turn without a recorded end falls back to the
 * owner's own sequence.
 * @param owner - Turn-tail owner currency for the closing Assistant.
 * @returns created links, or null when the Turn created none.
 */
export function selectLinkedSpawns(owner: SessionLinkTurnOwner): SessionLinkTurnData | null {
  const created = owner.turn.data.get('session-link-external-created')?.created
    .filter(item => item.seq <= (owner.turn.end?.seq ?? owner.seq))
  return created === undefined || created.length === 0 ? null : { created }
}

/** One in-window root call head, kept to pair its result. */
interface SpawnCall {
  readonly name: string
}

interface SessionLinkTurnState {
  readonly turn: number
  readonly calls: ReadonlyMap<string, SpawnCall>
  readonly created: readonly LinkedSpawn[]
}

/** Turn-local `session_spawn_linked_session` accumulator; it publishes no view Node. */
export const sessionLinkTurnDefinition: ConversationNodeDefinition<SessionLinkTurnState> = {
  kind: 'session-link-external-created',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('session-link-external-created start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), created: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(String(match.event.data.callId), { name: match.event.data.name })
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    const call = context.state.calls.get(String(match.event.data.message.source.callId))
    if (call?.name !== SPAWN_LINKED_SESSION_TOOL) return context.state
    // A failed spawn names no Session, so its Turn renders no card.
    if (match.event.data.message.isError === true) return context.state
    const facts = linkedSpawn(match.event.data.message.content)
    if (facts === undefined) return context.state
    const item: LinkedSpawn = {
      seq: match.event.seq,
      callId: String(match.event.data.message.source.callId),
      ...facts,
    }
    return { ...context.state, created: [...context.state.created, item] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'session-link-external-created'
      && previous.value.created === context.state.created) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'session-link-external-created',
      value: { created: context.state.created },
    }
  },
}
