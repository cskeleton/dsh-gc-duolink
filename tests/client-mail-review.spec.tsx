// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MailSection } from '../src/client/components.tsx'
import { en, type NS } from '../src/client/locales.ts'
import { SessionLinkId, SessionLinkMessageId, type SessionLinkActivityView } from '../src/types.ts'

const owner = 'session-owner' as SessionId
const peer = 'session-peer' as SessionId
const t: TranslateNS<typeof NS> = (key, params) => en[key].replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
function page(): SessionLinkActivityView {
  return {
    sampledAt: '2026-10-13T10:00:00.000Z', total: 2, nextCursor: 'next',
    summary: { wake: { used: 0, limit: 6, day: '2026-10-13', resetsAt: '2026-10-14T00:00:00.000Z' }, pendingInbound: 2, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [] },
    entries: [{ messageId: SessionLinkMessageId('mail-one'), linkId: SessionLinkId('link'), senderId: peer, targetId: owner, direction: 'inbound', status: 'pending', createdAt: '2026-10-13T09:00:00.000Z', preview: 'Last known message', canCancel: true, blockingReasons: [] }],
  }
}
async function settle() { await act(async () => { await Promise.resolve() }) }
afterEach(cleanup)

describe('M1 independent mail UI review', () => {
  it('makes a load-more failure visible while retaining the earlier page', async () => {
    const load = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('next page unavailable'))
    render(<MailSection sessionId={owner} snapshot={{ status: 'ready', view: { links: [], sessions: [], pollIntervalMs: 30000 } }} loadActivity={load} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await settle()
    expect(screen.getByText('Last known message')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('next page unavailable')
  })

  it('retains the last known page and marks refresh failure rather than clearing all data', async () => {
    const load = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('refresh unavailable'))
    render(<MailSection sessionId={owner} snapshot={{ status: 'ready', view: { links: [], sessions: [], pollIntervalMs: 30000 } }} loadActivity={load} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('refresh unavailable')
    expect(screen.getByText('Last known message')).toBeTruthy()
  })
})
