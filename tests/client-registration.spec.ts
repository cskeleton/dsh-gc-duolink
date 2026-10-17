/** Formal extension seats and owner-scoped wire mutations, without Host runtime imports. */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLinkId, SessionLinkMessageId, type SessionLinkExtendWakeResult } from '../src/types.ts'
import { LinkBusyError } from '../src/client/state.ts'

const SELF = 'session-self' as SessionId
const PEER = 'session-peer' as SessionId
const OTHER = 'session-other' as SessionId

const extensionResult = (requestId = 'receipt'): SessionLinkExtendWakeResult => ({
  messageId: SessionLinkMessageId('message-one'), requestId, outcome: 'applied',
  budget: { rootId: SessionLinkMessageId('root'), chain: { used: 8, baseLimit: 8, extra: 4, limit: 12, remaining: 4 },
    targetDay: { used: 0, limit: 12, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' },
    message: { used: 0, limit: 1 }, canExtend: true },
  continuation: 'queued', status: 'pending', blockingReasons: [],
})

function fixture() {
  const entries = new Map<string, { inject: (...args: any[]) => any }>()
  const registrations: any[] = []
  const dispose: Array<() => void> = []
  const wire = vi.fn(async (_route: string, method: string, payload?: any) => ({
    ok: true,
    value: method === 'gcDuolink/view' ? { pollIntervalMs: 30_000, links: [], sessions: [] }
      : method === 'gcDuolink/cancelMessageFrom' ? { messageId: payload.args.request.messageId, outcome: 'cancelled', status: 'cancelled' } : undefined,
  }))
  const openTab = vi.fn()
  const openSession = vi.fn()
  const ctx = {
    effect: (fn: () => (() => void)) => { dispose.push(fn()) },
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    connection: { rpc: { call: wire } },
    sidebarRight: { openTab },
    uiWorkspace: { openSession },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_seat: string, fn: () => void) => { fn() },
      register: (entry: { name: string; inject: (...args: any[]) => any }) => { registrations.push(entry); entries.set(entry.name, entry) },
    },
    inject: () => {}, // Optional transcript service not present in this fixture.
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  return { entries, registrations, wire, openTab, openSession, cleanup: () => { for (const fn of dispose) fn() } }
}

