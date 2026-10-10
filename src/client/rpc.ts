/** Validation of the plugin-owned JSON view at the Connection RPC receiver. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionLinkSessionView, SessionLinkSummary, SessionLinkView } from '../types.ts'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function sessionId(value: unknown): value is SessionId {
  return typeof value === 'string' && value.length > 0
}
function ids(value: unknown): value is readonly SessionId[] {
  return Array.isArray(value) && value.every(sessionId)
}
function link(value: unknown): value is SessionLinkSummary {
  return record(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && ids(value.memberIds) && ids(value.autoWakeSessionIds)
    && typeof value.revision === 'number' && Number.isInteger(value.revision)
}
function session(value: unknown): value is SessionLinkSessionView {
  return record(value) && sessionId(value.id) && typeof value.title === 'string'
    && typeof value.running === 'boolean' && typeof value.archived === 'boolean'
    && typeof value.ordinary === 'boolean' && typeof value.blank === 'boolean'
}

/**
 * Narrow the plugin's own JSON response before its fields reach controls.
 * @param value - untrusted wire response.
 * @returns whether it supplies complete catalogs and a bounded poll interval.
 */
export function isLinkView(value: unknown): value is SessionLinkView {
  return record(value) && Array.isArray(value.links) && value.links.every(link)
    && Array.isArray(value.sessions) && value.sessions.every(session)
    && typeof value.pollIntervalMs === 'number' && Number.isInteger(value.pollIntervalMs)
    && value.pollIntervalMs >= 1000 && value.pollIntervalMs <= 2_147_483_647
}
