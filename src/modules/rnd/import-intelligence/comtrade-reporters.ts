/**
 * ISO-3166 alpha-2 → UN M49 reporter code.
 *
 * WHY A TABLE AND NOT A LOOKUP. Comtrade publishes `Reporters.json`, and resolving a code
 * from it at job time would mean an extra network call, a cache, and a failure mode where
 * the ingest cannot start because a reference file is briefly unavailable. The eighteen
 * countries `discovery_region` seeds are a closed set that changes when somebody edits a
 * seed file, so the mapping is data in this repository and a new country is one line here
 * beside the one in `seed-data.ts`.
 *
 * `discovery_region.country_code` holds the ISO-2 and is the join key. Comtrade speaks
 * M49 and nothing else — 699 for India, not "IN" and not 356, which is India's PRE-1975
 * code and still resolvable in their reference data. Getting that wrong returns an empty
 * result set rather than an error, which is why the codes below were read from the live
 * reference file rather than from an ISO table.
 *
 * ⚠️ NOT EVERY SEEDED COUNTRY NAMES ITSELF THE SAME WAY. Comtrade calls Tanzania
 * "United Rep. of Tanzania" and Vietnam "Viet Nam", so matching on the seed's own label
 * would silently miss both. These are keyed on ISO-2 precisely to avoid that.
 */

/** The eighteen countries seeded in `src/db/seed-data.ts`, and nothing else. */
export const COMTRADE_REPORTER_CODE_BY_ISO2: Readonly<Record<string, number>> = {
  BD: 50, // Bangladesh
  BR: 76, // Brazil
  CO: 170, // Colombia
  ET: 231, // Ethiopia
  GH: 288, // Ghana
  ID: 360, // Indonesia
  IN: 699, // India — NOT 356, which expired in 1974
  KE: 404, // Kenya
  MX: 484, // Mexico
  NG: 566, // Nigeria
  NP: 524, // Nepal
  PE: 604, // Peru
  PH: 608, // Philippines
  PK: 586, // Pakistan
  SN: 686, // Senegal
  TZ: 834, // United Rep. of Tanzania
  UG: 800, // Uganda
  VN: 704, // Viet Nam
};

/**
 * Resolves a reporter code, or null when this country is not one the ingest can read.
 *
 * Null rather than a throw: a region row that has no Comtrade counterpart is a legitimate
 * state (every non-country region, for one), and the caller records a skipped sync run
 * rather than dead-lettering a job.
 */
export function comtradeReporterCodeFor(countryCodeIso2: string | null): number | null {
  if (countryCodeIso2 === null) {
    return null;
  }
  return COMTRADE_REPORTER_CODE_BY_ISO2[countryCodeIso2.toUpperCase()] ?? null;
}
