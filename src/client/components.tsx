/** Self-contained controls for the plugin's allocated Harness slots. */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable, InjectFace, SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  SessionLinkActivityEntry, SessionLinkActivityQuery, SessionLinkActivitySection,
  SessionLinkActivityView, SessionLinkId,
  SessionLinkCancelResult, SessionLinkMessageId,
  SessionLinkExtendWakeRequest, SessionLinkExtendWakeResult,
} from '../types.ts'
import { createMailController, LinkBusyError, type LinkSnapshot, type MailController } from './state.ts'
import { linkCandidates, peerRows, sessionTitle, type PeerRow } from './selectors.ts'
import { NS } from './locales.ts'
import { Styles } from './styles.tsx'
import { WakeBudgetDialog } from './WakeBudgetDialog.tsx'

/** Shared read and mutations; every action is granted and checked by the Host. */
export interface LinkInjected {
  readonly hooks: { readonly links: HostObservable<LinkSnapshot> }
  readonly refresh: () => Promise<boolean>
  readonly link: (peerId: SessionId, autoWake: boolean, autoWakeCaller: boolean) => Promise<void>
  readonly setWake: (linkId: SessionLinkId, memberId: SessionId, on: boolean) => Promise<void>
  readonly unlink: (linkId: SessionLinkId) => Promise<void>
  readonly cancelMessage: (messageId: SessionLinkMessageId) => Promise<SessionLinkCancelResult>
  readonly extendChainWake?: (request: Omit<SessionLinkExtendWakeRequest, 'sessionId'>) => Promise<SessionLinkExtendWakeResult>
  /** Read one mailbox page for the bound Session; rejects on a protocol mismatch. */
  readonly loadActivity: (query: SessionLinkActivityQuery) => Promise<SessionLinkActivityView>
  /** Shared per-owner mailbox source; panel, glance, and popover all read through it. */
  readonly mail: MailController
  readonly openPanel: () => void
  readonly openSession: (sessionId: SessionId) => void
}
export type LinkProps = InjectFace<LinkInjected> & {
  readonly sessionId: SessionId
  readonly t: TranslateNS<typeof NS>
}
export type LinkActions = Pick<LinkInjected, 'link' | 'setWake' | 'unlink' | 'cancelMessage' | 'extendChainWake' | 'loadActivity' | 'mail' | 'openPanel' | 'openSession'>

/** Local link icon, using only the current text color. */
export function LinkIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2" />
  </svg>
}

/** Visible direction, state, explanation, and keyboard-operable switch. */
function WakeSetting({ checked, disabled, onChange, label, accessibleLabel, hint, t }: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly accessibleLabel?: string
  readonly hint: string
  readonly t: LinkProps['t']
}): ReactNode {
  return <div className="gcdl-wake-setting">
    <div className="gcdl-wake-copy"><span>{label}</span><span className="gcdl-peer-meta">{hint}</span></div>
    <span className="gcdl-peer-meta">{t(checked ? 'wake.on' : 'wake.off')}</span>
    <button type="button" role="switch" aria-checked={checked} aria-label={accessibleLabel ?? label} title={hint}
      className={`gcdl-switch${checked ? ' gcdl-switch-on' : ''}`} disabled={disabled}
      onClick={() => { onChange(!checked) }}><span className="gcdl-switch-thumb" /></button>
  </div>
}

/** A pending write cannot repaint another Session or an unmounted entry. */
function useOperation(sessionId: SessionId) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const current = useRef({ sessionId, live: true, epoch: 0 })
  current.current.sessionId = sessionId
  useEffect(() => {
    current.current.live = true
    return () => { current.current.live = false; current.current.epoch++ }
  }, [])
  useEffect(() => { setBusy(false); setError(null); current.current.epoch++ }, [sessionId])
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (inflight.current) return false
    inflight.current = true
    const token = ++current.current.epoch
    const owner = sessionId
    setBusy(true)
    setError(null)
    try {
      await action()
      return current.current.live && current.current.sessionId === owner && current.current.epoch === token
    } catch (reason) {
      if (reason instanceof LinkBusyError) return false
      if (current.current.live && current.current.sessionId === owner && current.current.epoch === token) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
      return false
    } finally {
      inflight.current = false
      if (current.current.live && current.current.sessionId === owner && current.current.epoch === token) setBusy(false)
    }
  }
  return { busy, error, run }
}

function QueryState({ snapshot, refresh, t }: {
  readonly snapshot: LinkSnapshot
  readonly refresh: () => Promise<boolean>
  readonly t: LinkProps['t']
}): ReactNode {
  if (snapshot.status === 'error') return <div role="alert" className="gcdl-notice">
    <span>{t('panel.error')}{snapshot.error ? `: ${snapshot.error}` : ''}</span>
    <button type="button" className="gcdl-text-button" onClick={() => { void refresh() }}>{t('panel.retry')}</button>
  </div>
  return snapshot.view === undefined ? <div className="gcdl-state" role="status">{t('panel.loading')}</div> : null
}

