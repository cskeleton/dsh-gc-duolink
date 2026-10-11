// @vitest-environment jsdom
/** Settled spawn attribution, Turn cutoffs, and current Host wake state. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationMatch, ConversationNodeContext, ConversationStartMatch, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionLinkId, type SessionLinkTaskViewResponse, type SessionLinkView } from '../src/types.ts'
import { TurnCard } from '../src/client/TurnCard.tsx'
import {
  selectLinkedSpawns, selectTrackedTasks, sessionLinkTurnDefinition,
  SEND_SESSION_MESSAGE_TOOL, SPAWN_LINKED_SESSION_TOOL, type SessionLinkTurnData, type TrackedTaskFact,
} from '../src/client/turn.ts'
import { createLinkSource, createTaskSource, type LinkSnapshot, type TaskSnapshot } from '../src/client/state.ts'
import type { LinkProps } from '../src/client/components.tsx'
import { en, type NS } from '../src/client/locales.ts'

const SELF = 'owner' as SessionId
const PEER = 'spawned-session' as SessionId
const LINK = SessionLinkId('link-01')
const CALL = 'call-spawn'
const RESULT_TEXT = `session ${PEER} created and linked (${LINK}); task message msg-1 queued`
const DATA_KEY = 'session-link-external-created'
type State = ReturnType<typeof sessionLinkTurnDefinition.start>

afterEach(cleanup)

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return {
    type, seq, time: 1_000 + seq, data,
    ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
  } as SessionEvent
}
function call(seq: number, name = SPAWN_LINKED_SESSION_TOOL, callId = CALL): SessionEvent {
  return event(seq, 'tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
}
function result(seq: number, text = RESULT_TEXT, isError = false, callId = CALL): SessionEvent {
  return event(seq, 'tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({
      callId: ToolCallId(callId), content: [{ type: 'text', text }], isError,
    }),
  })
}

/** Exercise the Definition's public matcher, reducer, and Location publisher. */
function fold(events: readonly SessionEvent[]): SessionLinkTurnData | undefined {
  let state: State | undefined
  let start: ConversationStartMatch | undefined
  const matches: ConversationMatch[] = []
  const context = (): ConversationNodeContext<State> => ({
    key: DATA_KEY, kind: DATA_KEY, id: '1', state, start, matches, current: new Map(),
  })
  for (const current of events) {
    const found = sessionLinkTurnDefinition.match(current)
    if (found === null) continue
    const match: ConversationMatch = { event: current, role: found.role, location: { kind: 'session' } }
    matches.push(match)
    if (found.role === 'start') {
      start = { ...match, role: 'start' }
      state = sessionLinkTurnDefinition.start(context(), start, { previous: () => undefined })
    } else if (state !== undefined) {
      state = sessionLinkTurnDefinition.update({ ...context(), state }, match)
    }
  }
  const published = sessionLinkTurnDefinition.buildLocationData?.(context(), 'turn', null)
  return published?.kind === 'turn' && published.key === DATA_KEY ? published.value : undefined
}

function turn(data?: SessionLinkTurnData, endSeq?: number): TurnLocation {
  return {
    turn: 1, start: undefined, status: 'closed', steps: [],
    end: endSeq === undefined ? undefined : event(endSeq, 'turn/end', { turn: 1, reason: { kind: 'completed' } }) as SessionEvent<'turn/end'>,
    data: {
      get: () => data,
      source: () => ({ getSnapshot: () => data, subscribe: () => () => {} }),
    },
  }
}

