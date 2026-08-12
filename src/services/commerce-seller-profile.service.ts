import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceOrganization,
  commerceOrganizationCapability,
  commerceOrganizationCertification,
  commerceOrganizationMedia,
  commerceOrganizationMember,
  commerceOrganizationProductionLine,
  commerceOrganizationSite,
  commerceOrganizationSiteAccess,
  commerceOrganizationSiteAudit,
  commerceOrganizationSiteAuditSite,
  commerceOrganizationStakeholder,
  commerceSellerProfile,
} from "#src/db/schema.js";
import {
  deleteOrganizationMedia,
  deleteOrganizationStakeholderPhoto,
  uploadOrganizationMedia,
  uploadOrganizationStakeholderPhoto,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { encryptCommerceDocument } from "#src/lib/commerce-document-encryption.js";
import { encryptCommercePii } from "#src/lib/commerce-pii-encryption.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import {
  deletePrivateCommerceDocument,
  uploadPrivateCommerceDocument,
} from "#src/lib/object-storage.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import { scheduleDocumentScan } from "#src/services/commerce-document-scan.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { Result } from "#src/types/index.js";

type MemberRole = (typeof commerceOrganizationMember.$inferSelect)["role"];
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SellerProfileRow = typeof commerceSellerProfile.$inferSelect;
type MediaRow = typeof commerceOrganizationMedia.$inferSelect;
type SiteAccessRow = typeof commerceOrganizationSiteAccess.$inferSelect;
type StakeholderRow = typeof commerceOrganizationStakeholder.$inferSelect;
type CapabilityRow = typeof commerceOrganizationCapability.$inferSelect;
type CertificationRow = typeof commerceOrganizationCertification.$inferSelect;
type ProductionLineRow = typeof commerceOrganizationProductionLine.$inferSelect;
type SiteRow = typeof commerceOrganizationSite.$inferSelect;
type SiteAuditRow = typeof commerceOrganizationSiteAudit.$inferSelect;

export type CommerceSellerProfileError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED" }
  | { type: "CONFLICT"; message: string }
  /** A13. Its own tag so a client can branch, exactly as A15's address limit does. */
  | { type: "MEDIA_LIMIT_REACHED"; limit: number }
  | { type: "IMAGE_REJECTED"; imageError: ImageValidationError }
  | { type: "IMAGE_STORAGE_FAILED"; storageError: CloudinaryError }
  | { type: "EVIDENCE_ENCRYPTION_UNAVAILABLE" }
  | { type: "EVIDENCE_STORAGE_NOT_CONFIGURED" }
  | { type: "EVIDENCE_STORAGE_FAILED" }
  /** A moderator cannot decide a certification they submitted themselves (§11). */
  | { type: "SELF_REVIEW_FORBIDDEN" };

/**
 * Who may edit the company's public face. `finance` and `support` are deliberately absent:
 * this is marketing copy and compliance evidence, not billing or ticket handling, and the
 * narrowest set that can do the job is the right one.
 */
const PROFILE_MANAGERS: readonly MemberRole[] = ["owner", "administrator"];
/** Certification evidence is compliance paperwork, so it matches VERIFICATION_MANAGERS. */
const CERTIFICATION_MANAGERS: readonly MemberRole[] = ["owner", "administrator"];
const CERTIFICATION_READERS: readonly MemberRole[] = [
  "owner",
  "administrator",
  "finance",
  "seller",
];

/**
 * Server-owned caps, counted INSIDE the write transaction like A15's address cap — a cap
 * checked before the transaction is a cap two concurrent requests walk straight past.
 */
const MAXIMUM_MEDIA_PER_ORGANIZATION = 12;
const MAXIMUM_SITE_ACCESS_ROWS = 12;
const MAXIMUM_STAKEHOLDERS = 12;
/** Phase 17. Same ceiling as its sibling collections — a directory row, not a catalogue. */
const MAXIMUM_PRODUCTION_LINES = 12;
const MAXIMUM_SITES = 12;
const MEDIA_OUTPUT_MAX_DIMENSION_PX = 2400;
/** A headshot rendered in a profile card; it does not need the gallery's ceiling. */
const STAKEHOLDER_PHOTO_OUTPUT_MAX_DIMENSION_PX = 800;

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export interface OrganizationMediaProjection {
  readonly id: string;
  readonly mediaKind: MediaRow["mediaKind"];
  readonly imageUrl: string;
  readonly altText: string | null;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly position: number;
}

export interface OrganizationSiteAccessProjection {
  readonly id: string;
  readonly accessMode: SiteAccessRow["accessMode"];
  readonly facilityName: string;
  readonly distanceKm: number | null;
  readonly notes: string | null;
  readonly position: number;
}

export interface OrganizationStakeholderProjection {
  readonly id: string;
  readonly fullName: string;
  readonly roleTitle: string;
  readonly photoUrl: string | null;
  readonly position: number;
}

export interface OrganizationCapabilityProjection {
  readonly id: string;
  readonly capabilityKind: CapabilityRow["capabilityKind"];
  readonly detail: string | null;
  readonly position: number;
}

/**
 * One named production line (Phase 17, §16.3).
 *
 * `unitLabel` is NOT NULLABLE beside a nullable capacity, on purpose: a capacity with no
 * unit cannot be compared against an order, so the unit is required even when the number
 * is withheld.
 */
export interface OrganizationProductionLineProjection {
  readonly id: string;
  readonly name: string;
  readonly processSummary: string;
  readonly monthlyCapacityUnits: number | null;
  readonly unitLabel: string;
  readonly position: number;
}

/**
 * One physical site (Phase 17, §16.3).
 *
 * These areas and the org-wide `factoryAreaSquareMetres` are BOTH seller-declared, and
 * when they disagree the read publishes both rather than summing or preferring one.
 */
export interface OrganizationSiteProjection {
  readonly id: string;
  readonly label: string;
  readonly countryCode: string;
  readonly locality: string | null;
  readonly floorAreaSquareMetres: number | null;
  readonly productionStaffCount: number | null;
  readonly position: number;
}

/**
 * What the factory says about samples (Phase 17, §16.3).
 *
 * `sampleFeeInCents = null` MEANS UNSTATED AND `0` MEANS FREE. Rendering the first as the
 * second is the failure this object is shaped to prevent, which is why the fee is nullable
 * while the currency never is.
 */
export interface OrganizationSamplePolicyProjection {
  readonly offersSamples: boolean;
  readonly sampleLeadTimeDays: number | null;
  readonly sampleFeeInCents: number | null;
  readonly currency: string;
}

/**
 * The smallest order this factory takes, and how long it needs (Phase 17, §16.3).
 *
 * The MOQ pair is BOTH-OR-NEITHER: a bare `500` is unreadable, because 500 pieces and 500
 * cartons are different businesses.
 */
export interface OrganizationOrderBoundsProjection {
  readonly minimumOrderQuantity: number | null;
  readonly minimumOrderQuantityUnitLabel: string | null;
  readonly minimumLeadTimeDays: number | null;
  readonly maximumLeadTimeDays: number | null;
}

/**
 * A certification as the PUBLIC sees it.
 *
 * NOTE WHAT IS ABSENT: `evidenceDocumentId`, and any URL or token that could reach the
 * scan. A certificate carries registration numbers, site addresses and signatures, and §11
 * keeps private objects private. The seller's own view (`listCertifications`) adds review
 * state and reasons but still never exposes the document either — the only reader of that
 * column is the moderator flow inside this service.
 */
export interface OrganizationCertificationProjection {
  readonly id: string;
  readonly standardName: string;
  /** `null` for a standard outside the eight filterable codes — see the column comment. */
  readonly standardCode: CertificationRow["standardCode"];
  readonly issuerName: string;
  readonly certificateNumber: string;
  readonly scopeSummary: string | null;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly approvedAt: Date | null;
}

/** The seller's own view: every state, with the reviewer's reason when there is one. */
export interface OwnedCertificationProjection extends OrganizationCertificationProjection {
  readonly state: CertificationRow["state"];
  readonly decisionReason: string | null;
  readonly submittedAt: Date;
  readonly decidedAt: Date | null;
}

/**
 * EVERYTHING A SELLER ASSERTS ABOUT ITSELF, and nothing else (Appendix A13).
 *
 * This interface exists to be structurally impossible to confuse with
 * `OrganizationFulfillmentMetrics`. A13's closing rule is that a derived stat and a
 * declared stat must be visibly different on the wire, because "98.6% on-time, measured
 * across 412 completed orders" and "founded 2009, per the seller" are different kinds of
 * claim — and the mock's flat `stats: {label, value}[]` array taught the UI to render the
 * second as the first.
 *
 * `certifications` is the one member here that carries a platform decision, and it is
 * filtered to approved-and-unexpired before it ships.
 */
