/**
 * Self-reported funding outcomes on a pitch.
 *
 * ⚠️ NOTHING IN THIS FILE MOVES MONEY, AND NO RESPONSE BUILT ON IT MAY IMPLY THAT IT DID.
 * Qatoto operates no money rail: escrow left this codebase, there is no payment provider,
 * `PLATFORM_FEE_BASIS_POINTS` is 0. Two people transacted somewhere else and are telling
 * Qatoto about it afterwards. The words "collected", "paid", "held", "escrowed" and
 * "processed" are all wrong for this table; "reported" and "confirmed" are the true ones.
 *
 * IT TAKES TWO SIGNATURES. One party records, the counterparty confirms, and until both
 * exist the row is one person's claim about their own funding — which is exactly the thing
 * a founder would most like to publish through somebody else's voice. Every read carries
 * `isConfirmed` for that reason, and the frontend is required to render an unconfirmed row
 * as a claim rather than a fact.
 *
 * APPEND-ONLY, no status column, no edits. A correction is a new row. An attestation
 * somebody signed must not change under them — the same contract
 * `research_contribution_ledger_entry` and `compensation_payment_record` carry.
 */

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { pitch, pitchFundingOutcome, researchProject, user } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { RecordPitchOutcomeInput } from "#src/modules/rnd/pitches/pitches.schemas.js";
import type { Result } from "#src/types/index.js";

export type PitchOutcomeError =
  | { type: "PITCH_NOT_FOUND" }
  | { type: "OUTCOME_NOT_FOUND" }
  /** Only the founder or the named funder may record an outcome on a pitch. */
  | { type: "NOT_A_PARTY" }
  /** A pitch nobody could see cannot have produced funding. */
  | { type: "PITCH_NOT_PUBLIC"; status: string }
  | { type: "OUTCOME_ALREADY_CONFIRMED" }
  /** Two signatures from one person is one signature wearing a hat. */
  | { type: "CANNOT_CONFIRM_OWN_REPORT" }
  /**
   * The row names no Qatoto account for the funder, so no second party exists to sign it.
   * FOUND BY THE LIVE RUN: without this, such a row answered `NOT_A_PARTY` (a 404) to
   * everyone including both actual parties, which read as "no such record" when the truth is
   * "this record can never be confirmed, and will therefore never be public".
   */
  | { type: "OUTCOME_HAS_NO_COUNTERPARTY" }
  | { type: "FUNDER_NOT_FOUND" };

export interface PitchOutcomeView {
  readonly id: string;
  readonly pitchId: string;
  /** A DECIMAL STRING over a `bigint` column — `Number` would lose precision past 2^53. */
  readonly amountInCents: string;
  readonly currencyCode: string;
  readonly fundedOnDate: string;
  readonly funderUserId: string | null;
  readonly funderNameText: string;
  readonly note: string | null;
  readonly recordedByUserId: string;
  readonly recordedByName: string;
  readonly confirmedByUserId: string | null;
  readonly confirmedAt: Date | null;
  /**
   * DERIVED, never stored. The single field every renderer must branch on: an unconfirmed
   * outcome is one party's claim and may not be presented as a completed raise.
   */
  readonly isConfirmed: boolean;
  /**
   * DERIVED. False when no Qatoto account is named for the funder: there is nobody who could
   * countersign, so the row is a private note that will never appear on the public page.
   * A client that does not render this leaves a founder wondering why their record vanished.
   */
  readonly isConfirmable: boolean;
  readonly createdAt: Date;
}

type OutcomeRow = typeof pitchFundingOutcome.$inferSelect;

function toOutcomeView(row: OutcomeRow, recordedByName: string): PitchOutcomeView {
  return {
    id: row.id,
    pitchId: row.pitchId,
    amountInCents: row.amountInCents.toString(),
    currencyCode: row.currencyCode,
    fundedOnDate: row.fundedOnDate,
    funderUserId: row.funderUserId,
    funderNameText: row.funderNameText,
    note: row.note,
    recordedByUserId: row.recordedByUserId,
    recordedByName,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt,
    isConfirmed: row.confirmedAt !== null,
    isConfirmable: row.funderUserId !== null,
    createdAt: row.createdAt,
  };
}

