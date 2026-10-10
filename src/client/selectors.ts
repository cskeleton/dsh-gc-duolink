/** Display-only projections from the plugin's own Host view. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionLinkSessionView, SessionLinkSummary, SessionLinkView } from '../types.ts'

/** One peer within one explicitly granted group. */
export interface PeerRow {
  readonly link: SessionLinkSummary
  readonly peerId: SessionId
  readonly autoWake: boolean
}

/**
 * List each peer in the groups containing the displayed Session.
 * @param links - authoritative groups.
 * @param sessionId - displayed Session.
 * @returns peer rows in group order.
 */
export function peerRows(links: readonly SessionLinkSummary[], sessionId: SessionId): PeerRow[] {
  return links.filter(link => link.memberIds.includes(sessionId))
    .flatMap(link => link.memberIds.filter(id => id !== sessionId)
      .map(peerId => ({ link, peerId, autoWake: link.autoWakeSessionIds.includes(peerId) })))
}

/**
 * List eligible peers; the Host validates every submitted selection again.
 * @param view - latest Host view.
 * @param sessionId - displayed Session.
 * @returns ordinary, unarchived, nonblank peers outside its existing groups.
 */
export function linkCandidates(view: SessionLinkView, sessionId: SessionId): readonly SessionLinkSessionView[] {
  return view.sessions.filter(session => session.id !== sessionId && session.ordinary
    && !session.archived && !session.blank
    && !view.links.some(link => link.memberIds.includes(sessionId) && link.memberIds.includes(session.id)))
}

/**
 * Resolve a peer's title without activating or retaining the peer.
 * @param view - latest Host view, if read.
 * @param sessionId - peer identity.
 * @returns published title, or its identity when not listed.
 */
export function sessionTitle(view: SessionLinkView | undefined, sessionId: SessionId): string {
  return view?.sessions.find(session => session.id === sessionId)?.title ?? String(sessionId)
}
