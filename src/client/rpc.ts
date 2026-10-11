/** Validation of the plugin-owned JSON views at the Connection RPC receiver. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SessionLinkSessionView,
  SessionLinkSummary,
  SessionLinkTaskViewEntry,
  SessionLinkTaskViewResponse,
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

/** One concrete route the task view may name. */
function route(value: unknown): value is { provider: string; model: string; reasoningEffort?: string } {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

/** One outbox line of a task view entry. */
function outboxEntry(value: unknown): value is SessionLinkTaskViewEntry['outbox'][number] {
  return record(value) && typeof value.eventId === 'string' && typeof value.kind === 'string'
    && typeof value.status === 'string' && typeof value.decisionRequired === 'boolean'
    && typeof value.resumable === 'boolean'
}

/** One panel task line. */
function taskEntry(value: unknown): value is SessionLinkTaskViewEntry {
  return record(value) && typeof value.taskId === 'string' && typeof value.taskState === 'string'
    && typeof value.revision === 'number' && Number.isInteger(value.revision)
    && (value.executionState === undefined
      || value.executionState === 'not_started' || value.executionState === 'partial' || value.executionState === 'unknown')
    && (value.reason === undefined || typeof value.reason === 'string')
    && (value.targetSessionId === undefined || sessionId(value.targetSessionId))
    && route(value.requestedModel)
    && (value.currentRoute === undefined || route(value.currentRoute))
    && (value.routeUsed === undefined || route(value.routeUsed))
    && (value.scope === 'task' || value.scope === 'session')
    && typeof value.routePersisted === 'boolean'
    && typeof value.currentlyExecuting === 'boolean'
    && Array.isArray(value.outbox) && (value.outbox as unknown[]).every(outboxEntry)
    && typeof value.updatedAt === 'string'
}

/**
 * Narrow the plugin's read-only task projection. Anything malformed fails
 * closed to an empty/tasks-error surface; the panel never renders partial rows.
 * @param value - untrusted wire response.
 * @returns whether it supplies a bounded poll interval and well-formed rows.
 */
export function isTaskView(value: unknown): value is SessionLinkTaskViewResponse {
  return record(value)
    && typeof value.pollIntervalMs === 'number' && Number.isInteger(value.pollIntervalMs)
    && value.pollIntervalMs >= 1000 && value.pollIntervalMs <= 2_147_483_647
    && Array.isArray(value.tasks) && (value.tasks as unknown[]).every(taskEntry)
}
