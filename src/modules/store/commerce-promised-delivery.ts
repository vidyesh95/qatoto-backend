/**
 * Promised-delivery derivation (Appendix A13 item 1).
 *
 * `onTimeShipmentRate` was hardcoded `null` on three public projections because nothing in
 * this schema recorded what the seller had committed to. This module is the whole of that
 * commitment's arithmetic, kept in one place because two order sources need it and must
 * not drift: direct checkout derives from
 * `commerce_checkout_prepare_product_line.leadTimeMaxDaysSnapshot`, and an accepted quote
 * derives from `commerce_quote_product_line.leadTimeDays`.
 *
 * THE PROMISE IS FIXED WHEN THE ORDER IS CREATED AND NEVER RECOMPUTED. A seller entering a
 * target date at ship time would be setting the bar after it already knew the outcome, and
 * the metric would grade itself. This is the same posture §0 takes on prices: the client
 * may display one, it may never establish one.
 */

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The moment a line was promised for, or null when the seller declared no lead time.
 *
 * NULL IS NOT ZERO DAYS. A line with no declared lead time carries no commitment and is
 * excluded from the on-time denominator entirely — reporting it as met or missed would be
 * inventing a measurement, which is the failure A13 was written to close rather than
 * relocate.
 *
 * Arithmetic is in UTC milliseconds because every timestamp in this database is UTC (see
 * the type parser in src/db/index.ts). Adding days by calendar field would introduce a
 * local-zone dependency into an immutable commercial fact.
 */
export function derivePromisedDeliveryAt(input: {
  readonly orderedAt: Date;
  readonly leadTimeMaxDays: number | null;
}): Date | null {
  if (input.leadTimeMaxDays === null) return null;
  if (!Number.isInteger(input.leadTimeMaxDays) || input.leadTimeMaxDays < 0) return null;
  return new Date(input.orderedAt.getTime() + input.leadTimeMaxDays * MILLISECONDS_PER_DAY);
}

/**
 * The order-level promise: the LATEST of its line promises.
 *
 * Latest rather than earliest, because the order is complete when its slowest line has
 * arrived. Taking the earliest would mark an order late the moment its quickest line
 * slipped, which is a different and less useful claim than the one the storefront makes.
 *
 * Returns null when no line carried a promise. A partially-declared order — some lines with
 * a lead time, some without — is promised by the lines that had one; that is a weaker
 * commitment than a fully-declared order, but it is a real one, and dropping it would let a
 * seller escape measurement by leaving one line's lead time blank.
 */
export function latestPromisedDeliveryAt(linePromises: readonly (Date | null)[]): Date | null {
  let latest: Date | null = null;
  for (const promise of linePromises) {
    if (promise === null) continue;
    if (latest === null || promise.getTime() > latest.getTime()) latest = promise;
  }
  return latest;
}
