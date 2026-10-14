/** Shared, disposable Host queries for every Session Link surface. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SessionLinkActivityQuery, SessionLinkActivitySection, SessionLinkActivitySummary, SessionLinkActivityView,
  SessionLinkView,
} from '../types.ts'

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

/** One mailbox read state for one owner Session and one section. */
export interface MailState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly section: SessionLinkActivitySection
  /** Accumulated pages; every page keeps its own `sampledAt` sampling time. */
  readonly pages: readonly SessionLinkActivityView[]
  /** Latest session-level counters, from the newest page or a summary peek. */
  readonly summary: SessionLinkActivitySummary | undefined
  /** Sampling time of the latest summary, for staleness hints on peek-only surfaces. */
  readonly summarySampledAt?: string
  readonly refreshing: boolean
  readonly loadingMore: boolean
  /** Fatal first-read failure; nothing displayable exists. */
  readonly error?: string
  /** A refresh failed; the retained pages are stale but stay visible. */
  readonly refreshError?: string
  /** A load-more failed; the retained pages and cursor stay retryable. */
  readonly pageError?: string
  /** A counters-only peek failed; surfaces show it without touching pages. */
  readonly peekError?: string
}

/** Transport, polling cadence, and reset lifecycle for one owner's mailbox. */
export interface MailControllerDependencies {
  readonly load: (query: SessionLinkActivityQuery, signal: AbortSignal) => Promise<SessionLinkActivityView>
  readonly pollIntervalMs: () => number
  readonly subscribeReset?: (listener: () => void) => () => void
}

/**
 * The single per-owner mailbox data source every surface shares. Reads happen
 * only while subscribed; the Host's polling interval, connection resets, and
 * write invalidations all re-read through here. Failed refreshes keep the
 * last pages marked stale, failed page turns keep the cursor retryable, and a
 * superseded or unsubscribed request can never publish a late reply.
 */
export interface MailController extends HostObservable<MailState> {
  /** Switch section; the new section starts isolated from the old one's pages. */
  setSection(section: SessionLinkActivitySection): void
  /** Re-read every currently shown page from fresh cursors; keeps old pages on failure. */
  refresh(): Promise<void>
  /** Turn to the next page of the current section; failures stay retryable in place. */
  loadMore(): Promise<void>
  /** Read counters only (one-row pending page) without disturbing section pages. */
  peek(): Promise<void>
  /** Write invalidation: re-read when anyone is watching or data is on screen. */
  invalidate(): void
  /** Cancel outstanding requests, timers, and connection subscriptions. */
  dispose(): void
}

