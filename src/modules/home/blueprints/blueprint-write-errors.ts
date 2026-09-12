import { readSqlStateCode } from "#src/lib/pg-errors.js";

/**
 * Re-throws a database fault from a blueprint write with the bound parameters stripped.
 *
 * ⚠️ THE WHOLE POINT IS WHAT IS *NOT* CARRIED. A `DrizzleQueryError`'s message is
 * ``Failed query: ${sql}\nparams: ${params}``, and `errorFields` copies `error.message` into
 * `errorMessage` — so ANY failed statement on these paths writes its bound parameters into the log
 * stream verbatim. `request-log.ts` is careful never to log a body; this routes around that care.
 * Fixing `errorFields` instead would change every other surface's diagnostics.
 *
 * ⚠️ THE ORIGINAL IS DELIBERATELY NOT ATTACHED AS `cause`. A logger that walks `cause` would undo
 * every word of this. The SQLSTATE is the diagnostically useful part and it is not personal, so it
 * is all that survives.
 *
 * `withheldReason` says WHAT was at risk, so the next reader of a log line can tell a deliberate
 * silence from a missing error.
 */
export function buildErrorWithoutQueryParameters(
  error: unknown,
  statementContext: string,
  withheldReason: string,
): Error {
  const sqlStateCode = readSqlStateCode(error);
  return new Error(
    `Blueprint write failed in ${statementContext}: SQLSTATE ${sqlStateCode ?? "unknown"}. Parameters withheld — ${withheldReason}.`,
  );
}
