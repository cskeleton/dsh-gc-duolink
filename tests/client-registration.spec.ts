/** Formal extension seats and owner-scoped wire mutations, without Host runtime imports. */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLinkId } from '../src/types.ts'

const SELF = 'session-self' as SessionId
const PEER = 'session-peer' as SessionId
const OTHER = 'session-other' as SessionId

function fixture() {
  const entries = new Map<string, { inject: (...args: any[]) => any }>()
  const dispose: Array<() => void> = []
  const wire = vi.fn(async (_route: string, method: string) => ({
    ok: true,
    value: method === 'sessionLinks/view' ? { pollIntervalMs: 30_000, links: [], sessions: [] } : undefined,
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
      register: (entry: { name: string; inject: (...args: any[]) => any }) => { entries.set(entry.name, entry) },
    },
    inject: () => {}, // Optional transcript service not present in this fixture.
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  return { entries, wire, openTab, openSession, cleanup: () => { for (const fn of dispose) fn() } }
}

describe('client slot registration', () => {
  it('never registers a leading mark and contributes formal row action and menu seats', () => {
    const f = fixture()
    try {
      expect([...f.entries.keys()]).toEqual([
        'conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
        'sidebar.workspaces.session.row.action', 'sidebar.workspaces.session.menu.item',
      ])
      const row = f.entries.get('sidebar.workspaces.session.row.action')!.inject()
      row.openPanelFor(PEER)
      expect(f.openTab).toHaveBeenCalledWith('sessionLink', { params: { sessionId: PEER } })
      expect(f.openSession).not.toHaveBeenCalled()
    } finally { f.cleanup() }
  })

  it('binds a row-owner action to the row rather than the mounted Session on the wire', async () => {
    const f = fixture()
    try {
      const tab = f.entries.get('sidebar.right.pane.tab')!.inject(SELF)
      const actions = tab.actionsFor(PEER)
      await actions.link(OTHER, true, false)
      expect(f.wire).toHaveBeenCalledWith('/api', 'sessionLinks/linkFrom', {
        args: { request: { callerId: PEER, peerId: OTHER, autoWake: true, autoWakeCaller: false } },
      }, undefined)
      await actions.setWake(SessionLinkId('link-one'), PEER, true)
      expect(f.wire).toHaveBeenCalledWith('/api', 'sessionLinks/setAutoWakeFrom', {
        args: { request: { callerId: PEER, linkId: 'link-one', peerId: PEER, on: true } },
      }, undefined)
      actions.openPanel()
      expect(f.openTab).toHaveBeenCalledWith('sessionLink', { params: { sessionId: PEER } })
      expect(f.openSession).not.toHaveBeenCalled()
    } finally { f.cleanup() }
  })

  it('drives the read-only task projection through the same Remote bridge with `request`', async () => {
    const wire = vi.fn(async (_route: string, method: string, args?: unknown) => ({
      ok: true,
      value: method === 'sessionLinks/taskView' ? { pollIntervalMs: 30_000, tasks: [] } : undefined as unknown,
      args,
    }))
    const { createTaskSource } = await import('../src/client/state.ts')
    const { isTaskView } = await import('../src/client/rpc.ts')
    const source = createTaskSource({
      load: async signal => {
        const result = await wire('/api', 'sessionLinks/taskView', { args: { request: { sessionId: PEER } } }, signal)
        const value = (result as { ok: true; value: unknown }).value
        if (!isTaskView(value)) throw new Error('protocol')
        return value
      },
      subscribeReset: () => () => {},
    })
    const stop = source.subscribe(() => {})
    expect(await source.refresh()).toBe(true)
    expect(wire).toHaveBeenCalledWith('/api', 'sessionLinks/taskView',
      { args: { request: { sessionId: PEER } } }, expect.anything())
    expect(source.getSnapshot().view?.tasks).toEqual([])
    stop()
    source.dispose()
  })
})