/**
 * Records one outcome against a published pitch.
 *
 * WHO MAY RECORD: the project's founder, or the funder naming themselves. Both directions
 * are allowed because either party may be the one who bothers, and requiring it to be the
 * founder would let a founder alone decide what the public record of their raise says.
 *
 * THE PITCH MUST HAVE BEEN PUBLIC. A draft or rejected pitch never reached anyone, so an
 * outcome on one is either a mistake or an attempt to manufacture a track record.
 *
 * IDEMPOTENT on `(recordedByUserId, idempotencyKey)`: the insert is allowed to try and a
 * unique violation is translated into a replay, never check-then-insert.
 */
export async function recordPitchOutcome(input: {
  readonly pitchId: string;
  readonly callerUserId: string;
  readonly body: RecordPitchOutcomeInput;
}): Promise<
  Result<{ readonly outcome: PitchOutcomeView; readonly wasReplay: boolean }, PitchOutcomeError>
> {
  const [found] = await db
    .select({ status: pitch.status, founderUserId: researchProject.founderUserId })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .where(eq(pitch.id, input.pitchId));

  if (!found) return { success: false, error: { type: "PITCH_NOT_FOUND" } };
  if (found.status !== "published" && found.status !== "closed") {
    return { success: false, error: { type: "PITCH_NOT_PUBLIC", status: found.status } };
  }

  const isFounder = found.founderUserId === input.callerUserId;
  const isSelfNamedFunder = input.body.funderUserId === input.callerUserId;
  if (!isFounder && !isSelfNamedFunder) {
    return { success: false, error: { type: "NOT_A_PARTY" } };
  }

  if (input.body.funderUserId !== undefined) {
    const [funder] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, input.body.funderUserId));
    // Named but unknown: better a refusal than a row pointing at nobody, since the whole
    // value of the record is that a second person can confirm it.
    if (!funder) return { success: false, error: { type: "FUNDER_NOT_FOUND" } };
  }

  const [recorder] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, input.callerUserId));
  const recordedByName = recorder?.name ?? "";

  try {
    const [created] = await db
      .insert(pitchFundingOutcome)
      .values({
        pitchId: input.pitchId,
        amountInCents: Number(input.body.amountInCents),
        currencyCode: input.body.currencyCode,
        fundedOnDate: input.body.fundedOnDate,
        funderUserId: input.body.funderUserId ?? null,
        funderNameText: input.body.funderNameText,
        note: input.body.note ?? null,
        recordedByUserId: input.callerUserId,
        idempotencyKey: input.body.idempotencyKey,
      })
      .returning();
    if (!created) throw new Error("recordPitchOutcome: insert returned no row");
    return {
      success: true,
      value: { outcome: toOutcomeView(created, recordedByName), wasReplay: false },
    };
  } catch (insertError: unknown) {
    if (!isUniqueViolation(insertError)) throw insertError;

    const [existing] = await db
      .select()
      .from(pitchFundingOutcome)
      .where(
        and(
          eq(pitchFundingOutcome.recordedByUserId, input.callerUserId),
          eq(pitchFundingOutcome.idempotencyKey, input.body.idempotencyKey),
        ),
      );

    // A DIFFERENT unique index fired — re-throw rather than swallow it.
    if (!existing) throw insertError;
    return {
      success: true,
      value: { outcome: toOutcomeView(existing, recordedByName), wasReplay: true },
    };
  }
}

