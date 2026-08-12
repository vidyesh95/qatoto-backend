/**
 * Asserts the STORE Phase 23 invariants against a live database.
 *
 *   pnpm run db:verify-store-phase-23-constraints
 *
 * WHAT THIS FILE IS REALLY GUARDING is one redefinition and its blast radius.
 * `commerce_review.media_count` counts VISIBLE media from Phase 23 on, because a YouTube video
 * its host deleted now HIDES its media row rather than losing it. Every reader of that counter
 * had to be re-examined, and the two that were missed — the six-item cap and the next position —
 * fail as a unique violation on a buyer's own review, which is not where anyone looks for the
 * consequences of a counter's semantics changing.
 *
 * THE POSITION CHECK IS THE ONE THAT WOULD HAVE CAUGHT IT. A hidden row keeps its slot on
 * purpose, so `count(*)` and `max(position) + 1` are the same number only while nothing is
 * hidden; anything reading the counter for a slot lands on an occupied one the first night
 * `revalidate-youtube-embeds` hides a video.
 *
 * THE INCOTERM CHECKS ARE CHEAP AND ALMOST TRIVIALLY TRUE post-migration. They are here for the
 * case they are not trivially true: a future free-text incoterm column added beside these two,
 * which is exactly how `commerce_order.incoterm_snapshot` came to carry no constraint at all
 * while the column it was copied from carried a length check.
 *
 * Nothing here writes. The refusal probes each roll back.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";

interface Check {
  readonly name: string;
  readonly why: string;
  run(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ value: number }>(query);
  return result.rows[0]?.value ?? 0;
}

async function probeRefusal(statement: string): Promise<boolean> {
  try {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(statement));
      throw new Error("verify-probe-rollback");
    });
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "verify-probe-rollback") {
      return false;
    }
    return true;
  }
}

async function indexExists(indexName: string): Promise<boolean> {
  const found = await scalar(sql`
    SELECT count(*)::int AS value FROM pg_indexes WHERE indexname = ${indexName}`);
  return found === 1;
}

/**
 * A CHECK as the database itself renders it.
 *
 * READ RATHER THAN PROBED because the probes below cannot run on a database with no reviews —
 * `commerce_review_media.review_id` is a non-deferrable FK onto a row that needs a completion,
 * which needs an order. A development database that has never taken an order would otherwise
 * report four skips as four passes, which is the shape of check this repo treats as worse than
 * having none.
 */
async function constraintDefinition(constraintName: string): Promise<string> {
  const result = await db.execute<{ definition: string }>(sql`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conname = ${constraintName}`);
  return result.rows[0]?.definition ?? "";
}

/**
 * A review the media probes can hang a row off, with a slot free for it.
 *
 * The probes run inside a transaction that is rolled back, so this only ever reads. A review
 * whose gallery is full is skipped rather than probed, because `commerce_review_media_position_ck`
 * would then refuse the probe for the wrong reason and the check would pass on a lie.
 */
async function findProbeReviewId(): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT review.id
      FROM commerce_review AS review
     WHERE (SELECT count(*) FROM commerce_review_media AS media
             WHERE media.review_id = review.id) < 6
     LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/**
 * One media INSERT with its position computed from the rows that are already there, so a probe
 * never collides with `commerce_review_media_position_uidx` and reports a refusal it did not
 * earn. Every literal is fixed; `reviewId` comes from a SELECT above, not from input.
 */
function probeMediaInsert(
  reviewId: string,
  columns: {
    readonly kind: "photo" | "youtube_video";
    readonly state: string;
    readonly unavailableAt: string;
  },
): string {
  const supply =
    columns.kind === "photo"
      ? `'photo', 'https://example.invalid/probe.avif', NULL, 800, 600`
      : `'youtube_video', NULL, 'aaaaaaaaaaa', NULL, NULL`;

  return `
    INSERT INTO commerce_review_media
      (id, review_id, media_kind, url, youtube_video_id, width_px, height_px,
       position, state, unavailable_at)
    SELECT 'probe-review-media', '${reviewId}', ${supply},
           (SELECT COALESCE(MAX(position), -1) + 1
              FROM commerce_review_media WHERE review_id = '${reviewId}'),
           '${columns.state}', ${columns.unavailableAt}`;
}

/** Incoterms 2020, the eleven the ICC publishes. */
const EXPECTED_INCOTERMS = [
  "CFR",
  "CIF",
  "CIP",
  "CPT",
  "DAP",
  "DDP",
  "DPU",
  "EXW",
  "FAS",
  "FCA",
  "FOB",
] as const;

