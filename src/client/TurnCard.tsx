/** Linked-spawn transcript rows rendered through the Turn-tail slot. */
import type { ReactNode } from 'react'
import type { LinkProps } from './components.tsx'
import { LinkIcon } from './components.tsx'
import { Styles } from './styles.tsx'
import { sessionTitle } from './selectors.ts'
import { selectLinkedSpawns, type SessionLinkTurnOwner } from './turn.ts'

/** Settled spawned Sessions and the current wake flags read from the Host. */
export function TurnCard({ sessionId, turn, seq, useLinks, openPanel, openSession, t }: LinkProps & SessionLinkTurnOwner): ReactNode {
  const view = useLinks(snapshot => snapshot.view)
  const created = selectLinkedSpawns({ turn, seq })?.created ?? []
  if (created.length === 0) return null
  return <><Styles />{created.map(spawn => {
    const group = view?.links.find(link => link.id === spawn.linkId && link.memberIds.includes(spawn.sessionId))
    const wake = group === undefined ? null : group.autoWakeSessionIds.includes(spawn.sessionId)
    const title = sessionTitle(view, spawn.sessionId)
    return <div key={spawn.callId} className="slp-card" data-session-link-created="">
      <LinkIcon /><span className="slp-card-title">{t('card.linked', { title })}</span>
      <span className="slp-card-wake">{t(spawn.delivery === 'accepted' ? 'card.delivery.accepted' : 'card.delivery.queued')}</span>
      {wake === null ? null : <>
        <span className="slp-card-wake">{t(wake ? 'card.wake.on' : 'card.wake.off')}</span>
        <span className="slp-card-wake">{t(group?.autoWakeSessionIds.includes(sessionId) ? 'card.wake.self.on' : 'card.wake.self.off')}</span>
      </>}
      <button type="button" className="slp-text-button" title={t('peer.open.title', { title })}
        onClick={() => { openSession(spawn.sessionId) }}>{t('peer.open')}</button>
      <button type="button" className="slp-text-button" onClick={openPanel}>{t('card.open')}</button>
      {spawn.initialModel === undefined ? null : <span className="slp-card-initial-model">
        {t('card.initial.model')}: {spawn.initialModel.provider} / {spawn.initialModel.model}
        {spawn.initialModel.reasoningEffort === undefined ? null : ` · ${t('card.initial.effort')}: ${spawn.initialModel.reasoningEffort}`}
      </span>}
    </div>
  })}</>
}
