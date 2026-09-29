import { and, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { blueprintRightsClaim } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { buildErrorWithoutQueryParameters } from "#src/modules/home/blueprints/blueprint-write-errors.js";

/**
 * The daily rights-claim retention purge.
 *
 * ⚠️ SIX YEARS FROM RESOLUTION, NEVER FROM FILING, AND NEVER WHILE OPEN. A claim is kept as a legal
 * record (Art. 17(3)(e)) for as long as it could matter: six years covers the US patent damages
 * window (35 USC 286) and exceeds copyright's three (17 USC 507(b)). An open claim has no clock
 * running at all — it is purged only after somebody answers it and six years pass.
 *
 * WHAT GOES: the claimant's name, organisation, email, their account of their standing, the claim
 * text, and the moderator's resolution note (which may quote the claimant). WHAT STAYS: the ids,
 * the claim kind, the target and its title, the sworn/resolved/created instants, the status and
 * the resolver — the record that a claim existed and how it was answered.
 * `blueprint_rights_claim_purge_ck` refuses a row that is half of each.
 *
 * ⚠️ NO AUDIT ENTRY. The chain records STAFF action and `actorUserId` is NOT NULL; a retention
 * purge names nobody. This is housekeeping on a schedule the privacy policy states, not a decision.
 *
 * A PURE FUNCTION OF ITS PAYLOAD. The cutoff is derived from `asOf`, never from the clock.
 */
const RETENTION_YEARS_AFTER_RESOLUTION = 6;

/** Bounds one run's write. A backlog larger than this drains over several nights. */
const MAX_CLAIMS_PURGED_PER_BATCH = 500;
const MAX_BATCHES_PER_RUN = 20;

export interface RightsClaimRetentionSweepSummary {
  readonly claimsPurged: number;
  readonly batchesRun: number;
}

/** `asOf` minus six calendar years, in UTC. Leap days roll to 1 March, which only keeps data longer. */
export function computeRightsClaimRetentionCutoff(asOf: Date): Date {
  const cutoff = new Date(asOf.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS_AFTER_RESOLUTION);
  return cutoff;
}

export async function sweepExpiredRightsClaimDetails(
  asOf: Date,
): Promise<RightsClaimRetentionSweepSummary> {
  const cutoff = computeRightsClaimRetentionCutoff(asOf);
  let claimsPurged = 0;
  let batchesRun = 0;

  while (batchesRun < MAX_BATCHES_PER_RUN) {
    batchesRun += 1;

    let purgedRows: { id: string }[];
    try {
      purgedRows = await db
        .update(blueprintRightsClaim)
        .set({
          claimantFullName: null,
          claimantOrganizationName: null,
          claimantEmail: null,
          relationshipToRightsHolder: null,
          claimSubstance: null,
          resolutionNote: null,
          claimantDetailsPurgedAt: asOf,
        })
        .where(
          inArray(
            blueprintRightsClaim.id,
            db
              .select({ id: blueprintRightsClaim.id })
              .from(blueprintRightsClaim)
              .where(
                and(
                  // `status <> 'open'` AND a resolution instant: both, so a row can never be purged
                  // on one half of the rule. `resolution_ck` already ties them; this says it here too.
                  ne(blueprintRightsClaim.status, "open"),
                  isNotNull(blueprintRightsClaim.resolvedAt),
                  lte(blueprintRightsClaim.resolvedAt, cutoff),
                  isNull(blueprintRightsClaim.claimantDetailsPurgedAt),
                ),
              )
              .orderBy(blueprintRightsClaim.resolvedAt)
              .limit(MAX_CLAIMS_PURGED_PER_BATCH)
              // Two overlapping runs skip each other's rows rather than waiting on them.
              .for("update", { skipLocked: true }),
          ),
        )
        .returning({ id: blueprintRightsClaim.id });
    } catch (error: unknown) {
      throw buildErrorWithoutQueryParameters(
        error,
        "rights claim retention sweep",
        "the statement touches rows holding a rights claimant's name and email",
      );
    }

    claimsPurged += purgedRows.length;
    if (purgedRows.length < MAX_CLAIMS_PURGED_PER_BATCH) break;
  }

  return { claimsPurged, batchesRun };
}

export async function handleSweepExpiredRightsClaimDetails(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.sweepExpiredRightsClaimDetails,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.sweepExpiredRightsClaimDetails],
    rawPayload,
  );

  const summary = await sweepExpiredRightsClaimDetails(new Date(payload.asOf));

  // Counts only. A claim id is not personal, but there is nothing a log reader needs it for.
  logger.info("sweep-expired-rights-claim-details complete", {
    claimsPurged: summary.claimsPurged,
    batchesRun: summary.batchesRun,
  });
}