/** The pending section invalidates its page chain when the queue changes. */
function isInvalidCursor(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('ACTIVITY_CURSOR_INVALID')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the per-owner mailbox source. Polling and reset subscriptions exist
 * only while a listener is attached, so a closed panel or popover stops all
 * mailbox traffic for that owner.
 * @param deps - paged Host query, polling cadence, and reset subscription.
 * @returns observable mailbox state plus explicit read controls.
 */
export function createMailController(deps: MailControllerDependencies): MailController {
  let state: MailState = {
    status: 'idle', section: 'pending', pages: [], summary: undefined,
    refreshing: false, loadingMore: false,
  }
  const listeners = new Set<() => void>()
  let epoch = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeReset: (() => void) | undefined
  let op: AbortController | undefined

  const publish = (patch: Partial<MailState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const schedule = (): void => {
    stopTimer()
    if (disposed || listeners.size === 0) return
    // A pageless subscription (a header glance) still polls its counters;
    // without a summary there is nothing to refresh yet.
    if (state.pages.length === 0 && state.summary === undefined) return
    timer = setTimeout(() => {
      if (state.pages.length === 0) void peek()
      else void refresh()
    }, deps.pollIntervalMs())
  }
  /** Abort the in-flight operation and open a new epoch for the next one. */
  const supersede = (): { controller: AbortController; current: number } => {
    op?.abort()
    const controller = new AbortController()
    op = controller
    return { controller, current: ++epoch }
  }
  const settle = (current: number): boolean => {
    if (current !== epoch) return false
    op = undefined
    return true
  }

  /** Re-walk every shown page from fresh cursors so a refresh is all-or-nothing. */
  const walk = async (section: SessionLinkActivitySection, depth: number, signal: AbortSignal) => {
    const pages: SessionLinkActivityView[] = []
    let cursor: string | undefined
    for (let index = 0; index < Math.max(depth, 1); index += 1) {
      const view = await deps.load({ section, ...(cursor === undefined ? {} : { cursor }) }, signal)
      pages.push(view)
      cursor = view.nextCursor
      if (cursor === undefined) break
    }
    return pages
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    stopTimer()
    const { controller, current } = supersede()
    const section = state.section
    const depth = state.pages.length
    // Busy flags belong to the current operation: superseding a page read
    // retires its loadingMore flag here, not in the aborted op's finally.
    publish({
      status: state.pages.length === 0 ? 'loading' : state.status,
      refreshing: true, loadingMore: false, refreshError: undefined, pageError: undefined,
    })
    try {
      const pages = await walk(section, depth, controller.signal)
      if (!settle(current) || disposed) return
      publish({
        status: 'ready', pages,
        summary: pages[0]?.summary ?? state.summary,
        summarySampledAt: pages[0]?.sampledAt ?? state.summarySampledAt,
        refreshing: false,
      })
      schedule()
    } catch (error) {
      if (!settle(current) || disposed) return
      if (state.pages.length > 0) {
        // Retained pages keep polling: a transient failure must not silence the view.
        publish({ refreshing: false, refreshError: errorText(error) })
        schedule()
      } else {
        publish({ status: 'error', refreshing: false, error: errorText(error) })
      }
    }
  }

  const loadMore = async (): Promise<void> => {
    if (disposed || state.loadingMore || state.refreshing) return
    const cursor = state.pages[state.pages.length - 1]?.nextCursor
    if (cursor === undefined) return
    stopTimer()
    const { controller, current } = supersede()
    const section = state.section
    // Busy flags belong to the current operation: superseding a refresh
    // retires its refreshing flag here, not in the aborted op's finally.
    publish({ loadingMore: true, refreshing: false, pageError: undefined })
    try {
      const view = await deps.load({ section, cursor }, controller.signal)
      if (!settle(current) || disposed) return
      publish({
        pages: [...state.pages, view],
        summary: state.summary ?? view.summary,
        summarySampledAt: state.summary === undefined ? view.sampledAt : state.summarySampledAt,
        loadingMore: false,
      })
      schedule()
    } catch (error) {
      if (!settle(current) || disposed) return
      publish({ loadingMore: false })
      // A changed queue invalidates the chain; re-read from the first page
      // instead of leaving the viewer stuck on a dead cursor.
      if (isInvalidCursor(error)) await refresh()
      else {
        publish({ pageError: errorText(error) })
        schedule()
      }
    }
  }

  const peek = async (): Promise<void> => {
    if (disposed || state.refreshing || state.loadingMore) return
    const { controller, current } = supersede()
    try {
      const view = await deps.load({ section: 'pending', limit: 1 }, controller.signal)
      if (current !== epoch || disposed) return
      publish({ summary: view.summary, summarySampledAt: view.sampledAt, peekError: undefined })
    } catch (error) {
      // A failed peek keeps the last counters; the failure is still visible.
      if (current !== epoch || disposed) return
      publish({ peekError: errorText(error) })
    } finally {
      // A peek that superseded an in-flight poll owns the timer: without
      // re-arming here the superseded refresh's chain dies silently.
      if (current === epoch) { op = undefined; schedule() }
    }
  }

  /** Write invalidation arrived while unsubscribed; the next activation re-reads. */
  let dirty = false

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      // Activation wires resets and polling only; surfaces decide whether
      // their first read is a full section page or a counters-only peek.
      if (listeners.size === 1) unsubscribeReset = deps.subscribeReset?.(() => { void refresh() })
      // A remount re-arms polling from the retained pages: unsubscribe-all
      // stops the timer, so without this a re-attached view would go stale.
      schedule()
      // A write landed while nobody watched: this activation re-reads the
      // kind of data this subscription actually holds.
      if (dirty) {
        dirty = false
        if (state.pages.length === 0) { if (state.summary !== undefined) void peek() }
        else void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          epoch++
          stopTimer()
          op?.abort()
          op = undefined
          unsubscribeReset?.()
          unsubscribeReset = undefined
          // Busy flags belong to the aborted epoch: restore a re-readable
          // state so a remount restarts an interrupted first read.
          publish({
            status: state.status === 'loading' && state.pages.length === 0 ? 'idle' : state.status,
            refreshing: false,
            loadingMore: false,
          })
        }
      }
    },
    setSection(section) {
      if (disposed || section === state.section) return
      epoch++
      stopTimer()
      op?.abort()
      op = undefined
      // Section switch isolates immediately: no page or error may bleed across.
      publish({
        status: listeners.size > 0 ? 'loading' : 'idle', section, pages: [],
        refreshing: false, loadingMore: false,
        error: undefined, refreshError: undefined, pageError: undefined,
      })
      if (listeners.size > 0) void refresh()
    },
    refresh,
    loadMore,
    peek,
    invalidate() {
      if (disposed) return
      // Nobody is watching: only mark the retained data dirty. The next
      // subscription performs the re-read, so a write never queries every
      // ever-opened owner.
      if (listeners.size === 0) { dirty = true; return }
      if (state.pages.length === 0) { if (state.summary !== undefined) void peek() }
      else void refresh()
    },
    dispose() {
      disposed = true
      epoch++
      stopTimer()
      op?.abort()
      op = undefined
      unsubscribeReset?.()
      unsubscribeReset = undefined
      listeners.clear()
    },
  }
}
