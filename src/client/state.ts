/** Shared, disposable Host queries for every Session Link surface. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLinkView } from '../types.ts'

/** A write refused because another Session Link write from this client is still in flight. */
export class LinkBusyError extends Error {
  constructor() {
    super('another Session Link change is still in progress')
    this.name = 'LinkBusyError'
  }
}

/**
 * Admit one write at a time; a write requested while another is pending
 * rejects with {@link LinkBusyError} without running.
 * @returns a gate that runs one write and releases when it settles.
 */
export function createWriteGate(): <T>(write: () => Promise<T>) => Promise<T> {
  let writing = false
  return async (write) => {
    if (writing) throw new LinkBusyError()
    writing = true
    try {
      return await write()
    } finally {
      writing = false
    }
  }
}

/** Last authoritative read and its current transport state. */
export interface LinkSnapshot {
  readonly view: SessionLinkView | undefined
  readonly status: 'loading' | 'ready' | 'error'
  readonly error?: string
}

/** Transport and connection lifecycle supplied by the active plugin. */
export interface LinkSourceDependencies {
  readonly load: (signal: AbortSignal) => Promise<SessionLinkView>
  readonly subscribeReset: (listener: () => void) => () => void
}

/** One query shared by header, panel, marks, and transcript cards. */
export interface LinkSource extends HostObservable<LinkSnapshot> {
  /** Reload after acknowledgement; supersedes requests issued before it. */
  refresh(): Promise<boolean>
  /** Cancel outstanding requests, timers, and connection subscriptions. */
  dispose(): void
}

/**
 * Keep display reads only while subscribed, using the Host's polling interval.
 * Superseded, unsubscribed, and disposed requests cannot publish a late reply.
 * @param deps - Host query and reset subscription.
 * @returns observable read state, explicit refresh, and teardown.
 */
export function createLinkSource(deps: LinkSourceDependencies): LinkSource {
  let snapshot: LinkSnapshot = { view: undefined, status: 'loading' }
  const listeners = new Set<() => void>()
  let epoch = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeReset: (() => void) | undefined
  let request: AbortController | undefined
  let latest: Promise<boolean> | undefined

  const publish = (next: LinkSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const schedule = (): void => {
    stopTimer()
    if (disposed || listeners.size === 0 || snapshot.view === undefined) return
    timer = setTimeout(() => { void refresh() }, snapshot.view.pollIntervalMs)
  }
  const refresh = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    stopTimer()
    request?.abort()
    const controller = new AbortController()
    request = controller
    const current = ++epoch
    publish({ view: snapshot.view, status: 'loading' })
    const read = async (): Promise<boolean> => {
      try {
        const view = await deps.load(controller.signal)
        if (disposed) return false
        if (current !== epoch) return latest ?? false
        publish({ view, status: 'ready' })
        return true
      } catch (error) {
        if (disposed) return false
        if (current !== epoch) return latest ?? false
        publish({
          view: snapshot.view,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      } finally {
        if (current === epoch) {
          request = undefined
          schedule()
        }
      }
    }
    latest = read()
    return latest
  }
  const suspend = (): void => {
    epoch++
    stopTimer()
    request?.abort()
    request = undefined
    latest = undefined
    unsubscribeReset?.()
    unsubscribeReset = undefined
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribeReset = deps.subscribeReset(() => { void refresh() })
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) suspend()
      }
    },
    refresh,
    dispose() {
      disposed = true
      suspend()
      listeners.clear()
    },
  }
}
