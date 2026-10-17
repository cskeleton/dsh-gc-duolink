// @vitest-environment jsdom
/** Self-contained panel, header, and mark interactions. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLinkId, type SessionLinkActivityView, type SessionLinkSessionView, type SessionLinkView } from '../src/types.ts'
import {
  HeaderAction, LinkTab, RowLinkAction, RowLinkMenu, ManagedLinkTab, panelOwner,
  type LinkProps,
} from '../src/client/components.tsx'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createLinkSource, createMailController, LinkBusyError, type LinkSource, type LinkSnapshot } from '../src/client/state.ts'
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

/** One empty mailbox page; the panel fixture answers mail reads with it. */
export function emptyActivity(): SessionLinkActivityView {
  return {
    sampledAt: '2026-10-13T00:00:00.000Z', total: 0, entries: [],
    summary: {
      wake: { used: 0, limit: 6, day: '2026-10-13', resetsAt: '2026-10-14T00:00:00.000Z' },
      pendingInbound: 0, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [],
    },
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
  const link = vi.fn(async (peerId: SessionId, autoWake: boolean, autoWakeCaller: boolean) => {
    view = { ...view, links: [...view.links, {
      id: SessionLinkId('link-added'), name: 'Added', memberIds: [SELF, peerId], autoWakeSessionIds: [...(autoWake ? [peerId] : []), ...(autoWakeCaller ? [SELF] : [])], revision: 1,
    }] }
    await source.refresh()
  })
  const setWake = vi.fn(async (linkId: SessionLinkId, peerId: SessionId, on: boolean) => {
    view = { ...view, links: view.links.map(group => group.id !== linkId ? group : {
      ...group, autoWakeSessionIds: on ? [...new Set([...group.autoWakeSessionIds, peerId])] : group.autoWakeSessionIds.filter(id => id !== peerId), revision: group.revision + 1,
    }) }
    await source.refresh()
  })
  const unlink = vi.fn(async (linkId: SessionLinkId) => {
    view = { ...view, links: view.links.filter(group => group.id !== linkId) }
    await source.refresh()
  })
  const props: LinkProps = {
    sessionId: SELF, useLinks: selector(source), refresh: source.refresh,
    link, setWake, unlink, cancelMessage: vi.fn(), loadActivity: vi.fn(async () => emptyActivity()),
    mail: createMailController({
      load: vi.fn(async () => emptyActivity()),
      pollIntervalMs: () => 3_600_000,
    }),
    openPanel: vi.fn(), openSession: vi.fn(), t,
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
    for (const title of ['Archived', 'Subagent', 'Blank', 'Self', 'Peer']) {
      expect(screen.queryByRole('button', { name: title })).toBeNull()
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Search title or ID' }), { target: { value: 'Candidate' } })
    fireEvent.click(screen.getByRole('button', { name: /Candidate/ }))
    fireEvent.click(screen.getByRole('switch', { name: 'My messages → wake peer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link', exact: true }))
    await settle()
    expect(f.link).toHaveBeenCalledWith(CANDIDATE, false, true)
    expect(screen.getByText('Added')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('refreshes wake state and requires confirmation before unlinking', async () => {
    const f = fixture()
    render(<LinkTab {...f.props} />)
    await settle()
    fireEvent.click(screen.getByRole('switch', { name: 'My messages → wake peer · Peer' }))
    await settle()
    expect(f.setWake).toHaveBeenCalledWith(LINK, PEER, false)
    expect(screen.getByRole('switch', { name: 'My messages → wake peer · Peer' }).getAttribute('aria-checked')).toBe('false')
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
    const toggle = screen.getByRole('switch', { name: 'My messages → wake peer · Peer' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(setWake).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(); await pending.promise })
    fireEvent.click(screen.getByRole('switch', { name: 'My messages → wake peer · Peer' }))
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

describe('quick header and right-side row entry', () => {
  const useSession = <Value,>(select: (state: { openState: string }) => Value): Value => select({ openState: 'open' })
  it('opens only on click; dismisses with Escape or outside pointer and restores focus', async () => {
    const f = fixture()
    render(<HeaderAction {...f.props} useSession={useSession} />)
    await settle()
    const action = screen.getByRole('button', { name: '1 linked session(s)' })
    fireEvent.focus(action)
    fireEvent.pointerEnter(action)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(action)
    expect(screen.getByRole('dialog', { name: 'Quick link' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(action)
    fireEvent.click(action)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(action)
    fireEvent.click(screen.getByRole('button', { name: 'Manage links' }))
    expect(f.props.openPanel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('requires explicit confirmation and sends independent default-on wake choices', async () => {
    const f = fixture()
    render(<HeaderAction {...f.props} useSession={useSession} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '1 linked session(s)' }))
    fireEvent.click(screen.getByRole('button', { name: /Candidate/ }))
    expect(f.link).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Peer messages → wake me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link', exact: true }))
    await settle()
    expect(f.link).toHaveBeenCalledWith(CANDIDATE, true, false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: '2 linked session(s)' })).toBeTruthy()
  })

  it('does not equate linked status with wake and manages the clicked row identity', async () => {
    const f = fixture()
    const openPanelFor = vi.fn()
    render(<RowLinkAction sessionId={PEER} useLinks={f.props.useLinks} openPanelFor={openPanelFor} t={t} />)
    await settle()
    expect(screen.getByTitle('1 linked session(s) · Manage links')).toBeTruthy()
    await act(async () => { await f.setWake(LINK, PEER, false) })
    fireEvent.click(screen.getByRole('button', { name: '1 linked session(s) · Manage links' }))
    expect(openPanelFor).toHaveBeenCalledWith(PEER)
    expect(screen.getByRole('button').className).toContain('gcdl-row-linked')
  })

  it('offers an unlinked row and joins the formal menu with dismissal', async () => {
    const f = fixture()
    const openPanelFor = vi.fn()
    const close = vi.fn()
    render(<RowLinkMenu sessionId={CANDIDATE} useLinks={f.props.useLinks} openPanelFor={openPanelFor}
      useMenuOpenState={() => [true, close]} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Session links…' }))
    expect(openPanelFor).toHaveBeenCalledWith(CANDIDATE)
    expect(close).toHaveBeenCalledWith(false)
  })
})

describe('explicit management owner', () => {
  it('binds wake operations to the row owner while the main session stays unchanged', async () => {
    const f = fixture()
    const peerWake = vi.fn(async () => {})
    const useTabInfo = (() => ({ tab: { navigation: { params: { sessionId: PEER } } } })) as UseSidebarRightTabInfo
    const actionsFor = vi.fn(() => ({ ...f.props, setWake: peerWake }))
    render(<ManagedLinkTab {...f.props} useTabInfo={useTabInfo} actionsFor={actionsFor} />)
    await settle()
    expect(screen.getByText('Managing: Peer')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Peer messages → wake me' }))
    await settle()
    expect(peerWake).toHaveBeenCalledWith(LINK, PEER, false)
    expect(actionsFor).toHaveBeenCalledWith(PEER)
    expect(f.setWake).not.toHaveBeenCalled()
    expect(f.props.openSession).not.toHaveBeenCalled()
  })

  it('falls back for old parameterless tabs and rejects malformed owner params', () => {
    for (const params of [undefined, null, {}, { sessionId: 7 }, { sessionId: '' }]) {
      expect(panelOwner(SELF, params)).toBe(SELF)
    }
    expect(panelOwner(SELF, { sessionId: PEER })).toBe(PEER)
  })

  it('warns on disabled return wake and changes self without removing peer authorization', async () => {
    const f = fixture()
    render(<LinkTab {...f.props} />)
    await settle()
    expect(screen.getByText(/Return wake is off/)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Peer messages → wake me' }))
    await settle()
    expect(f.setWake).toHaveBeenCalledWith(LINK, SELF, true)
    expect(screen.queryByText(/Return wake is off/)).toBeNull()
    expect(screen.getByRole('switch', { name: 'My messages → wake peer · Peer' }).getAttribute('aria-checked')).toBe('true')
  })
})
