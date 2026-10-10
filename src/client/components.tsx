/** Self-contained controls for the plugin's allocated Harness slots. */
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable, InjectFace, SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLinkId } from '../types.ts'
import { LinkBusyError, type LinkSnapshot } from './state.ts'
import { linkCandidates, peerRows, sessionTitle, type PeerRow } from './selectors.ts'
import { NS } from './locales.ts'
import { Styles } from './styles.tsx'

/** Shared read and mutations; every action is granted and checked by the Host. */
export interface LinkInjected {
  readonly hooks: { readonly links: HostObservable<LinkSnapshot> }
  readonly refresh: () => Promise<boolean>
  readonly link: (peerId: SessionId, autoWake: boolean) => Promise<void>
  readonly setWake: (linkId: SessionLinkId, peerId: SessionId, on: boolean) => Promise<void>
  readonly unlink: (linkId: SessionLinkId) => Promise<void>
  readonly openPanel: () => void
  readonly openSession: (sessionId: SessionId) => void
}

/** Component inputs produced by the slot renderer's observable adapter. */
export type LinkProps = InjectFace<LinkInjected> & {
  readonly sessionId: SessionId
  readonly t: TranslateNS<typeof NS>
}

/** Local link icon, using only the current text color. */
export function LinkIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="m10 14 4-4M8.5 15.5 6 18a4.25 4.25 0 0 1-6-6l4-4a4.25 4.25 0 0 1 6 0m5.5.5L18 6a4.25 4.25 0 0 1 6 6l-4 4a4.25 4.25 0 0 1-6 0" transform="translate(1.5 0) scale(.875)" />
    </svg>
  )
}

/** Accessible switch with the Host's token colors and keyboard semantics. */
function WakeSwitch({ checked, disabled, onChange, label, title }: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly title: string
}): ReactNode {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title}
      className={`slp-switch${checked ? ' slp-switch-on' : ''}`} disabled={disabled}
      onClick={() => { onChange(!checked) }}>
      <span className="slp-switch-thumb" />
    </button>
  )
}

/**
 * Run one write at a time; a click during a pending write is ignored. A
 * completed operation never repaints another Session or an unmounted entry.
 */
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
    // A ref, not `busy`: two clicks in one frame both read the same stale state.
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

/** Query failures stay beside retained content; an unresolved read has one state. */
function QueryState({ snapshot, refresh, t }: {
  readonly snapshot: LinkSnapshot
  readonly refresh: () => Promise<boolean>
  readonly t: TranslateNS<typeof NS>
}): ReactNode {
  if (snapshot.status === 'error') {
    return (
      <div role="alert" className="slp-notice">
        <span>{t('panel.error')}{snapshot.error ? `: ${snapshot.error}` : ''}</span>
        <button type="button" className="slp-text-button" onClick={() => { void refresh() }}>{t('panel.retry')}</button>
      </div>
    )
  }
  return snapshot.view === undefined ? <div className="slp-state" role="status">{t('panel.loading')}</div> : null
}

/** A peer row shared by the hover summary and full panel. */
function Peer({ row, snapshot, busy, setWake, openSession, compact, t }: {
  readonly row: PeerRow
  readonly snapshot: LinkSnapshot
  readonly busy: boolean
  readonly setWake: (on: boolean) => void
  readonly openSession: (sessionId: SessionId) => void
  readonly compact?: boolean
  readonly t: TranslateNS<typeof NS>
}): ReactNode {
  const session = snapshot.view?.sessions.find(item => item.id === row.peerId)
  const title = sessionTitle(snapshot.view, row.peerId)
  const status = session?.archived ? t('peer.archived') : t(session?.running ? 'peer.running' : 'peer.idle')
  return (
    <div className="slp-peer">
      <span aria-hidden="true" className={`slp-dot${session?.running ? ' slp-dot-on' : ''}`} />
      <div className="slp-peer-main">
        <span className="slp-peer-title" title={title}>{title}</span>
        <span className="slp-peer-meta">{compact ? status : `${String(row.peerId).slice(0, 8)} · ${status}`}</span>
      </div>
      <WakeSwitch checked={row.autoWake} disabled={busy || snapshot.status === 'error'} onChange={setWake}
        label={`${t('row.wake')} · ${title}`} title={t('row.wake.title')} />
      {!compact && !session?.archived
        ? <button type="button" className="slp-text-button" title={t('peer.open.title', { title })}
            onClick={() => { openSession(row.peerId) }}>{t('peer.open')}</button>
        : null}
    </div>
  )
}