export interface SellerDeclaredProfileProjection {
  readonly yearFounded: number | null;
  readonly factoryCount: number | null;
  readonly totalStaffCount: number | null;
  readonly productionLineCount: number | null;
  readonly factoryAreaSquareMetres: number | null;
  readonly businessType: SellerProfileRow["businessType"];
  readonly visitPolicy: SellerProfileRow["visitPolicy"];
  readonly acceptingCustomOrders: boolean;
  readonly publicSummary: string | null;
  /**
   * The seller's own estimate, kept under this object precisely because
   * `commerce_provider_profile.averageResponseTimeHours` had been shipping as a flat
   * sibling of the derived `onTimeShipmentRate` since Phase 2.
   */
  readonly declaredResponseTimeHours: number | null;
  /** Phase 17 (§16.3). Still declarations — nobody checked any of the three. */
  readonly samplePolicy: OrganizationSamplePolicyProjection;
  readonly orderBounds: OrganizationOrderBoundsProjection;
  readonly acceptingInquiries: boolean;
  readonly media: readonly OrganizationMediaProjection[];
  readonly siteAccess: readonly OrganizationSiteAccessProjection[];
  readonly stakeholders: readonly OrganizationStakeholderProjection[];
  readonly capabilities: readonly OrganizationCapabilityProjection[];
  readonly certifications: readonly OrganizationCertificationProjection[];
  readonly productionLines: readonly OrganizationProductionLineProjection[];
  readonly sites: readonly OrganizationSiteProjection[];
}

/**
 * The defaults a seller who has never filled the form projects as.
 *
 * `USD` is the column default and is server-owned; `offersSamples: false` is the honest
 * reading of silence, and it is what makes every other sample field null by construction.
 */
const UNSTATED_SAMPLE_POLICY: OrganizationSamplePolicyProjection = {
  offersSamples: false,
  sampleLeadTimeDays: null,
  sampleFeeInCents: null,
  currency: "USD",
};

const UNSTATED_ORDER_BOUNDS: OrganizationOrderBoundsProjection = {
  minimumOrderQuantity: null,
  minimumOrderQuantityUnitLabel: null,
  minimumLeadTimeDays: null,
  maximumLeadTimeDays: null,
};

function projectMedia(row: MediaRow): OrganizationMediaProjection {
  return {
    id: row.id,
    mediaKind: row.mediaKind,
    imageUrl: row.imageUrl,
    altText: row.altText,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    position: row.position,
  };
}

function projectSiteAccess(row: SiteAccessRow): OrganizationSiteAccessProjection {
  return {
    id: row.id,
    accessMode: row.accessMode,
    facilityName: row.facilityName,
    distanceKm: row.distanceKm,
    notes: row.notes,
    position: row.position,
  };
}

function projectStakeholder(row: StakeholderRow): OrganizationStakeholderProjection {
  return {
    id: row.id,
    fullName: row.fullName,
    roleTitle: row.roleTitle,
    photoUrl: row.photoUrl,
    position: row.position,
  };
}

function projectCapability(row: CapabilityRow): OrganizationCapabilityProjection {
  return {
    id: row.id,
    capabilityKind: row.capabilityKind,
    detail: row.detail,
    position: row.position,
  };
}

function projectProductionLine(row: ProductionLineRow): OrganizationProductionLineProjection {
  return {
    id: row.id,
    name: row.name,
    processSummary: row.processSummary,
    monthlyCapacityUnits: row.monthlyCapacityUnits,
    unitLabel: row.unitLabel,
    position: row.position,
  };
}

function projectSite(row: SiteRow): OrganizationSiteProjection {
  return {
    id: row.id,
    label: row.label,
    countryCode: row.countryCode,
    locality: row.locality,
    floorAreaSquareMetres: row.floorAreaSquareMetres,
    productionStaffCount: row.productionStaffCount,
    position: row.position,
  };
}

