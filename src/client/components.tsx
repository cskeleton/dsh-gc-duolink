/** Self-contained controls for the plugin's allocated Harness slots. */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable, InjectFace, SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  SessionLinkActivityQuery, SessionLinkActivitySection,
  SessionLinkActivityView, SessionLinkId,
} from '../types.ts'
import { createMailController, LinkBusyError, type LinkSnapshot, type MailController } from './state.ts'
import { linkCandidates, peerRows, sessionTitle, type PeerRow } from './selectors.ts'
import { NS } from './locales.ts'
import { Styles } from './styles.tsx'

/** Shared read and mutations; every action is granted and checked by the Host. */
export interface LinkInjected {
  readonly hooks: { readonly links: HostObservable<LinkSnapshot> }
  readonly refresh: () => Promise<boolean>
  readonly link: (peerId: SessionId, autoWake: boolean, autoWakeCaller: boolean) => Promise<void>
  readonly setWake: (linkId: SessionLinkId, memberId: SessionId, on: boolean) => Promise<void>
  readonly unlink: (linkId: SessionLinkId) => Promise<void>
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
export type LinkActions = Pick<LinkInjected, 'link' | 'setWake' | 'unlink' | 'loadActivity' | 'mail' | 'openPanel' | 'openSession'>

/** Local link icon, using only the current text color. */
export function LinkIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2" />
  </svg>
}