/** Session-scoped header entry with a viewport-fitted, dismissible hover summary. */
export function HeaderAction(props: LinkProps & {
  readonly useSession: SnapshotSelectorHook<{ readonly openState: string }>
}): ReactNode {
  const { sessionId, useLinks, useSession, refresh, setWake, openPanel, t } = props
  const snapshot = useLinks(value => value)
  const visible = useSession(value => value.openState) === 'open'
  const rows = snapshot.view === undefined ? [] : peerRows(snapshot.view.links, sessionId)
  const count = new Set(rows.map(row => row.peerId)).size
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const ignoreFocus = useRef(false)
  const panelId = useId()
  const { busy, error, run } = useOperation(sessionId)
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])
  const closeLater = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => { setOpen(false) }, 180)
  }
  useEffect(() => cancelClose, [cancelClose])
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
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (trigger.current?.contains(event.target) || panel.current?.contains(event.target)) return
      cancelClose()
      setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      cancelClose()
      setOpen(false)
      ignoreFocus.current = true
      trigger.current?.focus()
      queueMicrotask(() => { ignoreFocus.current = false })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, cancelClose])
  if (!visible) return null
  const manage = (): void => { cancelClose(); setOpen(false); openPanel() }
  return (
    <div className="slp-header">
      <Styles />
      <button ref={trigger} type="button" className={`slp-trigger${open ? ' slp-trigger-open' : ''}`}
        data-session-link-action="" title={t('trigger.label')}
        aria-label={count > 0 ? t('trigger.badge.aria', { count }) : t('trigger.label')}
        aria-expanded={open} aria-controls={open ? panelId : undefined}
        onClick={manage} onPointerEnter={() => { cancelClose(); setOpen(true) }} onPointerLeave={closeLater}
        onFocus={() => { if (!ignoreFocus.current) { cancelClose(); setOpen(true) } }}
        onBlur={event => { if (!panel.current?.contains(event.relatedTarget)) closeLater() }}>
        <LinkIcon />{count > 0 ? <span className="slp-badge" aria-hidden="true">{count}</span> : null}
      </button>
      {open ? createPortal(
        <div ref={panel} id={panelId} role="group" aria-label={t('trigger.label')} className="slp-popover"
          style={position} onPointerEnter={cancelClose} onPointerLeave={closeLater}
          onFocus={cancelClose} onBlur={event => {
            if (!panel.current?.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) closeLater()
          }}>
          <QueryState snapshot={snapshot} refresh={refresh} t={t} />
          {snapshot.view !== undefined && rows.length === 0
            ? <div className="slp-state">{t('panel.empty')}<div>{t('panel.empty.hint')}</div></div>
            : rows.map(row => <Peer key={`${row.link.id}:${row.peerId}`} row={row} snapshot={snapshot}
                busy={busy} compact setWake={on => { void run(() => setWake(row.link.id, row.peerId, on)) }}
                openSession={props.openSession} t={t} />)}
          {error === null ? null : <div role="alert" className="slp-notice">{error}</div>}
          <div className="slp-popover-footer"><button type="button" className="slp-text-button" onClick={manage}>{t('popover.manage')}</button></div>
        </div>, document.body,
      ) : null}
    </div>
  )
}

