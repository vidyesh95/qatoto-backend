import { createHash } from "node:crypto";

import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectAuditEntry, projectChainHead, user } from "#src/db/schema.js";
import {
  canonicalHashHex,
  canonicalizeDocument,
  type CanonicalValue,
} from "#src/lib/canonical-hash.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The tamper-evident audit chain (R_AND_D_BACKEND_STRUCTURE.md §9.9).
 *
 * EVERY ledger write, rate lock, dispute transition, consent change and bake appends here
 * IN THE SAME TRANSACTION as the thing it records. An audit trail that can lag the ledger
 * is worse than none: it produces a record that looks complete and is not, and nothing
 * downstream can tell the difference.
 *
 * APPENDING TAKES A LOCK. `SELECT … FROM project_chain_head WHERE project_id = $1 FOR
 * UPDATE` is what guarantees one writer per project, always. Two concurrent appends
 * without it either collide on the unique (project_id, sequence_number) — the lucky case,
 * because it fails loudly — or interleave their `previousEntryHash` reads and produce two
 * entries claiming the same predecessor, which verifies as a broken chain forever.
 *
 * THE ANTI-THEATRE PART, stated plainly because it is easy to oversell this. A server that
 * grades its own homework proves nothing. Three things make the chain independently
 * checkable: {@link buildHashInputDocument} returns the canonical bytes so any client can
 * SHA-256 them in five lines; the list read returns every hashed column so a client can
 * canonicalize WITHOUT trusting our bytes; and `project_chain_head.lastAnchoredHash` is
 * where a daily external anchor lands. Without that anchor, anyone with database write
 * access can recompute the whole chain from any point forward and every verification still
 * passes — a hash chain is tamper-evident AGAINST OUTSIDERS ONLY.
 */

/** Bumping this changes future hashes without invalidating history (§4c). */
export const AUDIT_HASH_ALGORITHM_VERSION = "sha256-jcs-v1";

export type ProjectAuditEventKind = (typeof projectAuditEntry.$inferSelect)["eventKind"];

/** A database handle that may be a transaction. Appends REQUIRE one. */
type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AuditAppendInput {
  readonly projectId: string;
  readonly eventKind: ProjectAuditEventKind;
  /** NULL for a system actor — the expiry sweep, a nightly recompute. */
  readonly actorUserId: string | null;
  /** The actor's project role at the time, e.g. "founder". A snapshot, never a join. */
  readonly actorRoleSnapshot: string;
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly detailNote?: string | undefined;
  /**
   * The event's own data. Serialized canonically and stored verbatim, so integers must
   * arrive as `bigint` and instants as `Date` — a float throws at canonicalization
   * rather than corrupting a hash silently.
   */
  readonly payload: Readonly<Record<string, CanonicalValue>>;
  /** When the EVENT happened. Not when the row was written; the two are different facts. */
  readonly occurredAt: Date;
}

export interface AuditEntryRecord {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly entryHash: string;
  readonly previousEntryHash: string | null;
}

/**
 * The pseudonym written into the hash, and the reason GDPR and this chain can coexist.
 *
 * §9.10: `actorNameSnapshot` is INSIDE the hash and can never be edited without breaking
 * the chain — so it must be pseudonymous AT WRITE TIME. A `user` row anonymizes later; a
 * legal name already hashed into 400 entries does not. Get this wrong at the first write
 * and the two become mutually exclusive with no migration path.
 *
 * Scoped to the project deliberately: the same person is a different label on a different
 * project, so an outsider holding one project's audit trail cannot correlate a member
 * across the platform. Deterministic within a project, so the trail still reads as one
 * consistent actor.
 */
export function pseudonymousActorLabel(projectId: string, actorUserId: string | null): string {
  if (actorUserId === null) {
    return "system";
  }
  const digest = createHash("sha256").update(`${projectId}:${actorUserId}`, "utf8").digest("hex");
  return `member-${digest.slice(0, 12)}`;
}

/**
 * The hashed document, in the FIXED DECLARED ORDER of §9.9.
 *
 * The key ORDER in this literal is documentation — RFC 8785 sorts keys itself — but the
 * key SET is the contract. Adding a field silently changes every hash computed afterwards,
 * which is what `hashAlgorithmVersion` exists to make visible.
 *
 * Deliberately EXCLUDED: `id` (a random UUID makes the chain unreproducible from
 * semantics), `createdAt` (write time is not event time), and every FK back-reference
 * (circular).
 */