describe('client slot registration', () => {
  it('owner-binds extension RPC, uses the shared gate, and validates receipt identity', async () => {
    const f = fixture()
    try {
      const pending = Promise.withResolvers<any>()
      const ordinary = f.wire.getMockImplementation()!
      f.wire.mockImplementation((route, method, payload) => method === 'gcDuolink/extendChainWakeFrom'
        ? pending.promise : ordinary(route, method, payload))
      const tab = f.entries.get('sidebar.right.pane.tab')!.inject(SELF)
      const clicked = tab.actionsFor(PEER)
      const request = { messageId: SessionLinkMessageId('message-one'), additional: 4, expectedExtra: 0, requestId: 'receipt' }
      const writing = clicked.extendChainWake({ ...request, sessionId: OTHER })
      await expect(tab.actionsFor(OTHER).cancelMessage(request.messageId)).rejects.toBeInstanceOf(LinkBusyError)
      await expect(tab.actionsFor(OTHER).setWake(SessionLinkId('link'), OTHER, false)).rejects.toBeInstanceOf(LinkBusyError)
      expect(f.wire).toHaveBeenCalledWith('/api', 'gcDuolink/extendChainWakeFrom', {
        args: { request: { ...request, sessionId: PEER } },
      }, undefined)
      pending.resolve({ ok: true, value: extensionResult() })
      expect(await writing).toEqual(extensionResult())
      for (const value of [extensionResult('wrong-receipt'), { ...extensionResult(), messageId: 'another-message' },
        { ...extensionResult(), blockingReasons: ['invalid'] }]) {
        f.wire.mockResolvedValueOnce({ ok: true, value } as any)
        await expect(clicked.extendChainWake(request)).rejects.toThrow('panel.protocol.error')
      }
    } finally { f.cleanup() }
  })

  it('refreshes every subscribed mailbox after conflict or applied receipt and retains success on read failure', async () => {
    const f = fixture()
    const unsubscriptions: Array<() => void> = []
    try {
      const ordinary = f.wire.getMockImplementation()!
      let offline = false
      let outcome: 'applied' | 'conflict' = 'conflict'
      f.wire.mockImplementation(async (route, method, payload) => {
        if (method === 'gcDuolink/extendChainWakeFrom') return { ok: true,
          value: { ...extensionResult(), outcome, continuation: outcome === 'conflict' ? 'not_attempted' : 'queued' } } as any
        if (method !== 'gcDuolink/activityView') return ordinary(route, method, payload)
        if (offline) return { ok: false, error: { message: 'read offline' } } as any
        return { ok: true, value: { sampledAt: '2026-10-14T00:00:00.000Z', total: 0, entries: [],
          summary: { wake: { used: 0, limit: 12, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' },
            pendingInbound: 0, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [] } } } as any
      })
      const tab = f.entries.get('sidebar.right.pane.tab')!.inject(SELF)
      const self = tab.actionsFor(SELF), peer = tab.actionsFor(PEER)
      for (const action of [self, peer]) { unsubscriptions.push(action.mail.subscribe(vi.fn())); await action.mail.refresh() }
      const request = { messageId: SessionLinkMessageId('message-one'), additional: 4, expectedExtra: 0, requestId: 'receipt' }
      f.wire.mockClear()
      expect((await peer.extendChainWake(request)).outcome).toBe('conflict')
      await vi.waitFor(() => {
        expect(f.wire.mock.calls.filter(([, method]) => method === 'gcDuolink/activityView').map(([, , payload]) => payload.args.request.sessionId).sort()).toEqual([PEER, SELF].sort())
      })
      outcome = 'applied'; offline = true
      expect((await peer.extendChainWake(request)).outcome).toBe('applied')
      await vi.waitFor(() => {
        expect(self.mail.getSnapshot().refreshError).toBe('read offline')
        expect(peer.mail.getSnapshot().refreshError).toBe('read offline')
      })
    } finally { for (const unsubscribe of unsubscriptions) unsubscribe(); f.cleanup() }
  })
  it('never registers a leading mark and contributes formal row action and menu seats', () => {
    const f = fixture()
    try {
      expect([...f.entries.keys()]).toEqual([
        'conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
        'sidebar.workspaces.session.row.action', 'sidebar.workspaces.session.menu.item',
      ])
      const row = f.entries.get('sidebar.workspaces.session.row.action')!.inject()
      row.openPanelFor(PEER)
      expect(f.openTab).toHaveBeenCalledWith('gcDuolink', { params: { sessionId: PEER } })
      expect(f.openSession).not.toHaveBeenCalled()
      const menu = f.registrations.filter(entry => entry.name === 'sidebar.workspaces.session.menu.item')
      expect(menu.map(entry => entry.id)).toEqual(['dsh-gc-duolink/menu', 'dsh-gc-duolink/copy-session-id'])
      expect(menu[1].order).toBe(500)
      expect(menu[1].inject).toBeUndefined()
    } finally { f.cleanup() }
  })

  it('binds a row-owner action to the row rather than the mounted Session on the wire', async () => {
    const f = fixture()
    try {
      const tab = f.entries.get('sidebar.right.pane.tab')!.inject(SELF)
      const actions = tab.actionsFor(PEER)
      await actions.link(OTHER, true, false)
      expect(f.wire).toHaveBeenCalledWith('/api', 'gcDuolink/linkFrom', {
        args: { request: { callerId: PEER, peerId: OTHER, autoWake: true, autoWakeCaller: false } },
      }, undefined)
      await actions.setWake(SessionLinkId('link-one'), PEER, true)
      expect(f.wire).toHaveBeenCalledWith('/api', 'gcDuolink/setAutoWakeFrom', {
        args: { request: { callerId: PEER, linkId: 'link-one', peerId: PEER, on: true } },
      }, undefined)
      const result = await actions.cancelMessage(SessionLinkMessageId('message-one'))
      expect(result).toEqual({ messageId: 'message-one', outcome: 'cancelled', status: 'cancelled' })
      expect(f.wire).toHaveBeenCalledWith('/api', 'gcDuolink/cancelMessageFrom', {
        args: { request: { sessionId: PEER, messageId: 'message-one' } },
      }, undefined)
      actions.openPanel()
      expect(f.openTab).toHaveBeenCalledWith('gcDuolink', { params: { sessionId: PEER } })
      expect(f.openSession).not.toHaveBeenCalled()
    } finally { f.cleanup() }
  })

  it('uses the shared write gate and freezes the clicked owner while cancellation is pending', async () => {
    const f = fixture()
    try {
      const pending = Promise.withResolvers<any>()
      const ordinary = f.wire.getMockImplementation()!
      f.wire.mockImplementation((route, method, payload) => method === 'gcDuolink/cancelMessageFrom'
        ? pending.promise : ordinary(route, method, payload))
      const tab = f.entries.get('sidebar.right.pane.tab')!.inject(SELF)
      const clicked = tab.actionsFor(PEER)
      const cancellation = clicked.cancelMessage(SessionLinkMessageId('message-one'))
      const nextOwner = tab.actionsFor(OTHER)
      await expect(nextOwner.link(SELF, false, false)).rejects.toBeInstanceOf(LinkBusyError)
      await expect(clicked.cancelMessage(SessionLinkMessageId('message-one'))).rejects.toBeInstanceOf(LinkBusyError)
      expect(f.wire.mock.calls.filter(([, method]) => method === 'gcDuolink/cancelMessageFrom')).toHaveLength(1)
      expect(f.wire).toHaveBeenCalledWith('/api', 'gcDuolink/cancelMessageFrom', {
        args: { request: { sessionId: PEER, messageId: 'message-one' } },
      }, undefined)
      pending.resolve({ ok: true, value: { messageId: 'message-one', outcome: 'too_late', status: 'pending' } })
      expect(await cancellation).toEqual({ messageId: 'message-one', outcome: 'too_late', status: 'pending' })
      f.wire.mockImplementation(ordinary)
      await nextOwner.cancelMessage(SessionLinkMessageId('next-message'))
      expect(f.wire).toHaveBeenLastCalledWith('/api', 'gcDuolink/cancelMessageFrom', {
        args: { request: { sessionId: OTHER, messageId: 'next-message' } },
      }, undefined)
    } finally { f.cleanup() }
  })

  it('rejects mismatched and inconsistent cancellation replies', async () => {
    const f = fixture()
    try {
      const actions = f.entries.get('sidebar.right.pane.tab')!.inject(SELF).actionsFor(PEER)
      for (const value of [
        undefined,
        { messageId: 'unrelated', outcome: 'cancelled', status: 'cancelled' },
        { messageId: 'message-one', outcome: 'cancelled', status: 'pending' },
        { messageId: 'message-one', outcome: 'already_terminal', status: 'pending' },
        { messageId: 'message-one', outcome: 'already_terminal', status: ['delivered'] },
        { messageId: 'message-one', outcome: 'already_terminal', status: {} },
      ]) {
        f.wire.mockResolvedValueOnce({ ok: true, value } as any)
        await expect(actions.cancelMessage(SessionLinkMessageId('message-one'))).rejects.toThrow('panel.protocol.error')
      }
    } finally { f.cleanup() }
  })

  it('returns the accepted cancellation outcome when the shared mailbox refresh fails', async () => {
    const f = fixture()
    let unsubscribe: (() => void) | undefined
    try {
      let offline = false
      const ordinary = f.wire.getMockImplementation()!
      f.wire.mockImplementation(async (route, method, payload) => {
        if (method !== 'gcDuolink/activityView') return ordinary(route, method, payload)
        if (offline) return { ok: false, error: { message: 'read offline' } } as any
        return { ok: true, value: {
          sampledAt: '2026-10-14T00:00:00.000Z', total: 0, entries: [],
          summary: { wake: { used: 0, limit: 6, day: '2026-10-14', resetsAt: '2026-10-15T00:00:00.000Z' },
            pendingInbound: 0, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [] },
        } } as any
      })
      const actions = f.entries.get('sidebar.right.pane.tab')!.inject(SELF).actionsFor(PEER)
      unsubscribe = actions.mail.subscribe(vi.fn())
      await actions.mail.refresh()
      offline = true
      const accepted = await actions.cancelMessage(SessionLinkMessageId('message-one'))
      expect(accepted).toEqual({ messageId: 'message-one', outcome: 'cancelled', status: 'cancelled' })
      await vi.waitFor(() => { expect(actions.mail.getSnapshot().refreshError).toBe('read offline') })
      expect(actions.mail.getSnapshot().status).toBe('ready')
    } finally { unsubscribe?.(); f.cleanup() }
  })
})