function projectCertification(row: CertificationRow): OrganizationCertificationProjection {
  return {
    id: row.id,
    standardName: row.standardName,
    standardCode: row.standardCode,
    issuerName: row.issuerName,
    certificateNumber: row.certificateNumber,
    scopeSummary: row.scopeSummary,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    approvedAt: row.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface MembershipContext {
  readonly memberId: string;
  readonly role: MemberRole;
}

async function activeMembership(
  userId: string,
  organizationId: string,
): Promise<MembershipContext | null> {
  const [membership] = await db
    .select({
      memberId: commerceOrganizationMember.id,
      role: commerceOrganizationMember.role,
    })
    .from(commerceOrganizationMember)
    .where(
      and(
        eq(commerceOrganizationMember.organizationId, organizationId),
        eq(commerceOrganizationMember.userId, userId),
        eq(commerceOrganizationMember.state, "active"),
      ),
    )
    .limit(1);
  return membership ?? null;
}

/**
 * NOT_FOUND rather than FORBIDDEN for a caller with no standing, matching
 * `requireMembershipRole` in commerce-organizations.service.ts. §11 requires that an
 * inaccessible organization id be indistinguishable from a nonexistent one, or the error
 * code becomes a membership oracle.
 */
async function requireMembershipRole(
  userId: string,
  organizationId: string,
  allowedRoles: readonly MemberRole[],
): Promise<Result<MembershipContext, CommerceSellerProfileError>> {
  const membership = await activeMembership(userId, organizationId);
  if (!membership || !allowedRoles.includes(membership.role)) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  return { success: true, value: membership };
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Seller profile audit append failed: ${appended.error.type}`);
  }
}

// ---------------------------------------------------------------------------
// Public batched read
// ---------------------------------------------------------------------------

/**
 * Loads declared profiles for many organizations at once (Appendix A13).
 *
 * SIX QUERIES REGARDLESS OF HOW MANY ORGANIZATIONS ARE ASKED FOR, each an
 * `= any($1)`, run concurrently. The provider directory and the storefront both call this,
 * and the directory pages 24 organizations at a time — a per-organization read would be a
 * 144-query page.
 *
 * A missing profile row yields NO ENTRY in the returned map, not an empty projection. The
 * caller projects that absence as `declaredProfile: null`, because "this seller has not
 * described itself" and "this seller described itself and said nothing" are different
 * facts — the same call A11 made with `engagement.viewer`.
 */
export async function loadSellerDeclaredProfiles(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, SellerDeclaredProfileProjection>> {
  const profiles = new Map<string, SellerDeclaredProfileProjection>();
  if (organizationIds.length === 0) return profiles;

  const requestedIds = [...organizationIds];

  const [
    profileRows,
    mediaRows,
    siteAccessRows,
    stakeholderRows,
    capabilityRows,
    certificationRows,
    productionLineRows,
    siteRows,
  ] = await Promise.all([
    db
      .select()
      .from(commerceSellerProfile)
      .where(inArray(commerceSellerProfile.organizationId, requestedIds)),
    db
      .select()
      .from(commerceOrganizationMedia)
      .where(inArray(commerceOrganizationMedia.organizationId, requestedIds))
      .orderBy(
        asc(commerceOrganizationMedia.organizationId),
        asc(commerceOrganizationMedia.position),
      ),
    db
      .select()
      .from(commerceOrganizationSiteAccess)
      .where(inArray(commerceOrganizationSiteAccess.organizationId, requestedIds))
      .orderBy(
        asc(commerceOrganizationSiteAccess.organizationId),
        asc(commerceOrganizationSiteAccess.position),
      ),
    db
      .select()
      .from(commerceOrganizationStakeholder)
      .where(inArray(commerceOrganizationStakeholder.organizationId, requestedIds))
      .orderBy(
        asc(commerceOrganizationStakeholder.organizationId),
        asc(commerceOrganizationStakeholder.position),
      ),
    db
      .select()
      .from(commerceOrganizationCapability)
      .where(inArray(commerceOrganizationCapability.organizationId, requestedIds))
      .orderBy(
        asc(commerceOrganizationCapability.organizationId),
        asc(commerceOrganizationCapability.position),
      ),
    /**
     * APPROVED AND UNEXPIRED ONLY, and the expiry is evaluated by POSTGRES against
     * `current_date` rather than in JavaScript. That is why `commerce_certification_state`
     * has no `expired` value: a lapse is a date comparison at read time, so it can never
     * be stale, where a stored state would need a nightly job and would be wrong between
     * ticks. Publishing a lapsed certificate is the failure A13 exists to prevent.
     */
    db
      .select()
      .from(commerceOrganizationCertification)
      .where(
        and(
          inArray(commerceOrganizationCertification.organizationId, requestedIds),
          eq(commerceOrganizationCertification.state, "approved"),
          sql`${commerceOrganizationCertification.validUntil} >= current_date`,
        ),
      )
      .orderBy(
        asc(commerceOrganizationCertification.organizationId),
        asc(commerceOrganizationCertification.standardName),
      ),
    db
      .select()
      .from(commerceOrganizationProductionLine)
      .where(inArray(commerceOrganizationProductionLine.organizationId, requestedIds))
      .orderBy(
        asc(commerceOrganizationProductionLine.organizationId),
        asc(commerceOrganizationProductionLine.position),
      ),
    db
      .select()
      .from(commerceOrganizationSite)
      .where(inArray(commerceOrganizationSite.organizationId, requestedIds))
      .orderBy(
        asc(commerceOrganizationSite.organizationId),
        asc(commerceOrganizationSite.position),
      ),
  ]);

  const mediaByOrganization = new Map<string, OrganizationMediaProjection[]>();
  for (const row of mediaRows) {
    const existing = mediaByOrganization.get(row.organizationId) ?? [];
    existing.push(projectMedia(row));
    mediaByOrganization.set(row.organizationId, existing);
  }
  const siteAccessByOrganization = new Map<string, OrganizationSiteAccessProjection[]>();
  for (const row of siteAccessRows) {
    const existing = siteAccessByOrganization.get(row.organizationId) ?? [];
    existing.push(projectSiteAccess(row));
    siteAccessByOrganization.set(row.organizationId, existing);
  }
  const stakeholdersByOrganization = new Map<string, OrganizationStakeholderProjection[]>();
  for (const row of stakeholderRows) {
    const existing = stakeholdersByOrganization.get(row.organizationId) ?? [];
    existing.push(projectStakeholder(row));
    stakeholdersByOrganization.set(row.organizationId, existing);
  }
  const capabilitiesByOrganization = new Map<string, OrganizationCapabilityProjection[]>();
  for (const row of capabilityRows) {
    const existing = capabilitiesByOrganization.get(row.organizationId) ?? [];
    existing.push(projectCapability(row));
    capabilitiesByOrganization.set(row.organizationId, existing);
  }
  const certificationsByOrganization = new Map<string, OrganizationCertificationProjection[]>();
  for (const row of certificationRows) {
    const existing = certificationsByOrganization.get(row.organizationId) ?? [];
    existing.push(projectCertification(row));
    certificationsByOrganization.set(row.organizationId, existing);
  }
  const productionLinesByOrganization = new Map<string, OrganizationProductionLineProjection[]>();
  for (const row of productionLineRows) {
    const existing = productionLinesByOrganization.get(row.organizationId) ?? [];
    existing.push(projectProductionLine(row));
    productionLinesByOrganization.set(row.organizationId, existing);
  }
  const sitesByOrganization = new Map<string, OrganizationSiteProjection[]>();
  for (const row of siteRows) {
    const existing = sitesByOrganization.get(row.organizationId) ?? [];
    existing.push(projectSite(row));
    sitesByOrganization.set(row.organizationId, existing);
  }

  for (const row of profileRows) {
    profiles.set(row.organizationId, {
      yearFounded: row.yearFounded,
      factoryCount: row.factoryCount,
      totalStaffCount: row.totalStaffCount,
      productionLineCount: row.productionLineCount,
      factoryAreaSquareMetres: row.factoryAreaSquareMetres,
      businessType: row.businessType,
      visitPolicy: row.visitPolicy,
      acceptingCustomOrders: row.acceptingCustomOrders,
      publicSummary: row.publicSummary,
      declaredResponseTimeHours: row.declaredResponseTimeHours,
      samplePolicy: {
        offersSamples: row.offersSamples,
        sampleLeadTimeDays: row.sampleLeadTimeDays,
        sampleFeeInCents: row.sampleFeeInCents,
        currency: row.sampleCurrency,
      },
      orderBounds: {
        minimumOrderQuantity: row.minimumOrderQuantity,
        minimumOrderQuantityUnitLabel: row.minimumOrderQuantityUnitLabel,
        minimumLeadTimeDays: row.minimumLeadTimeDays,
        maximumLeadTimeDays: row.maximumLeadTimeDays,
      },
      acceptingInquiries: row.acceptingInquiries,
      media: mediaByOrganization.get(row.organizationId) ?? [],
      siteAccess: siteAccessByOrganization.get(row.organizationId) ?? [],
      stakeholders: stakeholdersByOrganization.get(row.organizationId) ?? [],
      capabilities: capabilitiesByOrganization.get(row.organizationId) ?? [],
      certifications: certificationsByOrganization.get(row.organizationId) ?? [],
      productionLines: productionLinesByOrganization.get(row.organizationId) ?? [],
      sites: sitesByOrganization.get(row.organizationId) ?? [],
    });
  }

  /**
   * An organization with depth rows but no profile row still projects, because the
   * scalars are all nullable and the collections are the interesting part. Without this a
   * seller who uploaded factory photos and never filled the form would render as having
   * described nothing.
   */
  for (const organizationId of requestedIds) {
    if (profiles.has(organizationId)) continue;
    const media = mediaByOrganization.get(organizationId) ?? [];
    const siteAccess = siteAccessByOrganization.get(organizationId) ?? [];
    const stakeholders = stakeholdersByOrganization.get(organizationId) ?? [];
    const capabilities = capabilitiesByOrganization.get(organizationId) ?? [];
    const certifications = certificationsByOrganization.get(organizationId) ?? [];
    const productionLines = productionLinesByOrganization.get(organizationId) ?? [];
    const sites = sitesByOrganization.get(organizationId) ?? [];
    if (
      productionLines.length === 0 &&
      sites.length === 0 &&
      media.length === 0 &&
      siteAccess.length === 0 &&
      stakeholders.length === 0 &&
      capabilities.length === 0 &&
      certifications.length === 0
    ) {
      continue;
    }
    profiles.set(organizationId, {
      yearFounded: null,
      factoryCount: null,
      totalStaffCount: null,
      productionLineCount: null,
      factoryAreaSquareMetres: null,
      businessType: null,
      visitPolicy: null,
      acceptingCustomOrders: false,
      publicSummary: null,
      declaredResponseTimeHours: null,
      samplePolicy: UNSTATED_SAMPLE_POLICY,
      orderBounds: UNSTATED_ORDER_BOUNDS,
      /**
       * A seller with no profile row has not turned its inbox off, so the default is the
       * column default. An inquiry create still re-reads the row rather than trusting this.
       */
      acceptingInquiries: true,
      media,
      siteAccess,
      stakeholders,
      capabilities,
      certifications,
      productionLines,
      sites,
    });
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// Scalar profile write
// ---------------------------------------------------------------------------

export interface UpsertSellerProfileInput {
  readonly yearFounded?: number | null;
  readonly factoryCount?: number | null;
  readonly totalStaffCount?: number | null;
  readonly productionLineCount?: number | null;
  readonly factoryAreaSquareMetres?: number | null;
  readonly businessType?: SellerProfileRow["businessType"];
  readonly visitPolicy?: SellerProfileRow["visitPolicy"];
  readonly acceptingCustomOrders?: boolean;
  readonly publicSummary?: string | null;
  readonly declaredResponseTimeHours?: number | null;
}

/**
 * The commercial terms the manufacturer directory renders (Phase 17, §16.3).
 *
 * A WHOLE-OBJECT REPLACE, NOT PART OF THE SCALAR PATCH ABOVE, and the reason is coherence.
 * Both invariants here are cross-field — a sample fee is only meaningful when samples are
 * offered, and a MOQ is only readable beside its unit — so a PARTIAL patch could not
 * validate either of them without first reading the stored row and merging. Sending the
 * whole object means Zod can refuse a contradiction at the boundary, which is where
 * `pg-errors.ts` says these belong: the DB CHECKs stay defense-in-depth, and a 23514
 * reaching the application would still be a bug.
 */
export interface ReplaceFactoryTermsInput {
  readonly offersSamples: boolean;
  readonly sampleLeadTimeDays: number | null;
  readonly sampleFeeInCents: number | null;
  readonly sampleCurrency: string;
  readonly minimumOrderQuantity: number | null;
  readonly minimumOrderQuantityUnitLabel: string | null;
  readonly minimumLeadTimeDays: number | null;
  readonly maximumLeadTimeDays: number | null;
  readonly acceptingInquiries: boolean;
}

/**
 * Creates or patches the profile row. An upsert rather than separate create/update routes
 * because there is exactly one row per organization and no meaningful "already exists"
 * conflict for the caller to resolve.
 */
export async function upsertSellerProfile(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly patch: UpsertSellerProfileInput;
}): Promise<Result<SellerDeclaredProfileProjection, CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    await transaction
      .insert(commerceSellerProfile)
      .values({
        organizationId: input.organizationId,
        ...input.patch,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: commerceSellerProfile.organizationId,
        set: { ...input.patch, updatedAt: occurredAt },
      });

    /**
     * The payload names the FIELDS THAT CHANGED, not their values. A declared profile is
     * public copy, so the values are not sensitive — but the audit log's job here is to
     * record that a seller restated its own credentials, and the current values are one
     * join away on a row that is not append-only.
     */
    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "seller_profile_updated",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_seller_profile",
      targetEntityId: input.organizationId,
      payload: { changedFields: Object.keys(input.patch).toSorted() },
      occurredAt,
    });
  });

  const reloaded = await loadSellerDeclaredProfiles([input.organizationId]);
  const profile = reloaded.get(input.organizationId);
  if (!profile) throw new Error("Seller profile vanished immediately after upsert.");
  return { success: true, value: profile };
}

/**
 * Replaces the factory's commercial terms (Phase 17, §16.3).
 *
 * An upsert like `upsertSellerProfile`, for the same reason: one row per organization and
 * no "already exists" conflict a caller could resolve. Unlike it, every field is required,
 * because this object's invariants are cross-field.
 */
export async function replaceFactoryTerms(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly terms: ReplaceFactoryTermsInput;
}): Promise<Result<SellerDeclaredProfileProjection, CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    await transaction
      .insert(commerceSellerProfile)
      .values({
        organizationId: input.organizationId,
        ...input.terms,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: commerceSellerProfile.organizationId,
        set: { ...input.terms, updatedAt: occurredAt },
      });

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "seller_profile_updated",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_seller_profile",
      targetEntityId: input.organizationId,
      payload: { changedFields: Object.keys(input.terms).toSorted() },
      occurredAt,
    });
  });

  const reloaded = await loadSellerDeclaredProfiles([input.organizationId]);
  const profile = reloaded.get(input.organizationId);
  if (!profile) throw new Error("Seller profile vanished immediately after terms replace.");
  return { success: true, value: profile };
}

// ---------------------------------------------------------------------------
// PUT-replace collections
// ---------------------------------------------------------------------------

export interface ProductionLineInput {
  readonly name: string;
  readonly processSummary: string;
  readonly monthlyCapacityUnits?: number | null;
  /** Required even when the capacity is withheld — see the projection's comment. */
  readonly unitLabel: string;
}

export interface OrganizationSiteInput {
  readonly label: string;
  readonly countryCode: string;
  readonly locality?: string | null;
  readonly floorAreaSquareMetres?: number | null;
  readonly productionStaffCount?: number | null;
}

export interface SiteAccessInput {
  readonly accessMode: SiteAccessRow["accessMode"];
  readonly facilityName: string;
  readonly distanceKm?: number | null;
  readonly notes?: string | null;
}

export interface StakeholderInput {
  /**
   * `0091`. Echo back the id of a stakeholder you are keeping so their uploaded portrait
   * survives an edit to the list. A HINT, NEVER A GRANT — honoured only when the id
   * already belongs to this organization.
   */
  readonly id?: string | undefined;
  readonly fullName: string;
  readonly roleTitle: string;
}

export interface CapabilityInput {
  readonly capabilityKind: CapabilityRow["capabilityKind"];
  readonly detail?: string | null;
}

/**
 * DELETE-THEN-INSERT INSIDE ONE TRANSACTION, which is what makes the position uniqueness
 * safe without the park-beyond-the-range dance `product_image` needs.
 *
 * A2's gallery re-pack cannot do this: it must PRESERVE existing image rows, so it updates
 * positions in place and collides with its own unique index mid-statement. Here every row
 * is replaced, so the old positions are gone before any new one is written.
 */
export async function replaceSiteAccess(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly rows: readonly SiteAccessInput[];
}): Promise<Result<readonly OrganizationSiteAccessProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;
  if (input.rows.length > MAXIMUM_SITE_ACCESS_ROWS) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: `At most ${String(MAXIMUM_SITE_ACCESS_ROWS)} site access rows are allowed.`,
      },
    };
  }

  const replaced = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    await transaction
      .delete(commerceOrganizationSiteAccess)
      .where(eq(commerceOrganizationSiteAccess.organizationId, input.organizationId));

    const inserted =
      input.rows.length === 0
        ? []
        : await transaction
            .insert(commerceOrganizationSiteAccess)
            .values(
              input.rows.map((row, index) => ({
                organizationId: input.organizationId,
                accessMode: row.accessMode,
                facilityName: row.facilityName,
                distanceKm: row.distanceKm ?? null,
                notes: row.notes ?? null,
                position: index,
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })),
            )
            .returning();

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "site_access_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_site_access",
      targetEntityId: input.organizationId,
      payload: { rowCount: String(inserted.length) },
      occurredAt,
    });
    return inserted;
  });

  return { success: true, value: replaced.map(projectSiteAccess) };
}

/**
 * Phase 17. Same delete-then-insert-in-one-transaction shape as `replaceSiteAccess`, and
 * safe for the same reason: every row is replaced, so the old positions are gone before
 * any new one is written against `(organizationId, position)`.
 */
export async function replaceProductionLines(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly rows: readonly ProductionLineInput[];
}): Promise<Result<readonly OrganizationProductionLineProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;
  if (input.rows.length > MAXIMUM_PRODUCTION_LINES) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: `At most ${String(MAXIMUM_PRODUCTION_LINES)} production lines are allowed.`,
      },
    };
  }

  const replaced = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    await transaction
      .delete(commerceOrganizationProductionLine)
      .where(eq(commerceOrganizationProductionLine.organizationId, input.organizationId));

    const inserted =
      input.rows.length === 0
        ? []
        : await transaction
            .insert(commerceOrganizationProductionLine)
            .values(
              input.rows.map((row, index) => ({
                organizationId: input.organizationId,
                name: row.name,
                processSummary: row.processSummary,
                monthlyCapacityUnits: row.monthlyCapacityUnits ?? null,
                unitLabel: row.unitLabel,
                position: index,
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })),
            )
            .returning();

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "production_lines_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_production_line",
      targetEntityId: input.organizationId,
      payload: { rowCount: String(inserted.length) },
      occurredAt,
    });
    return inserted;
  });

  return { success: true, value: replaced.map(projectProductionLine) };
}

/**
 * Phase 17. NOTE THE DELETE'S REACH: `commerce_organization_site_audit_site` cascades from
 * the site, so rewriting the site list drops the link rows saying which sites an auditor
 * walked. The AUDIT ITSELF SURVIVES — it references the organization, not a site — so
 * `site_audited` and `lastAuditedAt` are unaffected by a seller editing its own site list.
 * That is the intended asymmetry: a seller may restate where its factories are, and may
 * not thereby erase or claim a platform audit.
 */
export async function replaceOrganizationSites(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly rows: readonly OrganizationSiteInput[];
}): Promise<Result<readonly OrganizationSiteProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;
  if (input.rows.length > MAXIMUM_SITES) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: `At most ${String(MAXIMUM_SITES)} sites are allowed.`,
      },
    };
  }

  const replaced = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    await transaction
      .delete(commerceOrganizationSite)
      .where(eq(commerceOrganizationSite.organizationId, input.organizationId));

    const inserted =
      input.rows.length === 0
        ? []
        : await transaction
            .insert(commerceOrganizationSite)
            .values(
              input.rows.map((row, index) => ({
                organizationId: input.organizationId,
                label: row.label,
                countryCode: row.countryCode,
                locality: row.locality ?? null,
                floorAreaSquareMetres: row.floorAreaSquareMetres ?? null,
                productionStaffCount: row.productionStaffCount ?? null,
                position: index,
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })),
            )
            .returning();

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "sites_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_site",
      targetEntityId: input.organizationId,
      payload: { rowCount: String(inserted.length) },
      occurredAt,
    });
    return inserted;
  });

  return { success: true, value: replaced.map(projectSite) };
}

export async function replaceStakeholders(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly rows: readonly StakeholderInput[];
}): Promise<Result<readonly OrganizationStakeholderProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;
  if (input.rows.length > MAXIMUM_STAKEHOLDERS) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: `At most ${String(MAXIMUM_STAKEHOLDERS)} stakeholders are allowed.`,
      },
    };
  }

  const replaced = await db.transaction(async (transaction) => {
    const occurredAt = new Date();

    /**
     * IDENTITY-PRESERVING SINCE `0091`, no longer delete-then-insert.
     *
     * A stakeholder row gained a platform-hosted portrait, and the id is what the
     * portrait hangs on — so wiping the list to rename one officer would orphan every
     * photo. This is the shape `replaceProductVariants` uses, with positions parked
     * beyond the incoming range first because `(organizationId, position)` is unique and
     * writing final positions directly collides with a row still sitting on one.
     */
    const existingRows = await transaction
      .select({
        id: commerceOrganizationStakeholder.id,
        photoCloudinaryPublicId: commerceOrganizationStakeholder.photoCloudinaryPublicId,
      })
      .from(commerceOrganizationStakeholder)
      .where(eq(commerceOrganizationStakeholder.organizationId, input.organizationId));
    const existingIds = new Set(existingRows.map((row) => row.id));

    const positionParkingOffset = existingRows.length + input.rows.length + 1000;
    await transaction
      .update(commerceOrganizationStakeholder)
      .set({
        position: sql`${commerceOrganizationStakeholder.position} + ${positionParkingOffset}`,
      })
      .where(eq(commerceOrganizationStakeholder.organizationId, input.organizationId));

    const keptIds = new Set<string>();
    for (const [index, row] of input.rows.entries()) {
      const existingId = row.id !== undefined && existingIds.has(row.id) ? row.id : undefined;
      if (existingId === undefined) {
        const [insertedRow] = await transaction
          .insert(commerceOrganizationStakeholder)
          .values({
            organizationId: input.organizationId,
            fullName: row.fullName,
            roleTitle: row.roleTitle,
            position: index,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning({ id: commerceOrganizationStakeholder.id });
        if (!insertedRow) throw new Error("Stakeholder insert returned no row.");
        keptIds.add(insertedRow.id);
        continue;
      }

      // Photo columns untouched: they are owned by the upload route.
      await transaction
        .update(commerceOrganizationStakeholder)
        .set({
          fullName: row.fullName,
          roleTitle: row.roleTitle,
          position: index,
          updatedAt: occurredAt,
        })
        .where(eq(commerceOrganizationStakeholder.id, existingId));
      keptIds.add(existingId);
    }

    const droppedRows = existingRows.filter((row) => !keptIds.has(row.id));
    if (droppedRows.length > 0) {
      await transaction.delete(commerceOrganizationStakeholder).where(
        inArray(
          commerceOrganizationStakeholder.id,
          droppedRows.map((row) => row.id),
        ),
      );
    }

    const inserted = await transaction
      .select()
      .from(commerceOrganizationStakeholder)
      .where(eq(commerceOrganizationStakeholder.organizationId, input.organizationId))
      .orderBy(asc(commerceOrganizationStakeholder.position));

    /**
     * `rowCount` ONLY — never the names. These rows are publishable, but an audit entry is
     * immutable and hash-adjacent, and there is no reason to copy a named individual into
     * permanent history to record that a list was edited. `FORBIDDEN_PAYLOAD_KEY` would
     * not have caught `fullName`; this is a judgement, not a guard.
     */
    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "stakeholders_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_stakeholder",
      targetEntityId: input.organizationId,
      payload: { rowCount: String(inserted.length) },
      occurredAt,
    });
    return {
      rows: inserted,
      droppedPublicIds: droppedRows
        .map((row) => row.photoCloudinaryPublicId)
        .filter((publicId): publicId is string => publicId !== null),
    };
  });

  /**
   * AFTER commit, never inside it: a remote delete in a transaction that later rolls back
   * would leave a surviving row pointing at an asset that is gone. Best-effort — a
   * failure here leaks an orphan rather than breaking the profile.
   */
  for (const publicId of replaced.droppedPublicIds) {
    await deleteOrganizationStakeholderPhoto(publicId);
  }

  return { success: true, value: replaced.rows.map(projectStakeholder) };
}

/**
 * Attach a platform-hosted portrait to one stakeholder (A13 item 4, migration `0091`).
 *
 * `photoUrl` used to be a client-supplied https string on the stakeholder list. A portrait
 * is the strongest EXIF case in this schema — the coordinates belong to the named person,
 * not the premises — and this is a table whose own design note is about not turning a
 * public projection into a personal disclosure. Hotlinking it did exactly that, and left
 * the image swappable by the seller after the profile was reviewed.
 */
export async function replaceStakeholderPhoto(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly stakeholderId: string;
  readonly imageBytes: Buffer;
}): Promise<Result<OrganizationStakeholderProjection, CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  const [existing] = await db
    .select({
      id: commerceOrganizationStakeholder.id,
      previousPublicId: commerceOrganizationStakeholder.photoCloudinaryPublicId,
    })
    .from(commerceOrganizationStakeholder)
    .where(
      and(
        eq(commerceOrganizationStakeholder.id, input.stakeholderId),
        eq(commerceOrganizationStakeholder.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  if (!existing) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  /**
   * Re-encode BEFORE Cloudinary: proves the bytes are a raster image from their magic
   * bytes rather than the untrusted multipart header, and strips the EXIF above.
   * Dimensions come from the normalized buffer, never the client (A2).
   */
  const normalized = await validateAndNormalizeImage(input.imageBytes, {
    outputMaxDimensionPx: STAKEHOLDER_PHOTO_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return { success: false, error: { type: "IMAGE_REJECTED", imageError: normalized.error } };
  }

  const uploaded = await uploadOrganizationStakeholderPhoto(
    input.organizationId,
    input.stakeholderId,
    normalized.value.buffer,
  );
  if (!uploaded.success) {
    return {
      success: false,
      error: { type: "IMAGE_STORAGE_FAILED", storageError: uploaded.error },
    };
  }

  let updatedRow: StakeholderRow | null;
  try {
    updatedRow = await db.transaction(async (transaction) => {
      const occurredAt = new Date();
      const [row] = await transaction
        .update(commerceOrganizationStakeholder)
        .set({
          photoUrl: uploaded.value.secureUrl,
          photoCloudinaryPublicId: uploaded.value.publicId,
          photoWidthPx: normalized.value.width,
          photoHeightPx: normalized.value.height,
          updatedAt: occurredAt,
        })
        .where(eq(commerceOrganizationStakeholder.id, input.stakeholderId))
        .returning();
      if (!row) return null;

      /** Dimensions only — never the public id, and never the person's name. */
      await appendAuditOrThrow(transaction, {
        organizationId: input.organizationId,
        eventKind: "stakeholders_changed",
        actorUserId: input.userId,
        actorMemberRoleSnapshot: access.value.role,
        targetEntityType: "commerce_organization_stakeholder",
        targetEntityId: row.id,
        payload: {
          rowCount: "1",
          widthPx: String(normalized.value.width),
          heightPx: String(normalized.value.height),
        },
        occurredAt,
      });
      return row;
    });
  } catch (updateError: unknown) {
    await deleteOrganizationStakeholderPhoto(uploaded.value.publicId);
    throw updateError;
  }

  if (!updatedRow) {
    await deleteOrganizationStakeholderPhoto(uploaded.value.publicId);
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  if (existing.previousPublicId !== null && existing.previousPublicId !== uploaded.value.publicId) {
    await deleteOrganizationStakeholderPhoto(existing.previousPublicId);
  }

  return { success: true, value: projectStakeholder(updatedRow) };
}

export async function replaceCapabilities(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly rows: readonly CapabilityInput[];
}): Promise<Result<readonly OrganizationCapabilityProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  const distinctKinds = new Set(input.rows.map((row) => row.capabilityKind));
  if (distinctKinds.size !== input.rows.length) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: "Each capability may be declared at most once.",
      },
    };
  }

  const replaced = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    await transaction
      .delete(commerceOrganizationCapability)
      .where(eq(commerceOrganizationCapability.organizationId, input.organizationId));

    const inserted =
      input.rows.length === 0
        ? []
        : await transaction
            .insert(commerceOrganizationCapability)
            .values(
              input.rows.map((row, index) => ({
                organizationId: input.organizationId,
                capabilityKind: row.capabilityKind,
                detail: row.detail ?? null,
                position: index,
                createdAt: occurredAt,
                updatedAt: occurredAt,
              })),
            )
            .returning();

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "capabilities_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_capability",
      targetEntityId: input.organizationId,
      payload: {
        capabilityKinds: input.rows.map((row) => row.capabilityKind).toSorted(),
      },
      occurredAt,
    });
    return inserted;
  });

  return { success: true, value: replaced.map(projectCapability) };
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export async function addOrganizationMedia(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly mediaKind: MediaRow["mediaKind"];
  readonly altText: string | null;
  readonly imageBytes: Buffer;
}): Promise<Result<OrganizationMediaProjection, CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  /**
   * Re-encode BEFORE the cap check and before Cloudinary. This is the step that proves the
   * bytes are an image from their magic bytes rather than from the multipart header, and
   * that strips the EXIF a factory photo carries. Dimensions come out of the normalized
   * buffer, never from the client.
   */
  const normalized = await validateAndNormalizeImage(input.imageBytes, {
    outputMaxDimensionPx: MEDIA_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return {
      success: false,
      error: { type: "IMAGE_REJECTED", imageError: normalized.error },
    };
  }

  const mediaId = randomUUID();
  const uploaded = await uploadOrganizationMedia(
    input.organizationId,
    mediaId,
    normalized.value.buffer,
  );
  if (!uploaded.success) {
    return {
      success: false,
      error: { type: "IMAGE_STORAGE_FAILED", storageError: uploaded.error },
    };
  }

  try {
    const insertedRow = await db.transaction(async (transaction) => {
      const occurredAt = new Date();
      /**
       * Counted and positioned INSIDE the transaction. Two concurrent uploads that both
       * read a count of 11 outside it would both insert at position 11 and one would lose
       * to the unique index — with its Cloudinary asset already uploaded.
       */
      const [counted] = await transaction
        .select({ mediaCount: sql<number>`count(*)::int` })
        .from(commerceOrganizationMedia)
        .where(eq(commerceOrganizationMedia.organizationId, input.organizationId));
      const currentCount = counted?.mediaCount ?? 0;
      if (currentCount >= MAXIMUM_MEDIA_PER_ORGANIZATION) {
        return { status: "limit_reached" as const };
      }

      const [row] = await transaction
        .insert(commerceOrganizationMedia)
        .values({
          id: mediaId,
          organizationId: input.organizationId,
          mediaKind: input.mediaKind,
          imageUrl: uploaded.value.secureUrl,
          cloudinaryPublicId: uploaded.value.publicId,
          altText: input.altText,
          widthPx: normalized.value.width,
          heightPx: normalized.value.height,
          position: currentCount,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!row) throw new Error("Organization media insert returned no row.");

      /**
       * mediaId / mediaKind / position — NEVER `filename` or `publicId`.
       * `FORBIDDEN_PAYLOAD_KEY` matches `filename` and `object.*key` and THROWS, which is
       * how `addressKind` took down address creation in Phase 11. A storage handle also
       * has no business in an immutable log.
       */
      await appendAuditOrThrow(transaction, {
        organizationId: input.organizationId,
        eventKind: "organization_media_changed",
        actorUserId: input.userId,
        actorMemberRoleSnapshot: access.value.role,
        targetEntityType: "commerce_organization_media",
        targetEntityId: row.id,
        payload: {
          mediaId: row.id,
          mediaKind: row.mediaKind,
          position: String(row.position),
        },
        occurredAt,
      });
      return { status: "inserted" as const, row };
    });

    if (insertedRow.status === "limit_reached") {
      // The asset is already in Cloudinary and no row points at it. Remove it.
      await deleteOrganizationMedia(uploaded.value.publicId);
      return {
        success: false,
        error: {
          type: "MEDIA_LIMIT_REACHED",
          limit: MAXIMUM_MEDIA_PER_ORGANIZATION,
        },
      };
    }
    return { success: true, value: projectMedia(insertedRow.row) };
  } catch (insertError: unknown) {
    await deleteOrganizationMedia(uploaded.value.publicId);
    throw insertError;
  }
}

/**
 * Re-pack positions contiguously from 0 in the order given.
 *
 * TWO STATEMENTS, NOT A PER-ROW LOOP, and the reason is the same one A2 documents for
 * `product_image`: `(organization_id, position)` is unique, so assigning final positions
 * one row at a time collides with a position the sequence has not vacated yet. Parking
 * every row beyond the occupied range first makes the second statement collision-free.
 */
export async function reorderOrganizationMedia(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly mediaIdsInOrder: readonly string[];
}): Promise<Result<readonly OrganizationMediaProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const existing = await transaction
      .select({ id: commerceOrganizationMedia.id })
      .from(commerceOrganizationMedia)
      .where(eq(commerceOrganizationMedia.organizationId, input.organizationId))
      .for("update");

    const existingIds = new Set(existing.map((row) => row.id));
    if (
      existingIds.size !== input.mediaIdsInOrder.length ||
      input.mediaIdsInOrder.some((mediaId) => !existingIds.has(mediaId)) ||
      new Set(input.mediaIdsInOrder).size !== input.mediaIdsInOrder.length
    ) {
      return { status: "mismatch" as const };
    }

    // Park beyond the occupied range so no final position collides with a stale one.
    await transaction
      .update(commerceOrganizationMedia)
      .set({
        position: sql`${commerceOrganizationMedia.position} + ${existingIds.size + 1000}`,
      })
      .where(eq(commerceOrganizationMedia.organizationId, input.organizationId));

    for (const [index, mediaId] of input.mediaIdsInOrder.entries()) {
      await transaction
        .update(commerceOrganizationMedia)
        .set({ position: index, updatedAt: occurredAt })
        .where(
          and(
            eq(commerceOrganizationMedia.id, mediaId),
            eq(commerceOrganizationMedia.organizationId, input.organizationId),
          ),
        );
    }

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "organization_media_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_media",
      targetEntityId: input.organizationId,
      payload: { reorderedCount: String(input.mediaIdsInOrder.length) },
      occurredAt,
    });

    const reordered = await transaction
      .select()
      .from(commerceOrganizationMedia)
      .where(eq(commerceOrganizationMedia.organizationId, input.organizationId))
      .orderBy(asc(commerceOrganizationMedia.position));
    return { status: "reordered" as const, rows: reordered };
  });

  if (outcome.status === "mismatch") {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: "The media order must list every current image exactly once.",
      },
    };
  }
  return { success: true, value: outcome.rows.map(projectMedia) };
}

export async function deleteOrganizationMediaRow(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly mediaId: string;
}): Promise<Result<{ readonly deleted: true }, CommerceSellerProfileError>> {
  const access = await requireMembershipRole(input.userId, input.organizationId, PROFILE_MANAGERS);
  if (!access.success) return access;

  const removed = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [row] = await transaction
      .delete(commerceOrganizationMedia)
      .where(
        and(
          eq(commerceOrganizationMedia.id, input.mediaId),
          eq(commerceOrganizationMedia.organizationId, input.organizationId),
        ),
      )
      .returning();
    if (!row) return null;

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "organization_media_changed",
      actorUserId: input.userId,
      actorMemberRoleSnapshot: access.value.role,
      targetEntityType: "commerce_organization_media",
      targetEntityId: row.id,
      payload: { mediaId: row.id, mediaKind: row.mediaKind, removed: true },
      occurredAt,
    });
    return row;
  });

  if (!removed) return { success: false, error: { type: "NOT_FOUND" } };

  /**
   * Asset destroyed AFTER the row is committed, not inside the transaction. If Cloudinary
   * fails the row is still gone, which is the honest outcome — the alternative is a
   * committed asset with no row, invisible to every reader and impossible to find again.
   * An orphaned asset is recoverable by prefix; an orphaned row is not.
   */
  await deleteOrganizationMedia(removed.cloudinaryPublicId);
  return { success: true, value: { deleted: true } };
}

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

export async function submitCertification(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly standardName: string;
  /**
   * Phase 17 (§16.2). OPTIONAL, and nothing infers it from `standardName` — a fuzzy match
   * would put a factory into a compliance filter it never claimed. Omitting it costs the
   * seller only filterability; the certificate still renders on the detail page.
   */
  readonly standardCode?: CertificationRow["standardCode"];
  readonly issuerName: string;
  readonly certificateNumber: string;
  readonly scopeSummary: string | null;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly evidenceBytes: Buffer;
  readonly mediaType: string;
  readonly originalFileName: string;
}): Promise<Result<OwnedCertificationProjection, CommerceSellerProfileError>> {
  const access = await requireMembershipRole(
    input.userId,
    input.organizationId,
    CERTIFICATION_MANAGERS,
  );
  if (!access.success) return access;

  const encryptedDocument = encryptCommerceDocument(input.evidenceBytes);
  if (!encryptedDocument.success) {
    return {
      success: false,
      error: { type: "EVIDENCE_ENCRYPTION_UNAVAILABLE" },
    };
  }
  const encryptedFileName = encryptCommercePii(input.originalFileName);
  if (!encryptedFileName.success) {
    return {
      success: false,
      error: { type: "EVIDENCE_ENCRYPTION_UNAVAILABLE" },
    };
  }

  const documentId = randomUUID();
  const uploaded = await uploadPrivateCommerceDocument({
    organizationId: input.organizationId,
    documentId,
    contentSha256: encryptedDocument.value.contentSha256,
    documentBytes: encryptedDocument.value.ciphertext,
    mediaType: "application/octet-stream",
    downloadFileName: `${documentId}.bin`,
  });
  if (!uploaded.success) {
    return {
      success: false,
      error: {
        type:
          uploaded.error.type === "NOT_CONFIGURED"
            ? "EVIDENCE_STORAGE_NOT_CONFIGURED"
            : "EVIDENCE_STORAGE_FAILED",
      },
    };
  }

  try {
    const certification = await db.transaction(async (transaction) => {
      const occurredAt = new Date();
      const [document] = await transaction
        .insert(commerceEncryptedDocument)
        .values({
          id: documentId,
          organizationId: input.organizationId,
          documentKind: "certification_evidence",
          // Upload completion is not a malware verdict. Phase 14b finally supplies the
          // scanner that promotes this; before it, a certificate stayed pending forever.
          state: "pending_scan",
          storageProvider: "backblaze_b2",
          objectStorageKey: uploaded.value.objectKey,
          mediaType: input.mediaType,
          fileByteSize: input.evidenceBytes.length,
          contentSha256: encryptedDocument.value.contentSha256,
          encryptionAlgorithm: encryptedDocument.value.encryptionAlgorithm,
          encryptionKeyVersion: encryptedDocument.value.encryptionKeyVersion,
          encryptedDataKey: encryptedDocument.value.encryptedDataKey,
          initializationVector: encryptedDocument.value.initializationVector,
          originalFileNameEncrypted: encryptedFileName.value,
          uploadedByUserId: input.userId,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!document) throw new Error("Certification document insert returned no row.");

      const [row] = await transaction
        .insert(commerceOrganizationCertification)
        .values({
          organizationId: input.organizationId,
          standardName: input.standardName,
          standardCode: input.standardCode ?? null,
          issuerName: input.issuerName,
          certificateNumber: input.certificateNumber,
          scopeSummary: input.scopeSummary,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          evidenceDocumentId: document.id,
          state: "pending",
          submittedByUserId: input.userId,
          submittedAt: occurredAt,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .returning();
      if (!row) throw new Error("Certification insert returned no row.");

      /**
       * certificationId / standardName — and NOT the evidence object key, which
       * `object.*key` matches and which would copy a private document's address into
       * immutable history for no reader's benefit.
       */
      await appendAuditOrThrow(transaction, {
        organizationId: input.organizationId,
        eventKind: "certification_submitted",
        actorUserId: input.userId,
        actorMemberRoleSnapshot: access.value.role,
        targetEntityType: "commerce_organization_certification",
        targetEntityId: row.id,
        payload: {
          certificationId: row.id,
          standardName: row.standardName,
          evidenceDocumentId: document.id,
        },
        occurredAt,
      });
      return row;
    });

    /**
     * STORE Phase 14b. A certificate could not previously leave `pending_scan` at all —
     * `recordDocumentScannerVerdict` demands a pending verification row that a certification
     * never has. Enqueued after commit and never allowed to fail this call.
     */
    await scheduleDocumentScan(documentId);

    return { success: true, value: projectOwnedCertification(certification) };
  } catch (submissionError: unknown) {
    return handleCertificationSubmissionFailure(submissionError, uploaded.value.objectKey);
  }
}

function projectOwnedCertification(row: CertificationRow): OwnedCertificationProjection {
  return {
    ...projectCertification(row),
    state: row.state,
    decisionReason: row.decisionReason,
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
  };
}

export async function listCertifications(input: {
  readonly userId: string;
  readonly organizationId: string;
}): Promise<Result<readonly OwnedCertificationProjection[], CommerceSellerProfileError>> {
  const access = await requireMembershipRole(
    input.userId,
    input.organizationId,
    CERTIFICATION_READERS,
  );
  if (!access.success) return access;

  const rows = await db
    .select()
    .from(commerceOrganizationCertification)
    .where(eq(commerceOrganizationCertification.organizationId, input.organizationId))
    .orderBy(
      asc(commerceOrganizationCertification.standardName),
      asc(commerceOrganizationCertification.id),
    );
  return { success: true, value: rows.map(projectOwnedCertification) };
}

export type CertificationDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly decisionReason: string };

/**
 * A moderator approves or rejects. Platform capability, NOT an organization role — a
 * certification a seller could approve for itself is not evidence of anything, which is the
 * only reason this table is worth having next to the declared capability rows.
 */
export async function decideCertification(input: {
  readonly moderatorUserId: string;
  readonly certificationId: string;
  readonly decision: CertificationDecision;
}): Promise<Result<OwnedCertificationProjection, CommerceSellerProfileError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [existing] = await transaction
      .select()
      .from(commerceOrganizationCertification)
      .where(eq(commerceOrganizationCertification.id, input.certificationId))
      .for("update");
    if (!existing) return { status: "not_found" as const };
    if (existing.submittedByUserId === input.moderatorUserId) {
      return { status: "self_review" as const };
    }
    if (existing.state !== "pending") {
      return { status: "already_decided" as const, state: existing.state };
    }

    const [row] = await transaction
      .update(commerceOrganizationCertification)
      .set(
        input.decision.kind === "approve"
          ? {
              state: "approved",
              reviewedByUserId: input.moderatorUserId,
              decisionReason: null,
              decidedAt: occurredAt,
              updatedAt: occurredAt,
            }
          : {
              state: "rejected",
              reviewedByUserId: input.moderatorUserId,
              decisionReason: input.decision.decisionReason,
              decidedAt: occurredAt,
              updatedAt: occurredAt,
            },
      )
      .where(
        and(
          eq(commerceOrganizationCertification.id, input.certificationId),
          eq(commerceOrganizationCertification.state, "pending"),
        ),
      )
      .returning();
    if (!row) return { status: "race_conflict" as const };

    /**
     * Written to the CERTIFIED ORGANIZATION's chain with a null role snapshot, exactly as
     * `trade_state_changed` records a moderator's trade-state decision. 0064 routed content
     * moderation to the platform chain because a review or question may have no
     * organization behind it; a certification always does, and this is where a reader would
     * look for it.
     */
    await appendAuditOrThrow(transaction, {
      organizationId: row.organizationId,
      eventKind: "certification_decided",
      actorUserId: input.moderatorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_organization_certification",
      targetEntityId: row.id,
      payload: {
        certificationId: row.id,
        standardName: row.standardName,
        decision: row.state,
        reason: row.decisionReason,
      },
      occurredAt,
    });
    return { status: "decided" as const, row };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_review":
      return { success: false, error: { type: "SELF_REVIEW_FORBIDDEN" } };
    case "already_decided":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: `This certification is already ${outcome.state}.`,
        },
      };
    case "race_conflict":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: "This certification was decided concurrently.",
        },
      };
    case "decided":
      return { success: true, value: projectOwnedCertification(outcome.row) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(
        `Unhandled certification decision outcome: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

/**
 * The uploaded evidence has no row pointing at it, so it must not stay in object storage.
 * Mirrors `submitVerificationEvidence`'s cleanup, including the distinction between a
 * uniqueness conflict (the seller resubmitted a live certificate) and anything else.
 */
async function handleCertificationSubmissionFailure(
  submissionError: unknown,
  objectKey: string,
): Promise<Result<OwnedCertificationProjection, CommerceSellerProfileError>> {
  const uniqueConflict = isUniqueViolation(submissionError);
  const cleanup = await deletePrivateCommerceDocument(objectKey);
  if (!cleanup.success) {
    return { success: false, error: { type: "EVIDENCE_STORAGE_FAILED" } };
  }
  if (uniqueConflict) {
    return {
      success: false,
      error: {
        type: "CONFLICT",
        message: "This certificate number is already recorded for this standard.",
      },
    };
  }
  throw submissionError;
}

// ---------------------------------------------------------------------------
// Site audits — the record behind `site_audited` (Phase 17, §16.2 conflict 3)
// ---------------------------------------------------------------------------

/**
 * One recorded audit, as the owner and the moderator see it.
 *
 * The PUBLIC read never projects this object. The manufacturer detail carries only
 * `lastAuditedAt`, because publishing an auditor's name and the scope they walked is a
 * disclosure about a third party that nobody consented to on a browse page.
 */
export interface OrganizationSiteAuditProjection {
  readonly id: string;
  readonly organizationId: string;
  readonly auditedAt: string;
  readonly auditorName: string;
  readonly auditorOrganizationName: string | null;
  readonly scopeSummary: string;
  readonly state: SiteAuditRow["state"];
  readonly siteIds: readonly string[];
  readonly withdrawnAt: Date | null;
  readonly withdrawalReason: string | null;
  readonly createdAt: Date;
}

function projectSiteAudit(
  row: SiteAuditRow,
  siteIds: readonly string[],
): OrganizationSiteAuditProjection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    auditedAt: row.auditedAt,
    auditorName: row.auditorName,
    auditorOrganizationName: row.auditorOrganizationName,
    scopeSummary: row.scopeSummary,
    state: row.state,
    siteIds,
    withdrawnAt: row.withdrawnAt,
    withdrawalReason: row.withdrawalReason,
    createdAt: row.createdAt,
  };
}

export interface RecordSiteAuditInput {
  readonly moderatorUserId: string;
  readonly organizationId: string;
  readonly auditedAt: string;
  readonly auditorName: string;
  readonly auditorOrganizationName: string | null;
  readonly scopeSummary: string;
  /**
   * Which of the organization's declared sites were walked. A HINT THAT IS VERIFIED, never
   * a grant: ids belonging to another organization are refused rather than filtered out,
   * because silently dropping one would record an audit narrower than the moderator wrote.
   */
  readonly siteIds: readonly string[];
}

/**
 * Records that somebody stood in the building.
 *
 * `moderate_commerce` IS CHECKED FIRST, before any id in the input is read, which is what
 * keeps the route from being an existence oracle for organization ids.
 *
 * The platform audit entry is appended IN THE SAME TRANSACTION and its id is stored on the
 * row, so no audit can exist without an accountable human attached to it. That is the
 * shape `commerce_moderation_action` already uses.
 */
export async function recordSiteAudit(
  input: RecordSiteAuditInput,
): Promise<Result<OrganizationSiteAuditProjection, CommerceSellerProfileError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();

    const [organization] = await transaction
      .select({ id: commerceOrganization.id })
      .from(commerceOrganization)
      .where(eq(commerceOrganization.id, input.organizationId))
      .limit(1);
    if (!organization) return { status: "not_found" as const };

    const requestedSiteIds = [...new Set(input.siteIds)];
    if (requestedSiteIds.length > 0) {
      const ownedSites = await transaction
        .select({ id: commerceOrganizationSite.id })
        .from(commerceOrganizationSite)
        .where(
          and(
            eq(commerceOrganizationSite.organizationId, input.organizationId),
            inArray(commerceOrganizationSite.id, requestedSiteIds),
          ),
        );
      if (ownedSites.length !== requestedSiteIds.length) {
        return { status: "unknown_site" as const };
      }
    }

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: "commerce_organization_site_audit_recorded",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: capability.value.platformRole,
      actionLabel: "commerce_organization_site_audit_recorded",
      targetLabel: `commerce_organization:${input.organizationId}`,
      detailNote: input.scopeSummary,
      payload: {
        organizationId: input.organizationId,
        auditedAt: input.auditedAt,
        siteCount: String(requestedSiteIds.length),
      },
      occurredAt,
    });

    const [row] = await transaction
      .insert(commerceOrganizationSiteAudit)
      .values({
        organizationId: input.organizationId,
        auditedAt: input.auditedAt,
        auditorName: input.auditorName,
        auditorOrganizationName: input.auditorOrganizationName,
        scopeSummary: input.scopeSummary,
        state: "recorded",
        recordedByUserId: input.moderatorUserId,
        auditEntryId: auditEntry.id,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning();
    if (!row) throw new Error("Site audit insert returned no row.");

    if (requestedSiteIds.length > 0) {
      await transaction.insert(commerceOrganizationSiteAuditSite).values(
        requestedSiteIds.map((siteId) => ({
          auditId: row.id,
          siteId,
          createdAt: occurredAt,
        })),
      );
    }

    await appendAuditOrThrow(transaction, {
      organizationId: input.organizationId,
      eventKind: "site_audit_recorded",
      actorUserId: input.moderatorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_organization_site_audit",
      targetEntityId: row.id,
      payload: { auditedAt: input.auditedAt },
      occurredAt,
    });

    return { status: "recorded" as const, row, siteIds: requestedSiteIds };
  });

  if (outcome.status === "not_found") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (outcome.status === "unknown_site") {
    return {
      success: false,
      error: { type: "CONFLICT", message: "One or more sites do not belong to this organization." },
    };
  }
  return { success: true, value: projectSiteAudit(outcome.row, outcome.siteIds) };
}

