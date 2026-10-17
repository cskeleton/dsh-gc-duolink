// @vitest-environment jsdom
/** Explicit extension intent, native-modal lifecycle, and safe retry boundaries. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MailSection, ManagedLinkTab, type LinkProps } from '../src/client/components.tsx'
import { createMailController } from '../src/client/state.ts'
import { isActivityView, isExtendWakeResult, isWakeBudget } from '../src/client/rpc.ts'
import { en, type NS } from '../src/client/locales.ts'
import { SessionLinkId, SessionLinkMessageId, type SessionLinkActivityEntry, type SessionLinkActivityView,
  type SessionLinkExtendWakeResult, type SessionLinkWakeBudget } from '../src/types.ts'

const owner = 'owner' as SessionId
const peer = 'peer' as SessionId
const messageId = SessionLinkMessageId('pending-message')
const t: TranslateNS<typeof NS> = (key, params) => en[key].replace(/\{(\w+)\}/g,
  (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
const snapshot = { status: 'ready' as const, view: { links: [], sessions: [], pollIntervalMs: 30_000 } }
const budget = (extra = 0): SessionLinkWakeBudget => ({ rootId: SessionLinkMessageId('root'),
  chain: { used: 8, baseLimit: 8, extra, limit: 8 + extra, remaining: extra },
  targetDay: { used: 3, limit: 12, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' },
  message: { used: 0, limit: 1 }, canExtend: true,
})
const page = (patch: Partial<SessionLinkActivityEntry> = {}): SessionLinkActivityView => ({
  sampledAt: '2026-10-14T00:00:00.000Z', total: 1,
  entries: [{ messageId, linkId: SessionLinkId('link'), senderId: owner, targetId: peer, direction: 'outbound',
    status: 'pending', createdAt: '2026-10-14T00:00:00.000Z', preview: 'queued body', canCancel: true,
    blockingReasons: ['wake-budget'], wakeBudget: budget(), ...patch }],
  summary: { wake: { used: 1, limit: 12, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' },
    pendingInbound: 0, pendingOutbound: 1, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [] },
})
const receipt = (requestId: string, patch: Partial<SessionLinkExtendWakeResult> = {}): SessionLinkExtendWakeResult => ({
  messageId, requestId, outcome: 'applied', budget: budget(4), continuation: 'queued', status: 'pending', blockingReasons: [], ...patch,
})
async function settle() { await act(async () => { await Promise.resolve() }) }
const open = () => { const trigger = screen.getByRole('button', { name: 'Increase wake budget' }); trigger.focus(); fireEvent.click(trigger); return trigger }
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Add and continue' }))
beforeAll(() => {
  // jsdom does not implement the native dialog; browser QA checks real modality.
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(cleanup)

describe('human chain wake budget', () => {
  it.each([8, 1, 100])('confirms the selected %i additional wakes', async additional => {
    const extendChainWake = vi.fn(async request => receipt(request.requestId, { budget: budget(additional) }))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} extendChainWake={extendChainWake} t={t} />)
    await settle(); open()
    if (additional === 8) fireEvent.click(screen.getByRole('radio', { name: 'Add 8 wakes' }))
    else {
      fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(additional) } })
    }
    confirm(); await settle()
    expect(extendChainWake).toHaveBeenCalledOnce()
    expect(extendChainWake.mock.calls[0]![0]).toMatchObject({ additional, expectedExtra: 0, messageId })
  })
  it('cleans the top-layer dialog and ignores its late response when the Host hides a mounted tab', async () => {
    let visible = true
    const pending = Promise.withResolvers<SessionLinkExtendWakeResult>()
    const extendChainWake = vi.fn(() => pending.promise)
    const mail = createMailController({ load: async () => page(), pollIntervalMs: () => 30_000 })
    const props: LinkProps = { sessionId: owner, useLinks: select => select(snapshot), refresh: async () => true,
      link: vi.fn(), setWake: vi.fn(), unlink: vi.fn(), cancelMessage: vi.fn(),
      extendChainWake, loadActivity: async () => page(), mail, openPanel: vi.fn(), openSession: vi.fn(), t }
    const useTabInfo = (() => ({ tab: { visible, navigation: { params: { sessionId: owner } } } })) as any
    const ui = () => <ManagedLinkTab {...props} useTabInfo={useTabInfo} actionsFor={() => props} />
    const view = render(ui())
    await settle(); open(); confirm()
    const node = screen.getByRole('dialog') as HTMLDialogElement
    visible = false; view.rerender(ui())
    expect(screen.queryByRole('dialog')).toBeNull(); expect(node.open).toBe(false)
    await act(async () => { pending.resolve(receipt('hidden')); await pending.promise }); await settle()
    visible = true; view.rerender(ui()); await settle()
    expect(screen.queryByText(/Chain budget saved/)).toBeNull()
    view.unmount(); mail.dispose()
  })
  it('shows authoritative combined usage but only offers an exhausted eligible pending chain', async () => {
    const loadActivity = vi.fn(async () => page())
    const extendChainWake = vi.fn()
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={loadActivity} extendChainWake={extendChainWake} t={t} />)
    await settle()
    expect(screen.getByText('Reply-chain wakes 8/8 · both parties combined')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    for (const patch of [{ wakeBudget: undefined }, { wakeBudget: { ...budget(), canExtend: false } },
      { wakeBudget: budget(4) }, { status: 'delivered' as const }]) {
      loadActivity.mockResolvedValue(page(patch))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle()
      expect(screen.queryByRole('button', { name: 'Increase wake budget' })).toBeNull()
    }
    expect(extendChainWake).not.toHaveBeenCalled()
  })

  it('defaults to four, previews eight/custom, rejects invalid values, and cancels without a write', async () => {
    const extendChainWake = vi.fn()
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} extendChainWake={extendChainWake} t={t} />)
    await settle(); const trigger = open()
    expect(screen.getByRole('dialog', { name: 'Increase wake budget for this reply chain' })).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Add 4 wakes' }) as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Add 4 wakes' }))
    expect(screen.getByText('New limit: 12 wakes')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Add 8 wakes' }))
    expect(screen.getByText('New limit: 16 wakes')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    const input = screen.getByRole('spinbutton', { name: 'Add 1–100 wakes (whole number)' })
    for (const value of ['', '0', '-1', '1.5', '101']) {
      fireEvent.change(input, { target: { value } })
      expect((screen.getByRole('button', { name: 'Add and continue' }) as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.change(input, { target: { value: '100' } })
    expect(screen.getByText('New limit: 108 wakes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(extendChainWake).not.toHaveBeenCalled()
  })

  it('confirms one exact payload and freezes duplicate submit, cancel, and Escape until acknowledgement', async () => {
    const pending = Promise.withResolvers<SessionLinkExtendWakeResult>()
    const extendChainWake = vi.fn(() => pending.promise)
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} extendChainWake={extendChainWake} t={t} />)
    await settle(); open(); confirm(); confirm()
    expect(extendChainWake).toHaveBeenCalledOnce()
    const request = extendChainWake.mock.calls[0]![0] as any
    expect(request).toMatchObject({ messageId, additional: 4, expectedExtra: 0 })
    expect(request.requestId).toMatch(/^[a-f\d-]{36}$/)
    expect((screen.getByRole('button', { name: 'Cancel', exact: true }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { pending.resolve(receipt(request.requestId)); await pending.promise }); await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(/Chain budget saved: 8\/12/)).toBeTruthy()
    expect(screen.getByText(/message remains queued/)).toBeTruthy()
  })

  it('retains every request field on an unknown-result retry, but selection changes create a new intent', async () => {
    const extendChainWake = vi.fn().mockRejectedValue(new Error('offline'))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} extendChainWake={extendChainWake} t={t} />)
    await settle(); open(); confirm(); await settle()
    expect(screen.getByRole('alert').textContent).toContain('result is unknown')
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' })); await settle()
    expect(extendChainWake.mock.calls[1]![0]).toEqual(extendChainWake.mock.calls[0]![0])
    fireEvent.click(screen.getByRole('radio', { name: 'Add 8 wakes' })); confirm(); await settle()
    expect(extendChainWake.mock.calls[2]![0]).toMatchObject({ additional: 8, expectedExtra: 0 })
    expect(extendChainWake.mock.calls[2]![0].requestId).not.toBe(extendChainWake.mock.calls[0]![0].requestId)
  })

  it('refreshes a conflict in place and requires a second explicit confirmation against the new extra', async () => {
    const extendChainWake = vi.fn(async request => receipt(request.requestId, { outcome: 'conflict', budget: budget(8), continuation: 'not_attempted' }))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} extendChainWake={extendChainWake} t={t} />)
    await settle(); open(); confirm(); await settle()
    expect(extendChainWake).toHaveBeenCalledOnce()
    const modal = within(screen.getByRole('dialog'))
    expect(modal.getByText('Reply-chain wakes 8/16 · both parties combined')).toBeTruthy()
    expect(modal.getByText('New limit: 20 wakes')).toBeTruthy()
    expect(modal.getByRole('status').textContent).toContain('confirm again')
    confirm(); await settle()
    expect(extendChainWake.mock.calls[1]![0]).toMatchObject({ additional: 4, expectedExtra: 8 })
    expect(extendChainWake.mock.calls[1]![0].requestId).not.toBe(extendChainWake.mock.calls[0]![0].requestId)
  })

  it('shows target daily, message, and authorization blockers and separates a saved receipt from a failed refresh', async () => {
    const facts = { ...budget(), targetDay: { ...budget().targetDay, used: 12 }, message: { used: 1, limit: 1 } }
    const loadActivity = vi.fn().mockResolvedValueOnce(page({ wakeBudget: facts, blockingReasons: ['wake-budget', 'wake-unauthorized', 'archived'] })).mockRejectedValue(new Error('read offline'))
    const extendChainWake = vi.fn(async request => receipt(request.requestId, { budget: { ...facts, chain: budget(4).chain }, blockingReasons: ['wake-budget', 'wake-unauthorized', 'archived'] }))
    render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={loadActivity} extendChainWake={extendChainWake} t={t} />)
    await settle(); open()
    const modal = within(screen.getByRole('dialog'))
    expect(modal.getByText(/Target daily budget: 12\/12/)).toBeTruthy()
    expect(modal.getByText(/target daily budget is exhausted/)).toBeTruthy()
    expect(modal.getByText(/message wake budget is exhausted/)).toBeTruthy()
    expect(modal.getByText(/wake not authorized · target archived/)).toBeTruthy()
    confirm(); await settle()
    expect(screen.getByText(/Chain budget saved: 8\/12/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('read offline')
    expect(screen.getByText('Reply-chain wakes 8/12 · both parties combined')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Increase wake budget' })).toBeNull()
  })

  it('cleans up on owner change and unmount, ignores late writes, and permits Escape before submission', async () => {
    const pending = Promise.withResolvers<SessionLinkExtendWakeResult>()
    const extendChainWake = vi.fn(() => pending.promise)
    const view = render(<MailSection sessionId={owner} snapshot={snapshot} loadActivity={async () => page()} extendChainWake={extendChainWake} t={t} />)
    await settle(); open()
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
    open(); confirm()
    const modal = screen.getByRole('dialog') as HTMLDialogElement
    view.rerender(<MailSection sessionId={peer} snapshot={snapshot} loadActivity={async () => page({ preview: 'other owner' })} extendChainWake={extendChainWake} t={t} />)
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull(); expect(modal.open).toBe(false)
    await act(async () => { pending.resolve(receipt('late')); await pending.promise }); await settle()
    expect(screen.queryByText(/Chain budget saved/)).toBeNull()
    open(); const last = screen.getByRole('dialog') as HTMLDialogElement
    view.unmount(); expect(last.open).toBe(false)
  })
})

describe('strict budget wire parsing', () => {
  it('rejects inconsistent, unbounded, malformed, and unknown response facts', () => {
    expect(isWakeBudget(budget())).toBe(true)
    expect(isActivityView(page())).toBe(true)
    expect(isExtendWakeResult(receipt('request'))).toBe(true)
    for (const bad of [{ ...budget(), rootId: '' }, { ...budget(), chain: { ...budget().chain, extra: 1 } },
      { ...budget(), message: { used: 0.5, limit: 1 } }, { ...budget(), targetDay: { ...budget().targetDay, used: Number.MAX_SAFE_INTEGER + 1 } }]) {
      expect(isWakeBudget(bad)).toBe(false)
      expect(isActivityView(page({ wakeBudget: bad as any }))).toBe(false)
    }
    for (const bad of [receipt(''), receipt('request', { blockingReasons: ['invented' as any] }),
      receipt('request', { outcome: 'conflict', continuation: 'accepted' }), { ...receipt('request'), outcome: ['applied'] },
      receipt('request', { continuation: 'accepted', status: 'pending' }), receipt('request', { continuation: 'accepted', status: 'failed' }),
      receipt('request', { continuation: 'queued', status: 'delivered' }), receipt('request', { continuation: 'not_pending', status: 'pending' })]) {
      expect(isExtendWakeResult(bad)).toBe(false)
    }
  })
})
