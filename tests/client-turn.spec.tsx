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
import { SessionLinkId, type SessionLinkView } from '../src/types.ts'
import { TurnCard } from '../src/client/TurnCard.tsx'
import {
  sessionLinkTurnDefinition, selectLinkedSpawns, SPAWN_LINKED_SESSION_TOOL, type SessionLinkTurnData,
} from '../src/client/turn.ts'
import { createLinkSource, type LinkSnapshot } from '../src/client/state.ts'
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
    expect(fold([start, call(2)])).toEqual({ created: [] })
    expect(fold([start, result(3)])).toEqual({ created: [] })
    expect(fold([start, call(2), result(3)])).toEqual({
      created: [{ seq: 3, callId: CALL, sessionId: PEER, linkId: LINK }],
    })
    const replacement = result(3)
    if (replacement.type !== 'tool/result') throw new Error('tool/result fixture required')
    expect(fold([start, call(2), {
      ...replacement, surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
    }])).toEqual({ created: [] })
    const missingMarker = { ...replacement, surfaceOp: undefined } as SessionEvent
    expect(fold([start, call(2), missingMarker])).toEqual({ created: [] })
  })

  it('omits failed, unpaired, differently named, or unparsable tool results', () => {
    const start = event(1, 'turn/start', { turn: 1 })
    expect(fold([start, call(2), result(3, RESULT_TEXT, true)])).toEqual({ created: [] })
    expect(fold([start, call(2, 'session_spawn'), result(3)])).toEqual({ created: [] })
    expect(fold([start, call(2), result(3, RESULT_TEXT, false, 'another-call')])).toEqual({ created: [] })
    expect(fold([start, call(2), result(3, 'session created; task message msg-1 queued')])).toEqual({ created: [] })
    expect(fold([start, call(2), result(3, RESULT_TEXT.replace('queued', 'failed'))])).toEqual({ created: [] })
  })

  it('creates no card from human link commands or another Turn with no spawn', () => {
    const first = fold([event(1, 'turn/start', { turn: 1 }), call(2), result(3)])
    expect(first?.created).toHaveLength(1)
    const human = event(2, 'user/message', {
      id: 'human-link', role: 'user', content: [{ type: 'text', text: '/session-link add peer' }],
      source: { kind: 'user', rpcId: 'human' },
    })
    expect(fold([event(1, 'turn/start', { turn: 2 }), human, event(4, 'turn/end', { turn: 2 })]))
      .toEqual({ created: [] })
  })
})

describe('closing Turn cutoff', () => {
  const data: SessionLinkTurnData = { created: [
    { seq: 3, callId: 'call-a', sessionId: PEER, linkId: LINK },
    { seq: 7, callId: 'call-b', sessionId: PEER, linkId: LINK },
  ] }

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
      sessionId: SELF, useLinks, refresh: source.refresh, t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), openPanel: vi.fn(), openSession: vi.fn(),
    }
    const location = turn({ created: [{ seq: 3, callId: CALL, sessionId: PEER, linkId: LINK }] }, 9)
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
      sessionId: SELF, useLinks, refresh: vi.fn(), t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), openPanel: vi.fn(), openSession: vi.fn(),
    }
    const rendered = render(<TurnCard {...props} turn={turn({ created: [] }, 9)} seq={9} />)
    expect(rendered.container.firstChild).toBeNull()
  })
})