/**
 * The counterparty countersigns.
 *
 * WHO MAY CONFIRM: whichever of the two parties did not record it — the founder if a funder
 * recorded, the named funder if the founder recorded. Anyone else is `NOT_A_PARTY`, and the
 * person who wrote it is `CANNOT_CONFIRM_OWN_REPORT` rather than being quietly allowed.
 *
 * The DB carries the same rule in `pitch_funding_outcome_two_parties_ck`, because a check
 * that lives only in a service is one refactor away from not existing.
 */
export async function confirmPitchOutcome(input: {
  readonly outcomeId: string;
  readonly callerUserId: string;
}): Promise<Result<PitchOutcomeView, PitchOutcomeError>> {
  const [found] = await db
    .select({ row: pitchFundingOutcome, founderUserId: researchProject.founderUserId })
    .from(pitchFundingOutcome)
    .innerJoin(pitch, eq(pitch.id, pitchFundingOutcome.pitchId))
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .where(eq(pitchFundingOutcome.id, input.outcomeId));

  if (!found) return { success: false, error: { type: "OUTCOME_NOT_FOUND" } };
  if (found.row.confirmedAt !== null) {
    return { success: false, error: { type: "OUTCOME_ALREADY_CONFIRMED" } };
  }
  if (found.row.recordedByUserId === input.callerUserId) {
    return { success: false, error: { type: "CANNOT_CONFIRM_OWN_REPORT" } };
  }

  // A CONFIRMATION NEEDS SOMEBODY TO GIVE IT. When `funderUserId` is null the funder is a
  // stranger to this platform, so the row has exactly one party and no signature can ever be
  // added — say that, rather than answering 404 and implying the record does not exist.
  if (found.row.funderUserId === null) {
    return { success: false, error: { type: "OUTCOME_HAS_NO_COUNTERPARTY" } };
  }

  const isFounder = found.founderUserId === input.callerUserId;
  const isNamedFunder = found.row.funderUserId === input.callerUserId;
  if (!isFounder && !isNamedFunder) {
    return { success: false, error: { type: "NOT_A_PARTY" } };
  }

  const [updated] = await db
    .update(pitchFundingOutcome)
    .set({ confirmedByUserId: input.callerUserId, confirmedAt: new Date() })
    // The NULL guard is what makes a double confirm lose rather than overwrite the first
    // signature's timestamp.
    .where(
      and(eq(pitchFundingOutcome.id, input.outcomeId), isNull(pitchFundingOutcome.confirmedAt)),
    )
    .returning();

  if (!updated) return { success: false, error: { type: "OUTCOME_ALREADY_CONFIRMED" } };

  const [recorder] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, updated.recordedByUserId));

  return { success: true, value: toOutcomeView(updated, recorder?.name ?? "") };
}

/**
 * Outcomes on one pitch.
 *
 * THE PUBLIC READ RETURNS CONFIRMED ROWS ONLY. An unconfirmed outcome is one person's
 * unverified claim about money, and publishing it would let a founder announce a raise
 * through Qatoto with nobody agreeing. The parties see their own unconfirmed rows through
 * `includeUnconfirmed`, which the controller sets from the session — never from a query
 * parameter.
 */
export async function listPitchOutcomes(input: {
  readonly pitchId: string;
  readonly includeUnconfirmed: boolean;
}): Promise<readonly PitchOutcomeView[]> {
  const rows = await db
    .select({ row: pitchFundingOutcome, recordedByName: user.name })
    .from(pitchFundingOutcome)
    .innerJoin(user, eq(user.id, pitchFundingOutcome.recordedByUserId))
    .where(
      input.includeUnconfirmed
        ? eq(pitchFundingOutcome.pitchId, input.pitchId)
        : and(
            eq(pitchFundingOutcome.pitchId, input.pitchId),
            isNotNull(pitchFundingOutcome.confirmedAt),
          ),
    )
    .orderBy(desc(pitchFundingOutcome.createdAt), desc(pitchFundingOutcome.id));

  return rows.map((entry) => toOutcomeView(entry.row, entry.recordedByName));
}
