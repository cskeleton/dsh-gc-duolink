/** Linked-spawn transcript rows rendered through the Turn-tail slot. */
import type { ReactNode } from 'react'
import type { LinkProps } from './components.tsx'
import { LinkIcon } from './components.tsx'
import { Styles } from './styles.tsx'
import { sessionTitle } from './selectors.ts'
import { selectLinkedSpawns, type SessionLinkTurnOwner } from './turn.ts'

/** Settled spawned Sessions and the current wake flags read from the Host. */
export function TurnCard({ turn, seq, useLinks, openPanel, t }: LinkProps & SessionLinkTurnOwner): ReactNode {
  const view = useLinks(snapshot => snapshot.view)
  const created = selectLinkedSpawns({ turn, seq })?.created ?? []
  if (created.length === 0) return null
  return <><Styles />{created.map(spawn => {
    const group = view?.links.find(link => link.id === spawn.linkId && link.memberIds.includes(spawn.sessionId))
    const wake = group === undefined ? null : group.autoWakeSessionIds.includes(spawn.sessionId)
    return <div key={spawn.callId} className="slp-card" data-session-link-created="">
      <LinkIcon /><span className="slp-card-title">{t('card.linked', { title: sessionTitle(view, spawn.sessionId) })}</span>
      {wake === null ? null : <span className="slp-card-wake">{t(wake ? 'card.wake.on' : 'card.wake.off')}</span>}
      <button type="button" className="slp-text-button" onClick={openPanel}>{t('card.open')}</button>
    </div>
  })}</>
}