/**
 * Retracts a published audit.
 *
 * REVERSIBLE IS THE WRONG WORD FOR IT — a withdrawal is its own recorded act with its own
 * reason, not an undo. The row survives, `site_audited` stops deriving from it, and the
 * platform chain carries both the claim and its retraction.
 */
export async function withdrawSiteAudit(input: {
  readonly moderatorUserId: string;
  readonly auditId: string;
  readonly reason: string;
}): Promise<Result<OrganizationSiteAuditProjection, CommerceSellerProfileError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [existing] = await transaction
      .select()
      .from(commerceOrganizationSiteAudit)
      .where(eq(commerceOrganizationSiteAudit.id, input.auditId))
      .for("update");
    if (!existing) return { status: "not_found" as const };
    if (existing.state === "withdrawn") return { status: "already_withdrawn" as const };

    await appendPlatformAuditEntry(transaction, {
      eventKind: "commerce_organization_site_audit_withdrawn",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: capability.value.platformRole,
      actionLabel: "commerce_organization_site_audit_withdrawn",
      targetLabel: `commerce_organization_site_audit:${existing.id}`,
      detailNote: input.reason,
      payload: { organizationId: existing.organizationId, auditId: existing.id },
      occurredAt,
    });

    const [row] = await transaction
      .update(commerceOrganizationSiteAudit)
      .set({
        state: "withdrawn",
        withdrawnByUserId: input.moderatorUserId,
        withdrawnAt: occurredAt,
        withdrawalReason: input.reason,
        updatedAt: occurredAt,
      })
      .where(eq(commerceOrganizationSiteAudit.id, input.auditId))
      .returning();
    if (!row) throw new Error("Site audit withdrawal returned no row.");

    await appendAuditOrThrow(transaction, {
      organizationId: existing.organizationId,
      eventKind: "site_audit_withdrawn",
      actorUserId: input.moderatorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_organization_site_audit",
      targetEntityId: row.id,
      payload: { auditId: row.id },
      occurredAt,
    });

    return { status: "withdrawn" as const, row };
  });

  if (outcome.status === "not_found") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (outcome.status === "already_withdrawn") {
    return {
      success: false,
      error: { type: "CONFLICT", message: "This audit has already been withdrawn." },
    };
  }

  const linkedSites = await db
    .select({ siteId: commerceOrganizationSiteAuditSite.siteId })
    .from(commerceOrganizationSiteAuditSite)
    .where(eq(commerceOrganizationSiteAuditSite.auditId, outcome.row.id));
  return {
    success: true,
    value: projectSiteAudit(
      outcome.row,
      linkedSites.map((link) => link.siteId),
    ),
  };
}