function buildHashDocument(fields: {
  readonly projectId: string;
  readonly sequenceNumber: number;
  readonly eventKind: string;
  readonly actorUserId: string | null;
  readonly actorNameSnapshot: string;
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
    projectId: fields.projectId,
    // `bigint`: canonicalize refuses plain numbers outright, because JCS's double
    // serialization is easy to get subtly wrong across platforms.
    sequenceNumber: BigInt(fields.sequenceNumber),
    eventKind: fields.eventKind,
    actorUserId: fields.actorUserId,
    actorNameSnapshot: fields.actorNameSnapshot,
    actorRoleSnapshot: fields.actorRoleSnapshot,
    actionLabel: fields.actionLabel,
    targetLabel: fields.targetLabel,
    // '' and null are DIFFERENT DOCUMENTS and hash differently. The column defaults to ''
    // and this coalesce keeps a hand-written NULL from producing a second hash for the
    // same event.
    detailNote: fields.detailNote,
    payloadJson: fields.payloadJson,
    occurredAt: fields.occurredAt,
    previousEntryHash: fields.previousEntryHash,
    hashAlgorithmVersion: fields.hashAlgorithmVersion,
  };
}

/**
 * Locks the project's chain head and returns it, creating it on first use.
 *
 * The insert is `ON CONFLICT DO NOTHING` followed by a re-select rather than an upsert
 * with `RETURNING`, because two transactions racing the very first append must both end
 * up holding the SAME locked row — an upsert's RETURNING gives the loser nothing and it
 * would proceed unlocked.
 */
async function lockChainHead(
  tx: DatabaseExecutor,
  projectId: string,
): Promise<typeof projectChainHead.$inferSelect> {
  const [existing] = await tx
    .select()
    .from(projectChainHead)
    .where(eq(projectChainHead.projectId, projectId))
    .for("update");

  if (existing) {
    return existing;
  }

  await tx.insert(projectChainHead).values({ projectId }).onConflictDoNothing();

  const [created] = await tx
    .select()
    .from(projectChainHead)
    .where(eq(projectChainHead.projectId, projectId))
    .for("update");

  if (!created) {
    throw new Error(`lockChainHead: chain head for project ${projectId} could not be created`);
  }
  return created;
}

/**
 * Appends one entry to a project's chain. MUST be called inside a transaction that also
 * performs the thing being recorded.
 *
 * @throws if the insert or the head update fails — an unrecoverable fault. Never a
 *         `Result`: there is no domain outcome in which "the audit entry did not get
 *         written" is something a caller should handle and continue past.
 */
export async function appendAuditEntry(
  tx: DatabaseExecutor,
  input: AuditAppendInput,
): Promise<AuditEntryRecord> {
  const head = await lockChainHead(tx, input.projectId);

  const sequenceNumber = head.lastAuditSequenceNumber + 1;
  const previousEntryHash = head.headEntryHash;

  // Sequence 1 is the genesis entry and has no predecessor; every later one must. The
  // CHECK constraint says the same thing, but failing here names the caller.
  if ((sequenceNumber === 1) !== (previousEntryHash === null)) {
    throw new Error(
      `appendAuditEntry: chain head for ${input.projectId} is inconsistent — sequence ${sequenceNumber} with ${previousEntryHash === null ? "no" : "a"} previous hash`,
    );
  }

  const actorNameSnapshot = pseudonymousActorLabel(input.projectId, input.actorUserId);
  const payloadJson = canonicalizeDocument(input.payload);
  const detailNote = input.detailNote ?? "";

  const hashDocument = buildHashDocument({
    projectId: input.projectId,
    sequenceNumber,
    eventKind: input.eventKind,
    actorUserId: input.actorUserId,
    actorNameSnapshot,
    actorRoleSnapshot: input.actorRoleSnapshot,
    actionLabel: input.actionLabel,
    targetLabel: input.targetLabel,
    detailNote,
    payloadJson,
    occurredAt: input.occurredAt,
    previousEntryHash,
    hashAlgorithmVersion: AUDIT_HASH_ALGORITHM_VERSION,
  });
  const entryHash = canonicalHashHex(hashDocument);

  const [inserted] = await tx
    .insert(projectAuditEntry)
    .values({
      projectId: input.projectId,
      sequenceNumber,
      eventKind: input.eventKind,
      actorUserId: input.actorUserId,
      actorNameSnapshot,
      actorRoleSnapshot: input.actorRoleSnapshot,
      actionLabel: input.actionLabel,
      targetLabel: input.targetLabel,
      detailNote,
      payloadJson,
      occurredAt: input.occurredAt,
      previousEntryHash,
      entryHash,
      hashAlgorithmVersion: AUDIT_HASH_ALGORITHM_VERSION,
    })
    .returning({ id: projectAuditEntry.id });

  if (!inserted) {
    throw new Error("appendAuditEntry: insert returned no row");
  }

  await tx
    .update(projectChainHead)
    .set({
      lastAuditSequenceNumber: sequenceNumber,
      headEntryHash: entryHash,
      headEntryId: inserted.id,
    })
    .where(eq(projectChainHead.projectId, input.projectId));

  return { id: inserted.id, sequenceNumber, entryHash, previousEntryHash };
}

