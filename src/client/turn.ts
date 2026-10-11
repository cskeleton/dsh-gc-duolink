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
import type { SessionLinkId } from '../types.ts'

/** Wire Tool name whose settled result announces one spawned-and-linked Session. */
export const SPAWN_LINKED_SESSION_TOOL = 'session_spawn_linked_session'
/** Wire Tool name whose tracked send result may append the task sidecar block. */
export const SEND_SESSION_MESSAGE_TOOL = 'session_send_session_message'

/** Machine-readable sidecar marker the Host tool's render appends after the text. */
export const TASK_RESULT_MARKER = '"type":"session-link/task-result"'

/** Immutable linked-session facts published against one Turn. */
export interface SessionLinkTurnData {
  readonly created: readonly LinkedSpawn[]
  /** Tracked-task facts from `session_spawn_linked_session` and `session_send_session_message` sidecars. */
  readonly tasks: readonly TrackedTaskFact[]
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
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** `session_spawn_linked_session` results settled in this Turn, in settlement order. */
    'session-link-external-created': SessionLinkTurnData
  }
}

/** One tracked task fact: spawn or send, admitted or waiting decision. */
export interface TrackedTaskFact {
  /** Sequence of the settling `tool/result`, for the closing-boundary filter. */
  readonly seq: number
  /** The call that settled it, for the row key. */
  readonly callId: string
  /** Which tracked tool emitted the result. */
  readonly tool: 'session_spawn_linked_session' | 'session_send_session_message'
  /** Durable task identity. */
  readonly taskId: string
  /** CAS revision at admission. */
  readonly taskRevision: number
  /** Admission outcome; a `needs_decision` task may have NO Session at all. */
  readonly outcome: 'admitted' | 'needs_decision'
  /** Durable task state at admission. */
  readonly taskState: string
  /** Task or session scope; persistent labels only ever show when persisted. */
  readonly scope?: 'task' | 'session'
  /** Requested route text; a needs_decision fact may omit it. */
  readonly requestedModel?: string
  /** Selected route text, present on admitted flows. */
  readonly selectedModel?: string
  /** Mailbox identity of the admitted task message. */
  readonly messageId?: string
  /** Delivery status of that message (never an execution claim). */
  readonly status?: 'queued' | 'accepted'
  /** Spawn or send target Session id, present only when a Session exists. */
  readonly sessionId?: SessionId
  /** Link group the pair shares, present only when one exists. */
  readonly linkId?: SessionLinkId
  /** needs_decision detail. */
  readonly reason?: string

  readonly attempts?: number
  readonly executionState?: 'not_started' | 'partial' | 'unknown'
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

/** One text block of a settled tool result. */
interface ResultContentBlock {
  readonly type: string
  readonly text?: string
}

/** The spawn result's text shape, published by the Host tool's renderer. */
const RESULT_PATTERN = /^session (\S+) created and linked \((\S+)\); task message \S+ (?:queued|accepted)$/

/**
 * Narrow one settled result's FIRST text segment to the linked-session
 * identity it announces: byte-exact legacy shape, so old logs replay and a
 * tracked spawn NEVER breaks this surface (its first segment stays the
 * legacy sentence). Later text blocks never satisfy this pattern.
 * @param content - result content blocks of the settling call.
 * @returns the linked facts, or undefined when the text names none.
 */
function linkedSpawn(content: readonly ResultContentBlock[]): { sessionId: SessionId; linkId: SessionLinkId } | undefined {
  const text = content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  const match = RESULT_PATTERN.exec(text)
  if (match === null) return undefined
  return { sessionId: match[1] as SessionId, linkId: match[2] as SessionLinkId }
}

/**
 * Pull the machine-readable task sidecar the Host render appends after the
 * legacy text. The whole result is replayed byte-for-byte: we never render
 * its text, only narrow the JSON line that follows the `---` marker. Any
 * parse miss stays silent (an untracked call's result has no such block).
 * @param content - result content blocks of the settling call.
 * @returns the parsed facts, or undefined when the result carries no sidecar.
 */
function taskSidecar(content: readonly ResultContentBlock[]): Record<string, unknown> | undefined {
  for (const block of content) {
    if (block.type !== 'text' || block.text === undefined) continue
    const jsonStart = block.text.indexOf('{')
    const marker = block.text.indexOf(TASK_RESULT_MARKER)
    if (jsonStart === -1 || marker === -1 || marker < jsonStart) continue
    for (let end = block.text.length; end > jsonStart; end -= 1) {
      const candidate = block.text.slice(jsonStart, end)
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>
        if (parsed.type === 'session-link/task-result') return parsed
      } catch {
        // keep shrinking until the closing brace fits
      }
    }
  }
  return undefined
}

