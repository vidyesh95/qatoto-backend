import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { reconciliationDiscrepancy, researchProject } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import {
  appendJournalEntry,
  deriveAccountBalances,
  ESCROW_ACCOUNT_KINDS,
  type EscrowAccountKind,
} from "#src/modules/rnd/funding/escrow.service.js";

/**
 * Provider ↔ ledger reconciliation (R_AND_D_BACKEND_STRUCTURE.md §7, §4e). Hourly.
 *
 * WHEN THE PROVIDER AND THE LEDGER DISAGREE, THE LEDGER IS NOT SILENTLY PATCHED. This job
 * writes a `reconciliation_discrepancy` row, posts the delta into
 * `reconciliation_suspense` — preserving the zero-sum invariant — and alarms. The provider
 * is authoritative for CASH; the ledger is authoritative for ENTITLEMENT; the suspense
 * account is where the two are allowed to differ, in public.
 *
 * ---------------------------------------------------------------------------
 * **THE HONEST CAVEAT, and it is the whole reason this file leads with it (Appendix A3).**
 *
 * There is no adapter that moves real cash, so there is no external source of truth to
 * reconcile against. `readProviderBalances` returns the ledger's own figures, every delta
 * is zero, and the discrepancy count is trivially zero. **Do not read that as evidence the
 * books are right.** It means the comparison has nothing to compare.
 *
 * What this job DOES do today, and it is not nothing: it re-derives every balance from the
 * postings and asserts the ZERO-SUM IDENTITY across all six accounts. That check is real,
 * it runs hourly, and it is the aggregate form of the per-entry invariant the deferred
 * constraint trigger enforces one entry at a time. A drift there would mean a posting was
 * written outside `escrow.service.ts`, which is the failure this domain is built to make
 * impossible.
 * ---------------------------------------------------------------------------
 *
 * `asOf` comes from the payload, never from a clock read here (§4c rule 3), so an operator
 * can replay any historical run and get the historical result. Idempotent on
 * `(projectId, accountKind, asOf)`.
 */

/**
 * What the payment provider says it holds.
 *
 * THE SEAM, and deliberately the dullest function in the file. Against Stripe this is a
 * balance API call per connected account; against the internal adapter there is no
 * external system, so it echoes the ledger and every delta is zero by construction.
 *
 * Returning the ledger's own numbers rather than throwing "not configured" is the correct
 * shape: the reconciliation pipeline — the comparison, the discrepancy row, the suspense
 * posting, the alarm — is EXERCISED every hour today, so switching Appendix A3 on changes
 * this function and nothing downstream of it.
 */
async function readProviderBalances(
  projectId: string,
): Promise<ReadonlyMap<EscrowAccountKind, bigint>> {
  const ledgerBalances = await deriveAccountBalances(projectId);
  return new Map(
    ESCROW_ACCOUNT_KINDS.map((kind) => [kind, ledgerBalances.get(kind)?.settledInCents ?? 0n]),
  );
}

export interface ReconciliationOutcome {
  readonly projectsChecked: number;
  readonly discrepanciesOpened: number;
  /** FALSE means a posting exists that `escrow.service.ts` did not write. Pages. */
  readonly zeroSumHolds: boolean;
  readonly offendingProjectIds: readonly string[];
}