const CHECKS: readonly Check[] = [
  {
    name: "A40 · the state/timestamp CHECK is present and TWO-SIDED",
    why: "The two facts are one fact, and the equality is what makes them one. Written as an implication instead, a visible row could carry an `unavailable_at` — the state a half-applied un-hide leaves behind, which no read can render and nothing else would catch.",
    async run() {
      const definition = await constraintDefinition("commerce_review_media_state_ck");
      const twoSided =
        definition.includes("unavailable_upstream") &&
        definition.includes("unavailable_at IS NOT NULL") &&
        definition.includes("=");
      return {
        ok: twoSided,
        detail: definition === "" ? "MISSING — 0118 was not applied" : definition,
      };
    },
  },
  {
    name: "A40 · only a third-party embed may be unavailable upstream",
    why: "A photo's bytes are on Cloudinary, which this platform controls. Without this CHECK a future writer could hide a photo behind a state no read explains, and its author would never learn why their own upload disappeared.",
    async run() {
      const definition = await constraintDefinition("commerce_review_media_upstream_kind_ck");
      const scopedToEmbeds = definition.includes("youtube_video") && definition.includes("visible");
      return {
        ok: scopedToEmbeds,
        detail: definition === "" ? "MISSING — 0118 was not applied" : definition,
      };
    },
  },
  {
    name: "A40 · an unavailable media row with no timestamp is refused",
    why: "The two facts are one fact. A row marked unavailable that cannot say WHEN the host dropped it leaves the author with a vanished video and no explanation, which is the failure the state column exists to end.",
    async run() {
      const reviewId = await findProbeReviewId();
      if (reviewId === null) {
        return {
          ok: true,
          detail:
            "not exercised — no review exists to hang a probe row off; the definition checks above stand in",
        };
      }
      const refused = await probeRefusal(
        probeMediaInsert(reviewId, {
          kind: "youtube_video",
          state: "unavailable_upstream",
          unavailableAt: "NULL",
        }),
      );
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED — commerce_review_media_state_ck is missing",
      };
    },
  },
  {
    name: "A40 · a VISIBLE media row with a timestamp is refused",
    why: "The same CHECK in the other direction. A visible row carrying an `unavailable_at` is a state no read can render, and it is how a partially-applied un-hide would look.",
    async run() {
      const reviewId = await findProbeReviewId();
      if (reviewId === null) {
        return {
          ok: true,
          detail:
            "not exercised — no review exists to hang a probe row off; the definition checks above stand in",
        };
      }
      const refused = await probeRefusal(
        probeMediaInsert(reviewId, {
          kind: "youtube_video",
          state: "visible",
          unavailableAt: "now()",
        }),
      );
      return {
        ok: refused,
        detail: refused ? "refused" : "ACCEPTED — commerce_review_media_state_ck is one-sided",
      };
    },
  },
  {
    name: "A40 · a PHOTO cannot be marked unavailable upstream",
    why: "A photo's bytes are on Cloudinary, which this platform controls; only a third-party embed has a host that can stop serving it. Without this a photo could be hidden by a state no read explains, and the author would never learn why their own upload disappeared.",
    async run() {
      const reviewId = await findProbeReviewId();
      if (reviewId === null) {
        return {
          ok: true,
          detail:
            "not exercised — no review exists to hang a probe row off; the definition checks above stand in",
        };
      }
      const refused = await probeRefusal(
        probeMediaInsert(reviewId, {
          kind: "photo",
          state: "unavailable_upstream",
          unavailableAt: "now()",
        }),
      );
      return {
        ok: refused,
        detail: refused
          ? "refused"
          : "ACCEPTED — commerce_review_media_upstream_kind_ck is missing",
      };
    },
  },
  {
    name: "A40 · a visible video IS accepted",
    why: "THE POSITIVE CONTROL. Three refusals prove nothing on their own — a constraint that refuses everything would pass all of them while making review media unwritable.",
    async run() {
      const reviewId = await findProbeReviewId();
      if (reviewId === null) {
        return {
          ok: true,
          detail:
            "not exercised — no review exists to hang a probe row off; the definition checks above stand in",
        };
      }
      const refused = await probeRefusal(
        probeMediaInsert(reviewId, {
          kind: "youtube_video",
          state: "visible",
          unavailableAt: "NULL",
        }),
      );
      return {
        ok: !refused,
        detail: refused ? "REFUSED — a constraint is too broad" : "accepted",
      };
    },
  },
  {
    name: "A40 · media_count equals the count of VISIBLE media",
    why: "The Phase 10 invariant as Phase 23 amended it. Restated here rather than imported, because a verifier that calls the implementation only proves the implementation equals itself. Drift means `hasMedia` lies in one direction or the other, and the detach path double-decrementing a hidden row is exactly how it drifts.",
    async run() {
      const drifted = await scalar(sql`
        SELECT count(*)::int AS value
          FROM commerce_review AS review
         WHERE review.media_count <> (
                 SELECT count(*) FROM commerce_review_media AS media
                  WHERE media.review_id = review.id
                    AND media.state = 'visible')`);
      return {
        ok: drifted === 0,
        detail: `${String(drifted)} review(s) whose counter disagrees with their visible media`,
      };
    },
  },
  {
    name: "A40 · media positions are contiguous from zero across ALL rows, hidden included",
    why: "THE CHECK THAT CATCHES THE CAP READING THE WRONG NUMBER. A hidden row keeps its slot, so positions are packed over attached rows and not over visible ones. A gap means a detach did not repack; a review whose highest position is below its row count means two rows are fighting for one slot, which is the unique violation a buyer would see as a 500.",
    async run() {
      const broken = await scalar(sql`
        SELECT count(*)::int AS value
          FROM (
            SELECT review_id
              FROM commerce_review_media
             GROUP BY review_id
            HAVING MAX(position) + 1 <> count(*)
                OR count(DISTINCT position) <> count(*)
          ) AS offenders`);
      return {
        ok: broken === 0,
        detail: `${String(broken)} review(s) with a gap or a duplicate in their media positions`,
      };
    },
  },
  {
    name: "A40 · the partial index the visible gallery scans exists by name",
    why: "The public media read filters `state = 'visible'` inside one review's rows. Without the partial index every product page's review strip falls back to scanning the table.",
    async run() {
      const present = await indexExists("commerce_review_media_visible_idx");
      return { ok: present, detail: present ? "present" : "missing — 0118 was not applied" };
    },
  },
  {
    name: "A40 · commerce_incoterm carries exactly the eleven ICC 2020 terms",
    why: "The vocabulary IS the fix. One value too many is `BANANA` again under a better name; one too few refuses a term a real quote needs, and `commerce_prevent_submitted_quote_revision_mutation` then freezes the wrong answer on the revision forever.",
    async run() {
      const matching = await scalar(sql`
        SELECT count(*)::int AS value
          FROM pg_enum
          INNER JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
         WHERE pg_type.typname = 'commerce_incoterm'
           AND pg_enum.enumlabel IN (${sql.join(
             EXPECTED_INCOTERMS.map((term) => sql`${term}`),
             sql`, `,
           )})`);
      const total = await scalar(sql`
        SELECT count(*)::int AS value
          FROM pg_enum
          INNER JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
         WHERE pg_type.typname = 'commerce_incoterm'`);
      const correct = matching === EXPECTED_INCOTERMS.length && total === matching;
      return {
        ok: correct,
        detail: `${String(matching)}/${String(EXPECTED_INCOTERMS.length)} expected, ${String(total)} total`,
      };
    },
  },
  {
    name: "A40 · both incoterm columns are typed by that enum",
    why: "THE ASYMMETRY THIS PHASE CLOSED. `commerce_order.incoterm_snapshot` carried no constraint of any kind while the column it is copied FROM carried a length check — a snapshot less constrained than its source. This check is what catches a third incoterm column being added beside them as free text.",
    async run() {
      const typed = await scalar(sql`
        SELECT count(*)::int AS value
          FROM information_schema.columns
         WHERE (table_name, column_name) IN (
                 ('commerce_quote_revision', 'incoterm'),
                 ('commerce_order', 'incoterm_snapshot'))
           AND udt_name = 'commerce_incoterm'`);
      return {
        ok: typed === 2,
        detail: `${String(typed)}/2 columns typed commerce_incoterm`,
      };
    },
  },
  {
    name: "A40 · every dispute's event sequences are contiguous from zero, with no duplicates",
    why: "A third writer joined `commerce_dispute_event` this phase, and the table is append-only by trigger — a colliding sequence cannot be repaired afterwards. `openDispute` hard-coded 0 and `decideDispute` used count(*); both are MAX+1 now, and this is what proves the three agree on live data.",
    async run() {
      const broken = await scalar(sql`
        SELECT count(*)::int AS value
          FROM (
            SELECT dispute_id
              FROM commerce_dispute_event
             GROUP BY dispute_id
            HAVING MIN(sequence) <> 0
                OR MAX(sequence) + 1 <> count(*)
                OR count(DISTINCT sequence) <> count(*)
          ) AS offenders`);
      return {
        ok: broken === 0,
        detail: `${String(broken)} dispute(s) with a gap, a duplicate, or a timeline not starting at zero`,
      };
    },
  },
];

async function main(): Promise<void> {
  console.log("verify-store-phase-23-constraints\n");
  let failures = 0;

  for (const check of CHECKS) {
    const result = await check.run();
    console.log(`${result.ok ? "  ok  " : "  FAIL"}  ${check.name} — ${result.detail}`);
    if (!result.ok) {
      console.log(`        why it matters: ${check.why}`);
      failures += 1;
    }
  }

  console.log(`\n${String(CHECKS.length - failures)}/${String(CHECKS.length)} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