/**
 * Allocates the next LEDGER sequence number under the same lock.
 *
 * The ledger and the audit trail keep separate counters but share one lock, so a caller
 * writing both takes it once. Two locks taken in an order someone eventually gets
 * backwards is a deadlock waiting for load.
 */
export async function allocateLedgerSequenceNumber(
  tx: DatabaseExecutor,
  projectId: string,
): Promise<number> {
  const head = await lockChainHead(tx, projectId);
  const next = head.lastLedgerSequenceNumber + 1;

  await tx
    .update(projectChainHead)
    .set({ lastLedgerSequenceNumber: next })
    .where(eq(projectChainHead.projectId, projectId));

  return next;
}

export interface AuditEntryView {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly eventKind: ProjectAuditEventKind;
  /** The pseudonym that is INSIDE the hash. */
  readonly actorNameSnapshot: string;
  readonly actorRoleSnapshot: string;
  /**
   * Joined live from `user` for display. Deliberately NOT hashed and deliberately not
   * stored: it is a rendering, and it must stay editable when someone changes their name
   * or exercises erasure (§9.10).
   */
  readonly actorDisplayName: string | null;
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly detailNote: string;
  readonly payloadJson: string;
  readonly occurredAt: Date;
  readonly previousEntryHash: string | null;
  /** Full 64 hex characters, always. The 6-character form the UI shows is a rendering. */
  readonly entryHash: string;
  readonly hashAlgorithmVersion: string;
}

export interface ListAuditTrailOptions {
  readonly fromSequence?: number | undefined;
  readonly toSequence?: number | undefined;
  readonly limit?: number | undefined;
}

const DEFAULT_AUDIT_PAGE_SIZE = 50;
const MAXIMUM_AUDIT_PAGE_SIZE = 200;

/**
 * Reads a page of the chain, ordered by `sequenceNumber` ASC — never `createdAt`, because
 * two rows share a millisecond and replica clocks skew (§9.4).
 *
 * Returns every hashed column, so a client can canonicalize and verify WITHOUT trusting
 * this server's bytes.
 */
export async function listAuditTrail(
  projectId: string,
  options: ListAuditTrailOptions = {},
): Promise<readonly AuditEntryView[]> {
  const limit = Math.min(options.limit ?? DEFAULT_AUDIT_PAGE_SIZE, MAXIMUM_AUDIT_PAGE_SIZE);

  const filters = [eq(projectAuditEntry.projectId, projectId)];
  if (options.fromSequence !== undefined) {
    filters.push(gte(projectAuditEntry.sequenceNumber, options.fromSequence));
  }
  if (options.toSequence !== undefined) {
    filters.push(lte(projectAuditEntry.sequenceNumber, options.toSequence));
  }

  const rows = await db
    .select({
      id: projectAuditEntry.id,
      sequenceNumber: projectAuditEntry.sequenceNumber,
      eventKind: projectAuditEntry.eventKind,
      actorNameSnapshot: projectAuditEntry.actorNameSnapshot,
      actorRoleSnapshot: projectAuditEntry.actorRoleSnapshot,
      actorDisplayName: user.name,
      actionLabel: projectAuditEntry.actionLabel,
      targetLabel: projectAuditEntry.targetLabel,
      detailNote: projectAuditEntry.detailNote,
      payloadJson: projectAuditEntry.payloadJson,
      occurredAt: projectAuditEntry.occurredAt,
      previousEntryHash: projectAuditEntry.previousEntryHash,
      entryHash: projectAuditEntry.entryHash,
      hashAlgorithmVersion: projectAuditEntry.hashAlgorithmVersion,
    })
    .from(projectAuditEntry)
    .leftJoin(user, eq(user.id, projectAuditEntry.actorUserId))
    .where(and(...filters))
    .orderBy(asc(projectAuditEntry.sequenceNumber))
    .limit(limit);

  return rows;
}

export type AuditChainError =
  | ProjectAccessError
  | { type: "AUDIT_ENTRY_NOT_FOUND"; entryId: string }
  | {
      type: "CHAIN_BROKEN";
      sequenceNumber: number;
      reason: "hash-mismatch" | "link-mismatch" | "sequence-gap";
    };

export interface ChainVerificationSummary {
  readonly entriesChecked: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly headEntryHash: string | null;
  readonly lastAnchoredAt: Date | null;
}