/** Every audit on one organization, newest first. Staff-only, like the writes above. */
export async function listSiteAudits(input: {
  readonly moderatorUserId: string;
  readonly organizationId: string;
}): Promise<Result<readonly OrganizationSiteAuditProjection[], CommerceSellerProfileError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED" } };
  }

  const rows = await db
    .select()
    .from(commerceOrganizationSiteAudit)
    .where(eq(commerceOrganizationSiteAudit.organizationId, input.organizationId))
    .orderBy(desc(commerceOrganizationSiteAudit.auditedAt), desc(commerceOrganizationSiteAudit.id));
  if (rows.length === 0) return { success: true, value: [] };

  const linkRows = await db
    .select()
    .from(commerceOrganizationSiteAuditSite)
    .where(
      inArray(
        commerceOrganizationSiteAuditSite.auditId,
        rows.map((row) => row.id),
      ),
    );
  const siteIdsByAudit = new Map<string, string[]>();
  for (const link of linkRows) {
    const existing = siteIdsByAudit.get(link.auditId) ?? [];
    existing.push(link.siteId);
    siteIdsByAudit.set(link.auditId, existing);
  }

  return {
    success: true,
    value: rows.map((row) => projectSiteAudit(row, siteIdsByAudit.get(row.id) ?? [])),
  };
}
