// @vitest-environment jsdom
/** Read-only mail panel and header glance: sections, paging, and error isolation. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SessionLinkId, SessionLinkMessageId,
  type SessionLinkActivityEntry, type SessionLinkActivityView, type SessionLinkSessionView, type SessionLinkView,
} from '../src/types.ts'
import { HeaderAction, LinkTab, MailSection, type LinkProps } from '../src/client/components.tsx'
import { createLinkSource, createMailController, type LinkSnapshot, type LinkSource } from '../src/client/state.ts'
import { en, type NS } from '../src/client/locales.ts'

const SELF = 'session-self' as SessionId
const PEER = 'session-peer' as SessionId
const LINK = SessionLinkId('link-1')

const t: TranslateNS<typeof NS> = (key, params) => {
  const template = en[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
}

function entry(overrides: Partial<SessionLinkActivityEntry> = {}): SessionLinkActivityEntry {
  return {
    messageId: SessionLinkMessageId('msg-1'), linkId: LINK, direction: 'inbound',
    senderId: PEER, targetId: SELF, status: 'pending', createdAt: '2026-10-13T08:00:00.000Z',
    seq: 1, preview: 'first body', canCancel: true, blockingReasons: [], ...overrides,
  }
}

function mail(entries: readonly SessionLinkActivityEntry[], overrides: Partial<SessionLinkActivityView> = {}): SessionLinkActivityView {
  return {
    sampledAt: '2026-10-13T10:00:00.000Z', total: entries.length, entries,
    summary: {
      wake: { used: 2, limit: 6, day: '2026-10-13', resetsAt: '2026-10-14T00:00:00.000Z' },
      pendingInbound: 1, pendingOutbound: 1, firstTaskWakeOwed: false, legacyBlocked: 0,
      targets: [{ id: PEER, live: true, running: false, archived: false }],
    },
    ...overrides,
  }
}

function view(extraSessions: SessionLinkSessionView[] = []): SessionLinkView {
  return {
    pollIntervalMs: 30_000,
    links: [{ id: LINK, name: 'Pair', memberIds: [SELF, PEER], autoWakeSessionIds: [], revision: 1 }],
    sessions: [
      { id: SELF, title: 'Self', running: false, archived: false, ordinary: true, blank: false },
      { id: PEER, title: 'Peer', running: false, archived: false, ordinary: true, blank: false },
      ...extraSessions,
    ],
  }
}

const sources: LinkSource[] = []
function readySnapshot(current: SessionLinkView = view()): { snapshot: LinkSnapshot; source: LinkSource } {
  const source = createLinkSource({ load: async () => current, subscribeReset: () => () => {} })
  sources.push(source)
  return { snapshot: { status: 'ready', view: current }, source }
}

function useStatic(snapshot: LinkSnapshot): SnapshotSelectorHook<LinkSnapshot> {
  return <Value,>(select: (value: LinkSnapshot) => Value): Value => select(snapshot)
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
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
})

describe('mail section', () => {
  it('lists pending entries with direction, preview, status, and blocking reasons', async () => {
    const loadActivity = vi.fn(async () => mail([
      entry({ preview: 'please review the plan', blockingReasons: ['wake-budget', 'cold-target'] }),
      entry({
        messageId: SessionLinkMessageId('msg-2'), direction: 'outbound', senderId: SELF, targetId: PEER,
        status: 'failed', seq: 2, preview: 'outbound body', canCancel: false, lastError: 'target mailbox full',
      }),
    ]))
    render(<MailSection sessionId={SELF} snapshot={readySnapshot().snapshot} loadActivity={loadActivity} t={t} />)
    await settle()
    expect(loadActivity).toHaveBeenCalledWith({ section: 'pending' })
    expect(screen.getByText('please review the plan')).toBeTruthy()
    expect(screen.getByText('From Peer')).toBeTruthy()
    expect(screen.getByText('To Peer')).toBeTruthy()
    expect(screen.getByText('Pending', { selector: '.gcdl-mail-status' })).toBeTruthy()
    expect(screen.getByText('Failed', { selector: '.gcdl-mail-status' })).toBeTruthy()
    expect(screen.getByText('Blocked: wake budget exhausted · target not resident')).toBeTruthy()
    expect(screen.getByText(/Last error: target mailbox full/)).toBeTruthy()
    expect(screen.getByText('Inbound 1 · Outbound 1 · Wake 2/6 today, resets 00:00 UTC')).toBeTruthy()
    expect(screen.getByText(/^Updated /)).toBeTruthy()
    expect(screen.queryByText(/read|executed|completed/i)).toBeNull()
  })

  it('switches sections, reloads from the first page, and renders recent order', async () => {
    const loadActivity = vi.fn(async (query: { section: string }) => query.section === 'pending'
      ? mail([entry()])
      : mail([entry({ status: 'delivered', preview: 'settled body', blockingReasons: [], canCancel: false })]))
    render(<MailSection sessionId={SELF} snapshot={readySnapshot().snapshot} loadActivity={loadActivity} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('tab', { name: 'Recent' }))
    await settle()
    expect(loadActivity).toHaveBeenLastCalledWith({ section: 'recent' })
    expect(screen.getByText('settled body')).toBeTruthy()
    expect(screen.queryByText('first body')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Recent' }).getAttribute('aria-selected')).toBe('true')
  })

  it('pages with the opaque cursor, appends entries, and stops on the last page', async () => {
    const loadActivity = vi.fn(async (query: { section: string; cursor?: string }) => query.cursor === undefined
      ? mail([entry()], { nextCursor: 'cursor-2' })
      : mail([entry({ messageId: SessionLinkMessageId('msg-2'), seq: 2, preview: 'second body' })]))
    render(<MailSection sessionId={SELF} snapshot={readySnapshot().snapshot} loadActivity={loadActivity} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await settle()
    expect(loadActivity).toHaveBeenLastCalledWith({ section: 'pending', cursor: 'cursor-2' })
    expect(screen.getByText('first body')).toBeTruthy()
    expect(screen.getByText('second body')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('isolates a mail failure, retries, and never claims delivery from a pending row', async () => {
    let calls = 0
    const loadActivity = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('rpc down')
      return mail([entry({ blockingReasons: ['wake-unauthorized'] })])
    })
    render(<MailSection sessionId={SELF} snapshot={readySnapshot().snapshot} loadActivity={loadActivity} t={t} />)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Mail unavailable: rpc down')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByText('first body')).toBeTruthy()
    expect(screen.getByText('Blocked: wake not authorized')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps legacy report records out of the list while counting them', async () => {
    const loadActivity = vi.fn(async () => mail([], {
      summary: {
        wake: { used: 0, limit: 6, day: '2026-10-13', resetsAt: '2026-10-14T00:00:00.000Z' },
        pendingInbound: 0, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 2, targets: [],
      },
    }))
    render(<MailSection sessionId={SELF} snapshot={readySnapshot().snapshot} loadActivity={loadActivity} t={t} />)
    await settle()
    expect(screen.getByText('No messages')).toBeTruthy()
    expect(screen.getByText('2 legacy experimental marker(s) stay in storage: this version never delivers them; inspect manually')).toBeTruthy()
  })

  it('stays visible beside a failed link view inside the management tab', async () => {
    const source = createLinkSource({ load: async () => { throw new Error('view down') }, subscribeReset: () => () => {} })
    sources.push(source)
    const useLinks: SnapshotSelectorHook<LinkSnapshot> = <Value,>(select: (snapshot: LinkSnapshot) => Value): Value =>
      select(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
    const props: LinkProps = {
      sessionId: SELF, useLinks, refresh: source.refresh, t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), cancelMessage: vi.fn(), openPanel: vi.fn(), openSession: vi.fn(),
      loadActivity: vi.fn(async () => mail([entry()])),
      mail: createMailController({
        load: vi.fn(async () => mail([entry()])),
        pollIntervalMs: () => 3_600_000,
      }),
    }
    render(<LinkTab {...props} />)
    await settle()
    expect(screen.getByText('first body')).toBeTruthy()
  })
})

describe('header mail glance', () => {
  function header(loadActivity: LinkProps['loadActivity']): void {
    const { snapshot } = readySnapshot()
    const props: LinkProps = {
      sessionId: SELF, useLinks: useStatic(snapshot), refresh: vi.fn(), t,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), cancelMessage: vi.fn(), loadActivity,
      mail: createMailController({
        load: (query) => loadActivity(query),
        pollIntervalMs: () => 3_600_000,
      }),
      openPanel: vi.fn(), openSession: vi.fn(),
    }
    render(<HeaderAction {...props} useSession={<Value,>(select: (state: { openState: string }) => Value): Value => select({ openState: 'open' })} />)
  }

  it('shows pending inbound and the day wake budget when the popover opens', async () => {
    const loadActivity = vi.fn(async () => mail([], {
      summary: {
        wake: { used: 5, limit: 6, day: '2026-10-13', resetsAt: '2026-10-14T00:00:00.000Z' },
        pendingInbound: 3, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [],
      },
    }))
    header(loadActivity)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '1 linked session(s)' }))
    await settle()
    expect(loadActivity).toHaveBeenCalledWith({ section: 'pending', limit: 1 })
    expect(screen.getByText('Inbound 3 · Wake 5/6 today')).toBeTruthy()
  })

  it('keeps a glance failure local to the popover', async () => {
    header(vi.fn(async () => { throw new Error('rpc down') }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '1 linked session(s)' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Mail unavailable: rpc down')
    expect(screen.getByRole('button', { name: 'Manage links' })).toBeTruthy()
  })
})
