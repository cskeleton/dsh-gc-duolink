// @vitest-environment jsdom
/** Self-contained panel, header, and mark interactions. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLinkId, type SessionLinkSessionView, type SessionLinkView } from '../src/types.ts'
import { HeaderAction, LinkTab, LinkMark, type LinkProps } from '../src/client/components.tsx'
import { createLinkSource, LinkBusyError, type LinkSource, type LinkSnapshot } from '../src/client/state.ts'
import { en, type NS } from '../src/client/locales.ts'

const SELF = 'session-self' as SessionId
const PEER = 'session-peer' as SessionId
const CANDIDATE = 'session-new' as SessionId
const LINK = SessionLinkId('link-1')

const t: TranslateNS<typeof NS> = (key, params) => {
  const template = en[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
}

function session(id: SessionId, title: string, overrides: Partial<SessionLinkSessionView> = {}): SessionLinkSessionView {
  return { id, title, running: false, archived: false, ordinary: true, blank: false, ...overrides }
}

function selector(source: LinkSource): SnapshotSelectorHook<LinkSnapshot> {
  return <Value,>(select: (snapshot: LinkSnapshot) => Value): Value => {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    return select(snapshot)
  }
}

const sources: LinkSource[] = []
function fixture(extraSessions: SessionLinkSessionView[] = []) {
  let view: SessionLinkView = {
    pollIntervalMs: 30_000,
    links: [{ id: LINK, name: 'Pair', memberIds: [SELF, PEER], autoWakeSessionIds: [PEER], revision: 1 }],
    sessions: [session(SELF, 'Self'), session(PEER, 'Peer'), session(CANDIDATE, 'Candidate'), ...extraSessions],
  }
  const source = createLinkSource({ load: async () => view, subscribeReset: () => () => {} })
  sources.push(source)
  const link = vi.fn(async (peerId: SessionId, autoWake: boolean) => {
    view = { ...view, links: [...view.links, {
      id: SessionLinkId('link-added'), name: 'Added', memberIds: [SELF, peerId], autoWakeSessionIds: autoWake ? [peerId] : [], revision: 1,
    }] }
    await source.refresh()
  })
  const setWake = vi.fn(async (linkId: SessionLinkId, peerId: SessionId, on: boolean) => {
    view = { ...view, links: view.links.map(group => group.id !== linkId ? group : {
      ...group, autoWakeSessionIds: on ? [peerId] : [], revision: group.revision + 1,
    }) }
    await source.refresh()
  })
  const unlink = vi.fn(async (linkId: SessionLinkId) => {
    view = { ...view, links: view.links.filter(group => group.id !== linkId) }
    await source.refresh()
  })
  const props: LinkProps = {
    sessionId: SELF, useLinks: selector(source), refresh: source.refresh,
    link, setWake, unlink, openPanel: vi.fn(), openSession: vi.fn(), t,
  }
  return { props, source, link, setWake, unlink }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  })
})
afterEach(() => {
  cleanup()
  for (const source of sources.splice(0)) source.dispose()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('link management panel', () => {
  it('offers eligible peers, sends the chosen wake value, and publishes the new peer', async () => {
    const f = fixture([
      session('archived' as SessionId, 'Archived', { archived: true }),
      session('child' as SessionId, 'Subagent', { ordinary: false }),
      session('blank' as SessionId, 'Blank', { blank: true }),
    ])
    render(<LinkTab {...f.props} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Link a session' }))
    expect(screen.queryByRole('button', { name: /Archived|Subagent|Blank|Self|Peer/ })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search title or ID' }), { target: { value: 'Candidate' } })
    fireEvent.click(screen.getByRole('button', { name: /Candidate/ }))
    fireEvent.click(screen.getByRole('switch', { name: 'Auto wake' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link', exact: true }))
    await settle()
    expect(f.link).toHaveBeenCalledWith(CANDIDATE, false)
    expect(screen.getByText('Added')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('refreshes wake state and requires confirmation before unlinking', async () => {
    const f = fixture()
    render(<LinkTab {...f.props} />)
    await settle()
    fireEvent.click(screen.getByRole('switch', { name: 'Auto wake · Peer' }))
    await settle()
    expect(f.setWake).toHaveBeenCalledWith(LINK, PEER, false)
    expect(screen.getByRole('switch', { name: 'Auto wake · Peer' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Unlink', exact: true }))
    expect(f.unlink).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }))
    await settle()
    expect(f.unlink).toHaveBeenCalledWith(LINK)
    expect(screen.getByText('No linked sessions yet')).toBeTruthy()
  })

  it('sends one write for repeated clicks while it is pending', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    const setWake = vi.fn(() => pending.promise)
    render(<LinkTab {...f.props} setWake={setWake} />)
    await settle()
    const toggle = screen.getByRole('switch', { name: 'Auto wake · Peer' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(setWake).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(); await pending.promise })
    fireEvent.click(screen.getByRole('switch', { name: 'Auto wake · Peer' }))
    expect(setWake).toHaveBeenCalledTimes(2)
  })

  it('treats a write refused by another surface\'s pending write as no change', async () => {
    const f = fixture()
    const link = vi.fn(async () => { throw new LinkBusyError() })
    render(<LinkTab {...f.props} link={link} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Link a session' }))
    fireEvent.click(screen.getByRole('button', { name: /Candidate/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Link', exact: true }))
    await settle()
    expect(link).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /Candidate/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a refused selection available and shows the failure', async () => {
    const f = fixture()
    const link = vi.fn(async () => { throw new Error('Peer was archived') })
    render(<LinkTab {...f.props} link={link} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Link a session' }))
    fireEvent.click(screen.getByRole('button', { name: /Candidate/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Link', exact: true }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Peer was archived')
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Candidate/ }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('header and idle row mark', () => {
  it('opens the summary by focus and dismisses with Escape or outside click', async () => {
    const f = fixture()
    const useSession = <Value,>(select: (state: { openState: string }) => Value): Value => select({ openState: 'open' })
    render(<HeaderAction {...f.props} useSession={useSession} />)
    await settle()
    const action = screen.getByRole('button', { name: '1 linked session(s)' })
    fireEvent.focus(action)
    expect(screen.getByRole('group', { name: 'Session links' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('group')).toBeNull()
    fireEvent.pointerEnter(action)
    expect(screen.getByRole('group')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('group')).toBeNull()
    fireEvent.click(action)
    expect(f.props.openPanel).toHaveBeenCalledOnce()
  })

  it('shares the authoritative wake value with a row mark', async () => {
    const f = fixture()
    render(<LinkMark sessionId={PEER} useLinks={f.props.useLinks} t={t} />)
    await settle()
    expect(screen.getByTitle('Linked, auto wake on')).toBeTruthy()
    await act(async () => { await f.setWake(LINK, PEER, false) })
    expect(screen.getByTitle('Linked, auto wake off')).toBeTruthy()
  })
})
