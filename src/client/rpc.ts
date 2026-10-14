/** Validation of the plugin-owned JSON view at the Connection RPC receiver. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SessionLinkActivityEntry,
  SessionLinkActivitySummary,
  SessionLinkActivityView,
  SessionLinkBlockingReason,
  SessionLinkSessionView,
  SessionLinkSummary,
  SessionLinkView,
} from '../types.ts'

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

const STATUSES = new Set(['pending', 'delivered', 'cancelled', 'failed', 'revoked'])
const REASONS = new Set<SessionLinkBlockingReason>([
  'wake-unauthorized', 'wake-budget', 'archived', 'cold-target',
  'delivery-unverified', 'link-revoked', 'unknown',
])

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
function activityEntry(value: unknown): value is SessionLinkActivityEntry {
  return record(value) && typeof value.messageId === 'string' && value.messageId.length > 0
    && typeof value.linkId === 'string'
    && (value.direction === 'inbound' || value.direction === 'outbound')
    && sessionId(value.senderId) && sessionId(value.targetId)
    && typeof value.status === 'string' && STATUSES.has(value.status)
    && typeof value.createdAt === 'string'
    && (value.seq === undefined || (typeof value.seq === 'number' && Number.isInteger(value.seq)))
    && (value.inReplyTo === undefined || typeof value.inReplyTo === 'string')
    && typeof value.preview === 'string'
    && (value.lastError === undefined || typeof value.lastError === 'string')
    && typeof value.canCancel === 'boolean'
    && Array.isArray(value.blockingReasons) && value.blockingReasons.every(reason => REASONS.has(reason))
}
function activitySummary(value: unknown): value is SessionLinkActivitySummary {
  if (!record(value) || !record(value.wake)) return false
  return nonNegativeInteger(value.wake.used) && nonNegativeInteger(value.wake.limit)
    && typeof value.wake.day === 'string' && typeof value.wake.resetsAt === 'string'
    && nonNegativeInteger(value.pendingInbound) && nonNegativeInteger(value.pendingOutbound)
    && typeof value.firstTaskWakeOwed === 'boolean' && nonNegativeInteger(value.legacyBlocked)
    && Array.isArray(value.targets) && value.targets.every(target => record(target)
      && sessionId(target.id) && typeof target.live === 'boolean'
      && typeof target.running === 'boolean' && typeof target.archived === 'boolean')
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

/**
 * Narrow one `sessionLinks/activityView` response before entries reach controls.
 * @param value - untrusted wire response.
 * @returns whether it carries a consistent page, summary, and optional cursor.
 */
export function isActivityView(value: unknown): value is SessionLinkActivityView {
  return record(value) && typeof value.sampledAt === 'string'
    && nonNegativeInteger(value.total)
    && Array.isArray(value.entries) && value.entries.every(activityEntry)
    && (value.nextCursor === undefined || typeof value.nextCursor === 'string')
    && activitySummary(value.summary)
}
