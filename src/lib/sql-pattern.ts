/**
 * Escaping for `LIKE` / `ILIKE` patterns.
 *
 * WHY THIS EXISTS. Drizzle parameterizes VALUES, which stops SQL injection — but a
 * parameterized `LIKE` pattern is still interpreted as a pattern. So a search box that
 * interpolates raw user text is not an injection hole, it is a WILDCARD hole: a lone `%`
 * matches every row, `_` matches any character, and both defeat the index the query was
 * written to use. On a paginated search that reads as "the search returns everything",
 * and on a large table as a full scan a client can request at will.
 *
 * ORDER IS LOAD-BEARING. Postgres's default escape character is `\`, so backslashes must
 * be doubled FIRST — escaping `%` and `_` first would then have their inserted
 * backslashes doubled, turning `\%` into `\\%`, which matches a literal backslash
 * followed by any run of characters rather than a literal percent sign.
 *
 * This escapes the pattern's CONTENTS. The caller adds its own `%` anchors around the
 * result, which is what keeps "contains", "starts with" and "exact" the caller's choice:
 *
 *   const pattern = `%${escapeLikePattern(searchText)}%`;   // contains
 *   const prefix  = `${escapeLikePattern(pathPrefix)}%`;    // starts with — subtree reads
 */
export function escapeLikePattern(rawText: string): string {
  return rawText.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
