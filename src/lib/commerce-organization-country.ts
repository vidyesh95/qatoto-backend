/**
 * The country of an organization a query has already constrained to trading.
 *
 * Phase 21 made `commerce_organization.country_code` nullable so a buyer shell the server
 * auto-provisions can exist without the platform inventing a fact it does not have (§14,
 * Appendix A37). The nullability is bounded by `commerce_organization_country_pending_ck`:
 * only a `pending` row may lack one, and a row cannot reach `active` without it.
 *
 * Every public read — catalog, search, storefront, supplier directory, provider directory,
 * reviews — filters `trade_state = 'active'` before projecting, so none of them can observe
 * the NULL. Their wire contracts are correspondingly non-null, and widening them to
 * `string | null` would put an absence on the wire that the database forbids.
 *
 * This function is where that guarantee stops being implicit. It THROWS rather than
 * returning a `Result` because a null here is not an operational failure a caller could
 * handle — it means either the CHECK was dropped or the query lost its active filter, and
 * both are programmer errors of the kind §3.3 reserves `throw` for.
 *
 * DO NOT reach for this to silence a type error on a read that is not active-filtered. On
 * such a read the null is real and belongs in the projection.
 */
export function tradingOrganizationCountryCode(
  countryCode: string | null,
  subjectIdForDiagnostics: string,
): string {
  if (countryCode === null) {
    throw new Error(
      `Row ${subjectIdForDiagnostics} reached a trading projection with no organization country code. ` +
        "Either commerce_organization_country_pending_ck is missing or this query lost its trade_state = 'active' filter.",
    );
  }
  return countryCode;
}

/**
 * The row-shaped form of {@link tradingOrganizationCountryCode}, for the several public
 * reads that select a whole organization card and hand it straight to an enrichment step.
 *
 * The generic keeps every other column's type exactly as the query produced it, so this
 * narrows one field and asserts nothing else.
 */
export function withTradingOrganizationCountryCode<
  Row extends { readonly countryCode: string | null },
>(row: Row, subjectIdForDiagnostics: string): Omit<Row, "countryCode"> & { countryCode: string } {
  return {
    ...row,
    countryCode: tradingOrganizationCountryCode(row.countryCode, subjectIdForDiagnostics),
  };
}