/**
 * Re-walks the chain and checks THREE things per entry (§9.9): the hash recomputes from
 * its own columns, the link matches its predecessor, and `sequenceNumber` has no gap.
 *
 * The third check is the one that is easy to omit and impossible to do without: a DELETED
 * row leaves every surviving hash self-consistent, so a chain missing its middle verifies
 * perfectly unless someone counts.
 *
 * A break is a `Result` failure the controller renders as **409 CHAIN_BROKEN**, never
 * `200 {valid:false}` — a broken chain is an operational emergency and must page.
 */
export async function verifyAuditChain(
  projectId: string,
): Promise<Result<ChainVerificationSummary, AuditChainError>> {
  const rows = await db
    .select()
    .from(projectAuditEntry)
    .where(eq(projectAuditEntry.projectId, projectId))
    .orderBy(asc(projectAuditEntry.sequenceNumber));

  let expectedSequence = 1;
  let expectedPreviousHash: string | null = null;

  for (const entry of rows) {
    if (entry.sequenceNumber !== expectedSequence) {
      return {
        success: false,
        error: {
          type: "CHAIN_BROKEN",
          sequenceNumber: expectedSequence,
          reason: "sequence-gap",
        },
      };
    }

    if (entry.previousEntryHash !== expectedPreviousHash) {
      return {
        success: false,
        error: {
          type: "CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "link-mismatch",
        },
      };
    }

    const recomputed = canonicalHashHex(
      buildHashDocument({
        projectId: entry.projectId,
        sequenceNumber: entry.sequenceNumber,
        eventKind: entry.eventKind,
        actorUserId: entry.actorUserId,
        actorNameSnapshot: entry.actorNameSnapshot,
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
          type: "CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "hash-mismatch",
        },
      };
    }

    expectedPreviousHash = entry.entryHash;
    expectedSequence += 1;
  }

  const [head] = await db
    .select()
    .from(projectChainHead)
    .where(eq(projectChainHead.projectId, projectId));

  // The head must agree with what was just walked. A head pointing at a hash no entry
  // carries means a row was removed from the END, where the per-entry checks above see
  // nothing wrong at all.
  if ((head?.headEntryHash ?? null) !== expectedPreviousHash) {
    return {
      success: false,
      error: {
        type: "CHAIN_BROKEN",
        sequenceNumber: expectedSequence - 1,
        reason: "link-mismatch",
      },
    };
  }

  const firstEntry = rows[0];
  const lastEntry = rows.at(-1);

  return {
    success: true,
    value: {
      entriesChecked: rows.length,
      firstSequence: firstEntry?.sequenceNumber ?? null,
      lastSequence: lastEntry?.sequenceNumber ?? null,
      headEntryHash: head?.headEntryHash ?? null,
      lastAnchoredAt: head?.lastAnchoredAt ?? null,
    },
  };
}

export interface HashInputView {
  readonly entryId: string;
  readonly sequenceNumber: number;
  /**
   * The exact RFC 8785 bytes that were hashed. Five lines of `crypto.subtle`,
   * `MessageDigest` or `CryptoKit` reproduce `entryHash` from this string — which is the
   * whole point, because a server that grades its own homework proves nothing.
   */
  readonly canonicalBytes: string;
  readonly entryHash: string;
  readonly hashAlgorithmVersion: string;
}

/** `GET …/audit-trail/:entryId/hash-input` — the anti-theatre endpoint (§9.9). */
export async function buildHashInputDocument(
  projectId: string,
  entryId: string,
): Promise<Result<HashInputView, AuditChainError>> {
  const [entry] = await db
    .select()
    .from(projectAuditEntry)
    .where(
      // BOTH columns: an entry id belonging to another project must be indistinguishable
      // from a nonexistent one, or this becomes a cross-tenant probe.
      and(eq(projectAuditEntry.id, entryId), eq(projectAuditEntry.projectId, projectId)),
    );

  if (!entry) {
    return { success: false, error: { type: "AUDIT_ENTRY_NOT_FOUND", entryId } };
  }

  return {
    success: true,
    value: {
      entryId: entry.id,
      sequenceNumber: entry.sequenceNumber,
      canonicalBytes: canonicalizeDocument(
        buildHashDocument({
          projectId: entry.projectId,
          sequenceNumber: entry.sequenceNumber,
          eventKind: entry.eventKind,
          actorUserId: entry.actorUserId,
          actorNameSnapshot: entry.actorNameSnapshot,
          actorRoleSnapshot: entry.actorRoleSnapshot,
          actionLabel: entry.actionLabel,
          targetLabel: entry.targetLabel,
          detailNote: entry.detailNote,
          payloadJson: entry.payloadJson,
          occurredAt: entry.occurredAt,
          previousEntryHash: entry.previousEntryHash,
          hashAlgorithmVersion: entry.hashAlgorithmVersion,
        }),
      ),
      entryHash: entry.entryHash,
      hashAlgorithmVersion: entry.hashAlgorithmVersion,
    },
  };
}