/** Render one route the sidecar names into display text (provider/model + optional effort). */
function routeText(route: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined): string | undefined {
  if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
  return `${route.provider}/${route.model}${typeof route.reasoningEffort === 'string' ? ` (effort ${route.reasoningEffort})` : ''}`
}

/** Project the parsed sidecar into the turn-local task fact (spawn or send). */
function taskFactOf(
  seq: number,
  callId: string,
  tool: TrackedTaskFact['tool'],
  parsed: Record<string, unknown>,
): TrackedTaskFact | undefined {
  if (typeof parsed.taskId !== 'string' || typeof parsed.taskRevision !== 'number') return undefined
  if (parsed.outcome !== 'admitted' && parsed.outcome !== 'needs_decision') return undefined
  const requestedModel = routeText(parsed.requestedModel as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined)
  if (typeof parsed.taskState !== 'string') return undefined
  return {
    seq,
    callId,
    tool,
    taskId: parsed.taskId,
    taskRevision: parsed.taskRevision,
    outcome: parsed.outcome,
    taskState: parsed.taskState,
    ...(parsed.scope === 'session' || parsed.scope === 'task' ? { scope: parsed.scope } : {}),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    ...(routeText(parsed.selectedModel as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined) === undefined
      ? {} : { selectedModel: routeText(parsed.selectedModel as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined) }),
    ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
    ...(parsed.status === 'queued' || parsed.status === 'accepted' ? { status: parsed.status } : {}),
    ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId as SessionId } : {}),
    ...(typeof parsed.linkId === 'string' ? { linkId: parsed.linkId as SessionLinkId } : {}),
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    ...(typeof parsed.attempts === 'number' ? { attempts: parsed.attempts } : {}),
    ...(parsed.executionState === 'not_started' || parsed.executionState === 'partial' || parsed.executionState === 'unknown'
      ? { executionState: parsed.executionState } : {}),
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
  const tasks = owner.turn.data.get('session-link-external-created')?.tasks ?? []
  return created === undefined || created.length === 0 ? null : { created, tasks }
}

/**
 * Task facts one Turn settled, in settlement order, with each tracked spawn's
 * Session pairing folded onto its task card when a Session actually exists.
 * A `needs_decision` spawn names no Session and never gets a session jump.
 * @param owner - Turn-tail owner currency for the closing Assistant.
 * @returns tracked task facts, or null when the Turn settled none.
 */
export function selectTrackedTasks(owner: SessionLinkTurnOwner): TrackedTaskFact[] | null {
  const turnData = owner.turn.data.get('session-link-external-created')
  const tasks = turnData?.tasks.filter(item => item.seq <= (owner.turn.end?.seq ?? owner.seq))
  if (tasks === undefined || tasks.length === 0) return null
  return tasks
}

/** One in-window root call head, kept to pair its result. */
interface SpawnCall {
  readonly name: string
}

interface SessionLinkTurnState {
  readonly turn: number
  readonly calls: ReadonlyMap<string, SpawnCall>
  readonly created: readonly LinkedSpawn[]
  readonly tasks: readonly TrackedTaskFact[]
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
    return { turn: match.event.data.turn, calls: new Map(), created: [], tasks: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(String(match.event.data.callId), { name: match.event.data.name })
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    const callName = context.state.calls.get(String(match.event.data.message.source.callId))?.name
    if (callName !== SPAWN_LINKED_SESSION_TOOL && callName !== SEND_SESSION_MESSAGE_TOOL) return context.state
    // A failed spawn names no Session, so its Turn renders no card.
    if (match.event.data.message.isError === true) return context.state
    const seq = match.event.seq
    const callId = String(match.event.data.message.source.callId)
    let created = context.state.created
    if (callName === SPAWN_LINKED_SESSION_TOOL) {
      const facts = linkedSpawn(match.event.data.message.content)
      if (facts !== undefined) {
        created = [...created, { seq, callId, ...facts }]
      }
    }
    const parsed = taskSidecar(match.event.data.message.content)
    let tasks = context.state.tasks
    if (parsed !== undefined) {
      const fact = taskFactOf(seq, callId, callName, parsed)
      if (fact !== undefined && !tasks.some(item => item.taskId === fact.taskId && item.callId === fact.callId)) {
        tasks = [...tasks, fact]
      }
    }
    if (created === context.state.created && tasks === context.state.tasks) return context.state
    return { ...context.state, created, tasks }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'session-link-external-created'
      && previous.value.created === context.state.created
      && previous.value.tasks === context.state.tasks) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'session-link-external-created',
      value: { created: context.state.created, tasks: context.state.tasks },
    }
  },
}
