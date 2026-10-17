/**
 * The Session Link domain declaration: durable schemas for link groups,
 * mailbox entries, and the throttle ledgers the service opens through
 * `ctx.storageDomain`.
 * @module dsh-gc-duolink/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
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
  /** Missing on old mail; only explicit false suppresses an idle wake request. */
  wake: z.boolean().optional(),
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
  /** Pre-insertion intent, not a receipt; cold targets must conservatively be treated as holding it. */
  inserted: z.boolean().optional(),
  /** Legacy experimental report markers must survive decoding; 0.5 never executes them. */
  statusKind: z.json().optional(),
  taskStatus: z.json().optional(),
})

/** Inferred link record type, shared with the runtime module. */
export type SessionLinkRecordData = z.infer<typeof sessionLinkRecordSchema>

/** Inferred mailbox record type, shared with the runtime module. */
export type SessionLinkMessageRecordData = z.infer<typeof sessionLinkMessageSchema>

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
    /** Target is fixed before attach; completion prevents replay from undoing human edits. */
    workspacePlacement: z.object({
      workspaceId: z.string().transform(value => brandString<WorkspaceId>(value)).optional(),
      completed: z.boolean(),
    }).optional(),
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
 * One durable DuoLink ledgers row: wake counters, spawn facts and extension receipts.
 */
export const sessionLinkLedgersSchema = z.object({
  wakes: sessionLinkWakeLedgerSchema,
  spawns: sessionLinkSpawnLedgerSchema.default({}),
  initialModelSpawns: z.record(z.string(), initialModelSpawnSchema).default({}),
  /** Append facts also serve as durable retry receipts; never delete them or reset wake history. */
  chainWakeExtensions: z.record(z.string(), z.object({
    rootId: messageId,
    sessionId,
    messageId,
    additional: z.number().int().min(1).max(100),
    expectedExtra: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.string(),
  })).default({}),
}).strict()

/** Inferred ledgers row type, shared with the runtime module. */
export type SessionLinkLedgersData = z.infer<typeof sessionLinkLedgersSchema>

/**
 * The Session Link domain spec: link groups and mailbox entries as per-record
 * tables plus one ledgers singleton. The spec object is the single source of
 * the domain's identity, version, and schemas.
 */
export const sessionLinkDomainSpec = defineDomain({
  name: 'gc_duolink',
  version: 1,
  global: {
    schema: z.object({ product: z.literal('dsh-gc-duolink'), initialized: z.boolean() }),
    initial: { product: 'dsh-gc-duolink', initialized: false },
  },
  tables: {
    links: domainTable<SessionLinkId, SessionLinkRecordData>(sessionLinkRecordSchema),
    messages: domainTable<SessionLinkMessageId, SessionLinkMessageRecordData>(sessionLinkMessageSchema),
    ledgers: domainTable<string, SessionLinkLedgersData>(sessionLinkLedgersSchema),
  },
})

/** Stamp a fresh domain; never adopt a nonempty store without DuoLink ownership. */
export async function initializeDuolinkDomain(domain: Domain<typeof sessionLinkDomainSpec>): Promise<void> {
  if (domain.global.get().initialized) return
  for (const table of ['links', 'messages', 'ledgers'] as const) {
    for (const _ of domain.table(table).entries()) {
      throw new Error('DuoLink refuses records without its storage ownership marker; old or foreign data cannot be imported')
    }
  }
  // The Host's global.initial is an in-memory default, so explicitly persist ownership.
  await domain.global.set({ product: 'dsh-gc-duolink', initialized: true })
}
