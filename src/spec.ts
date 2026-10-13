/**
 * The Session Link domain declaration: durable schemas for link groups,
 * mailbox entries, and the throttle ledgers the service opens through
 * `ctx.storageDomain`.
 * @module dsh-session-link/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionLinkId, SessionLinkMessageId } from './types.ts'

const sessionId = z.string().transform(value => brandString<SessionId>(value))
const linkId = z.string().transform(value => SessionLinkId(value))
const messageId = z.string().transform(value => SessionLinkMessageId(value))

/** Durable shape of one link record at the medium boundary. */
export const sessionLinkRecordSchema = z.object({
  name: z.string(),
  memberIds: z.array(sessionId),
  autoWakeSessionIds: z.array(sessionId).default([]),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  grantedBy: z.object({
    kind: z.union([z.literal('human'), z.literal('session')]),
    sessionId: sessionId.optional(),
  }),
})

/** Durable shape of one mailbox record at the medium boundary. */
export const sessionLinkMessageSchema = z.object({
  linkId,
  senderId: sessionId,
  senderTitle: z.string(),
  targetId: sessionId,
  inReplyTo: messageId.optional(),
  text: z.string(),
  status: z.union([
    z.literal('pending'),
    z.literal('delivered'),
    z.literal('cancelled'),
    z.literal('failed'),
    z.literal('revoked'),
  ]),
  wakesUsed: z.number().int().nonnegative(),
  chainLength: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  error: z.string().optional(),
  /** Caller-supplied idempotency key, committed in the same write as the message. */
  idempotencyKey: z.string().optional(),
  /** Monotonic admission sequence; absent on messages admitted before 0.4.0. */
  seq: z.number().int().positive().optional(),
  /** Set before the message is handed to the target; such a message is never made terminal. */
  inserted: z.boolean().optional(),
  /** Legacy experimental report markers must survive decoding; 0.5 never executes them. */
  statusKind: z.json().optional(),
  taskStatus: z.json().optional(),
})

/** Inferred link record type, shared with the runtime module. */
export type SessionLinkRecordData = z.infer<typeof sessionLinkRecordSchema>

/** Inferred mailbox record type, shared with the runtime module. */
export type SessionLinkMessageRecordData = z.infer<typeof sessionLinkMessageSchema>

/**
 * Call-site idempotency map: `senderId:idempotencyKey` → admitted message id.
 * Read-only since 0.3.3, which stores the key on the message itself; kept for
 * messages admitted by earlier versions.
 */
export const sessionLinkIdempotencySchema = z.record(z.string(), z.string())

/** Per-session automatic-wake ledger: session id → day-keyed counter. */
export const sessionLinkWakeLedgerSchema = z.record(
  z.string(),
  z.object({
    day: z.string(),
    wakes: z.number().int().nonnegative(),
  }),
)

/**
 * Spawn-call ledger: `callerId:callId` → the Session that call created and the
 * group it grants. The entry is committed before the group (`intent: true`),
 * and unlinking marks it `removed` before deleting the group, so every
 * partially written state reads as either "never granted" or "removed".
 * Entries without `intent` were written by 0.3.2 after its group existed.
 */
export const sessionLinkSpawnLedgerSchema = z.record(
  z.string(),
  z.object({
    sessionId,
    linkId,
    intent: z.boolean().optional(),
    removed: z.boolean().optional(),
    /** Creation intent's original grants; replay cannot widen these from changed arguments. */
    autoWakeSessionIds: z.array(sessionId).optional(),
  }),
)

/** The key of the only singleton record in the ledgers table. */
export const SESSION_LINK_LEDGER_KEY = 'ledger'

/** Only bootstrap facts for a new ordinary Session; runtime selection stays native. */
export const initialModelSpawnSchema = z.object({
  sessionId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  cwd: z.string(),
  preset: z.string().min(1),
  title: z.string(),
  autoWake: z.boolean(),
  wakeCaller: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  selection: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() }),
  headerCreated: z.boolean(),
  seedConfirmed: z.boolean(),
})
export type InitialModelSpawnRecord = z.infer<typeof initialModelSpawnSchema>

/**
 * One durable ledgers row: the idempotency map, the wake ledger, and the spawn
 * ledger. Rows written before the spawn ledger existed read it as empty.
 */
export const sessionLinkLedgersSchema = z.object({
  idempotency: sessionLinkIdempotencySchema,
  wakes: sessionLinkWakeLedgerSchema,
  spawns: sessionLinkSpawnLedgerSchema.default({}),
  initialModelSpawns: z.record(z.string(), initialModelSpawnSchema).default({}),
})

/** Inferred ledgers row type, shared with the runtime module. */
export type SessionLinkLedgersData = z.infer<typeof sessionLinkLedgersSchema>

/**
 * The Session Link domain spec: link groups and mailbox entries as per-record
 * tables plus one ledgers singleton. The spec object is the single source of
 * the domain's identity, version, and schemas.
 */
export const sessionLinkDomainSpec = defineDomain({
  name: 'session_link',
  version: 1,
  global: {
    schema: z.object({ initialized: z.boolean() }),
    initial: { initialized: true },
  },
  tables: {
    links: domainTable<SessionLinkId, SessionLinkRecordData>(sessionLinkRecordSchema),
    messages: domainTable<SessionLinkMessageId, SessionLinkMessageRecordData>(sessionLinkMessageSchema),
    ledgers: domainTable<string, SessionLinkLedgersData>(sessionLinkLedgersSchema),
  },
})
