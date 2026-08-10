import { and, asc, eq, exists, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrganization,
  commerceOrganizationAddress,
  commerceOrganizationCapability,
  commerceOrganizationCertification,
  commerceOrganizationSiteAudit,
  commerceOrganizationVerification,
  commerceSellerProfile,
  storeSearchDocument,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import {
  loadOrganizationFulfillmentMetrics,
  type OrganizationFulfillmentMetrics,
} from "#src/services/commerce-trust-metrics.service.js";
import {
  loadSellerDeclaredProfiles,
  type OrganizationProductionLineProjection,
  type OrganizationSamplePolicyProjection,
  type OrganizationSiteProjection,
} from "#src/services/commerce-seller-profile.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The manufacturer directory (STORE_BACKEND_STRUCTURE.md §16, Appendix A32).
 *
 * A FACTORY IS A PROJECTION, NOT AN ENTITY. There is no `commerce_factory` table and there
 * must not be one: a manufacturer is a `commerce_organization` that sells physical goods
 * and has declared how it makes them, and Phase 12 already built the seller profile, the
 * capability list, the certifications and the photography this surface renders. A parallel
 * table set would give one organization two capability lists that can disagree, and the
 * disagreement is the bug — not the duplication.
 *
 * THE OTHER TEMPTATION, forbidden by `catalog.schemas.ts` before this file existed: do NOT
 * synthesise the directory by searching products and grouping by seller. That ranks a
 * manufacturer by whichever of its listings happened to match a keyword, which is not a
 * claim about the manufacturer at all.
 */

type CapabilityKind = (typeof commerceOrganizationCapability.$inferSelect)["capabilityKind"];
type StandardCode = NonNullable<
  (typeof commerceOrganizationCertification.$inferSelect)["standardCode"]
>;

/**
 * How far the platform has gone in checking this ORGANIZATION — never a capability.
 *
 * `site_audited` does not mean this factory is approved to do injection moulding, and
 * there is no per-capability approval anywhere on this wire. `documents_reviewed` means
 * somebody read the papers the factory uploaded; `site_audited` means somebody stood in
 * the building. Collapsing them would let a paper review carry the weight of an audit.
 */
export type FactoryVerificationState = "unverified" | "documents_reviewed" | "site_audited";

export interface FactoryCardProjection {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly logoUrl: string | null;
  readonly publicSummary: string | null;
  readonly capabilityKinds: readonly CapabilityKind[];
  readonly minimumOrderQuantity: number | null;
  readonly minimumOrderQuantityUnitLabel: string | null;
  readonly minimumLeadTimeDays: number | null;
  readonly maximumLeadTimeDays: number | null;
  /**
   * NAMES ONLY on the card, and only the eight filterable codes. Validity windows live on
   * the detail read: a card that shows a certification cannot tell you whether it has
   * lapsed, and must not imply that it has not.
   */
  readonly certifications: readonly StandardCode[];
  readonly verificationState: FactoryVerificationState;
  readonly acceptingInquiries: boolean;
  readonly fulfillmentMetrics: OrganizationFulfillmentMetrics;
}

/**
 * One certification with the window it is good for.
 *
 * `validUntil` is never null here — the column is NOT NULL — but the wire keeps it
 * nullable so a future "no expiry recorded" is expressible without a contract change.
 */
export interface FactoryCertificationRecordProjection {
  readonly certification: StandardCode;
  readonly certificateNumber: string | null;
  readonly issuingBody: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

/**
 * A certification the platform approved that has NO filterable code (§16.2, conflict 2).
 *
 * These carry the standards no enum will ever enumerate, and they render on the detail
 * page exactly as the coded ones do. They cannot appear in `certificationRecords[]`
 * because that member's `certification` is a closed enum — dropping them entirely instead
 * would mean an approved, valid certificate the platform silently refuses to show.
 */
export interface FactoryUncodedCertificationProjection {
  readonly standardName: string;
  readonly certificateNumber: string | null;
  readonly issuingBody: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface FactoryDetailProjection {
  readonly factory: FactoryCardProjection;
  readonly productionLines: readonly OrganizationProductionLineProjection[];
  readonly certificationRecords: readonly FactoryCertificationRecordProjection[];
  readonly otherCertifications: readonly FactoryUncodedCertificationProjection[];
  readonly sites: readonly OrganizationSiteProjection[];
  readonly samplePolicy: OrganizationSamplePolicyProjection;
  /** The date of the most recent recorded audit, or `null` when nobody has been. */
  readonly lastAuditedAt: string | null;
  /**
   * ISO country codes this factory HAS ACTUALLY SHIPPED TO — derived, not declared.
   *
   * Distinct delivery-address countries across this organization's COMPLETED orders. A13's
   * rule is that a derived stat and a declared stat must be visibly different on the wire,
   * and this one is derived, so nothing about it is seller-editable. An empty array is a
   * fact, not a gap: it means no completed order carried a delivery address, which is also
   * true of a factory whose orders all came from accepted quotes.
   */
  readonly exportMarkets: readonly string[];
}

export interface ListFactoriesInput {
  readonly capabilityKind?: CapabilityKind;
  readonly countryCode?: string;
  readonly certification?: StandardCode;
  readonly maxMinimumOrderQuantity?: number;
  readonly limit: number;
  readonly cursor?: string;
}

export interface FactoryDirectoryPage {
  readonly items: readonly FactoryCardProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export type StoreFactoriesError = { type: "NOT_FOUND" } | { type: "INVALID_CURSOR" };

/**
 * WHO IS IN THE DIRECTORY AT ALL.
 *
 * The eligibility half is `store_search_document`'s own rule, written once in
 * `refreshOrganizationSearchDocument` and kept fresh by the existing job:
 * `tradeState = 'active' AND visibility = 'public'`. Reimplementing it here would be a
 * third place for the same predicate to drift, which is the failure §15's "Still open"
 * note already records between `getCategoryFacets` and `/store/search`.
 *
 * The manufacturer half is `businessType`. A `trading_company` is a real seller and is not
 * a factory, and a directory that included one would be answering a different question
 * from the one its filters ask.
 */
const MANUFACTURER_BUSINESS_TYPES = ["manufacturer", "manufacturer_trading"] as const;

function directoryPredicate() {
  return and(
    eq(storeSearchDocument.documentKind, "organization"),
    eq(storeSearchDocument.isEligible, true),
    inArray(commerceSellerProfile.businessType, [...MANUFACTURER_BUSINESS_TYPES]),
  );
}

/**
 * Derives the organization-level verification state.
 *
 * ORDER IS THE WHOLE POINT. A recorded site audit outranks a document review, and a
 * document review NEVER produces `site_audited`. That collapse is the precise thing the
 * three-state enum exists to prevent, and it is why `commerce_organization_site_audit` was
 * built rather than the state being inferred from paperwork already on file.
 */
function deriveVerificationState(input: {
  readonly hasRecordedAudit: boolean;
  readonly hasApprovedVerification: boolean;
}): FactoryVerificationState {
  if (input.hasRecordedAudit) return "site_audited";
  if (input.hasApprovedVerification) return "documents_reviewed";
  return "unverified";
}

/** Organizations with at least one `recorded` audit, batched. */
async function loadAuditedOrganizationIds(
  organizationIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (organizationIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ organizationId: commerceOrganizationSiteAudit.organizationId })
    .from(commerceOrganizationSiteAudit)
    .where(
      and(
        inArray(commerceOrganizationSiteAudit.organizationId, [...organizationIds]),
        eq(commerceOrganizationSiteAudit.state, "recorded"),
      ),
    );
  return new Set(rows.map((row) => row.organizationId));
}

/** Organizations with at least one approved verification of any kind, batched. */
async function loadDocumentReviewedOrganizationIds(
  organizationIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (organizationIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ organizationId: commerceOrganizationVerification.organizationId })
    .from(commerceOrganizationVerification)
    .where(
      and(
        inArray(commerceOrganizationVerification.organizationId, [...organizationIds]),
        eq(commerceOrganizationVerification.state, "approved"),
      ),
    );
  return new Set(rows.map((row) => row.organizationId));
}

/**
 * The codes a card advertises: approved, still valid, and inside the closed eight.
 *
 * The expiry is evaluated by POSTGRES against `current_date`, never in JavaScript, for the
 * reason `commerce_certification_state` has no `expired` member: a lapse is a read-time
 * comparison, so it cannot go stale between the ticks of a job that does not exist.
 */
async function loadCardCertifications(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, StandardCode[]>> {
  const byOrganization = new Map<string, StandardCode[]>();
  if (organizationIds.length === 0) return byOrganization;

  const rows = await db
    .selectDistinct({
      organizationId: commerceOrganizationCertification.organizationId,
      standardCode: commerceOrganizationCertification.standardCode,
    })
    .from(commerceOrganizationCertification)
    .where(
      and(
        inArray(commerceOrganizationCertification.organizationId, [...organizationIds]),
        eq(commerceOrganizationCertification.state, "approved"),
        sql`${commerceOrganizationCertification.standardCode} IS NOT NULL`,
        sql`${commerceOrganizationCertification.validUntil} >= current_date`,
      ),
    )
    .orderBy(
      asc(commerceOrganizationCertification.organizationId),
      asc(commerceOrganizationCertification.standardCode),
    );

  for (const row of rows) {
    if (row.standardCode === null) continue;
    const existing = byOrganization.get(row.organizationId) ?? [];
    existing.push(row.standardCode);
    byOrganization.set(row.organizationId, existing);
  }
  return byOrganization;
}

/** The capability chips a card carries. Projected HERE and not only on the detail. */
async function loadCapabilityKinds(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, CapabilityKind[]>> {
  const byOrganization = new Map<string, CapabilityKind[]>();
  if (organizationIds.length === 0) return byOrganization;

  const rows = await db
    .select({
      organizationId: commerceOrganizationCapability.organizationId,
      capabilityKind: commerceOrganizationCapability.capabilityKind,
    })
    .from(commerceOrganizationCapability)
    .where(inArray(commerceOrganizationCapability.organizationId, [...organizationIds]))
    .orderBy(
      asc(commerceOrganizationCapability.organizationId),
      asc(commerceOrganizationCapability.position),
    );

  for (const row of rows) {
    const existing = byOrganization.get(row.organizationId) ?? [];
    existing.push(row.capabilityKind);
    byOrganization.set(row.organizationId, existing);
  }
  return byOrganization;
}

interface DirectoryRow {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly logoUrl: string | null;
  readonly publicSummary: string | null;
  readonly minimumOrderQuantity: number | null;
  readonly minimumOrderQuantityUnitLabel: string | null;
  readonly minimumLeadTimeDays: number | null;
  readonly maximumLeadTimeDays: number | null;
  readonly acceptingInquiries: boolean;
  readonly sortTitle: string;
  readonly documentId: string;
}

async function buildCards(rows: readonly DirectoryRow[]): Promise<FactoryCardProjection[]> {
  const organizationIds = rows.map((row) => row.organizationId);
  const [capabilities, certifications, audited, documentReviewed, metrics] = await Promise.all([
    loadCapabilityKinds(organizationIds),
    loadCardCertifications(organizationIds),
    loadAuditedOrganizationIds(organizationIds),
    loadDocumentReviewedOrganizationIds(organizationIds),
    loadOrganizationFulfillmentMetrics(organizationIds),
  ]);

  return rows.map((row) => ({
    organizationId: row.organizationId,
    slug: row.slug,
    displayName: row.displayName,
    countryCode: row.countryCode,
    logoUrl: row.logoUrl,
    publicSummary: row.publicSummary,
    capabilityKinds: capabilities.get(row.organizationId) ?? [],
    minimumOrderQuantity: row.minimumOrderQuantity,
    minimumOrderQuantityUnitLabel: row.minimumOrderQuantityUnitLabel,
    minimumLeadTimeDays: row.minimumLeadTimeDays,
    maximumLeadTimeDays: row.maximumLeadTimeDays,
    certifications: certifications.get(row.organizationId) ?? [],
    verificationState: deriveVerificationState({
      hasRecordedAudit: audited.has(row.organizationId),
      hasApprovedVerification: documentReviewed.has(row.organizationId),
    }),
    acceptingInquiries: row.acceptingInquiries,
    /**
     * EVERY MEASURED FIGURE IS NULLABLE AND NULL IS NOT ZERO. An unmeasured on-time rate
     * means the sample was too small, not that the factory ships late, which is why
     * `onTimeSampleSize` rides alongside it.
     */
    fulfillmentMetrics: metrics.get(row.organizationId) ?? {
      onTimeShipmentRate: null,
      onTimeSampleSize: 0,
      completedOrderCount: 0,
    },
  }));
}

/**
 * `GET /store/factories`.
 *
 * Keyset on `(title, entityId)`, the same shape `/store/search`'s title branch uses, so
 * paging is deterministic and cannot skip a row when a factory renames itself mid-scroll.
 *
 * `maxMinimumOrderQuantity` ADMITS NULL, and that is the A25 rule applied here: "show me
 * factories that will take an order this small" is satisfied by a factory that declared no
 * minimum at all. Excluding those would hide exactly the shops most likely to say yes.
 */
export async function listFactories(
  input: ListFactoriesInput,
): Promise<Result<FactoryDirectoryPage, StoreFactoriesError>> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters = [directoryPredicate()];

  if (input.countryCode !== undefined) {
    filters.push(eq(storeSearchDocument.organizationCountryCode, input.countryCode));
  }
  if (input.capabilityKind !== undefined) {
    const capabilityKind = input.capabilityKind;
    filters.push(
      exists(
        db
          .select({ present: sql`1` })
          .from(commerceOrganizationCapability)
          .where(
            and(
              eq(
                commerceOrganizationCapability.organizationId,
                storeSearchDocument.organizationId,
              ),
              eq(commerceOrganizationCapability.capabilityKind, capabilityKind),
            ),
          ),
      ),
    );
  }
  if (input.certification !== undefined) {
    const certification = input.certification;
    filters.push(
      exists(
        db
          .select({ present: sql`1` })
          .from(commerceOrganizationCertification)
          .where(
            and(
              eq(
                commerceOrganizationCertification.organizationId,
                storeSearchDocument.organizationId,
              ),
              eq(commerceOrganizationCertification.standardCode, certification),
              eq(commerceOrganizationCertification.state, "approved"),
              sql`${commerceOrganizationCertification.validUntil} >= current_date`,
            ),
          ),
      ),
    );
  }
  if (input.maxMinimumOrderQuantity !== undefined) {
    filters.push(
      or(
        isNull(commerceSellerProfile.minimumOrderQuantity),
        lte(commerceSellerProfile.minimumOrderQuantity, input.maxMinimumOrderQuantity),
      ),
    );
  }
  if (decodedCursor !== null) {
    filters.push(
      or(
        sql`${storeSearchDocument.title} > ${decodedCursor.sortKey}`,
        and(
          eq(storeSearchDocument.title, decodedCursor.sortKey),
          gt(storeSearchDocument.id, decodedCursor.id),
        ),
      ),
    );
  }

  const rows = await db
    .select({
      organizationId: storeSearchDocument.organizationId,
      slug: storeSearchDocument.organizationSlug,
      displayName: storeSearchDocument.organizationDisplayName,
      countryCode: storeSearchDocument.organizationCountryCode,
      logoUrl: commerceOrganization.logoUrl,
      publicSummary: commerceSellerProfile.publicSummary,
      minimumOrderQuantity: commerceSellerProfile.minimumOrderQuantity,
      minimumOrderQuantityUnitLabel: commerceSellerProfile.minimumOrderQuantityUnitLabel,
      minimumLeadTimeDays: commerceSellerProfile.minimumLeadTimeDays,
      maximumLeadTimeDays: commerceSellerProfile.maximumLeadTimeDays,
      acceptingInquiries: commerceSellerProfile.acceptingInquiries,
      sortTitle: storeSearchDocument.title,
      documentId: storeSearchDocument.id,
    })
    .from(storeSearchDocument)
    .innerJoin(
      commerceSellerProfile,
      eq(commerceSellerProfile.organizationId, storeSearchDocument.organizationId),
    )
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, storeSearchDocument.organizationId),
    )
    .where(and(...filters))
    .orderBy(asc(storeSearchDocument.title), asc(storeSearchDocument.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.sortTitle, id: lastRow.documentId })
      : null;

  return {
    success: true,
    value: { items: await buildCards(pageRows), page: { nextCursor, hasMore } },
  };
}

/**
 * Distinct destination countries across this organization's COMPLETED orders (§16.3).
 *
 * DERIVED, NEVER DECLARED. The join runs through `commerce_order.deliveryAddressId`, which
 * is nullable — a quote-originated order has no checkout prepare and therefore no address
 * pointer — so those orders simply do not contribute. `countryCode` is plaintext on the
 * address row; the street lines are encrypted and are not read here.
 */
async function loadExportMarkets(organizationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ countryCode: commerceOrganizationAddress.countryCode })
    .from(commerceOrder)
    .innerJoin(
      commerceOrganizationAddress,
      eq(commerceOrganizationAddress.id, commerceOrder.deliveryAddressId),
    )
    .where(
      and(
        eq(commerceOrder.counterpartyOrganizationId, organizationId),
        sql`${commerceOrder.completedAt} IS NOT NULL`,
      ),
    )
    .orderBy(asc(commerceOrganizationAddress.countryCode));
  return rows.map((row) => row.countryCode);
}