describe('settled linked-spawn Definition', () => {
  it('publishes only a settled successful spawn with its paired call and append result', () => {
    const start = event(1, 'turn/start', { turn: 1 })
    expect(fold([start, call(2)])).toEqual({ created: [], tasks: [] })
    expect(fold([start, result(3)])).toEqual({ created: [], tasks: [] })
    expect(fold([start, call(2), result(3)])).toEqual({
      created: [{ seq: 3, callId: CALL, sessionId: PEER, linkId: LINK }], tasks: [],
    })
    const replacement = result(3)
    if (replacement.type !== 'tool/result') throw new Error('tool/result fixture required')
    expect(fold([start, call(2), {
      ...replacement, surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
    }])).toEqual({ created: [], tasks: [] })
    const missingMarker = { ...replacement, surfaceOp: undefined } as SessionEvent
    expect(fold([start, call(2), missingMarker])).toEqual({ created: [], tasks: [] })
  })

  it('omits failed, unpaired, differently named, or unparsable tool results', () => {
    const start = event(1, 'turn/start', { turn: 1 })
    expect(fold([start, call(2), result(3, RESULT_TEXT, true)])).toEqual({ created: [], tasks: [] })
    expect(fold([start, call(2, 'session_spawn'), result(3)])).toEqual({ created: [], tasks: [] })
    expect(fold([start, call(2), result(3, RESULT_TEXT, false, 'another-call')])).toEqual({ created: [], tasks: [] })
    expect(fold([start, call(2), result(3, 'session created; task message msg-1 queued')])).toEqual({ created: [], tasks: [] })
    expect(fold([start, call(2), result(3, RESULT_TEXT.replace('queued', 'failed'))])).toEqual({ created: [], tasks: [] })
  })

  it('creates no card from human link commands or another Turn with no spawn', () => {
    const first = fold([event(1, 'turn/start', { turn: 1 }), call(2), result(3)])
    expect(first?.created).toHaveLength(1)
    const human = event(2, 'user/message', {
      id: 'human-link', role: 'user', content: [{ type: 'text', text: '/session-link add peer' }],
      source: { kind: 'user', rpcId: 'human' },
    })
    expect(fold([event(1, 'turn/start', { turn: 2 }), human, event(4, 'turn/end', { turn: 2 })]))
      .toEqual({ created: [], tasks: [] })
  })
})

describe('closing Turn cutoff', () => {
  const data: SessionLinkTurnData = { created: [
    { seq: 3, callId: 'call-a', sessionId: PEER, linkId: LINK },
    { seq: 7, callId: 'call-b', sessionId: PEER, linkId: LINK },
  ], tasks: [] }

  it('uses the Turn end before the owner sequence, with an open-Turn fallback', () => {
    expect(selectLinkedSpawns({ turn: turn(), seq: 9 })).toBeNull()
    expect(selectLinkedSpawns({ turn: turn(data, 5), seq: 9 })?.created.map(spawn => spawn.callId)).toEqual(['call-a'])
    expect(selectLinkedSpawns({ turn: turn(data), seq: 6 })?.created.map(spawn => spawn.callId)).toEqual(['call-a'])
    expect(selectLinkedSpawns({ turn: turn(data, 9), seq: 2 })?.created).toHaveLength(2)
  })
})

describe('Turn card Host view', () => {
  const t: TranslateNS<typeof NS> = (key, params) =>
    en[key].replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))

  function taskHook(tasks: SessionLinkTaskViewResponse): SnapshotSelectorHook<TaskSnapshot> {
    return <Value,>(select: (snapshot: TaskSnapshot) => Value): Value => select({ status: 'ready', view: tasks })
  }
  const emptyTasks: SessionLinkTaskViewResponse = { pollIntervalMs: 30_000, tasks: [] }

  it('renders a title and wake flag, opens management, and drops the flag after revoke', async () => {
    let view: SessionLinkView = {
      pollIntervalMs: 30_000,
      links: [{ id: LINK, name: 'Pair', memberIds: [SELF, PEER], autoWakeSessionIds: [PEER], revision: 1 }],
      sessions: [{ id: PEER, title: 'Peer title', running: false, archived: false, ordinary: true, blank: false }],
    }
    const source = createLinkSource({ load: async () => view, subscribeReset: () => () => {} })
    const useLinks: SnapshotSelectorHook<LinkSnapshot> = <Value,>(select: (snapshot: LinkSnapshot) => Value): Value =>
      select(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
    const props: LinkProps = {
      sessionId: SELF, useLinks, useTasks: taskHook(emptyTasks), refresh: source.refresh, refreshTasks: vi.fn(async () => true), t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), openPanel: vi.fn(), openSession: vi.fn(),
    }
    const location = turn({ created: [{ seq: 3, callId: CALL, sessionId: PEER, linkId: LINK }], tasks: [] }, 9)
    const rendered = render(<TurnCard {...props} turn={location} seq={9} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Linked with "Peer title"')).toBeTruthy()
    expect(screen.getByText('Wake peer: on')).toBeTruthy()
    expect(screen.getByText('Wake me: off')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View link' }))
    expect(props.openPanel).toHaveBeenCalledOnce()
    view = { ...view, links: [] }
    await act(async () => { await source.refresh() })
    expect(screen.getByText('Linked with "Peer title"')).toBeTruthy()
    expect(screen.queryByText('Wake peer: on')).toBeNull()
    expect(screen.queryByText('Wake peer: off')).toBeNull()
    expect(screen.queryByText('Wake me: off')).toBeNull()
    rendered.unmount()
    source.dispose()
  })

  it('renders no card when a human-created group has no settled spawn in this Turn', () => {
    const useLinks: SnapshotSelectorHook<LinkSnapshot> = <Value,>(select: (snapshot: LinkSnapshot) => Value): Value =>
      select({ status: 'ready', view: { pollIntervalMs: 30_000, sessions: [], links: [
        { id: LINK, name: 'Human grant', memberIds: [SELF, PEER], autoWakeSessionIds: [], revision: 1 },
      ] } })
    const props: LinkProps = {
      sessionId: SELF, useLinks, useTasks: taskHook(emptyTasks), refresh: vi.fn(), refreshTasks: vi.fn(async () => true), t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), openPanel: vi.fn(), openSession: vi.fn(),
    }
    const rendered = render(<TurnCard {...props} turn={turn({ created: [], tasks: [] }, 9)} seq={9} />)
    expect(rendered.container.firstChild).toBeNull()
  })
})

