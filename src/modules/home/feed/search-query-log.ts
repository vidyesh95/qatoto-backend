import { db } from "#src/db/index.js";
import { searchQueryLog } from "#src/db/schema.js";
import { utcDayStringOf, utcIsoWeekStringOf } from "#src/lib/utc-day.js";
import { computeSearchQueryFingerprint } from "#src/lib/viewer-fingerprint.js";

/**
 * The search log behind "Everyone is searching for" — what is kept, what never is, and how.
 *
 * ## What a row is
 *
 * `(day, normalized term, weekly searcher fingerprint)`. No user id, no IP, no User-Agent: the
 * fingerprint is a salted hash whose salt rotates every ISO week (`computeSearchQueryFingerprint`).
 * A repeat of the same search the same day is the same row.
 *
 * ## What is NEVER stored
 *
 * A search is not written at all — not redacted, not truncated — when after normalizing it is
 * shorter than 2 or longer than 80 characters, or when it contains an email address, a web
 * address, or seven or more digits in total (a phone number, an account or order id). People
 * search for themselves and for each other; a public "what everyone is searching for" line is the
 * last place such a string may surface, and a string never stored cannot surface.
 *
 * ## Only page 1
 *
 * Paging through results is not searching again, so the controller records page 1 only.
 */

/** A search shorter than this is noise; longer is a pasted paragraph, not a term. */
const MINIMUM_TERM_LENGTH = 2;
const MAXIMUM_TERM_LENGTH = 80;

/** Seven digits anywhere in the query: a phone number, however it is punctuated, or an id. */
const MINIMUM_DIGIT_COUNT_TO_DROP = 7;

const EMAIL_ADDRESS_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const WEB_ADDRESS_PATTERN = /(?:https?:|www\.|:\/\/)/;

/**
 * The query as it would be stored, or `null` when it must not be stored at all.
 *
 * NFKC first, so full-width and compatibility characters fold to one spelling before anything
 * compares them; then lowercase, and runs of whitespace collapse to one space.
 */
export function normalizeSearchTerm(rawQuery: string): string | null {
  const normalizedTerm = rawQuery.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedTerm.length < MINIMUM_TERM_LENGTH) return null;
  if (normalizedTerm.length > MAXIMUM_TERM_LENGTH) return null;
  if (EMAIL_ADDRESS_PATTERN.test(normalizedTerm)) return null;
  if (WEB_ADDRESS_PATTERN.test(normalizedTerm)) return null;
  const digitCount = normalizedTerm.replace(/\D/g, "").length;
  if (digitCount >= MINIMUM_DIGIT_COUNT_TO_DROP) return null;
  return normalizedTerm;
}

/**
 * Records one search, or nothing. Returns whether a term was eligible to be kept, which is what
 * the caller logs if the insert fails — never the term itself.
 *
 * `ON CONFLICT DO NOTHING`: the same person searching the same term twice in a day is one row, and
 * the key is what enforces it.
 */
export async function recordSearchQuery(input: {
  readonly rawQuery: string;
  readonly searchedAt: Date;
  readonly viewerUserId: string | null;
  readonly clientIp: string;
  readonly userAgent: string;
}): Promise<void> {
  const normalizedTerm = normalizeSearchTerm(input.rawQuery);
  if (normalizedTerm === null) return;

  await db
    .insert(searchQueryLog)
    .values({
      searchDay: utcDayStringOf(input.searchedAt),
      normalizedTerm,
      searcherFingerprint: computeSearchQueryFingerprint({
        utcIsoWeekString: utcIsoWeekStringOf(input.searchedAt),
        viewerUserId: input.viewerUserId,
        clientIp: input.clientIp,
        userAgent: input.userAgent,
      }),
    })
    .onConflictDoNothing();
}
