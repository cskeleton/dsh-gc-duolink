/**
 * Human-granted peer messaging between ordinary top-level Sessions, mounted as
 * `ctx.sessionLinks`. The service stores link groups, mailbox entries, and
 * throttle ledgers in one `session-link` storage domain; delivery lands in the
 * target Agent's durable inbox with a dedicated non-human
 * `session-link-message` source, and acceptance is acknowledged only after the
 * target write handle flushes. The default export mounts the Service class
 * directly, matching the loader's Service-plugin convention.
 * @module dsh-session-link
 */

import { SessionLinkService } from './link.ts'

// Host-only augmentations keep browser imports free of host services.

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Human-granted peer messaging between ordinary top-level Sessions. */
    sessionLinks: SessionLinkService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Peer delivery attribution written by `dsh-session-link`. Readers
     * preserve this message without the producer; only Session Link delivery
     * and recovery read the kind for target-side de-duplication.
     * @persistenceAttribution
     */
    'session-link-message': import('./types.ts').SessionLinkMessageSource
    /**
     * Host-generated task-status attribution written by `dsh-session-link`
     * about the ORIGINAL task, distinct from any Agent speech. Read-side
     * de-duplication keys on this kind + messageId; no producer path treats
     * such a message as a task or an instruction.
     * @persistenceAttribution
     */
    'session-task-status': import('./types.ts').SessionLinkTaskStatusSource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable tracked-task intents, transitions, outbox, and decision idempotency. */
    sessionLinkTasks: import('./tasks.ts').SessionLinkTaskService
  }
}

export { SessionLinkService, frameSessionLinkText, notificationMessageId } from './link.ts'
export type { SessionLinkLimits, SessionLinkOptions } from './link.ts'
export {
  sessionLinkDomainSpec,
  sessionLinkRecordSchema,
  sessionLinkMessageSchema,
  sessionLinkLedgersSchema,
  SESSION_LINK_LEDGER_KEY,
} from './spec.ts'
export type {
  SessionLinkLedgersData,
  SessionLinkMessageRecordData,
  SessionLinkRecordData,
} from './spec.ts'
export {
  CATALOG_UNAVAILABLE,
  checkCandidateRoutes,
  EFFORT_UNSUPPORTED,
  IF_EXHAUSTED_NOTIFY_SENDER,
  MAX_CANDIDATE_ATTEMPTS,
  MAX_CANDIDATE_FALLBACKS,
  MODEL_NOT_FOUND,
  MODEL_PARAMS_INVALID,
  modelRoutingParamsSchema,
  ModelRoutingError,
  normalizeModelRoutingParams,
  parseModelRoutingParams,
  projectModelCatalog,
  PROVIDER_NOT_FOUND,
  readModelCatalog,
  SessionListModelsParamsError,
  validateCandidateAgainstCatalog,
} from './model-policy.ts'
export type {
  CandidateAvailability,
  CandidateCheckResult,
  ModelCatalogEffort,
  ModelCatalogLike,
  ModelCatalogModelEntry,
  ModelCatalogProviderFailure,
  ModelCatalogProviderGroup,
  ModelCatalogReader,
  ModelCatalogReasoning,
  ModelRouteCandidate,
  ModelRouteSelection,
  ModelRoutingErrorCode,
  ModelRoutingParams,
  ModelRoutingParamsParseResult,
  ModelRoutingPolicy,
  SessionDefaultCandidate,
  SessionModelListEffort,
  SessionModelListModel,
  SessionModelListProvider,
  SessionModelListView,
} from './model-policy.ts'
export { sessionLinkTaskDomainSpec, sessionLinkTaskSchema, TASK_DIGEST_MAX_TEXT } from './task-spec.ts'
export type {
  SessionLinkTaskAttempt,
  SessionLinkTaskDecisionRecord,
  SessionLinkTaskExecutionProjection,
  SessionLinkTaskOutboxEvent,
  SessionLinkTaskRecordData,
} from './task-spec.ts'
export {
  attemptCallKey,
  candidatesEqual,
  mintTaskMessageId,
  requestDigest,
  SessionLinkTaskError,
  SessionLinkTaskService,
  TASK_BINDING_INCOMPLETE,
  TASK_NOT_CONTINUABLE,
  TASK_NOT_RETRYABLE,
  TASK_RUNNING,
  TASK_TERMINAL,
  TASK_WRITE_FAILED,
  TaskInvariantError,
  taskIdFor,
} from './tasks.ts'
export {
  installTaskRuntime,
  PERSISTENT_SELECTION_SKIPPED,
  precheckFailureOf,
  requestedRouteOf,
} from './task-runtime.ts'
export { installTaskNotifications } from './task-notifications.ts'
export type { TaskNotificationPump } from './task-notifications.ts'
export { ensureTaskHostLazy } from './task-host-lazy.ts'
export type { SessionLinkTaskStatusReport, SessionLinkTaskStatusSource } from './types.ts'
export type {
  AttachBindingInput,
  CreateTaskIntentInput,
  OriginalRequestInput,
  ReconcileReport,
  ReconcileResult,
  SavedTaskIntent,
  SessionLinkTaskServiceOptions,
  TaskChange,
  TaskErrorCode,
  TaskEventInput,
  TaskExecutionState,
  TaskLinksProbe,
  TaskOutboxKind,
  TaskSpawnIntentInput,
  TaskState,
  TaskView,
} from './tasks.ts'
export {
  SessionLinkError,
  SessionLinkId,
  SessionLinkMessageId,
  SessionLinkTaskId,
} from './types.ts'
export type {
  Config,
  SessionLinkAddRequest,
  SessionLinkAddResult,
  SessionLinkGrant,
  SessionLinkMessageRecord,
  SessionLinkMessageSource,
  SessionLinkRecord,
  SessionLinkRevokeRequest,
  SessionLinkSendRequest,
  SessionLinkSendResult,
  SessionLinkSpawnReplay,
  SessionLinkSummary,
  SessionLinkSessionView,
  SessionLinkTaskOutboxView,
  SessionLinkTaskRouteView,
  SessionLinkTaskViewEntry,
  SessionLinkTaskViewRequest,
  SessionLinkTaskViewResponse,
  SessionLinkView,
  SessionLinkWakeRequest,
} from './types.ts'

export default SessionLinkService