/* --------------------------------------------------------------------------
 * Tracked-task projections: legacy replay byte-compat, sidecar narrow, and
 * the three card branches (admitted / needs_decision-no-session /
 * needs_decision-with-session), plus the panel HUD facts.
 * ------------------------------------------------------------------------ */

/** Preview-style tracked sidecar text: comments + JSON after the legacy first segment. */
function sidecarText(parsed: Record<string, unknown>): string {
  return ['---', 'Tracked-task status (host facts; admission is never execution success).', JSON.stringify(parsed)].join('\n')
}

function taskResult(callSeq: number, opts: {
  tool?: string
  callId?: string
  outcome: 'admitted' | 'needs_decision'
  legacyFirst: string
  taskId?: string
  taskRevision?: number
  taskState?: string
  scope?: 'task' | 'session'
  requestedModel?: { provider: string; model: string; reasoningEffort?: string }
  selectedModel?: { provider: string; model: string; reasoningEffort?: string }
  sessionId?: string
  linkId?: string
  messageId?: string
  status?: 'queued' | 'accepted'
  reason?: string
  attempts?: number
  executionState?: 'not_started' | 'partial' | 'unknown'
}): SessionEvent {
  const taskId = opts.taskId ?? 'task:owner:call-1'
  const sidecar = {
    type: 'session-link/task-result', version: 1,
    tool: opts.tool ?? SPAWN_LINKED_SESSION_TOOL,
    outcome: opts.outcome, taskId,
    taskRevision: opts.taskRevision ?? 3,
    ...(opts.messageId === undefined ? {} : { messageId: opts.messageId }),
    ...(opts.status === undefined ? {} : { status: opts.status }),
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    ...(opts.linkId === undefined ? {} : { linkId: opts.linkId }),
    taskState: opts.taskState ?? 'preparing',
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    requestedModel: opts.requestedModel ?? { provider: 'deepseek', model: 'deepseek-chat' },
    ...(opts.selectedModel === undefined ? {} : { selectedModel: opts.selectedModel }),
    ...(opts.executionState === undefined ? {} : { executionState: opts.executionState }),
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    ...(opts.attempts === undefined ? {} : { attempts: opts.attempts }),
  }
  return event(callSeq, 'tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({
      callId: ToolCallId(opts.callId ?? CALL),
      content: [{ type: 'text', text: opts.legacyFirst }, { type: 'text', text: sidecarText(sidecar) }],
      isError: false,
    }),
  })
}

describe('tracked-task narrow from the sidecar', () => {
  const start = event(1, 'turn/start', { turn: 1 })

  it('parses a tracked spawn admitted sidecar and matches it to the spawn fact', () => {
    const folded = fold([start, call(2), taskResult(3, {
      outcome: 'admitted', legacyFirst: RESULT_TEXT,
      taskState: 'queued', scope: 'task',
      selectedModel: { provider: 'deepseek', model: 'deepseek-reasoner' },
      sessionId: PEER, linkId: LINK, messageId: 'msg-1', status: 'accepted',
    })])
    expect(folded?.created).toEqual([{ seq: 3, callId: CALL, sessionId: PEER, linkId: LINK }])
    expect(folded?.tasks).toHaveLength(1)
    expect(folded?.tasks[0]).toMatchObject({
      tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:owner:call-1', outcome: 'admitted',
      taskState: 'queued', scope: 'task', messageId: 'msg-1', status: 'accepted',
      sessionId: PEER, linkId: LINK,
    })
    expect(folded?.tasks[0]?.requestedModel).toBe('deepseek/deepseek-chat')
    expect(folded?.tasks[0]?.selectedModel).toBe('deepseek/deepseek-reasoner')
  })

  it('parses a needs_decision send with NO Session; the fact stays sessionId-free', () => {
    const folded = fold([start, call(2, SEND_SESSION_MESSAGE_TOOL), taskResult(3, {
      tool: SEND_SESSION_MESSAGE_TOOL, outcome: 'needs_decision', legacyFirst: 'task task:owner:call-1 needs a decision (model_unavailable); no routing admitted',
      taskState: 'waiting_decision', executionState: 'not_started', reason: 'model_unavailable', attempts: 2,
    })])
    expect(folded?.created).toEqual([])
    expect(folded?.tasks).toHaveLength(1)
    expect(folded?.tasks[0]?.sessionId).toBeUndefined()
    expect(folded?.tasks[0]?.outcome).toBe('needs_decision')
    expect(folded?.tasks[0]?.reason).toBe('model_unavailable')
  })

  it('ignores replayed append results with bad or missing sidecars (legacy replay compatibility)', () => {
    // No sidecar at all: behaves exactly like the legacy path.
    expect(fold([start, call(2), result(3)])?.tasks).toEqual([])
    // A first segment which is NOT the legacy sentence yields no card.
    expect(fold([start, call(2), taskResult(3, { outcome: 'admitted', legacyFirst: 'unrelated text' })])?.created).toEqual([])
  })
})