async function reconcileProject(
  projectId: string,
  asOf: Date,
): Promise<{ readonly discrepancies: number; readonly zeroSumHolds: boolean }> {
  const [ledgerBalances, providerBalances] = await Promise.all([
    deriveAccountBalances(projectId),
    readProviderBalances(projectId),
  ]);

  // THE AGGREGATE ZERO-SUM IDENTITY. Every entry sums to zero, so the sum of all six
  // account balances must too. A non-zero total means a posting was written by something
  // other than `appendJournalEntry` — a hand-run SQL statement, a bad migration, a bug.
  const projectTotal = ESCROW_ACCOUNT_KINDS.reduce(
    (runningTotal, kind) => runningTotal + (ledgerBalances.get(kind)?.settledInCents ?? 0n),
    0n,
  );
  const zeroSumHolds = projectTotal === 0n;

  let discrepancies = 0;

  for (const kind of ESCROW_ACCOUNT_KINDS) {
    const ledgerBalanceInCents = ledgerBalances.get(kind)?.settledInCents ?? 0n;
    const providerBalanceInCents = providerBalances.get(kind) ?? 0n;
    const deltaInCents = providerBalanceInCents - ledgerBalanceInCents;

    if (deltaInCents === 0n) {
      continue;
    }

    // Already recorded for this exact (project, account, asOf)? Then this is a re-run and
    // it must write nothing (§4e).
    const [alreadyRecorded] = await db
      .select({ id: reconciliationDiscrepancy.id })
      .from(reconciliationDiscrepancy)
      .where(
        and(
          eq(reconciliationDiscrepancy.projectId, projectId),
          eq(reconciliationDiscrepancy.accountKind, kind),
          eq(reconciliationDiscrepancy.asOf, asOf),
        ),
      );

    if (alreadyRecorded) {
      continue;
    }

    await db.transaction(async (tx) => {
      // THE SUSPENSE POSTING. The delta lands in `reconciliation_suspense` against the
      // account that disagreed, so the books still balance while the discrepancy stays
      // VISIBLE. Patching the disagreeing account directly would make the numbers agree
      // and destroy the evidence that they ever did not.
      const entry = await appendJournalEntry(tx, {
        projectId,
        currency: "USD",
        kind: "reconciliation_adjustment",
        description: `Reconciliation — ${kind} differs from the provider by ${deltaInCents.toString()} cents`,
        settlement: "settled",
        occurredAt: asOf,
        postings: [
          { accountKind: kind, signedAmountInCents: deltaInCents },
          { accountKind: "reconciliation_suspense", signedAmountInCents: -deltaInCents },
        ],
        // NULL actor: this is the system, and §9's chain spells that `null` rather than
        // inventing a service account nobody can be held to.
        createdByUserId: null,
        auditEventKind: "reconciliation_discrepancy_opened",
        actorRoleSnapshot: "system",
        auditActionLabel: "Opened a reconciliation discrepancy",
        auditTargetLabel: `account ${kind}`,
        auditDetailNote: `Ledger ${ledgerBalanceInCents.toString()}, provider ${providerBalanceInCents.toString()}.`,
      });

      await tx
        .insert(reconciliationDiscrepancy)
        .values({
          projectId,
          accountKind: kind,
          asOf,
          ledgerBalanceInCents,
          providerBalanceInCents,
          deltaInCents,
          status: "open",
          journalEntryId: entry.id,
        })
        .onConflictDoNothing();
    });

    discrepancies += 1;
  }

  return { discrepancies, zeroSumHolds };
}

export async function handleReconcileEscrowLedger(
  rawPayload: unknown,
): Promise<ReconciliationOutcome> {
  const payload = parseJobPayload(
    JOB_NAMES.reconcileEscrowLedger,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.reconcileEscrowLedger],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);

  const projectIds =
    payload.projectId === null
      ? (
          await db
            .select({ id: researchProject.id })
            .from(researchProject)
            // §4c rule 4: a stable, unique ordering, so a partial run and a full run visit
            // projects in the same sequence.
            .orderBy(researchProject.id)
        ).map((row) => row.id)
      : [payload.projectId];

  let discrepanciesOpened = 0;
  const offendingProjectIds: string[] = [];

  for (const projectId of projectIds) {
    const outcome = await reconcileProject(projectId, asOf);
    discrepanciesOpened += outcome.discrepancies;
    if (!outcome.zeroSumHolds) {
      offendingProjectIds.push(projectId);
    }
  }

  if (offendingProjectIds.length > 0) {
    // ALARM. §7 says reconciliation "alarms" rather than patching, and this is the shape
    // that alarm takes with no pager wired up: a loud, greppable line naming every project
    // whose books do not balance. A silent counter would be worse than nothing.
    console.error(
      `reconcile-escrow-ledger: ZERO-SUM VIOLATION on ${offendingProjectIds.length} project(s): ${offendingProjectIds.join(", ")}. ` +
        "A posting exists that escrow.service.ts did not write. Do not trust any escrow figure on these projects.",
    );
  }

  return {
    projectsChecked: projectIds.length,
    discrepanciesOpened,
    zeroSumHolds: offendingProjectIds.length === 0,
    offendingProjectIds,
  };
}