/** `GET /store/factories/:factorySlug`. A slug outside the directory predicate is a 404. */
export async function getFactoryBySlug(
  factorySlug: string,
): Promise<Result<FactoryDetailProjection, StoreFactoriesError>> {
  const [row] = await db
    .select({
      organizationId: storeSearchDocument.organizationId,
      slug: storeSearchDocument.organizationSlug,
      displayName: storeSearchDocument.organizationDisplayName,
      countryCode: storeSearchDocument.organizationCountryCode,
      logoUrl: commerceOrganization.logoUrl,
      publicSummary: commerceSellerProfile.publicSummary,
      minimumOrderQuantity: commerceSellerProfile.minimumOrderQuantity,
      minimumOrderQuantityUnitLabel: commerceSellerProfile.minimumOrderQuantityUnitLabel,
      minimumLeadTimeDays: commerceSellerProfile.minimumLeadTimeDays,
      maximumLeadTimeDays: commerceSellerProfile.maximumLeadTimeDays,
      acceptingInquiries: commerceSellerProfile.acceptingInquiries,
      sortTitle: storeSearchDocument.title,
      documentId: storeSearchDocument.id,
    })
    .from(storeSearchDocument)
    .innerJoin(
      commerceSellerProfile,
      eq(commerceSellerProfile.organizationId, storeSearchDocument.organizationId),
    )
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, storeSearchDocument.organizationId),
    )
    .where(and(directoryPredicate(), eq(storeSearchDocument.organizationSlug, factorySlug)))
    .limit(1);

  if (!row) return { success: false, error: { type: "NOT_FOUND" } };

  const [cards, declaredProfiles, certificationRows, auditRows, exportMarkets] = await Promise.all([
    buildCards([row]),
    loadSellerDeclaredProfiles([row.organizationId]),
    db
      .select()
      .from(commerceOrganizationCertification)
      .where(
        and(
          eq(commerceOrganizationCertification.organizationId, row.organizationId),
          eq(commerceOrganizationCertification.state, "approved"),
          sql`${commerceOrganizationCertification.validUntil} >= current_date`,
        ),
      )
      .orderBy(asc(commerceOrganizationCertification.standardName)),
    db
      .select({ auditedAt: commerceOrganizationSiteAudit.auditedAt })
      .from(commerceOrganizationSiteAudit)
      .where(
        and(
          eq(commerceOrganizationSiteAudit.organizationId, row.organizationId),
          eq(commerceOrganizationSiteAudit.state, "recorded"),
        ),
      )
      .orderBy(sql`${commerceOrganizationSiteAudit.auditedAt} DESC`)
      .limit(1),
    loadExportMarkets(row.organizationId),
  ]);

  const card = cards[0];
  if (!card) throw new Error("Factory card projection vanished after its own row was read.");
  const declared = declaredProfiles.get(row.organizationId);

  const certificationRecords: FactoryCertificationRecordProjection[] = [];
  const otherCertifications: FactoryUncodedCertificationProjection[] = [];
  for (const certification of certificationRows) {
    if (certification.standardCode === null) {
      otherCertifications.push({
        standardName: certification.standardName,
        certificateNumber: certification.certificateNumber,
        issuingBody: certification.issuerName,
        validFrom: certification.validFrom,
        validUntil: certification.validUntil,
      });
      continue;
    }
    certificationRecords.push({
      certification: certification.standardCode,
      certificateNumber: certification.certificateNumber,
      issuingBody: certification.issuerName,
      validFrom: certification.validFrom,
      validUntil: certification.validUntil,
    });
  }

  return {
    success: true,
    value: {
      factory: card,
      productionLines: declared?.productionLines ?? [],
      certificationRecords,
      otherCertifications,
      sites: declared?.sites ?? [],
      samplePolicy: declared?.samplePolicy ?? {
        offersSamples: false,
        sampleLeadTimeDays: null,
        sampleFeeInCents: null,
        currency: "USD",
      },
      lastAuditedAt: auditRows[0]?.auditedAt ?? null,
      exportMarkets,
    },
  };
}

/**
 * Resolves a public factory slug to the organization behind it, for the inquiry write.
 *
 * SAME PREDICATE AS THE DIRECTORY, deliberately: a buyer cannot open an inquiry against an
 * organization it could not have found, and a suspended factory's slug 404s here exactly
 * as it does on the detail read rather than accepting a message nobody will answer.
 */
export async function resolveFactoryForInquiry(
  factorySlug: string,
): Promise<Result<{ organizationId: string; acceptingInquiries: boolean }, StoreFactoriesError>> {
  const [row] = await db
    .select({
      organizationId: storeSearchDocument.organizationId,
      acceptingInquiries: commerceSellerProfile.acceptingInquiries,
    })
    .from(storeSearchDocument)
    .innerJoin(
      commerceSellerProfile,
      eq(commerceSellerProfile.organizationId, storeSearchDocument.organizationId),
    )
    .where(and(directoryPredicate(), eq(storeSearchDocument.organizationSlug, factorySlug)))
    .limit(1);

  if (!row) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: row };
}
