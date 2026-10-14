/** Shared query lifetime, polling, and obsolete response behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLinkSource, createMailController, createWriteGate, LinkBusyError } from '../src/client/state.ts'
import { isLinkView } from '../src/client/rpc.ts'
import type { SessionLinkActivityQuery, SessionLinkActivityView, SessionLinkView } from '../src/types.ts'

const view = (pollIntervalMs = 30_000): SessionLinkView => ({ pollIntervalMs, links: [], sessions: [] })

afterEach(() => { vi.useRealTimers() })

describe('client query lifecycle', () => {
  it('shares a query and configured polling across subscribers, then releases both', async () => {
    vi.useFakeTimers()
    let reset: (() => void) | undefined
    const unsubscribeReset = vi.fn()
    const load = vi.fn(async () => view(4_000))
    const source = createLinkSource({
      load,
      subscribeReset: listener => { reset = listener; return unsubscribeReset },
    })
    const first = source.subscribe(vi.fn())
    const second = source.subscribe(vi.fn())
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(load).toHaveBeenCalledTimes(2)
    reset?.()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(3)
    first()
    expect(unsubscribeReset).not.toHaveBeenCalled()
    second()
    expect(unsubscribeReset).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(load).toHaveBeenCalledTimes(3)
    source.dispose()
  })

  it('does not let a pre-acknowledgement read replace the later refresh', async () => {
    const old = Promise.withResolvers<SessionLinkView>()
    const fresh = Promise.withResolvers<SessionLinkView>()
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
    const source = createLinkSource({ load, subscribeReset: () => () => {} })
    const unsubscribe = source.subscribe(vi.fn())
    const refresh = source.refresh()
    const accepted = view(5_000)
    fresh.resolve(accepted)
    expect(await refresh).toBe(true)
    old.resolve(view(60_000))
    await Promise.resolve()
    expect(source.getSnapshot().view).toBe(accepted)
    expect(load.mock.calls[0][0].aborted).toBe(true)
    unsubscribe()
    source.dispose()
  })

  it('aborts and rejects late publication after unsubscribe or plugin disposal', async () => {
    const pending = Promise.withResolvers<SessionLinkView>()
    let signal: AbortSignal | undefined
    const listener = vi.fn()
    const source = createLinkSource({
      load: current => { signal = current; return pending.promise },
      subscribeReset: () => () => {},
    })
    const unsubscribe = source.subscribe(listener)
    const before = source.getSnapshot()
    const calls = listener.mock.calls.length
    unsubscribe()
    source.dispose()
    pending.resolve(view())
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(source.getSnapshot()).toBe(before)
    expect(listener).toHaveBeenCalledTimes(calls)
    expect(await source.refresh()).toBe(false)
  })

  it('waits for a newer reset read instead of reporting an acknowledged refresh as failed', async () => {
    const acknowledged = Promise.withResolvers<SessionLinkView>()
    const resetRead = Promise.withResolvers<SessionLinkView>()
    const load = vi.fn().mockImplementationOnce(() => acknowledged.promise).mockImplementationOnce(() => resetRead.promise)
    const source = createLinkSource({ load, subscribeReset: () => () => {} })
    const first = source.refresh()
    const newer = source.refresh()
    acknowledged.reject(new DOMException('Aborted', 'AbortError'))
    resetRead.resolve(view(5_000))
    expect(await first).toBe(true)
    expect(await newer).toBe(true)
    expect(source.getSnapshot().status).toBe('ready')
    source.dispose()
  })

  it('retains the last read on transport failure and permits an explicit retry', async () => {
    const good = view()
    const load = vi.fn().mockResolvedValueOnce(good).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(good)
    const source = createLinkSource({ load, subscribeReset: () => () => {} })
    expect(await source.refresh()).toBe(true)
    expect(await source.refresh()).toBe(false)
    expect(source.getSnapshot()).toEqual({ view: good, status: 'error', error: 'offline' })
    expect(await source.refresh()).toBe(true)
    expect(source.getSnapshot()).toEqual({ view: good, status: 'ready' })
    source.dispose()
  })
})

describe('mailbox controller', () => {
  const page = (overrides: Partial<SessionLinkActivityView> = {}): SessionLinkActivityView => ({
    sampledAt: '2026-10-13T00:00:00.000Z', total: 0, entries: [],
    summary: {
      wake: { used: 0, limit: 6, day: '2026-10-13', resetsAt: '2026-10-14T00:00:00.000Z' },
      pendingInbound: 0, pendingOutbound: 0, firstTaskWakeOwed: false, legacyBlocked: 0, targets: [],
    },
    ...overrides,
  })
  const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

  it('reads only on demand, polls while subscribed, and suspends when empty', async () => {
    vi.useFakeTimers()
    let reset: (() => void) | undefined
    const unsubscribeReset = vi.fn()
    const load = vi.fn(async (_query: SessionLinkActivityQuery, _signal: AbortSignal) => page())
    const mail = createMailController({
      load, pollIntervalMs: () => 5_000,
      subscribeReset: listener => { reset = listener; return unsubscribeReset },
    })
    const unsubscribe = mail.subscribe(vi.fn())
    expect(load).not.toHaveBeenCalled()
    await mail.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0][0]).toEqual({ section: 'pending' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(2)
    reset?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(3)
    unsubscribe()
    expect(unsubscribeReset).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    mail.dispose()
  })

  it('discards a late response after unsubscribe and aborts its signal', async () => {
    const pending = Promise.withResolvers<SessionLinkActivityView>()
    let signal: AbortSignal | undefined
    const load = vi.fn((_query: SessionLinkActivityQuery, current: AbortSignal) => { signal = current; return pending.promise })
    const mail = createMailController({ load, pollIntervalMs: () => 30_000 })
    const listener = vi.fn()
    const unsubscribe = mail.subscribe(listener)
    const refresh = mail.refresh()
    const calls = listener.mock.calls.length
    unsubscribe()
    expect(signal?.aborted).toBe(true)
    pending.resolve(page({ total: 9 }))
    await refresh
    expect(mail.getSnapshot().pages.length).toBe(0)
    expect(listener).toHaveBeenCalledTimes(calls)
    mail.dispose()
  })

  it('keeps the retained pages on refresh failure and recovers on retry', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page({ total: 1 }))
      .mockRejectedValueOnce(new Error('refresh unavailable'))
      .mockResolvedValueOnce(page({ total: 2 }))
    const mail = createMailController({ load, pollIntervalMs: () => 30_000 })
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    expect(mail.getSnapshot().pages[0]?.total).toBe(1)
    await mail.refresh()
    expect(mail.getSnapshot().pages[0]?.total).toBe(1)
    expect(mail.getSnapshot().refreshError).toBe('refresh unavailable')
    await mail.refresh()
    expect(mail.getSnapshot().pages[0]?.total).toBe(2)
    expect(mail.getSnapshot().refreshError).toBeUndefined()
    unsubscribe()
    mail.dispose()
  })

  it('keeps a failed next page retryable and re-walks after an invalid cursor', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page({ total: 1, nextCursor: 'cursor-2' }))
      .mockRejectedValueOnce(new Error('next page unavailable'))
      .mockResolvedValueOnce(page({ total: 1, nextCursor: 'cursor-3' }))
      .mockRejectedValueOnce(new Error('ACTIVITY_CURSOR_INVALID: stale cursor: the pending queue changed since this page chain started; reload from the first page'))
      .mockResolvedValueOnce(page({ total: 7, nextCursor: 'fresh-2' }))
      .mockResolvedValueOnce(page({ total: 8 }))
    const mail = createMailController({ load, pollIntervalMs: () => 30_000 })
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    await mail.loadMore()
    expect(mail.getSnapshot().pages.length).toBe(1)
    expect(mail.getSnapshot().pageError).toBe('next page unavailable')
    expect(load.mock.calls[1][0]).toEqual({ section: 'pending', cursor: 'cursor-2' })
    await mail.loadMore()
    expect(mail.getSnapshot().pages.length).toBe(2)
    expect(mail.getSnapshot().pageError).toBeUndefined()
    await mail.loadMore()
    // The stale queue invalidates the chain: re-walk both shown pages from
    // fresh cursors instead of leaving the viewer stuck on a dead cursor.
    expect(mail.getSnapshot().pages.length).toBe(2)
    expect(mail.getSnapshot().pages[0]?.total).toBe(7)
    expect(mail.getSnapshot().pages[1]?.total).toBe(8)
    expect(mail.getSnapshot().pageError).toBeUndefined()
    expect(load.mock.calls[4][0]).toEqual({ section: 'pending' })
    expect(load.mock.calls[5][0]).toEqual({ section: 'pending', cursor: 'fresh-2' })
    unsubscribe()
    mail.dispose()
  })

  it('re-arms polling when a view resubscribes after a full unmount', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => page({ total: 1 }))
    const mail = createMailController({ load, pollIntervalMs: () => 5_000 })
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(2)
    // A foreground switch unmounts every view: the timer stops with them.
    unsubscribe()
    // Remounting must re-arm polling from the retained pages, or the shared
    // mailbox goes silently stale while views keep showing old rows.
    const resubscribe = mail.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(3)
    resubscribe()
    mail.dispose()
  })

  it('isolates sections, re-reads from the first page, and peeks counters only', async () => {
    const load = vi.fn(async (query: SessionLinkActivityQuery) =>
      query.section === 'recent' ? page({ total: 5 }) : page({ total: 1 }))
    const mail = createMailController({ load, pollIntervalMs: () => 30_000 })
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    expect(mail.getSnapshot().pages[0]?.total).toBe(1)
    mail.setSection('recent')
    expect(mail.getSnapshot().section).toBe('recent')
    expect(mail.getSnapshot().pages.length).toBe(0)
    await settle()
    expect(mail.getSnapshot().pages[0]?.total).toBe(5)
    await mail.peek()
    expect(load.mock.lastCall?.[0]).toEqual({ section: 'pending', limit: 1 })
    expect(mail.getSnapshot().summary?.pendingInbound).toBe(0)
    expect(mail.getSnapshot().pages.length).toBe(1)
    unsubscribe()
    mail.dispose()
  })

  it('marks write invalidations dirty while unsubscribed and re-reads on activation', async () => {
    const load = vi.fn(async () => page({ total: 1 }))
    const mail = createMailController({ load, pollIntervalMs: () => 30_000 })
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    expect(mail.getSnapshot().pages.length).toBe(1)
    unsubscribe()
    // A write invalidation with no subscribers must not issue a read…
    mail.invalidate()
    expect(load).toHaveBeenCalledTimes(1)
    // …but the next activation re-reads the dirty data.
    const resubscribe = mail.subscribe(vi.fn())
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    resubscribe()
    mail.dispose()
  })

  it('re-reads a dirty pageless summary through peek on activation', async () => {
    const load = vi.fn(async (query: SessionLinkActivityQuery) => page({ total: 1 }))
    const mail = createMailController({ load, pollIntervalMs: () => 30_000 })
    const unsubscribe = mail.subscribe(vi.fn())
    await mail.peek()
    expect(load.mock.lastCall?.[0]).toEqual({ section: 'pending', limit: 1 })
    expect(mail.getSnapshot().pages.length).toBe(0)
    expect(mail.getSnapshot().summary).toBeDefined()
    unsubscribe()
    mail.invalidate()
    expect(load).toHaveBeenCalledTimes(1)
    const resubscribe = mail.subscribe(vi.fn())
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.lastCall?.[0]).toEqual({ section: 'pending', limit: 1 })
    expect(mail.getSnapshot().pages.length).toBe(0)
    resubscribe()
    mail.dispose()
  })
})

describe('plugin-owned JSON view', () => {
  it('accepts complete catalogs and rejects invalid timer values or missing Session fields', () => {
    expect(isLinkView(view())).toBe(true)
    expect(isLinkView(view(0))).toBe(false)
    expect(isLinkView(view(2_147_483_648))).toBe(false)
    expect(isLinkView({ ...view(), sessions: [{ id: 'a', title: 'A' }] })).toBe(false)
    expect(isLinkView({ ...view(), links: [{ id: 'g', memberIds: 'a' }] })).toBe(false)
  })
})

describe('write gate', () => {
  it('refuses a second write while one is pending and admits the next after it settles', async () => {
    const gate = createWriteGate()
    const pending = Promise.withResolvers<string>()
    const first = gate(() => pending.promise)
    const second = vi.fn(async () => 'second')
    await expect(gate(second)).rejects.toBeInstanceOf(LinkBusyError)
    expect(second).not.toHaveBeenCalled()
    pending.resolve('first')
    await expect(first).resolves.toBe('first')
    await expect(gate(second)).resolves.toBe('second')
  })

  it('releases after a failed write', async () => {
    const gate = createWriteGate()
    await expect(gate(async () => { throw new Error('refused') })).rejects.toThrow('refused')
    await expect(gate(async () => 'next')).resolves.toBe('next')
  })
})
