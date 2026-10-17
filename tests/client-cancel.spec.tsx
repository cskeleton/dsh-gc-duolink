// @vitest-environment jsdom
/** Human cancellation feedback at stale delivery and owner boundaries. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MailSection } from '../src/client/components.tsx'
import { LinkBusyError } from '../src/client/state.ts'
import { en, type NS } from '../src/client/locales.ts'
import {
  SessionLinkId, SessionLinkMessageId,
  type SessionLinkActivityEntry, type SessionLinkActivityView, type SessionLinkCancelResult,
} from '../src/types.ts'

const owner = 'session-owner' as SessionId
const peer = 'session-peer' as SessionId
const messageId = SessionLinkMessageId('message-one')
const t: TranslateNS<typeof NS> = (key, params) => en[key].replace(/\{(\w+)\}/g,
  (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
const snapshot = { status: 'ready' as const, view: { links: [], pollIntervalMs: 30_000, sessions: [
  { id: owner, title: 'Owner', running: false, archived: false, ordinary: true, blank: false },
  { id: peer, title: 'Peer', running: true, archived: false, ordinary: true, blank: false },
] } }
const page = (patch: Partial<SessionLinkActivityEntry> = {}): SessionLinkActivityView => ({
  sampledAt: '2026-10-14T00:00:00.000Z', total: 1,
  entries: [{ messageId, linkId: SessionLinkId('link'), senderId: owner, targetId: peer,
    direction: 'outbound', status: 'pending', createdAt: '2026-10-14T00:00:00.000Z',
    preview: 'queued body', canCancel: true, blockingReasons: [], ...patch }],
  summary: { wake: { used: 0, limit: 6, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' },
    pendingInbound: 0, pendingOutbound: 1, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [] },
})
const reply = (outcome: SessionLinkCancelResult['outcome'], status: SessionLinkCancelResult['status']): SessionLinkCancelResult => ({ messageId, outcome, status })
async function settle() { await act(async () => { await Promise.resolve() }) }
afterEach(cleanup)

describe('human mailbox cancellation', () => {
  it('honors canCancel and omits cancellation for terminal rows', async () => {
    const cancelMessage = vi.fn()
    const loadActivity = vi.fn(async () => page({ canCancel: false }))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={loadActivity} cancelMessage={cancelMessage} t={t} />)
    await settle()
    const button = screen.getByRole('button', { name: 'Cancel queued message' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(cancelMessage).not.toHaveBeenCalled()
    loadActivity.mockResolvedValue(page({ status: 'delivered', canCancel: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).toBeNull()
  })

  it('sends one request for duplicate clicks and reports a stale too-late response accurately', async () => {
    const pending = Promise.withResolvers<SessionLinkCancelResult>()
    const cancelMessage = vi.fn(() => pending.promise)
    const openSession = vi.fn()
    const stalePage = page()
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => stalePage}
      cancelMessage={cancelMessage} openSession={openSession} t={t} />)
    await settle()
    const button = screen.getByRole('button', { name: 'Cancel queued message' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(cancelMessage).toHaveBeenCalledExactlyOnceWith(messageId)
    await act(async () => { pending.resolve(reply('too_late', 'pending')); await pending.promise })
    await settle()
    expect(screen.getByText(/Too late to cancel/).textContent).toContain('Status when cancellation was checked: Pending')
    expect((screen.getByRole('button', { name: 'Cancel queued message' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Queued message cancelled. Delivered content is not recalled.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open target session' }))
    expect(openSession).toHaveBeenCalledWith(peer)
  })

  it('displays already-terminal as no change and updates the stale row to the returned state', async () => {
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()}
      cancelMessage={async () => reply('already_terminal', 'delivered')} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(screen.getByText('No change: the message is already Delivered.')).toBeTruthy()
    expect(screen.getByText('Delivered', { selector: '.gcdl-mail-status' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).toBeNull()
  })

  it('allows a fresh delivered row to supersede a too-late pending result', async () => {
    const loadActivity = vi.fn(async () => page())
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={loadActivity}
      cancelMessage={async () => reply('too_late', 'pending')} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    loadActivity.mockResolvedValue(page({ status: 'delivered', canCancel: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByText('Delivered', { selector: '.gcdl-mail-status' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).toBeNull()
    expect(screen.getByText(/Too late to cancel/).textContent).toContain('Status when cancellation was checked: Pending')
  })

  it('allows retry when a fresh snapshot finds a cold speculative marker is cancellable', async () => {
    const stalePage = page()
    const loadActivity = vi.fn(async () => stalePage)
    const cancelMessage = vi.fn().mockResolvedValueOnce(reply('too_late', 'pending')).mockResolvedValue(reply('cancelled', 'cancelled'))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={loadActivity} cancelMessage={cancelMessage} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect((screen.getByRole('button', { name: 'Cancel queued message' }) as HTMLButtonElement).disabled).toBe(true)
    loadActivity.mockResolvedValue(page({ canCancel: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect((screen.getByRole('button', { name: 'Cancel queued message' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(cancelMessage).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Queued message cancelled. Delivered content is not recalled.')).toBeTruthy()
  })

  it('keeps accepted cancellation distinct from a failed mailbox refresh', async () => {
    const loadActivity = vi.fn().mockResolvedValueOnce(page()).mockRejectedValue(new Error('read offline'))
    const cancelMessage = vi.fn(async () => reply('cancelled', 'cancelled'))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={loadActivity} cancelMessage={cancelMessage} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(screen.getByText('Queued message cancelled. Delivered content is not recalled.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('read offline')
    expect(screen.getByText('Cancelled', { selector: '.gcdl-mail-status' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).toBeNull()
    expect(cancelMessage).toHaveBeenCalledOnce()
  })

  it('keeps a rejected request retryable without implying cancellation', async () => {
    const cancelMessage = vi.fn().mockRejectedValueOnce(new Error('MESSAGE_NOT_FOUND')).mockResolvedValue(reply('cancelled', 'cancelled'))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} cancelMessage={cancelMessage} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('MESSAGE_NOT_FOUND')
    expect(screen.queryByText('Queued message cancelled. Delivered content is not recalled.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(cancelMessage).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('treats the shared gate refusal as no operation', async () => {
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()}
      cancelMessage={async () => { throw new LinkBusyError() }} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: 'Cancel queued message' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not publish a late cancellation into a newly managed owner', async () => {
    const pending = Promise.withResolvers<SessionLinkCancelResult>()
    const clickedAction = vi.fn(() => pending.promise)
    const nextAction = vi.fn(async () => reply('cancelled', 'cancelled'))
    const firstLoad = vi.fn(async () => page())
    const nextLoad = vi.fn(async () => page({ preview: 'next owner body', senderId: peer, targetId: owner }))
    const view = render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={firstLoad} cancelMessage={clickedAction} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    view.rerender(<MailSection sessionId={peer} snapshot={snapshot} loadActivity={nextLoad} cancelMessage={nextAction} t={t} />)
    await settle()
    await act(async () => { pending.resolve(reply('cancelled', 'cancelled')); await pending.promise })
    await settle()
    expect(screen.getByText('next owner body')).toBeTruthy()
    expect(screen.queryByText('Queued message cancelled. Delivered content is not recalled.')).toBeNull()
    expect(nextAction).not.toHaveBeenCalled()
    expect(firstLoad).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
    await settle()
    expect(nextAction).toHaveBeenCalledExactlyOnceWith(messageId)
  })
})
