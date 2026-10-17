/**
 * Human-granted peer messaging between ordinary top-level Sessions, mounted as
 * `ctx.gcDuolink`. The service stores link groups, mailbox entries, and
 * throttle ledgers in one `gc_duolink` storage domain; delivery lands in the
 * target Agent's durable inbox with a dedicated non-human
 * `gc-duolink-message` source, and acceptance is acknowledged only after the
 * target write handle flushes. The default export mounts the Service class
 * directly, matching the loader's Service-plugin convention.
 * @module dsh-gc-duolink
 */

import { SessionLinkService } from './link.ts'

// Host-only augmentations keep browser imports free of host services.

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Human-granted peer messaging between ordinary top-level Sessions. */
    gcDuolink: SessionLinkService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Peer delivery attribution written by `dsh-gc-duolink`. Readers
     * preserve this message without the producer; only Session Link delivery
     * and recovery read the kind for target-side de-duplication.
     * @persistenceAttribution
     */
    'gc-duolink-message': import('./types.ts').SessionLinkMessageSource
  }
}

export { SessionLinkService, frameSessionLinkText } from './link.ts'
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
  SessionLinkError,
  SessionLinkId,
  SessionLinkMessageId,
} from './types.ts'
export type {
  Config,
  SessionLinkAddRequest,
  SessionLinkAddResult,
  SessionLinkCancelRequest,
  SessionLinkCancelResult,
  SessionLinkWakeBudget,
  SessionLinkExtendWakeRequest,
  SessionLinkExtendWakeResult,
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
  SessionLinkView,
  SessionLinkWakeRequest,
} from './types.ts'

export default SessionLinkService