/** Session-scoped management tab, with Host-validated add, wake, and revoke operations. */
export function LinkTab({ sessionId, useLinks, refresh, setWake, link, unlink, openSession, t }: LinkProps): ReactNode {
  const snapshot = useLinks(value => value)
  const view = snapshot.view
  const { busy, error, run } = useOperation(sessionId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SessionId | null>(null)
  const [autoWake, setAutoWake] = useState(true)
  const [confirming, setConfirming] = useState<SessionLinkId | null>(null)
  const groups = useMemo(() => view?.links.filter(group => group.memberIds.includes(sessionId)) ?? [], [view, sessionId])
  const candidates = useMemo(() => view === undefined ? [] : linkCandidates(view, sessionId), [view, sessionId])
  const filtered = candidates.filter(candidate => candidate.title.toLowerCase().includes(query.trim().toLowerCase())
    || String(candidate.id).toLowerCase().includes(query.trim().toLowerCase()))
  useEffect(() => {
    setPickerOpen(false); setQuery(''); setSelected(null); setConfirming(null); setAutoWake(true)
  }, [sessionId])
  useEffect(() => {
    if (selected !== null && !candidates.some(candidate => candidate.id === selected)) setSelected(null)
    if (confirming !== null && !groups.some(group => group.id === confirming)) setConfirming(null)
  }, [candidates, selected, confirming, groups])
  const disabled = busy || snapshot.status === 'error'
  return (
    <div className="slp-panel" data-session-link-panel="" aria-busy={busy}>
      <Styles /><QueryState snapshot={snapshot} refresh={refresh} t={t} />
      {view === undefined ? null : <>
        {groups.length === 0 ? <div className="slp-state">{t('panel.empty')}</div> : groups.map(group => (
          <section key={group.id} className="slp-group" aria-label={group.name}>
            <header className="slp-group-header"><LinkIcon size={14} />{group.name}</header>
            {peerRows([group], sessionId).map(row => <Peer key={row.peerId} row={row} snapshot={snapshot}
              busy={busy} setWake={on => { void run(() => setWake(group.id, row.peerId, on)) }} openSession={openSession} t={t} />)}
            {confirming === group.id
              ? <div className="slp-confirm"><div>{t('revoke.confirm')}</div><div className="slp-confirm-actions">
                  <button type="button" className="slp-button" disabled={busy} onClick={() => { setConfirming(null) }}>{t('revoke.cancel')}</button>
                  <button type="button" className="slp-button slp-danger" disabled={disabled}
                    onClick={() => { void run(() => unlink(group.id)).then(ok => { if (ok) setConfirming(null) }) }}>{t('revoke.action')}</button>
                </div></div>
              : <div className="slp-confirm-actions"><button type="button" className="slp-text-button slp-danger" disabled={disabled}
                  onClick={() => { setConfirming(group.id) }}>{t('peer.revoke')}</button></div>}
          </section>
        ))}
        <div className="slp-add">
          <button type="button" className="slp-text-button slp-add-toggle" aria-expanded={pickerOpen} disabled={busy}
            onClick={() => { setPickerOpen(value => !value); setSelected(null); setQuery('') }}>{t('add.title')}</button>
          {pickerOpen ? <>
            <input className="slp-input" value={query} placeholder={t('add.search')} aria-label={t('add.search')}
              onChange={event => { setQuery(event.target.value) }} />
            <div className="slp-candidates">
              {filtered.length === 0 ? <div className="slp-state">{t('add.empty')}</div>
                : filtered.map(candidate => <button key={candidate.id} type="button" aria-pressed={selected === candidate.id}
                    className={`slp-candidate${selected === candidate.id ? ' slp-candidate-selected' : ''}`}
                    onClick={() => { setSelected(candidate.id) }}>
                    <span className="slp-peer-title">{candidate.title}</span><span className="slp-peer-meta">{String(candidate.id).slice(0, 8)}</span>
                  </button>)}
            </div>
            <div className="slp-add-options"><span>{t('add.wake.hint')}</span>
              <WakeSwitch checked={autoWake} disabled={disabled} label={t('add.wake')} title={t('add.wake.hint')} onChange={setAutoWake} />
            </div>
            <button type="button" className="slp-button slp-add-submit" disabled={selected === null || disabled} onClick={() => {
              if (selected === null) return
              const peerId = selected
              void run(() => link(peerId, autoWake)).then(ok => { if (ok) { setSelected(null); setPickerOpen(false) } })
            }}>{t('add.action')}</button>
          </> : null}
        </div>
        <div className="slp-footnote">{t('tab.command.hint')}</div>
      </>}
      {error === null ? null : <div role="alert" className="slp-notice">{error}</div>}
    </div>
  )
}

/** Tab chip copy and icon, reactive to peer count and current locale. */
export function LinkTabTitle({ sessionId, useLinks, t }: LinkProps): ReactNode {
  const count = useLinks(snapshot => new Set(peerRows(snapshot.view?.links ?? [], sessionId).map(row => row.peerId)).size)
  return <span className="slp-tab-title"><Styles /><LinkIcon size={14} />{t('tab.title')}{count === 0 ? '' : ` (${count})`}</span>
}

/** Idle-row mark; reading the shared catalog activates no Session. */
export function LinkMark({ sessionId, useLinks, t }: {
  readonly sessionId: SessionId
  readonly useLinks: SnapshotSelectorHook<LinkSnapshot>
  readonly t: TranslateNS<typeof NS>
}): ReactNode {
  const wake = useLinks(snapshot => {
    const groups = snapshot.view?.links.filter(group => group.memberIds.includes(sessionId)) ?? []
    return groups.length === 0 ? null : groups.some(group => group.autoWakeSessionIds.includes(sessionId))
  })
  if (wake === null) return null
  const title = t(wake ? 'mark.wake.on' : 'mark.wake.off')
  return <span className="slp-mark" data-session-link-mark="" title={title} onClick={event => { event.stopPropagation() }}>
    <Styles /><span aria-hidden="true" className={`slp-dot${wake ? ' slp-dot-on' : ''}`} /><span className="slp-hidden">{title}</span>
  </span>
}