/** Visible direction, state, explanation, and keyboard-operable switch. */
function WakeSetting({ checked, disabled, onChange, label, hint, t }: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly hint: string
  readonly t: LinkProps['t']
}): ReactNode {
  return <div className="slp-wake-setting">
    <div className="slp-wake-copy"><span>{label}</span><span className="slp-peer-meta">{hint}</span></div>
    <span className="slp-peer-meta">{t(checked ? 'wake.on' : 'wake.off')}</span>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={hint}
      className={`slp-switch${checked ? ' slp-switch-on' : ''}`} disabled={disabled}
      onClick={() => { onChange(!checked) }}><span className="slp-switch-thumb" /></button>
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
  if (snapshot.status === 'error') return <div role="alert" className="slp-notice">
    <span>{t('panel.error')}{snapshot.error ? `: ${snapshot.error}` : ''}</span>
    <button type="button" className="slp-text-button" onClick={() => { void refresh() }}>{t('panel.retry')}</button>
  </div>
  return snapshot.view === undefined ? <div className="slp-state" role="status">{t('panel.loading')}</div> : null
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
  const [selected, setSelected] = useState<SessionId | null>(null)
  const [autoWake, setAutoWake] = useState(true)
  const [autoWakeCaller, setAutoWakeCaller] = useState(true)
  const { busy, error, run } = useOperation(sessionId)
  const candidates = useMemo(() => snapshot.view === undefined ? [] : linkCandidates(snapshot.view, sessionId), [snapshot.view, sessionId])
  const filtered = candidates.filter(candidate => `${candidate.title} ${candidate.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  const self = snapshot.view?.sessions.find(session => session.id === sessionId)
  const disabled = busy || snapshot.status !== 'ready' || self === undefined || !self.ordinary || self.archived
  // Never send a candidate that disappeared after a poll or a change of query.
  const chosen = selected !== null && filtered.some(candidate => candidate.id === selected)
  useEffect(() => { setQuery(''); setSelected(null); setAutoWake(true); setAutoWakeCaller(true) }, [sessionId])
  return <div className="slp-picker" aria-busy={busy}>
    <input className="slp-input" value={query} placeholder={t('add.search')} aria-label={t('add.search')}
      autoFocus={autoFocus} disabled={busy} onChange={event => { setQuery(event.target.value); setSelected(null) }} />
    <div className="slp-candidates">
      {filtered.length === 0 ? <div className="slp-state">{t('add.empty')}</div> : filtered.map(candidate => (
        <button key={candidate.id} type="button" aria-pressed={selected === candidate.id} disabled={disabled}
          className={`slp-candidate${selected === candidate.id ? ' slp-candidate-selected' : ''}`}
          onClick={() => { setSelected(candidate.id) }}>
          <span className="slp-peer-title">{candidate.title}</span><span className="slp-peer-meta">{String(candidate.id).replace(/^session-/, '').slice(0, 8)}</span>
        </button>
      ))}
    </div>
    <WakeSetting checked={autoWake} disabled={disabled} onChange={setAutoWake} label={t('add.wake')} hint={t('add.wake.hint')} t={t} />
    <WakeSetting checked={autoWakeCaller} disabled={disabled} onChange={setAutoWakeCaller} label={t('add.wake.self')} hint={t('add.wake.self.hint')} t={t} />
    <p className="slp-footnote">{t('wake.budget.hint')}</p>
    {error === null ? null : <div role="alert" className="slp-notice">{error}</div>}
    <button type="button" className="slp-button slp-add-submit" disabled={!chosen || disabled} onClick={() => {
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
  return <div className="slp-peer">
    <div className="slp-peer-heading">
      <div className="slp-peer-main"><span className="slp-peer-title" title={title}>{title}</span>
        <span className="slp-peer-meta">{String(row.peerId).replace(/^session-/, '').slice(0, 8)} · {status}</span></div>
      <span className="slp-linked">{t('peer.linked')}</span>
      {!session?.archived ? <button type="button" className="slp-text-button" title={t('peer.open.title', { title })}
        onClick={() => { openSession(row.peerId) }}>{t('peer.open')}</button> : null}
    </div>
    <WakeSetting checked={row.autoWake} disabled={busy || snapshot.status !== 'ready' || session?.archived === true}
      onChange={setWake} label={`${t(group ? 'row.wake.group' : 'row.wake')} · ${title}`}
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
      ? <div className="slp-notice" role="alert">{t('mail.error')}: {state.peekError}</div>
      : <div className="slp-footnote">{t('mail.loading')}</div>
  }
  const { pendingInbound, wake } = summary
  // Peek-only counters poll through the shared controller; the sampled time
  // makes their staleness inspectable on hover.
  const sampled = state.summarySampledAt ?? state.pages[0]?.sampledAt
  return <div className="slp-footnote"
    title={sampled === undefined ? undefined : t('mail.updated', { time: new Date(sampled).toLocaleTimeString() })}>
    {t('mail.glance', { count: pendingInbound, used: wake.used, limit: wake.limit })}
  </div>
}

/** UTC wall-clock label for a wake-budget reset instant; 'HH:mm UTC', ISO input. */
function utcClock(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : `${time.toISOString().slice(11, 16)} UTC`
}

/** Read-only mailbox for the panel owner: pending and recent pages, never a write. */
export function MailSection({ sessionId, snapshot, loadActivity, mail: provided, t }: {
  readonly sessionId: SessionId
  readonly snapshot: LinkSnapshot
  readonly loadActivity: LinkInjected['loadActivity']
  /** Shared per-owner source; an ad-hoc controller is created when none is injected. */
  readonly mail?: MailController
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
  return <section className="slp-mail" aria-label={t('mail.title')}>
    <div className="slp-mail-head">
      <div className="slp-mail-tabs" role="tablist" aria-label={t('mail.title')}>
        {(['pending', 'recent'] as const).map(name => (
          <button key={name} type="button" role="tab" aria-selected={section === name}
            className={`slp-mail-tab${section === name ? ' slp-mail-tab-active' : ''}`}
            onClick={() => { select(name) }}>{t(name === 'pending' ? 'mail.pending' : 'mail.recent')}</button>
        ))}
      </div>
      <button type="button" className="slp-text-button" disabled={state.status === 'loading' || state.refreshing || state.loadingMore}
        onClick={() => { void mail.refresh() }}>{t('mail.refresh')}</button>
    </div>
    {summary === undefined ? null : <div className="slp-mail-summary">
      {t('mail.summary', {
        inbound: summary.pendingInbound, outbound: summary.pendingOutbound,
        used: summary.wake.used, limit: summary.wake.limit, reset: utcClock(summary.wake.resetsAt),
      })}
    </div>}
    {summary?.firstTaskWakeOwed === true
      ? <div className="slp-footnote" title={t('mail.firstwake.title')}>{t('mail.firstwake')}</div> : null}
    {sampledAt === undefined ? null
      : <div className="slp-footnote">{t('mail.updated', { time: timeOf(sampledAt) })}</div>}
    {state.status === 'error' ? <div className="slp-notice" role="alert">
      <span>{t('mail.error')}{state.error === undefined ? '' : `: ${state.error}`}</span>
      <button type="button" className="slp-text-button" onClick={() => { void mail.refresh() }}>{t('panel.retry')}</button>
    </div> : null}
    {state.refreshError === undefined && state.pageError === undefined ? null : <div className="slp-notice" role="alert">
      {state.refreshError === undefined ? null : <span>
        {t('mail.stale', { time: sampledAt === undefined ? '?' : timeOf(sampledAt) })}: {state.refreshError}
        {' '}<button type="button" className="slp-text-button" onClick={() => { void mail.refresh() }}>{t('panel.retry')}</button>
      </span>}
      {state.pageError === undefined ? null : <span>
        {t('mail.more.error')}: {state.pageError}
        {' '}<button type="button" className="slp-text-button" onClick={() => { void mail.loadMore() }}>{t('panel.retry')}</button>
      </span>}
    </div>}
    {state.status === 'loading' ? <div className="slp-state" role="status">{t('mail.loading')}</div> : null}
    {state.status === 'ready' && state.pages.every(page => page.entries.length === 0) ? <div className="slp-state">{t('mail.empty')}</div> : null}
    {state.pages.map((page, index) => <div key={`${state.section}-${index}`} className="slp-mail-page">
      {index === 0 ? null : <div className="slp-footnote">{t('mail.page.sampled', { time: timeOf(page.sampledAt) })}</div>}
      {page.entries.map(entry => {
        const peer = entry.direction === 'inbound' ? entry.senderId : entry.targetId
        const title = sessionTitle(snapshot.view, peer)
        return <article key={entry.messageId} className="slp-mail-entry">
          <div className="slp-mail-row">
            <span className="slp-mail-direction">{t(entry.direction === 'inbound' ? 'mail.direction.in' : 'mail.direction.out', { title })}</span>
            <span className={`slp-mail-status slp-mail-status-${entry.status}`}>{t(`mail.status.${entry.status}`)}</span>
          </div>
          {entry.preview === '' ? null : <div className="slp-mail-preview">{entry.preview}</div>}
          <div className="slp-mail-meta">{t('mail.enqueued', { time: new Date(entry.createdAt).toLocaleString() })}</div>
          {entry.lastError === undefined ? null : <div className="slp-notice">{t('mail.last.error')}: {entry.lastError}</div>}
          {entry.blockingReasons.length === 0 ? null : <div className="slp-footnote">
            {t('mail.blocking', { reasons: entry.blockingReasons.map(reason => t(`mail.reason.${reason}`)).join(' · ') })}
          </div>}
        </article>
      })}
    </div>)}
    {state.pages[state.pages.length - 1]?.nextCursor === undefined ? null : <div className="slp-mail-actions">
      <button type="button" className="slp-text-button" disabled={state.loadingMore || state.refreshing}
        onClick={() => { void mail.loadMore() }}>{state.loadingMore ? t('mail.loading') : t('mail.more')}</button>
    </div>}
    {summary === undefined || summary.legacyBlocked === 0 ? null
      : <div className="slp-footnote">{t('mail.legacy', { count: summary.legacyBlocked })}</div>}
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
  return <div className="slp-quick-peers">
    <div className="slp-footnote">{t('quick.peers')}</div>
    {peers.map(row => {
      const session = snapshot.view?.sessions.find(item => item.id === row.peerId)
      const title = sessionTitle(snapshot.view, row.peerId)
      const status = session?.archived ? t('peer.archived') : t(session?.running ? 'peer.running' : 'peer.idle')
      return <div key={row.peerId} className="slp-peer-heading">
        <div className="slp-peer-main">
          <span className="slp-peer-title" title={title}>{title}</span>
          <span className="slp-peer-meta">{status}</span>
        </div>
        {session?.archived === true ? null : <button type="button" className="slp-text-button"
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
  return <div className="slp-header">
    <Styles />
    <button ref={trigger} type="button" className={`slp-trigger${open ? ' slp-trigger-open' : ''}`}
      data-session-link-action="" title={t('trigger.label')} aria-haspopup="dialog"
      aria-label={count > 0 ? t('trigger.badge.aria', { count }) : t('trigger.label')}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => { setOpen(value => !value) }}>
      <LinkIcon /><span>{t('trigger.short')}</span>{count > 0 ? <span className="slp-badge" aria-hidden="true">{count}</span> : null}
    </button>
    {open ? createPortal(<div ref={panel} id={panelId} role="dialog" aria-label={t('quick.title')} className="slp-popover" style={position}>
      <div className="slp-peer-heading"><strong>{t('quick.title')}</strong><button type="button" className="slp-text-button"
        aria-label={t('quick.close')} onClick={() => { setOpen(false); trigger.current?.focus() }}>×</button></div>
      <div className="slp-footnote">{t('panel.owner', { title: sessionTitle(snapshot.view, sessionId) })}</div>
      <MailGlance mail={props.mail} t={t} />
      <QuickPeers snapshot={snapshot} sessionId={sessionId} openSession={props.openSession} t={t} />
      <QueryState snapshot={snapshot} refresh={refresh} t={t} />
      {snapshot.view === undefined ? null : <LinkPicker key={sessionId} sessionId={sessionId} snapshot={snapshot} link={props.link} t={t}
        autoFocus onLinked={() => { setOpen(false); trigger.current?.focus() }} />}
      <div className="slp-popover-footer"><button type="button" className="slp-text-button" onClick={() => { setOpen(false); openPanel() }}>{t('popover.manage')}</button></div>
    </div>, document.body) : null}
  </div>
}

/** Management actions always bind to this explicit owner, not the visible conversation. */
export function LinkTab({ sessionId, useLinks, refresh, setWake, link, unlink, loadActivity, mail, openSession, t }: LinkProps): ReactNode {
  const snapshot = useLinks(value => value)
  const view = snapshot.view
  const { busy, error, run } = useOperation(sessionId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirming, setConfirming] = useState<SessionLinkId | null>(null)
  const groups = useMemo(() => view?.links.filter(group => group.memberIds.includes(sessionId)) ?? [], [view, sessionId])
  useEffect(() => { setPickerOpen(false); setConfirming(null) }, [sessionId])
  useEffect(() => { if (confirming !== null && !groups.some(group => group.id === confirming)) setConfirming(null) }, [groups, confirming])
  const self = view?.sessions.find(session => session.id === sessionId)
  const disabled = busy || snapshot.status !== 'ready' || self === undefined || self.archived || !self.ordinary
  return <div className="slp-panel" data-session-link-panel="" data-session-link-owner={sessionId} aria-busy={busy}>
    <Styles /><div className="slp-peer-heading">
      <div className="slp-peer-main"><span className="slp-footnote">{t('panel.owner', { title: sessionTitle(view, sessionId) })}</span></div>
      {self === undefined || self.archived ? null : <button type="button" className="slp-text-button"
        title={t('peer.open.title', { title: sessionTitle(view, sessionId) })}
        onClick={() => { openSession(sessionId) }}>{t('panel.open.session')}</button>}
    </div>
    <QueryState snapshot={snapshot} refresh={refresh} t={t} />
    {view === undefined ? null : <>
      {groups.length === 0 ? <div className="slp-state">{t('panel.empty')}</div> : groups.map(group => (
        <section key={group.id} className="slp-group" aria-label={group.name}>
          <header className="slp-group-header"><LinkIcon size={14} />{group.name}</header>
          {peerRows([group], sessionId).map(row => <Peer key={row.peerId} row={row} snapshot={snapshot} busy={disabled}
            setWake={on => { void run(() => setWake(group.id, row.peerId, on)) }} openSession={openSession} t={t} />)}
          <div className="slp-group-self">
            <WakeSetting checked={group.autoWakeSessionIds.includes(sessionId)} disabled={disabled}
              onChange={on => { void run(() => setWake(group.id, sessionId, on)) }}
              label={t(group.memberIds.length > 2 ? 'row.wake.self.group' : 'add.wake.self')}
              hint={t('add.wake.self.hint')} t={t} />
            {!group.autoWakeSessionIds.includes(sessionId) ? <p className="slp-footnote">{t('wake.self.off.hint')}</p> : null}
          </div>
          {confirming === group.id ? <div className="slp-confirm"><div>{t('revoke.confirm')}</div><div className="slp-confirm-actions">
            <button type="button" className="slp-button" disabled={busy} onClick={() => { setConfirming(null) }}>{t('revoke.cancel')}</button>
            <button type="button" className="slp-button slp-danger" disabled={disabled}
              onClick={() => { void run(() => unlink(group.id)).then(ok => { if (ok) setConfirming(null) }) }}>{t('revoke.action')}</button>
          </div></div> : <div className="slp-confirm-actions"><button type="button" className="slp-text-button slp-danger" disabled={disabled}
            onClick={() => { setConfirming(group.id) }}>{t('peer.revoke')}</button></div>}
        </section>
      ))}
      <div className="slp-add">
        <button type="button" className="slp-text-button slp-add-toggle" aria-expanded={pickerOpen} disabled={disabled}
          onClick={() => { setPickerOpen(value => !value) }}>{t('add.title')}</button>
        {pickerOpen ? <LinkPicker key={sessionId} sessionId={sessionId} snapshot={snapshot} link={link} t={t} onLinked={() => { setPickerOpen(false) }} /> : null}
      </div>
      <div className="slp-footnote">{t('wake.budget.hint')}</div><div className="slp-footnote">{t('tab.command.hint')}</div>
    </>}
    <MailSection sessionId={sessionId} snapshot={snapshot} loadActivity={loadActivity} mail={mail} t={t} />
    {error === null ? null : <div role="alert" className="slp-notice">{error}</div>}
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
  const owner = panelOwner(props.sessionId, props.useTabInfo().tab.navigation.params)
  return <LinkTab key={owner} {...props} {...props.actionsFor(owner)} sessionId={owner} />
}
export function LinkTabTitle({ sessionId, useLinks, t }: LinkProps): ReactNode {
  const count = useLinks(snapshot => new Set(peerRows(snapshot.view?.links ?? [], sessionId).map(row => row.peerId)).size)
  return <span className="slp-tab-title"><Styles /><LinkIcon size={14} />{t('tab.title')}{count === 0 ? '' : ` (${count})`}</span>
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
/** The Host owns hover/focus visibility of this right-hand action strip. No leading decoration. */
export function RowLinkAction({ sessionId, useLinks, openPanelFor, t }: RowProps): ReactNode {
  const snapshot = useLinks(value => value)
  const session = snapshot.view?.sessions.find(row => row.id === sessionId)
  const [error, setError] = useState<string | null>(null)
  if (session?.ordinary !== true || session.archived || session.blank) return null
  const count = new Set(peerRows(snapshot.view?.links ?? [], sessionId).map(row => row.peerId)).size
  const title = count > 0 ? t('row.linked', { count }) : t('row.unlinked')
  return <><Styles /><button type="button" className={`slp-row-action${count > 0 ? ' slp-row-linked' : ''}`}
    data-session-link-row-action="" title={error ?? title} aria-label={title} onClick={event => {
      event.stopPropagation()
      try { openPanelFor(sessionId); setError(null) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    }}><LinkIcon /></button>{error === null ? null : <span className="slp-hidden" role="alert">{error}</span>}</>
}
export function RowLinkMenu(props: RowProps & { readonly useMenuOpenState: () => readonly [boolean, (open: boolean) => void] }): ReactNode {
  const snapshot = props.useLinks(value => value)
  const [, setMenuOpen] = props.useMenuOpenState()
  const [error, setError] = useState<string | null>(null)
  const session = snapshot.view?.sessions.find(row => row.id === props.sessionId)
  if (session?.ordinary !== true || session.archived || session.blank) return null
  return <><Styles /><button type="button" role="menuitem" className="slp-menu-item" onClick={() => {
    try { props.openPanelFor(props.sessionId); setMenuOpen(false); setError(null) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }}><LinkIcon />{props.t('row.manage')}</button>{error === null ? null : <span className="slp-notice" role="alert">{error}</span>}</>
}
