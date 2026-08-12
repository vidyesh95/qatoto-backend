import { and, asc, count, eq, gte, lte } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { platformAuditEntry, platformChainHead, user } from "#src/db/schema.js";
import {
  canonicalHashHex,
  canonicalizeDocument,
  type CanonicalValue,
} from "#src/lib/canonical-hash.js";
import {
  type PlatformCapability,
  requirePlatformCapability,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { PlatformAccessError } from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The PLATFORM audit chain (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 2).
 *
 * WHY THIS EXISTS. `requirePlatformCapability` gates 25 call sites and, before this
 * module, not one of them recorded that a decision had been made. A moderator could
 * approve a category, merge two clusters — which `discovery-moderation.service.ts` itself
 * calls irreversible — rewrite the public supplier directory, or unpublish a market
 * insight a project cites, and leave nothing behind. §4f's append-only doctrine is real
 * and is PROJECT-scoped; a taxonomy decision has no project to hang off.
 *
 * A DIRECT PORT of `project-audit.service.ts`, and it should stay one: same canonical
 * hash, same lock-then-allocate order, same "throws rather than returns a Result" rule.
 * The two differences both follow from there being no project —
 *
 *   * `actorUserId` is NOT NULL and the actor label is not pseudonymized. The project
 *     chain salts its actor label per project so the same person is a different label in
 *     each one (§9.10, worker monitoring). A platform action is an act of authority over
 *     other people's data, and the accountable answer to "who decided this" is a name.
 *   * ONE head row, not one per project. Every moderation decision serializes behind a
 *     single lock, which is affordable because they are few and typed by hand.
 *
 * APPEND-ONLY IS THE TRIGGER, not this module. Migration 0025 installs the same
 * `qatoto_reject_mutation()` pair every other append-only table carries, and
 * `pnpm db:verify-platform-audit-constraints` proves it against real rows.
 */

export const PLATFORM_AUDIT_HASH_ALGORITHM_VERSION = "sha256-jcs-v1";

/** The one head row. Pinned by a CHECK; a second row would be a second chain. */
const CHAIN_HEAD_ID = "global";

/** A `db` handle that may be a transaction. */
type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PlatformAuditEventKind = (typeof platformAuditEntry.$inferSelect)["eventKind"];

export interface PlatformAuditAppendInput {
  readonly eventKind: PlatformAuditEventKind;
  /** NEVER null. A platform action always has a human behind it. */
  readonly actorUserId: string;
  /** The role AT THE TIME, snapshotted — roles are revocable and a join would lie later. */
  readonly actorRoleSnapshot: string;
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly detailNote?: string | undefined;
  readonly payload: Readonly<Record<string, CanonicalValue>>;
  /** Event time, not write time. */
  readonly occurredAt: Date;
}

export interface PlatformAuditEntryRecord {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly entryHash: string;
  readonly previousEntryHash: string | null;
}

/**
 * The hashed field set, stated once and in a fixed order.
 *
 * Order here is documentation — JCS sorts keys — but the SET is the contract: adding a
 * field changes every hash computed after it, which is what `hashAlgorithmVersion` exists
 * to make visible. Excluded deliberately: `id` (a random UUID makes the chain
 * unreproducible from semantics) and `createdAt` (write time is not event time).
 */
function buildHashDocument(fields: {
  readonly sequenceNumber: number;
  readonly eventKind: string;
  readonly actorUserId: string;
  readonly actorRoleSnapshot: string;
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly detailNote: string;
  readonly payloadJson: string;
  readonly occurredAt: Date;
  readonly previousEntryHash: string | null;
  readonly hashAlgorithmVersion: string;
}): CanonicalValue {
  return {
    // `bigint`: canonicalize refuses plain numbers, because JCS's double serialization is
    // easy to get subtly wrong across platforms.
    sequenceNumber: BigInt(fields.sequenceNumber),
    eventKind: fields.eventKind,
    actorUserId: fields.actorUserId,
    actorRoleSnapshot: fields.actorRoleSnapshot,
    actionLabel: fields.actionLabel,
    targetLabel: fields.targetLabel,
    detailNote: fields.detailNote,
    payloadJson: fields.payloadJson,
    occurredAt: fields.occurredAt,
    previousEntryHash: fields.previousEntryHash,
    hashAlgorithmVersion: fields.hashAlgorithmVersion,
  };
}

/**
 * Locks the singleton head, creating it if migration 0025's seed row is somehow absent.
 *
 * `ON CONFLICT DO NOTHING` then re-select, rather than an upsert with `RETURNING`, for the
 * same reason the project chain does it: two transactions racing the very first append
 * must both end up holding the SAME locked row, and an upsert's RETURNING gives the loser
 * nothing while it proceeds unlocked.
 */
async function lockChainHead(tx: DatabaseExecutor): Promise<typeof platformChainHead.$inferSelect> {
  const [existing] = await tx
    .select()
    .from(platformChainHead)
    .where(eq(platformChainHead.id, CHAIN_HEAD_ID))
    .for("update");

  if (existing) return existing;

  await tx.insert(platformChainHead).values({ id: CHAIN_HEAD_ID }).onConflictDoNothing();

  const [created] = await tx
    .select()
    .from(platformChainHead)
    .where(eq(platformChainHead.id, CHAIN_HEAD_ID))
    .for("update");

  if (!created) {
    throw new Error("lockChainHead: the platform chain head could not be created");
  }
  return created;
}

/**
 * Appends one entry. MUST be called inside the transaction that performs the thing being
 * recorded — an audit row committed separately from its action can outlive a rollback.
 *
 * @throws if the insert or the head update fails. Never a `Result`: there is no domain
 *         outcome in which "the audit entry did not get written" is something a caller
 *         should handle and continue past.
 */
export async function appendPlatformAuditEntry(
  tx: DatabaseExecutor,
  input: PlatformAuditAppendInput,
): Promise<PlatformAuditEntryRecord> {
  const head = await lockChainHead(tx);

  const sequenceNumber = head.lastAuditSequenceNumber + 1;
  const previousEntryHash = head.headEntryHash;

  // Sequence 1 is genesis and has no predecessor; every later one must. The CHECK says the
  // same thing, but failing here names the caller rather than the constraint.
  if ((sequenceNumber === 1) !== (previousEntryHash === null)) {
    throw new Error(
      `appendPlatformAuditEntry: chain head is inconsistent — sequence ${String(sequenceNumber)} with ${previousEntryHash === null ? "no" : "a"} previous hash`,
    );
  }

  const payloadJson = canonicalizeDocument(input.payload);
  const detailNote = input.detailNote ?? "";

  const entryHash = canonicalHashHex(
    buildHashDocument({
      sequenceNumber,
      eventKind: input.eventKind,
      actorUserId: input.actorUserId,
      actorRoleSnapshot: input.actorRoleSnapshot,
      actionLabel: input.actionLabel,
      targetLabel: input.targetLabel,
      detailNote,
      payloadJson,
      occurredAt: input.occurredAt,
      previousEntryHash,
      hashAlgorithmVersion: PLATFORM_AUDIT_HASH_ALGORITHM_VERSION,
    }),
  );

  const [inserted] = await tx
    .insert(platformAuditEntry)
    .values({
      sequenceNumber,
      eventKind: input.eventKind,
      actorUserId: input.actorUserId,
      actorRoleSnapshot: input.actorRoleSnapshot,
      actionLabel: input.actionLabel,
      targetLabel: input.targetLabel,
      detailNote,
      payloadJson,
      occurredAt: input.occurredAt,
      previousEntryHash,
      entryHash,
      hashAlgorithmVersion: PLATFORM_AUDIT_HASH_ALGORITHM_VERSION,
    })
    .returning({ id: platformAuditEntry.id });

  if (!inserted) {
    throw new Error("appendPlatformAuditEntry: insert returned no row");
  }

  await tx
    .update(platformChainHead)
    .set({
      lastAuditSequenceNumber: sequenceNumber,
      headEntryHash: entryHash,
      headEntryId: inserted.id,
    })
    .where(eq(platformChainHead.id, CHAIN_HEAD_ID));

  return { id: inserted.id, sequenceNumber, entryHash, previousEntryHash };
}

/**
 * Runs a moderation write and its audit entry in ONE transaction.
 *
 * WHY A HELPER RATHER THAN `db.transaction` AT EACH CALL SITE. There are twenty of them
 * across five services, and every one had the same shape already — a single `db.insert` or
 * `db.update` with `.returning()`. Rewriting each into a bare transaction block would
 * duplicate the "append if the write matched a row" branch twenty times, and the one that
 * got it wrong would be a moderation action with no trail, which is the exact defect this
 * whole tranche exists to close.
 *
 * `describe` returns `null` when the write matched nothing — a lost race, an already-
 * decided row — because a decision that did not happen must not be recorded as one.
 */
export async function recordPlatformAction<T>(
  work: (tx: DatabaseExecutor) => Promise<T>,
  describe: (value: T) => PlatformAuditAppendInput | null,
): Promise<T> {
  return db.transaction(async (tx) => {
    const value = await work(tx);
    const entry = describe(value);
    if (entry !== null) {
      await appendPlatformAuditEntry(tx, entry);
    }
    return value;
  });
}

export interface PlatformAuditEntryView {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly eventKind: PlatformAuditEventKind;
  readonly actorUserId: string;
  readonly actorName: string | null;
  readonly actorRoleSnapshot: string;
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly detailNote: string;
  readonly occurredAt: Date;
  readonly entryHash: string;
  readonly previousEntryHash: string | null;
}

export interface PlatformAuditPage {
  readonly rows: readonly PlatformAuditEntryView[];
  readonly total: number;
  /** The next `fromSequence` to ask for, or null at the end. Keyset, never an offset. */
  readonly nextSequence: number | null;
}

export type PlatformAuditError =
  | PlatformAccessError
  | {
      type: "PLATFORM_CHAIN_BROKEN";
      sequenceNumber: number;
      reason: "sequence_gap" | "link_mismatch" | "hash_mismatch" | "head_mismatch";
    };

const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 200;

/**
 * `GET /admin/audit-trail` — the moderation log.
 *
 * CAPABILITY CHECKED BEFORE ANY ID IS READ, which is what keeps its `403` from being an
 * id oracle (§4a Layer 3) — the same ordering every `/discovery/admin/*` route uses.
 *
 * KEYSET BY SEQUENCE, not offset. The sequence is gapless and monotonic by construction,
 * so it is a better cursor than any timestamp, and an append-only log is precisely the
 * shape where OFFSET drifts under concurrent writes (§4c rule 4, §11l.2 item 4).
 */
export async function listPlatformAuditTrail(
  actorUserId: string,
  options: {
    readonly fromSequence?: number | undefined;
    readonly eventKind?: PlatformAuditEventKind | undefined;
    readonly limit?: number | undefined;
  } = {},
): Promise<Result<PlatformAuditPage, PlatformAuditError>> {
  const authorized = await requireModerationAudit(actorUserId);
  if (!authorized.success) return authorized;

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);

  const conditions = [];
  if (options.fromSequence !== undefined) {
    conditions.push(gte(platformAuditEntry.sequenceNumber, options.fromSequence));
  }
  if (options.eventKind !== undefined) {
    conditions.push(eq(platformAuditEntry.eventKind, options.eventKind));
  }
  const predicate = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: platformAuditEntry.id,
        sequenceNumber: platformAuditEntry.sequenceNumber,
        eventKind: platformAuditEntry.eventKind,
        actorUserId: platformAuditEntry.actorUserId,
        actorName: user.name,
        actorRoleSnapshot: platformAuditEntry.actorRoleSnapshot,
        actionLabel: platformAuditEntry.actionLabel,
        targetLabel: platformAuditEntry.targetLabel,
        detailNote: platformAuditEntry.detailNote,
        occurredAt: platformAuditEntry.occurredAt,
        entryHash: platformAuditEntry.entryHash,
        previousEntryHash: platformAuditEntry.previousEntryHash,
      })
      .from(platformAuditEntry)
      // LEFT, not inner: the FK is `restrict` so the actor cannot vanish, but a log that
      // silently drops rows when a join misses is not a log.
      .leftJoin(user, eq(user.id, platformAuditEntry.actorUserId))
      .where(predicate)
      // BY SEQUENCE, never by createdAt — the sequence IS the order the chain hashes in.
      .orderBy(asc(platformAuditEntry.sequenceNumber))
      .limit(limit + 1),
    db.select({ total: count() }).from(platformAuditEntry).where(predicate),
  ]);

  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      rows: pageRows,
      total: totalRow?.total ?? 0,
      nextSequence: hasMore && lastRow ? lastRow.sequenceNumber + 1 : null,
    },
  };
}