describe('tracked-task cards', () => {
  const t: TranslateNS<typeof NS> = (key, params) =>
    en[key].replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
  function useLinksFor(view: SessionLinkView): SnapshotSelectorHook<LinkSnapshot> {
    return <Value,>(select: (snapshot: LinkSnapshot) => Value): Value => select({ status: 'ready', view })
  }
  function useTasksFor(view: SessionLinkTaskViewResponse): SnapshotSelectorHook<TaskSnapshot> {
    return <Value,>(select: (snapshot: TaskSnapshot) => Value): Value => select({ status: 'ready', view })
  }
  const linkView: SessionLinkView = {
    pollIntervalMs: 30_000,
    links: [{ id: LINK, name: 'Pair', memberIds: [SELF, PEER], autoWakeSessionIds: [], revision: 1 }],
    sessions: [{ id: PEER, title: 'Peer title', running: false, archived: false, ordinary: true, blank: false }],
  }
  const emptyTasks: SessionLinkTaskViewResponse = { pollIntervalMs: 30_000, tasks: [] }
  function props(openSession = vi.fn()): LinkProps {
    return {
      sessionId: SELF, useLinks: useLinksFor(linkView), useTasks: useTasksFor(emptyTasks),
      refresh: vi.fn(), refreshTasks: vi.fn(async () => true), t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), openPanel: vi.fn(), openSession,
    }
  }

  it('renders an admitted task with requested-vs-actual and the temporary label; accepted is delivery only', () => {
    const p = props()
    render(<TurnCard {...p} turn={turn({
      created: [{ seq: 3, callId: CALL, sessionId: PEER, linkId: LINK }],
      tasks: [{
        seq: 3, callId: CALL, tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:owner:call-1', taskRevision: 3,
        outcome: 'admitted', taskState: 'queued', scope: 'task',
        requestedModel: 'deepseek/deepseek-chat', selectedModel: 'deepseek/deepseek-reasoner',
        messageId: 'msg-1', status: 'accepted', sessionId: PEER, linkId: LINK as SessionLinkId,
      }],
    }, 9)} seq={9} />)
    expect(screen.getByText('Task dispatched')).toBeTruthy()
    expect(screen.getByText('Route scope: this turn')).toBeTruthy()
    expect(screen.getByText('Requested route')).toBeTruthy()
    expect(screen.getByText('Selected route')).toBeTruthy()
    expect(screen.getByText(/deepseek\/deepseek-reasoner/)).toBeTruthy()
    // accepted explicitly framed as delivery only.
    expect(screen.getByText(/Admission means the message was delivered only, never that the task ran/)).toBeTruthy()
    // legacy card still renders side by side.
    expect(screen.getByText('Linked with "Peer title"')).toBeTruthy()
  })

  it('labels a session-scope final route as persistent only when the persisted fact is present', () => {
    const p = props()
    render(<TurnCard {...p} turn={turn({
      created: [], tasks: [{
        seq: 3, callId: CALL, tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:owner:call-1', taskRevision: 3,
        outcome: 'admitted', taskState: 'queued', scope: 'session',
        requestedModel: 'deepseek/deepseek-chat', selectedModel: 'deepseek/deepseek-chat',
        messageId: 'msg-1', status: 'accepted', sessionId: PEER, linkId: LINK as SessionLinkId,
      }],
    }, 9)} seq={9} />)
    expect(screen.getByText('Route scope: persistent')).toBeTruthy()
    // A skipped persist never shows the "Persisted" badge on the card lift.
    expect(screen.queryByText('Persisted as the long-term baseline')).toBeNull()
  })

  it('renders a needs_decision WITHOUT Session jump when no Session exists', () => {
    const p = props()
    render(<TurnCard {...p} turn={turn({
      created: [], tasks: [{
        seq: 3, callId: CALL, tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:owner:call-1', taskRevision: 1,
        outcome: 'needs_decision', taskState: 'waiting_decision', executionState: 'not_started',
        reason: 'model_unavailable', attempts: 2, requestedModel: 'deepseek/deepseek-chat',
      }],
    }, 9)} seq={9} />)
    expect(screen.getByText('Waiting for a decision')).toBeTruthy()
    expect(screen.getByText(/No Session was created/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull()
    // inspection hint names the exact task_id workflow.
    expect(screen.getByText(/session_get_task \(task_id above\)/)).toBeTruthy()
  })

  it('renders a needs_decision task WITH Session jump when the bound Session exists', () => {
    const p = props()
    render(<TurnCard {...p} turn={turn({
      created: [], tasks: [{
        seq: 3, callId: CALL, tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:owner:call-1', taskRevision: 1,
        outcome: 'needs_decision', taskState: 'waiting_decision', executionState: 'not_started',
        reason: 'model_unavailable', attempts: 1, requestedModel: 'deepseek/deepseek-chat',
        sessionId: PEER, linkId: LINK as SessionLinkId,
      }],
    }, 9)} seq={9} />)
    // The waiting statement shows; the bound Session may be opened.
    expect(screen.getByText('Waiting for a decision')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(p.openSession).toHaveBeenCalledWith(PEER)
  })

  it('partial: waiting_decision + partial executionState shows execution progress and never claims not_started', () => {
    const p = props()
    render(<TurnCard {...p} turn={turn({
      created: [], tasks: [{
        seq: 3, callId: CALL, tool: SEND_SESSION_MESSAGE_TOOL, taskId: 'task:owner:call-2', taskRevision: 7,
        outcome: 'needs_decision', taskState: 'waiting_decision', executionState: 'partial',
        reason: 'model_unavailable', attempts: 4, requestedModel: 'deepseek/deepseek-chat',
      }],
    }, 9)} seq={9} />)
    expect(screen.getByText(/waiting_decision · partial/)).toBeTruthy()
    expect(screen.queryByText(/not_started/)).toBeNull()
  })

  it('dark and light themes reuse the same token-driven classes (no theme-specific colors)', () => {
    // The stylesheet resolves through --dsw-alias-* only; rendering twice
    // under both prefers-color-scheme states keeps the same semantic classes.
    for (const _mode of ['light', 'dark']) {
      const p = props()
      const rendered = render(<TurnCard {...p} turn={turn({
        created: [], tasks: [{
          seq: 3, callId: CALL, tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:owner:call-1', taskRevision: 3,
          outcome: 'admitted', taskState: 'queued', scope: 'session',
          requestedModel: 'deepseek/deepseek-chat', selectedModel: 'deepseek/deepseek-reasoner',
          messageId: 'msg-1', status: 'accepted', sessionId: PEER, linkId: LINK as SessionLinkId,
        }],
      }, 9)} seq={9} />)
      const card = rendered.container.querySelector('[data-session-link-task-result]')
      expect(card).toBeTruthy()
      expect(card?.className).toContain('slp-task-card')
      rendered.unmount()
    }
  })
})

describe('selectTrackedTasks closing-Turn cutoff', () => {
  it('drops facts settled after the Turn end, keeping the visible set consistent', () => {
    const data: SessionLinkTurnData = {
      created: [],
      tasks: [
        { seq: 3, callId: 'a', tool: SPAWN_LINKED_SESSION_TOOL, taskId: 'task:s:a', taskRevision: 1, outcome: 'admitted', taskState: 'queued', scope: 'task', requestedModel: 'a/b' },
        { seq: 9, callId: 'b', tool: SEND_SESSION_MESSAGE_TOOL, taskId: 'task:s:b', taskRevision: 1, outcome: 'needs_decision', taskState: 'waiting_decision', executionState: 'not_started', reason: 'model_unavailable', requestedModel: 'a/b' },
      ],
    }
    expect(selectTrackedTasks({ turn: turn(data, 5), seq: 9 })).toHaveLength(1)
    expect(selectTrackedTasks({ turn: turn(data, 5), seq: 9 })?.[0]?.callId).toBe('a')
    expect(selectLinkedSpawns({ turn: turn(data, 5), seq: 9 })).toBeNull()
  })
})
