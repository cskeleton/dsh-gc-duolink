/** Shared query lifetime, polling, and obsolete response behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLinkSource, createWriteGate, LinkBusyError } from '../src/client/state.ts'
import { isLinkView } from '../src/client/rpc.ts'
import type { SessionLinkView } from '../src/types.ts'

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
