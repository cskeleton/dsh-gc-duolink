// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MailSection } from '../src/client/components.tsx'
import { createMailController, type MailController, type MailControllerDependencies } from '../src/client/state.ts'
import { en, type NS } from '../src/client/locales.ts'
import type { SessionLinkActivityView } from '../src/types.ts'

const owner = 'session-rereview' as SessionId
const t: TranslateNS<typeof NS> = (key, params) => en[key].replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
const controllers: MailController[] = []
const page = (patch: Partial<SessionLinkActivityView> = {}): SessionLinkActivityView => ({
  sampledAt: '2026-10-14T00:00:00.000Z', total: 0, entries: [],
  summary: { wake: { used: 0, limit: 6, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' }, pendingInbound: 0, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [] },
  ...patch,
})
function controller(load: MailControllerDependencies['load']) {
  const result = createMailController({ load, pollIntervalMs: () => 1000 })
  controllers.push(result)
  return result
}
function section(mail: MailController) {
  return <MailSection sessionId={owner} snapshot={{ status: 'ready', view: { links: [], sessions: [], pollIntervalMs: 1000 } }} loadActivity={async () => page()} mail={mail} t={t} />
}
async function settle() { await act(async () => { await Promise.resolve() }) }
afterEach(() => { cleanup(); for (const mail of controllers.splice(0)) mail.dispose(); vi.useRealTimers() })

describe('M1 second-review mailbox lifecycle', () => {
  it('restarts an interrupted first load when the panel remounts', async () => {
    const pending = Promise.withResolvers<SessionLinkActivityView>()
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(page())
    const mail = controller(load)
    const first = render(section(mail))
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    first.unmount()
    pending.resolve(page())
    await settle()
    render(section(mail))
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    expect(mail.getSnapshot().status).toBe('ready')
  })

  it('clears the load-more flag when a refresh supersedes pagination', async () => {
    const pending = Promise.withResolvers<SessionLinkActivityView>()
    const load = vi.fn().mockResolvedValueOnce(page({ nextCursor: 'next' })).mockReturnValueOnce(pending.promise).mockResolvedValue(page({ nextCursor: 'next' }))
    const mail = controller(load)
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    const more = mail.loadMore()
    expect(mail.getSnapshot().loadingMore).toBe(true)
    // Connection reset and write invalidation legitimately supersede a page read.
    await mail.refresh()
    pending.resolve(page())
    await more
    expect(mail.getSnapshot().loadingMore).toBe(false)
    const calls = load.mock.calls.length
    await mail.loadMore()
    expect(load).toHaveBeenCalledTimes(calls + 1)
    unsubscribe()
  })

  it('keeps counters fresh for a subscribed peek-only header', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => page())
    const mail = controller(load)
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.peek()
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(load.mock.calls.length).toBeGreaterThan(1)
    unsubscribe()
  })

  it('does not issue reads for an inactive cached owner on write invalidation', async () => {
    const load = vi.fn(async () => page())
    const mail = controller(load)
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    unsubscribe()
    expect(load).toHaveBeenCalledTimes(1)
    mail.invalidate()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the selected tab consistent with retained section data after remount', async () => {
    const mail = controller(vi.fn(async () => page()))
    const first = render(section(mail))
    await settle()
    fireEvent.click(screen.getByRole('tab', { name: 'Recent' }))
    await settle()
    expect(mail.getSnapshot().section).toBe('recent')
    first.unmount()
    render(section(mail))
    await settle()
    const selected = screen.getByRole('tab', { selected: true })
    expect(selected.textContent?.toLowerCase()).toBe(mail.getSnapshot().section)
  })
})