export interface PlatformChainVerificationSummary {
  readonly entriesChecked: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly headEntryHash: string | null;
}

/**
 * `GET /admin/audit-trail/verify` — re-walks the chain.
 *
 * A BREAK IS AN ERROR, NEVER `200 { valid: false }` — the rule §9's verifier already
 * follows. A 200 saying the audit log is broken is a response a monitoring system reads as
 * healthy, and this is the log that answers "who did that to the taxonomy".
 */
export async function verifyPlatformAuditChain(
  actorUserId: string,
): Promise<Result<PlatformChainVerificationSummary, PlatformAuditError>> {
  const authorized = await requireModerationAudit(actorUserId);
  if (!authorized.success) return authorized;

  const [entries, [head]] = await Promise.all([
    db.select().from(platformAuditEntry).orderBy(asc(platformAuditEntry.sequenceNumber)),
    db.select().from(platformChainHead).where(eq(platformChainHead.id, CHAIN_HEAD_ID)),
  ]);

  let expectedSequence = 1;
  let previousHash: string | null = null;

  for (const entry of entries) {
    if (entry.sequenceNumber !== expectedSequence) {
      return {
        success: false,
        error: {
          type: "PLATFORM_CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "sequence_gap",
        },
      };
    }
    if (entry.previousEntryHash !== previousHash) {
      return {
        success: false,
        error: {
          type: "PLATFORM_CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "link_mismatch",
        },
      };
    }

    const recomputed = canonicalHashHex(
      buildHashDocument({
        sequenceNumber: entry.sequenceNumber,
        eventKind: entry.eventKind,
        actorUserId: entry.actorUserId,
        actorRoleSnapshot: entry.actorRoleSnapshot,
        actionLabel: entry.actionLabel,
        targetLabel: entry.targetLabel,
        detailNote: entry.detailNote,
        payloadJson: entry.payloadJson,
        occurredAt: entry.occurredAt,
        previousEntryHash: entry.previousEntryHash,
        hashAlgorithmVersion: entry.hashAlgorithmVersion,
      }),
    );

    if (recomputed !== entry.entryHash) {
      return {
        success: false,
        error: {
          type: "PLATFORM_CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "hash_mismatch",
        },
      };
    }

    previousHash = entry.entryHash;
    expectedSequence += 1;
  }

  // The head must agree with the walk. A head pointing at a hash the entries do not end
  // with means someone rewrote the pointer, which the entry triggers cannot catch — the
  // head row is mutable by design.
  if ((head?.headEntryHash ?? null) !== previousHash) {
    return {
      success: false,
      error: {
        type: "PLATFORM_CHAIN_BROKEN",
        sequenceNumber: expectedSequence - 1,
        reason: "head_mismatch",
      },
    };
  }

  const firstEntry = entries.at(0);
  const lastEntry = entries.at(-1);

  return {
    success: true,
    value: {
      entriesChecked: entries.length,
      firstSequence: firstEntry?.sequenceNumber ?? null,
      lastSequence: lastEntry?.sequenceNumber ?? null,
      headEntryHash: head?.headEntryHash ?? null,
    },
  };
}

/**
 * Reading the moderation log is itself a moderator action, and `moderate_content` is the
 * capability that means "may see what moderators did". `audit_escrow` is deliberately NOT
 * accepted: an auditor's remit is money, and this log is taxonomy and directory decisions.
 */
const MODERATION_AUDIT_CAPABILITY: PlatformCapability = "moderate_content";

async function requireModerationAudit(
  actorUserId: string,
): Promise<Result<true, PlatformAccessError>> {
  const allowed = await requirePlatformCapability(actorUserId, MODERATION_AUDIT_CAPABILITY);
  return allowed.success ? { success: true, value: true } : allowed;
}

/** Exported for the constraint verifier, which walks a range rather than the whole log. */
export async function countPlatformAuditEntriesInRange(
  fromSequence: number,
  toSequence: number,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(platformAuditEntry)
    .where(
      and(
        gte(platformAuditEntry.sequenceNumber, fromSequence),
        lte(platformAuditEntry.sequenceNumber, toSequence),
      ),
    );
  return row?.total ?? 0;
}