/** One creation form used in the header and management pane. */
function LinkPicker({ sessionId, snapshot, link, t, onLinked, autoFocus = false }: {
  readonly sessionId: SessionId
  readonly snapshot: LinkSnapshot
  readonly link: LinkInjected['link']
  readonly t: LinkProps['t']
  readonly onLinked: () => void
  readonly autoFocus?: boolean
}): ReactNode {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const candidatesId = useId()
  const [selected, setSelected] = useState<SessionId | null>(null)
  const [autoWake, setAutoWake] = useState(true)
  const [autoWakeCaller, setAutoWakeCaller] = useState(true)
  const { busy, error, run } = useOperation(sessionId)
  const candidates = useMemo(() => snapshot.view === undefined ? [] : linkCandidates(snapshot.view, sessionId), [snapshot.view, sessionId])
  const filtered = candidates.filter(candidate => `${candidate.title} ${candidate.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  // The Host catalog is already ordered by latest activity. Search all candidates before limiting the display.
  const visible = filtered.slice(0, expanded ? 8 : 3)
  const self = snapshot.view?.sessions.find(session => session.id === sessionId)
  const disabled = busy || snapshot.status !== 'ready' || self === undefined || !self.ordinary || self.archived
  // Never send a candidate that disappeared after a poll or a change of query.
  const chosen = selected !== null && visible.some(candidate => candidate.id === selected)
  useEffect(() => { setQuery(''); setExpanded(false); setSelected(null); setAutoWake(true); setAutoWakeCaller(true) }, [sessionId])
  return <div className="gcdl-picker" aria-busy={busy}>
    <input className="gcdl-input" value={query} placeholder={t('add.search')} aria-label={t('add.search')}
      autoFocus={autoFocus} disabled={busy} onChange={event => { setQuery(event.target.value); setExpanded(false); setSelected(null) }} />
    <div id={candidatesId} className="gcdl-candidates" aria-live="polite">
      {visible.length === 0 ? <div className="gcdl-state">{t('add.empty')}</div> : visible.map(candidate => (
        <button key={candidate.id} type="button" aria-pressed={selected === candidate.id} disabled={disabled}
          data-gc-duolink-candidate={candidate.id}
          className={`gcdl-candidate${selected === candidate.id ? ' gcdl-candidate-selected' : ''}`}
          onClick={() => { setSelected(candidate.id) }}>
          <span className="gcdl-peer-title">{candidate.title}</span><span className="gcdl-peer-meta">{String(candidate.id).replace(/^session-/, '').slice(0, 8)}</span>
        </button>
      ))}
    </div>
    {filtered.length > 3 ? <button type="button" className="gcdl-text-button gcdl-more-toggle" disabled={busy}
      aria-expanded={expanded} aria-controls={candidatesId} onClick={() => {
        setExpanded(value => !value)
        if (expanded && !filtered.slice(0, 3).some(candidate => candidate.id === selected)) setSelected(null)
      }}>{t(expanded ? 'add.less' : 'add.more')}</button> : null}
    {expanded && filtered.length > 8 ? <div className="gcdl-footnote">{t('add.limit')}</div> : null}
    <WakeSetting checked={autoWake} disabled={disabled} onChange={setAutoWake} label={t('add.wake')} hint={t('add.wake.hint')} t={t} />
    <WakeSetting checked={autoWakeCaller} disabled={disabled} onChange={setAutoWakeCaller} label={t('add.wake.self')} hint={t('add.wake.self.hint')} t={t} />
    <p className="gcdl-footnote">{t('wake.budget.hint')}</p>
    {error === null ? null : <div role="alert" className="gcdl-notice">{error}</div>}
    <button type="button" className="gcdl-button gcdl-add-submit" disabled={!chosen || disabled} onClick={() => {
      if (!chosen || selected === null) return
      void run(() => link(selected, autoWake, autoWakeCaller)).then(ok => { if (ok) onLinked() })
    }}>{t('add.action')}</button>
  </div>
}

function Peer({ row, snapshot, busy, setWake, openSession, t }: {
  readonly row: PeerRow
  readonly snapshot: LinkSnapshot
  readonly busy: boolean
  readonly setWake: (on: boolean) => void
  readonly openSession: LinkInjected['openSession']
  readonly t: LinkProps['t']
}): ReactNode {
  const session = snapshot.view?.sessions.find(item => item.id === row.peerId)
  const title = sessionTitle(snapshot.view, row.peerId)
  const status = session?.archived ? t('peer.archived') : t(session?.running ? 'peer.running' : 'peer.idle')
  const group = row.link.memberIds.length > 2
  return <div className="gcdl-peer">
    <div className="gcdl-peer-heading">
      <div className="gcdl-peer-main">{group ? <span className="gcdl-peer-title" title={title}>{title}</span> : null}
        <span className="gcdl-peer-meta">{String(row.peerId).replace(/^session-/, '').slice(0, 8)} · {status}</span></div>
      <span className="gcdl-linked">{t('peer.linked')}</span>
      {!session?.archived ? <button type="button" className="gcdl-text-button" title={t('peer.open.title', { title })}
        onClick={() => { openSession(row.peerId) }}>{t('peer.open')}</button> : null}
    </div>
    <WakeSetting checked={row.autoWake} disabled={busy || snapshot.status !== 'ready' || session?.archived === true}
      onChange={setWake} label={group ? `${t('row.wake.group')} · ${title}` : t('row.wake')}
      accessibleLabel={`${t(group ? 'row.wake.group' : 'row.wake')} · ${title}`}
      hint={t(group ? 'row.wake.group.hint' : 'row.wake.title')} t={t} />
  </div>
}

/** One-line pending/wake glance inside the header popover; reads the shared per-owner source. */
function MailGlance({ mail, t }: {
  readonly mail: MailController
  readonly t: LinkProps['t']
}): ReactNode {
  const state = useSyncExternalStore(mail.subscribe, mail.getSnapshot)
  // A summary peek shares the controller without disturbing any section pages.
  useEffect(() => {
    if (state.summary === undefined) void mail.peek()
  }, [mail, state.summary])
  const summary = state.summary ?? state.pages[0]?.summary
  if (summary === undefined) {
    return state.peekError !== undefined
      ? <div className="gcdl-notice" role="alert">{t('mail.error')}: {state.peekError}</div>
      : <div className="gcdl-footnote">{t('mail.loading')}</div>
  }
  const { pendingInbound, wake } = summary
  // Peek-only counters poll through the shared controller; the sampled time
  // makes their staleness inspectable on hover.
  const sampled = state.summarySampledAt ?? state.pages[0]?.sampledAt
  return <div className="gcdl-footnote"
    title={sampled === undefined ? undefined : t('mail.updated', { time: new Date(sampled).toLocaleTimeString() })}>
    {t('mail.glance', { count: pendingInbound, used: wake.used, limit: wake.limit })}
  </div>
}

/** UTC wall-clock label for a wake-budget reset instant; 'HH:mm UTC', ISO input. */
function utcClock(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : `${time.toISOString().slice(11, 16)} UTC`
}

/** Owner mailbox; cancellation is checked again by the Host at the delivery boundary. */
export function MailSection({ sessionId, snapshot, loadActivity, mail: provided, cancelMessage, extendChainWake, openSession, t }: {
  readonly sessionId: SessionId
  readonly snapshot: LinkSnapshot
  readonly loadActivity: LinkInjected['loadActivity']
  /** Shared per-owner source; an ad-hoc controller is created when none is injected. */
  readonly mail?: MailController
  readonly cancelMessage?: LinkInjected['cancelMessage']
  readonly extendChainWake?: LinkInjected['extendChainWake']
  readonly openSession?: LinkInjected['openSession']
  readonly t: LinkProps['t']
}): ReactNode {
  const loader = useRef(loadActivity)
  loader.current = loadActivity
  const fallbackPoll = useRef(snapshot.view?.pollIntervalMs)
  fallbackPoll.current = snapshot.view?.pollIntervalMs
  // A direct-rendered section (tests, embedding) still runs the same state
  // machine as the production shared controller, so failure modes cannot
  // diverge between the two wiring paths.
  const own = useMemo(() => createMailController({
    load: (query) => loader.current(query),
    pollIntervalMs: () => fallbackPoll.current ?? 30_000,
  }), [sessionId])
  useEffect(() => () => { own.dispose() }, [own])
  const mail = provided ?? own
  const state = useSyncExternalStore(mail.subscribe, mail.getSnapshot)
  const { busy, error, run } = useOperation(sessionId)
  const [extension, setExtension] = useState<{ owner: SessionId; entry: SessionLinkActivityEntry; trigger: HTMLElement } | null>(null)
  const [wakeResult, setWakeResult] = useState<{ owner: SessionId; result: SessionLinkExtendWakeResult; entry: SessionLinkActivityEntry } | null>(null)
  useEffect(() => { setExtension(null); setWakeResult(null) }, [sessionId])
  const [cancellations, setCancellations] = useState<{
    owner: SessionId
    results: ReadonlyMap<SessionLinkMessageId, { result: SessionLinkCancelResult; entry: SessionLinkActivityEntry }>
    latest?: SessionLinkCancelResult
  }>({ owner: sessionId, results: new Map() })
  const results = cancellations.owner === sessionId ? cancellations.results : undefined
  const latest = cancellations.owner === sessionId ? cancellations.latest : undefined
  useEffect(() => { setCancellations({ owner: sessionId, results: new Map() }) }, [sessionId])
  const cancel = async (entry: SessionLinkActivityEntry): Promise<void> => {
    if (cancelMessage === undefined) return
    const messageId = entry.messageId
    let result: SessionLinkCancelResult | undefined
    const accepted = await run(async () => { result = await cancelMessage(messageId) })
    if (!accepted || result === undefined) return
    const settled = result
    setCancellations(previous => ({
      owner: sessionId,
      results: new Map(previous.owner === sessionId ? previous.results : []).set(messageId, { result: settled, entry }),
      latest: settled,
    }))
    // Production actions invalidate the shared sources. Standalone sections
    // refresh their local source separately from the accepted operation.
    if (provided === undefined) mail.invalidate()
  }
  // The controller is the single section authority: the tab and the data
  // both read it, so a remount can never show one tab with another's rows.
  const section = state.section
  // The section owns full-page loads; a fresh or cleared source reads page one.
  useEffect(() => {
    if (state.status === 'idle') void mail.refresh()
  }, [mail, state.status])
  const select = (name: SessionLinkActivitySection): void => { mail.setSection(name) }
  const summary = state.summary ?? state.pages[0]?.summary
  const sampledAt = state.pages[0]?.sampledAt
  const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString()
  return <section className="gcdl-mail" aria-label={t('mail.title')}>
    <div className="gcdl-mail-head">
      <div className="gcdl-mail-tabs" role="tablist" aria-label={t('mail.title')}>
        {(['pending', 'recent'] as const).map(name => (
          <button key={name} type="button" role="tab" aria-selected={section === name}
            className={`gcdl-mail-tab${section === name ? ' gcdl-mail-tab-active' : ''}`}
            onClick={() => { select(name) }}>{t(name === 'pending' ? 'mail.pending' : 'mail.recent')}</button>
        ))}
      </div>
      <button type="button" className="gcdl-text-button" disabled={state.status === 'loading' || state.refreshing || state.loadingMore}
        onClick={() => { void mail.refresh() }}>{t('mail.refresh')}</button>
    </div>
    {summary === undefined ? null : <div className="gcdl-mail-summary">
      {t('mail.summary', {
        inbound: summary.pendingInbound, outbound: summary.pendingOutbound,
        used: summary.wake.used, limit: summary.wake.limit, reset: utcClock(summary.wake.resetsAt),
      })}
    </div>}
    {summary?.firstTaskWakeOwed === true
      ? <div className="gcdl-footnote" title={t('mail.firstwake.title')}>{t('mail.firstwake')}</div> : null}
    {sampledAt === undefined ? null
      : <div className="gcdl-footnote">{t('mail.updated', { time: timeOf(sampledAt) })}</div>}
    {state.status === 'error' ? <div className="gcdl-notice" role="alert">
      <span>{t('mail.error')}{state.error === undefined ? '' : `: ${state.error}`}</span>
      <button type="button" className="gcdl-text-button" onClick={() => { void mail.refresh() }}>{t('panel.retry')}</button>
    </div> : null}
    {state.refreshError === undefined && state.pageError === undefined ? null : <div className="gcdl-notice" role="alert">
      {state.refreshError === undefined ? null : <span>
        {t('mail.stale', { time: sampledAt === undefined ? '?' : timeOf(sampledAt) })}: {state.refreshError}
        {' '}<button type="button" className="gcdl-text-button" onClick={() => { void mail.refresh() }}>{t('panel.retry')}</button>
      </span>}
      {state.pageError === undefined ? null : <span>
        {t('mail.more.error')}: {state.pageError}
        {' '}<button type="button" className="gcdl-text-button" onClick={() => { void mail.loadMore() }}>{t('panel.retry')}</button>
      </span>}
    </div>}
    {state.status === 'loading' ? <div className="gcdl-state" role="status">{t('mail.loading')}</div> : null}
    {cancelMessage === undefined ? null : <div className="gcdl-footnote">{t('mail.cancel.hint')}</div>}
    {latest === undefined ? null : <div className="gcdl-notice" role="status" data-gc-duolink-cancel-result={latest.outcome}>
      {t(`mail.cancel.${latest.outcome}`, { status: t(`mail.status.${latest.status}`) })}
    </div>}
    {error === null ? null : <div className="gcdl-notice" role="alert">{error}</div>}
    {wakeResult?.owner !== sessionId ? null : <div className="gcdl-notice" role="status" data-gc-duolink-wake-result={wakeResult.result.outcome}>
      {t('mail.extend.saved', { used: wakeResult.result.budget.chain.used, limit: wakeResult.result.budget.chain.limit })}
      {' '}{t(`mail.extend.continuation.${wakeResult.result.continuation}`)}
      {' '}{t('mail.extend.status', { status: t(`mail.status.${wakeResult.result.status}`) })}
      {wakeResult.result.blockingReasons.length === 0 ? null : ` ${t('mail.blocking', { reasons: wakeResult.result.blockingReasons.map(reason => t(`mail.reason.${reason}`)).join(' · ') })}`}
    </div>}
    {state.status === 'ready' && state.pages.every(page => page.entries.length === 0) ? <div className="gcdl-state">{t('mail.empty')}</div> : null}
    {state.pages.map((page, index) => <div key={`${state.section}-${index}`} className="gcdl-mail-page">
      {index === 0 ? null : <div className="gcdl-footnote">{t('mail.page.sampled', { time: timeOf(page.sampledAt) })}</div>}
      {page.entries.map(entry => {
        const peer = entry.direction === 'inbound' ? entry.senderId : entry.targetId
        const title = sessionTitle(snapshot.view, peer)
        const attempt = results?.get(entry.messageId)
        const result = attempt?.result
        // A cold target may resume without holding its speculative marker.
        // A fresh Host snapshot can then permit cancellation again. Terminal
        // results remain monotonic; pending results bind only the clicked row.
        const cancellationChecked = attempt !== undefined && (attempt.result.status !== 'pending' || attempt.entry === entry)
        const extended = wakeResult?.owner === sessionId && wakeResult.result.messageId === entry.messageId ? wakeResult.result : undefined
        const status = entry.status === 'pending' ? result?.status ?? extended?.status ?? entry.status : entry.status
        const budget = wakeResult?.entry === entry ? extended?.budget ?? entry.wakeBudget : entry.wakeBudget ?? extended?.budget
        const target = snapshot.view?.sessions.find(session => session.id === entry.targetId)
        return <article key={entry.messageId} className="gcdl-mail-entry" data-gc-duolink-message={entry.messageId}>
          <div className="gcdl-mail-row">
            <span className="gcdl-mail-direction">{t(entry.direction === 'inbound' ? 'mail.direction.in' : 'mail.direction.out', { title })}</span>
            <span className={`gcdl-mail-status gcdl-mail-status-${status}`}>{t(`mail.status.${status}`)}</span>
          </div>
          {entry.preview === '' ? null : <div className="gcdl-mail-preview">{entry.preview}</div>}
          <div className="gcdl-mail-meta">{t('mail.enqueued', { time: new Date(entry.createdAt).toLocaleString() })}</div>
          {status !== 'pending' || budget === undefined ? null : <div className="gcdl-mail-meta" data-gc-duolink-chain-budget>
            {t('mail.extend.chain', { used: budget.chain.used, limit: budget.chain.limit })}
          </div>}
          {entry.lastError === undefined ? null : <div className="gcdl-notice">{t('mail.last.error')}: {entry.lastError}</div>}
          {status !== 'pending' || entry.blockingReasons.length === 0 ? null : <div className="gcdl-footnote">
            {t('mail.blocking', { reasons: entry.blockingReasons.map(reason => t(`mail.reason.${reason}`)).join(' · ') })}
          </div>}
          <div className="gcdl-mail-actions">
            {extendChainWake === undefined || status !== 'pending' || budget?.canExtend !== true || budget.chain.remaining !== 0 ? null
              : <button type="button" className="gcdl-text-button" data-gc-duolink-extend disabled={busy}
                onClick={event => { setExtension({ owner: sessionId, entry: budget === entry.wakeBudget ? entry : { ...entry, wakeBudget: budget }, trigger: event.currentTarget }) }}>{t('mail.extend.action')}</button>}
            {cancelMessage === undefined || status !== 'pending' ? null : <button type="button" className="gcdl-text-button gcdl-danger"
              disabled={busy || !entry.canCancel || cancellationChecked}
              title={t(entry.canCancel && !cancellationChecked ? 'mail.cancel.title' : 'mail.cancel.unavailable')}
              onClick={() => { void cancel(entry) }}>{t('mail.cancel.action')}</button>}
            {openSession === undefined || target?.archived === true || (target?.running !== true && result?.outcome !== 'too_late') ? null
              : <button type="button" className="gcdl-text-button" onClick={() => { openSession(entry.targetId) }}>{t('mail.cancel.open.target')}</button>}
          </div>
        </article>
      })}
    </div>)}
    {state.pages[state.pages.length - 1]?.nextCursor === undefined ? null : <div className="gcdl-mail-actions">
      <button type="button" className="gcdl-text-button" disabled={state.loadingMore || state.refreshing}
        onClick={() => { void mail.loadMore() }}>{state.loadingMore ? t('mail.loading') : t('mail.more')}</button>
    </div>}
    {summary === undefined || summary.legacyBlocked === 0 ? null
      : <div className="gcdl-footnote">{t('mail.legacy', { count: summary.legacyBlocked })}</div>}
    {extension?.owner !== sessionId || extendChainWake === undefined ? null : <WakeBudgetDialog key={sessionId}
      entry={extension.entry} trigger={extension.trigger} extend={extendChainWake} t={t}
      onClose={() => { setExtension(null) }} onResult={result => {
        setWakeResult({ owner: sessionId, result, entry: extension.entry }); setExtension(null)
        if (provided === undefined) mail.invalidate()
      }} onConflict={() => { if (provided === undefined) mail.invalidate() }} />}
  </section>
}

/** Linked-peer quick view in the header popover; each row opens that session. */
function QuickPeers({ snapshot, sessionId, openSession, t }: {
  readonly snapshot: LinkSnapshot
  readonly sessionId: SessionId
  readonly openSession: LinkInjected['openSession']
  readonly t: LinkProps['t']
}): ReactNode {
  const rows = peerRows(snapshot.view?.links ?? [], sessionId)
  const seen = new Set<SessionId>()
  const peers = rows.filter(row => seen.size !== seen.add(row.peerId).size)
  if (peers.length === 0) return null
  return <div className="gcdl-quick-peers">
    <div className="gcdl-footnote">{t('quick.peers')}</div>
    {peers.map(row => {
      const session = snapshot.view?.sessions.find(item => item.id === row.peerId)
      const title = sessionTitle(snapshot.view, row.peerId)
      const status = session?.archived ? t('peer.archived') : t(session?.running ? 'peer.running' : 'peer.idle')
      return <div key={row.peerId} className="gcdl-peer-heading">
        <div className="gcdl-peer-main">
          <span className="gcdl-peer-title" title={title}>{title}</span>
          <span className="gcdl-peer-meta">{status}</span>
        </div>
        {session?.archived === true ? null : <button type="button" className="gcdl-text-button"
          title={t('peer.open.title', { title })} onClick={() => { openSession(row.peerId) }}>{t('peer.open')}</button>}
      </div>
    })}
  </div>
}

/** Click-to-open quick linker. Escape restores focus; outside pointer/focus dismisses. */
export function HeaderAction(props: LinkProps & {
  readonly useSession: SnapshotSelectorHook<{ readonly openState: string }>
}): ReactNode {
  const { sessionId, useLinks, useSession, refresh, openPanel, t } = props
  const snapshot = useLinks(value => value)
  const visible = useSession(value => value.openState) === 'open'
    && snapshot.view?.sessions.find(session => session.id === sessionId)?.ordinary !== false
  const count = new Set(peerRows(snapshot.view?.links ?? [], sessionId).map(row => row.peerId)).size
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const panelId = useId()
  useEffect(() => { setOpen(false) }, [sessionId, visible])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      const popup = panel.current?.getBoundingClientRect()
      if (anchor === undefined || popup === undefined) return
      const margin = 16
      const below = anchor.bottom + 5
      const above = anchor.top - popup.height - 5
      const top = below + popup.height <= window.innerHeight - margin ? below
        : above >= margin ? above : Math.max(margin, Math.min(below, window.innerHeight - popup.height - margin))
      const left = Math.max(margin, Math.min(anchor.right - popup.width, window.innerWidth - popup.width - margin))
      setPosition({ left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    if (panel.current !== null) observer.observe(panel.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => {
      if (!(event.target instanceof Node)) return
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape, true) }
  }, [open])
  if (!visible) return null
  return <div className="gcdl-header">
    <Styles />
    <button ref={trigger} type="button" className={`gcdl-trigger${open ? ' gcdl-trigger-open' : ''}`}
      data-gc-duolink-action="" title={t('trigger.label')} aria-haspopup="dialog"
      aria-label={count > 0 ? t('trigger.badge.aria', { count }) : t('trigger.label')}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => { setOpen(value => !value) }}>
      <LinkIcon /><span>{t('trigger.short')}</span>{count > 0 ? <span className="gcdl-badge" aria-hidden="true">{count}</span> : null}
    </button>
    {open ? createPortal(<div ref={panel} id={panelId} role="dialog" aria-label={t('quick.title')} className="gcdl-popover" style={position}>
      <div className="gcdl-peer-heading"><strong>{t('quick.title')}</strong><button type="button" className="gcdl-text-button"
        aria-label={t('quick.close')} onClick={() => { setOpen(false); trigger.current?.focus() }}>×</button></div>
      <div className="gcdl-footnote">{t('panel.owner', { title: sessionTitle(snapshot.view, sessionId) })}</div>
      <MailGlance mail={props.mail} t={t} />
      <QuickPeers snapshot={snapshot} sessionId={sessionId} openSession={props.openSession} t={t} />
      <QueryState snapshot={snapshot} refresh={refresh} t={t} />
      {snapshot.view === undefined ? null : <LinkPicker key={sessionId} sessionId={sessionId} snapshot={snapshot} link={props.link} t={t}
        autoFocus onLinked={() => { setOpen(false); trigger.current?.focus() }} />}
      <div className="gcdl-popover-footer"><button type="button" className="gcdl-text-button" onClick={() => { setOpen(false); openPanel() }}>{t('popover.manage')}</button></div>
    </div>, document.body) : null}
  </div>
}

/** Management actions always bind to this explicit owner, not the visible conversation. */
export function LinkTab({ sessionId, useLinks, refresh, setWake, link, unlink, cancelMessage, extendChainWake, loadActivity, mail, openSession, t }: LinkProps): ReactNode {
  const snapshot = useLinks(value => value)
  const view = snapshot.view
  const { busy, error, run } = useOperation(sessionId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirming, setConfirming] = useState<SessionLinkId | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<SessionLinkId>>(() => new Set())
  const groupPrefix = useId()
  const groups = useMemo(() => view?.links.filter(group => group.memberIds.includes(sessionId)) ?? [], [view, sessionId])
  useEffect(() => { setPickerOpen(false); setConfirming(null); setCollapsed(new Set()) }, [sessionId])
  useEffect(() => { if (confirming !== null && !groups.some(group => group.id === confirming)) setConfirming(null) }, [groups, confirming])
  const self = view?.sessions.find(session => session.id === sessionId)
  const disabled = busy || snapshot.status !== 'ready' || self === undefined || self.archived || !self.ordinary
  return <div className="gcdl-panel" data-gc-duolink-panel="" data-gc-duolink-owner={sessionId} aria-busy={busy}>
    <Styles /><div className="gcdl-peer-heading">
      <div className="gcdl-peer-main"><span className="gcdl-footnote">{t('panel.owner', { title: sessionTitle(view, sessionId) })}</span></div>
      {self === undefined || self.archived ? null : <button type="button" className="gcdl-text-button"
        title={t('peer.open.title', { title: sessionTitle(view, sessionId) })}
        onClick={() => { openSession(sessionId) }}>{t('panel.open.session')}</button>}
    </div>
    <QueryState snapshot={snapshot} refresh={refresh} t={t} />
    {view === undefined ? null : <>
      {groups.length === 0 ? <div className="gcdl-state">{t('panel.empty')}</div> : groups.map(group => {
        const rows = peerRows([group], sessionId)
        // A pair has exactly one peer: its title owns the card, so controls need no repeated name.
        // Larger groups retain their group title and each receiving member's identity below it.
        const title = group.memberIds.length === 2 && rows[0] !== undefined ? sessionTitle(view, rows[0].peerId) : group.name
        const isCollapsed = collapsed.has(group.id)
        const bodyId = `${groupPrefix}-${group.id}`
        return (
        <section key={group.id} className="gcdl-group" aria-label={title}>
          <header className="gcdl-group-header">
            <button type="button" className="gcdl-group-toggle" aria-expanded={!isCollapsed} aria-controls={bodyId}
              aria-label={t(isCollapsed ? 'group.expand' : 'group.collapse', { title })}
              title={group.name === title ? title : `${title} · ${group.name}`} onClick={() => { setCollapsed(previous => {
                const next = new Set(previous)
                if (next.has(group.id)) next.delete(group.id); else next.add(group.id)
                return next
              }) }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d={isCollapsed ? 'm6 3 5 5-5 5' : 'm3 6 5 5 5-5'} />
              </svg><span className="gcdl-group-title">{title}</span>
            </button>
            <button type="button" className="gcdl-text-button gcdl-danger" disabled={disabled}
              onClick={() => { setConfirming(group.id) }}>{t('peer.revoke')}</button>
          </header>
          <div id={bodyId} hidden={isCollapsed}>
          {rows.map(row => <Peer key={row.peerId} row={row} snapshot={snapshot} busy={disabled}
            setWake={on => { void run(() => setWake(group.id, row.peerId, on)) }} openSession={openSession} t={t} />)}
          <div className="gcdl-group-self">
            <WakeSetting checked={group.autoWakeSessionIds.includes(sessionId)} disabled={disabled}
              onChange={on => { void run(() => setWake(group.id, sessionId, on)) }}
              label={t(group.memberIds.length > 2 ? 'row.wake.self.group' : 'add.wake.self')}
              hint={t('add.wake.self.hint')} t={t} />
            {!group.autoWakeSessionIds.includes(sessionId) ? <p className="gcdl-footnote">{t('wake.self.off.hint')}</p> : null}
          </div>
          </div>
          {confirming === group.id ? <div className="gcdl-confirm"><div>{t('revoke.confirm')}</div><div className="gcdl-confirm-actions">
            <button type="button" className="gcdl-button" disabled={busy} onClick={() => { setConfirming(null) }}>{t('revoke.cancel')}</button>
            <button type="button" className="gcdl-button gcdl-danger" disabled={disabled}
              onClick={() => { void run(() => unlink(group.id)).then(ok => { if (ok) setConfirming(null) }) }}>{t('revoke.action')}</button>
          </div></div> : null}
        </section>
      )})}
      <div className="gcdl-add">
        <button type="button" className="gcdl-text-button gcdl-add-toggle" aria-expanded={pickerOpen} disabled={disabled}
          onClick={() => { setPickerOpen(value => !value) }}>{t('add.title')}</button>
        {pickerOpen ? <LinkPicker key={sessionId} sessionId={sessionId} snapshot={snapshot} link={link} t={t} onLinked={() => { setPickerOpen(false) }} /> : null}
      </div>
      <div className="gcdl-footnote">{t('wake.budget.hint')}</div><div className="gcdl-footnote">{t('tab.command.hint')}</div>
    </>}
    <MailSection sessionId={sessionId} snapshot={snapshot} loadActivity={loadActivity} mail={mail} cancelMessage={cancelMessage} extendChainWake={extendChainWake} openSession={openSession} t={t} />
    {error === null ? null : <div role="alert" className="gcdl-notice">{error}</div>}
  </div>
}

/** Navigation params identify the managed row without activating or switching that Session. */
export function panelOwner(sessionId: SessionId, params: unknown): SessionId {
  if (params !== null && typeof params === 'object' && 'sessionId' in params && typeof params.sessionId === 'string' && params.sessionId !== '') {
    return params.sessionId as SessionId
  }
  return sessionId
}
type ManagedProps = LinkProps & { readonly useTabInfo: UseSidebarRightTabInfo; readonly actionsFor: (id: SessionId) => LinkActions }
export function ManagedLinkTab(props: ManagedProps): ReactNode {
  const info = props.useTabInfo()
  const owner = panelOwner(props.sessionId, info.tab.navigation.params)
  // Hidden Host tabs can remain mounted. Unmount the owned surface so native
  // top-layer dialogs and local receipts cannot outlive their visible panel.
  if (info.tab.visible === false) return null
  return <LinkTab key={owner} {...props} {...props.actionsFor(owner)} sessionId={owner} />
}
export function LinkTabTitle({ sessionId, useLinks, t }: LinkProps): ReactNode {
  const count = useLinks(snapshot => new Set(peerRows(snapshot.view?.links ?? [], sessionId).map(row => row.peerId)).size)
  return <span className="gcdl-tab-title"><Styles /><LinkIcon size={14} />{t('tab.title')}{count === 0 ? '' : ` (${count})`}</span>
}
export function ManagedLinkTabTitle(props: ManagedProps): ReactNode {
  const owner = panelOwner(props.sessionId, props.useTabInfo().tab.navigation.params)
  return <LinkTabTitle {...props} sessionId={owner} />
}

export interface RowInjected {
  readonly hooks: { readonly links: HostObservable<LinkSnapshot> }
  readonly openPanelFor: (id: SessionId) => void
}
type RowProps = InjectFace<RowInjected> & { readonly sessionId: SessionId; readonly t: LinkProps['t'] }
/** Only linked Sessions contribute an action; the Host owns hover/focus visibility. */
export function RowLinkAction({ sessionId, useLinks, openPanelFor, t }: RowProps): ReactNode {
  const snapshot = useLinks(value => value)
  const session = snapshot.view?.sessions.find(row => row.id === sessionId)
  const [error, setError] = useState<string | null>(null)
  if (session?.ordinary !== true || session.archived || session.blank) return null
  const count = new Set(peerRows(snapshot.view?.links ?? [], sessionId).map(row => row.peerId)).size
  if (count === 0) return null
  const title = t('row.linked', { count })
  return <><Styles /><button type="button" className="gcdl-row-action gcdl-row-linked"
    data-gc-duolink-row-action="" title={error ?? title} aria-label={title} onClick={event => {
      event.stopPropagation()
      try { openPanelFor(sessionId); setError(null) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    }}><LinkIcon /></button>{error === null ? null : <span className="gcdl-hidden" role="alert">{error}</span>}</>
}
export function RowLinkMenu(props: RowProps & { readonly useMenuOpenState: () => readonly [boolean, (open: boolean) => void] }): ReactNode {
  const snapshot = props.useLinks(value => value)
  const [, setMenuOpen] = props.useMenuOpenState()
  const [error, setError] = useState<string | null>(null)
  const session = snapshot.view?.sessions.find(row => row.id === props.sessionId)
  if (session?.ordinary !== true || session.archived || session.blank) return null
  return <><MenuItemButton icon={<LinkIcon />} onSelect={() => {
    try { props.openPanelFor(props.sessionId); setMenuOpen(false); setError(null) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }}>{props.t('row.manage')}</MenuItemButton>{error === null ? null : <><Styles /><span className="gcdl-notice" role="alert">{error}</span></>}</>
}
