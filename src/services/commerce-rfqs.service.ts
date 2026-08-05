import { and, asc, desc, eq, exists, gt, inArray, lt, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceOrganization,
  commerceOrganizationAddress,
  commerceProviderKindLink,
  commerceProviderProfile,
  commerceRfq,
  commerceRfqDocument,
  commerceRfqInvitation,
  commerceRfqProductLine,
  commerceRfqServiceLine,
  commerceServiceOffering,
  customsBrokerageRfqRequirementDetail,
  foreignExchangeRfqRequirementDetail,
  freightRfqRequirementDetail,
  inspectionRfqRequirementDetail,
  insuranceRfqRequirementDetail,
  marketingRfqRequirementDetail,
  product,
  testingCertificationRfqRequirementDetail,
  warehouseRfqRequirementDetail,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RfqRow = typeof commerceRfq.$inferSelect;
type ProductLineRow = typeof commerceRfqProductLine.$inferSelect;
type ServiceLineRow = typeof commerceRfqServiceLine.$inferSelect;
type InvitationRow = typeof commerceRfqInvitation.$inferSelect;
type ProviderKind = ServiceLineRow["providerKind"];
type FreightTransportMode =
  (typeof freightRfqRequirementDetail.$inferSelect.transportModes)[number];
type RfqVisibility = RfqRow["visibility"];
type RfqState = RfqRow["state"];

export type CommerceRfqsError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "ORGANIZATION_NOT_ACTIVE" }
  | { type: "INVALID_STATE"; message?: string }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "CONFLICT"; message: string }
  | { type: "DEADLINE_INVALID" }
  | { type: "LINES_REQUIRED" }
  | { type: "PROVIDER_INELIGIBLE"; providerOrganizationId: string }
  | { type: "DOCUMENT_NOT_OWNED" }
  | { type: "ADDRESS_NOT_OWNED" }
  | { type: "INVALID_CURSOR" };

export type FreightRfqRequirementDetailInput = {
  readonly providerKind: "freight_forwarder" | "logistics_operator";
  readonly transportModes: readonly FreightTransportMode[];
  readonly originCountryCode?: string | null;
  readonly destinationCountryCode?: string | null;
  readonly requiresConsolidation?: boolean;
  readonly requiresHazardousGoodsSupport?: boolean;
  readonly cargoDescription?: string | null;
};

export type CustomsBrokerageRfqRequirementDetailInput = {
  readonly providerKind: "customs_broker";
  readonly jurisdictions: readonly string[];
  readonly importRequired?: boolean;
  readonly exportRequired?: boolean;
  readonly commoditySummary?: string | null;
};

export type InsuranceRfqRequirementDetailInput = {
  readonly providerKind: "insurance_provider";
  readonly cargoCoverageClasses: readonly string[];
  readonly coverageLimitInCents?: number | null;
  readonly currency?: string;
};

export type InspectionRfqRequirementDetailInput = {
  readonly providerKind: "inspection_agency";
  readonly preProduction?: boolean;
  readonly duringProduction?: boolean;
  readonly preShipment?: boolean;
  readonly loadingSupervision?: boolean;
};

export type TestingCertificationRfqRequirementDetailInput = {
  readonly providerKind: "testing_certification_lab";
  readonly standards: readonly string[];
  readonly laboratoryLocationPreference?: string | null;
};

export type MarketingRfqRequirementDetailInput = {
  readonly providerKind: "marketing_agency";
  readonly channels: readonly string[];
  readonly targetRegions: readonly string[];
  readonly languageCapabilities: readonly string[];
};

export type WarehouseRfqRequirementDetailInput = {
  readonly providerKind: "warehouse_provider";
  readonly storageTypes: readonly string[];
  readonly temperatureControlled?: boolean;
  readonly bondedStatusRequired?: boolean;
  readonly capacityUnits?: string | null;
};

export type ForeignExchangeRfqRequirementDetailInput = {
  readonly providerKind: "foreign_exchange_facilitator";
  readonly currencyPairs: readonly string[];
  readonly settlementRails: readonly string[];
  readonly notionalAmountInCents?: number | null;
  readonly notionalCurrency?: string;
};

export type RfqRequirementDetailInput =
  | FreightRfqRequirementDetailInput
  | CustomsBrokerageRfqRequirementDetailInput
  | InsuranceRfqRequirementDetailInput
  | InspectionRfqRequirementDetailInput
  | TestingCertificationRfqRequirementDetailInput
  | MarketingRfqRequirementDetailInput
  | WarehouseRfqRequirementDetailInput
  | ForeignExchangeRfqRequirementDetailInput;

export interface CreateRfqProductLineInput {
  readonly productId?: string;
  readonly categoryId?: string;
  readonly requestedTitle: string;
  readonly requestedSpecificationSnapshot: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly siblingOrder: number;
}

export interface CreateRfqServiceLineInput {
  readonly providerKind: ProviderKind;
  readonly serviceOfferingId?: string;
  readonly linkedProductLineSiblingOrder?: number;
  readonly requirementSummary: string;
  readonly siblingOrder: number;
  readonly requirementDetail: RfqRequirementDetailInput;
}

export interface CreateDraftRfqInput {
  readonly title: string;
  readonly description?: string;
  readonly visibility: RfqVisibility;
  readonly responseDeadlineAt: string;
  readonly desiredDeliveryStartsAt?: string;
  readonly desiredDeliveryEndsAt?: string;
  readonly destinationAddressId?: string;
  readonly destinationCountryCode?: string;
  readonly destinationLocality?: string;
  readonly settlementCurrency: string;
  readonly productLines: readonly CreateRfqProductLineInput[];
  readonly serviceLines: readonly CreateRfqServiceLineInput[];
  readonly documentIds?: readonly string[];
}

export interface UpdateDraftRfqInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly visibility?: RfqVisibility;
  readonly responseDeadlineAt?: string;
  readonly desiredDeliveryStartsAt?: string | null;
  readonly desiredDeliveryEndsAt?: string | null;
  readonly destinationAddressId?: string | null;
  readonly destinationCountryCode?: string | null;
  readonly destinationLocality?: string | null;
  readonly settlementCurrency?: string;
  readonly productLines?: readonly CreateRfqProductLineInput[];
  readonly serviceLines?: readonly CreateRfqServiceLineInput[];
  readonly documentIds?: readonly string[];
}

export interface RfqListPage {
  readonly items: readonly RfqSummaryProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface RfqSummaryProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly title: string;
  readonly state: RfqState;
  readonly visibility: RfqVisibility;
  readonly responseDeadlineAt: string | null;
  readonly settlementCurrency: string;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RfqDocumentProjection {
  readonly id: string;
  readonly encryptedDocumentId: string;
  readonly createdAt: string;
}

export interface RfqInvitationProjection {
  readonly id: string;
  readonly providerOrganizationId: string;
  readonly state: InvitationRow["state"];
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface RfqDetailProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly createdByMemberId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: RfqState;
  readonly visibility: RfqVisibility;
  readonly responseDeadlineAt: string | null;
  readonly desiredDeliveryStartsAt: string | null;
  readonly desiredDeliveryEndsAt: string | null;
  readonly destinationAddressId: string | null;
  readonly destinationCountryCode: string | null;
  readonly destinationLocality: string | null;
  readonly settlementCurrency: string;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly awardedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly productLines: readonly ProductLineRow[];
  readonly serviceLines: readonly ServiceLineWithRequirementProjection[];
  readonly documents: readonly RfqDocumentProjection[];
  readonly invitations: readonly RfqInvitationProjection[];
  readonly callerRelation: "buyer" | "invited_provider" | "matched_provider";
}

export interface ServiceLineWithRequirementProjection {
  readonly id: string;
  readonly rfqId: string;
  readonly providerKind: ProviderKind;
  readonly serviceOfferingId: string | null;
  readonly linkedProductLineId: string | null;
  readonly requirementSummary: string;
  readonly siblingOrder: number;
  readonly createdAt: string;
  readonly requirementDetail: RfqRequirementDetailInput | null;
}

const DEFAULT_PAGE_LIMIT = 20;

/** Thrown inside a transaction so Drizzle rolls back instead of committing a Result failure. */
class CommerceRfqTransactionAbort {
  readonly error: CommerceRfqsError;
  constructor(error: CommerceRfqsError) {
    this.error = error;
  }
}

function abortRfqTransaction(error: CommerceRfqsError): never {
  throw new CommerceRfqTransactionAbort(error);
}

function isRfqTransactionAbort(error: unknown): error is CommerceRfqTransactionAbort {
  return error instanceof CommerceRfqTransactionAbort;
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce RFQ audit append failed: ${appended.error.type}`);
  }
}

function parseIsoDate(value: string, fieldName: string): Result<Date, CommerceRfqsError> {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: `${fieldName} must be a valid ISO datetime.` },
    };
  }
  return { success: true, value: parsed };
}

function optionalIsoDate(
  value: string | null | undefined,
  fieldName: string,
): Result<Date | null | undefined, CommerceRfqsError> {
  if (value === undefined) return { success: true, value: undefined };
  if (value === null) return { success: true, value: null };
  return parseIsoDate(value, fieldName);
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function summarizeRfq(row: RfqRow): RfqSummaryProjection {
  return {
    id: row.id,
    buyerOrganizationId: row.buyerOrganizationId,
    title: row.title,
    state: row.state,
    visibility: row.visibility,
    responseDeadlineAt: toIsoOrNull(row.responseDeadlineAt),
    settlementCurrency: row.settlementCurrency,
    openedAt: toIsoOrNull(row.openedAt),
    closedAt: toIsoOrNull(row.closedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertServiceLineDetailMatch(
  serviceLine: CreateRfqServiceLineInput,
): Result<true, CommerceRfqsError> {
  if (serviceLine.requirementDetail.providerKind !== serviceLine.providerKind) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "requirementDetail.providerKind must match service line providerKind.",
      },
    };
  }
  return { success: true, value: true };
}

async function assertOwnedAddress(
  transaction: DatabaseTransaction,
  buyerOrganizationId: string,
  destinationAddressId: string,
): Promise<Result<true, CommerceRfqsError>> {
  const [address] = await transaction
    .select({ id: commerceOrganizationAddress.id })
    .from(commerceOrganizationAddress)
    .where(
      and(
        eq(commerceOrganizationAddress.id, destinationAddressId),
        eq(commerceOrganizationAddress.organizationId, buyerOrganizationId),
      ),
    )
    .limit(1);
  if (!address) return { success: false, error: { type: "ADDRESS_NOT_OWNED" } };
  return { success: true, value: true };
}

async function assertOwnedDocuments(
  transaction: DatabaseTransaction,
  buyerOrganizationId: string,
  documentIds: readonly string[],
): Promise<Result<true, CommerceRfqsError>> {
  if (documentIds.length === 0) return { success: true, value: true };
  const uniqueDocumentIds = [...new Set(documentIds)];
  const ownedDocuments = await transaction
    .select({ id: commerceEncryptedDocument.id })
    .from(commerceEncryptedDocument)
    .where(
      and(
        inArray(commerceEncryptedDocument.id, uniqueDocumentIds),
        eq(commerceEncryptedDocument.organizationId, buyerOrganizationId),
      ),
    );
  if (ownedDocuments.length !== uniqueDocumentIds.length) {
    return { success: false, error: { type: "DOCUMENT_NOT_OWNED" } };
  }
  return { success: true, value: true };
}

async function assertReferenceIntegrity(
  transaction: DatabaseTransaction,
  productLines: readonly CreateRfqProductLineInput[],
  serviceLines: readonly CreateRfqServiceLineInput[],
): Promise<Result<true, CommerceRfqsError>> {
  const productIds = [
    ...new Set(
      productLines
        .map((line) => line.productId)
        .filter((productId): productId is string => productId !== undefined),
    ),
  ];
  if (productIds.length > 0) {
    const foundProducts = await transaction
      .select({ id: product.id })
      .from(product)
      .where(inArray(product.id, productIds));
    if (foundProducts.length !== productIds.length) {
      return {
        success: false,
        error: { type: "VALIDATION_FAILED", message: "One or more productId values are invalid." },
      };
    }
  }

  const offeringIds = [
    ...new Set(
      serviceLines
        .map((line) => line.serviceOfferingId)
        .filter((offeringId): offeringId is string => offeringId !== undefined),
    ),
  ];
  if (offeringIds.length > 0) {
    const foundOfferings = await transaction
      .select({ id: commerceServiceOffering.id })
      .from(commerceServiceOffering)
      .where(inArray(commerceServiceOffering.id, offeringIds));
    if (foundOfferings.length !== offeringIds.length) {
      return {
        success: false,
        error: {
          type: "VALIDATION_FAILED",
          message: "One or more serviceOfferingId values are invalid.",
        },
      };
    }
  }

  return { success: true, value: true };
}

async function insertRequirementDetail(
  transaction: DatabaseTransaction,
  serviceLineId: string,
  detail: RfqRequirementDetailInput,
): Promise<void> {
  switch (detail.providerKind) {
    case "freight_forwarder":
    case "logistics_operator":
      await transaction.insert(freightRfqRequirementDetail).values({
        serviceLineId,
        transportModes: [...detail.transportModes],
        originCountryCode: detail.originCountryCode ?? null,
        destinationCountryCode: detail.destinationCountryCode ?? null,
        requiresConsolidation: detail.requiresConsolidation ?? false,
        requiresHazardousGoodsSupport: detail.requiresHazardousGoodsSupport ?? false,
        cargoDescription: detail.cargoDescription ?? null,
      });
      return;
    case "customs_broker":
      await transaction.insert(customsBrokerageRfqRequirementDetail).values({
        serviceLineId,
        jurisdictions: [...detail.jurisdictions],
        importRequired: detail.importRequired ?? true,
        exportRequired: detail.exportRequired ?? false,
        commoditySummary: detail.commoditySummary ?? null,
      });
      return;
    case "insurance_provider":
      await transaction.insert(insuranceRfqRequirementDetail).values({
        serviceLineId,
        cargoCoverageClasses: [...detail.cargoCoverageClasses],
        coverageLimitInCents: detail.coverageLimitInCents ?? null,
        currency: detail.currency ?? "USD",
      });
      return;
    case "inspection_agency":
      await transaction.insert(inspectionRfqRequirementDetail).values({
        serviceLineId,
        preProduction: detail.preProduction ?? false,
        duringProduction: detail.duringProduction ?? false,
        preShipment: detail.preShipment ?? false,
        loadingSupervision: detail.loadingSupervision ?? false,
      });
      return;
    case "testing_certification_lab":
      await transaction.insert(testingCertificationRfqRequirementDetail).values({
        serviceLineId,
        standards: [...detail.standards],
        laboratoryLocationPreference: detail.laboratoryLocationPreference ?? null,
      });
      return;
    case "marketing_agency":
      await transaction.insert(marketingRfqRequirementDetail).values({
        serviceLineId,
        channels: [...detail.channels],
        targetRegions: [...detail.targetRegions],
        languageCapabilities: [...detail.languageCapabilities],
      });
      return;
    case "warehouse_provider":
      await transaction.insert(warehouseRfqRequirementDetail).values({
        serviceLineId,
        storageTypes: [...detail.storageTypes],
        temperatureControlled: detail.temperatureControlled ?? false,
        bondedStatusRequired: detail.bondedStatusRequired ?? false,
        capacityUnits: detail.capacityUnits ?? null,
      });
      return;
    case "foreign_exchange_facilitator":
      await transaction.insert(foreignExchangeRfqRequirementDetail).values({
        serviceLineId,
        currencyPairs: [...detail.currencyPairs],
        settlementRails: [...detail.settlementRails],
        notionalAmountInCents: detail.notionalAmountInCents ?? null,
        notionalCurrency: detail.notionalCurrency ?? "USD",
      });
      return;
    default: {
      const exhaustiveCheck: never = detail;
      throw new Error(`Unhandled RFQ requirement detail: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function insertRfqLines(
  transaction: DatabaseTransaction,
  rfqId: string,
  productLines: readonly CreateRfqProductLineInput[],
  serviceLines: readonly CreateRfqServiceLineInput[],
): Promise<Result<true, CommerceRfqsError>> {
  for (const serviceLine of serviceLines) {
    const match = assertServiceLineDetailMatch(serviceLine);
    if (!match.success) return match;
  }

  const referenceCheck = await assertReferenceIntegrity(transaction, productLines, serviceLines);
  if (!referenceCheck.success) return referenceCheck;

  const siblingOrders = productLines.map((line) => line.siblingOrder);
  if (new Set(siblingOrders).size !== siblingOrders.length) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "productLines siblingOrder values must be unique within the RFQ.",
      },
    };
  }
  const serviceSiblingOrders = serviceLines.map((line) => line.siblingOrder);
  if (new Set(serviceSiblingOrders).size !== serviceSiblingOrders.length) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "serviceLines siblingOrder values must be unique within the RFQ.",
      },
    };
  }

  const productLineIdBySiblingOrder = new Map<number, string>();
  for (const productLine of productLines) {
    const [inserted] = await transaction
      .insert(commerceRfqProductLine)
      .values({
        rfqId,
        productId: productLine.productId,
        categoryId: productLine.categoryId,
        requestedTitle: productLine.requestedTitle,
        requestedSpecificationSnapshot: productLine.requestedSpecificationSnapshot,
        quantity: productLine.quantity,
        unitLabel: productLine.unitLabel,
        siblingOrder: productLine.siblingOrder,
      })
      .returning({
        id: commerceRfqProductLine.id,
        siblingOrder: commerceRfqProductLine.siblingOrder,
      });
    if (!inserted) throw new Error("RFQ product line insert returned no row.");
    productLineIdBySiblingOrder.set(inserted.siblingOrder, inserted.id);
  }

  for (const serviceLine of serviceLines) {
    let linkedProductLineId: string | undefined;
    if (serviceLine.linkedProductLineSiblingOrder !== undefined) {
      linkedProductLineId = productLineIdBySiblingOrder.get(
        serviceLine.linkedProductLineSiblingOrder,
      );
      if (linkedProductLineId === undefined) {
        return {
          success: false,
          error: {
            type: "VALIDATION_FAILED",
            message: "linkedProductLineSiblingOrder does not match a product line siblingOrder.",
          },
        };
      }
    }
    const [insertedServiceLine] = await transaction
      .insert(commerceRfqServiceLine)
      .values({
        rfqId,
        providerKind: serviceLine.providerKind,
        serviceOfferingId: serviceLine.serviceOfferingId,
        linkedProductLineId,
        requirementSummary: serviceLine.requirementSummary,
        siblingOrder: serviceLine.siblingOrder,
      })
      .returning({ id: commerceRfqServiceLine.id });
    if (!insertedServiceLine) throw new Error("RFQ service line insert returned no row.");
    await insertRequirementDetail(
      transaction,
      insertedServiceLine.id,
      serviceLine.requirementDetail,
    );
  }

  return { success: true, value: true };
}

async function replaceRfqDocuments(
  transaction: DatabaseTransaction,
  input: {
    readonly rfqId: string;
    readonly buyerOrganizationId: string;
    readonly memberId: string;
    readonly documentIds: readonly string[];
  },
): Promise<Result<true, CommerceRfqsError>> {
  const ownership = await assertOwnedDocuments(
    transaction,
    input.buyerOrganizationId,
    input.documentIds,
  );
  if (!ownership.success) return ownership;

  await transaction.delete(commerceRfqDocument).where(eq(commerceRfqDocument.rfqId, input.rfqId));

  const uniqueDocumentIds = [...new Set(input.documentIds)];
  for (const encryptedDocumentId of uniqueDocumentIds) {
    await transaction.insert(commerceRfqDocument).values({
      rfqId: input.rfqId,
      encryptedDocumentId,
      attachedByMemberId: input.memberId,
    });
  }
  return { success: true, value: true };
}

async function loadRequirementDetailForServiceLine(
  serviceLine: ServiceLineRow,
): Promise<RfqRequirementDetailInput | null> {
  switch (serviceLine.providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const [detail] = await db
        .select()
        .from(freightRfqRequirementDetail)
        .where(eq(freightRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: serviceLine.providerKind,
        transportModes: detail.transportModes,
        originCountryCode: detail.originCountryCode,
        destinationCountryCode: detail.destinationCountryCode,
        requiresConsolidation: detail.requiresConsolidation,
        requiresHazardousGoodsSupport: detail.requiresHazardousGoodsSupport,
        cargoDescription: detail.cargoDescription,
      };
    }
    case "customs_broker": {
      const [detail] = await db
        .select()
        .from(customsBrokerageRfqRequirementDetail)
        .where(eq(customsBrokerageRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "customs_broker",
        jurisdictions: detail.jurisdictions,
        importRequired: detail.importRequired,
        exportRequired: detail.exportRequired,
        commoditySummary: detail.commoditySummary,
      };
    }
    case "insurance_provider": {
      const [detail] = await db
        .select()
        .from(insuranceRfqRequirementDetail)
        .where(eq(insuranceRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "insurance_provider",
        cargoCoverageClasses: detail.cargoCoverageClasses,
        coverageLimitInCents: detail.coverageLimitInCents,
        currency: detail.currency,
      };
    }
    case "inspection_agency": {
      const [detail] = await db
        .select()
        .from(inspectionRfqRequirementDetail)
        .where(eq(inspectionRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "inspection_agency",
        preProduction: detail.preProduction,
        duringProduction: detail.duringProduction,
        preShipment: detail.preShipment,
        loadingSupervision: detail.loadingSupervision,
      };
    }
    case "testing_certification_lab": {
      const [detail] = await db
        .select()
        .from(testingCertificationRfqRequirementDetail)
        .where(eq(testingCertificationRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "testing_certification_lab",
        standards: detail.standards,
        laboratoryLocationPreference: detail.laboratoryLocationPreference,
      };
    }
    case "marketing_agency": {
      const [detail] = await db
        .select()
        .from(marketingRfqRequirementDetail)
        .where(eq(marketingRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "marketing_agency",
        channels: detail.channels,
        targetRegions: detail.targetRegions,
        languageCapabilities: detail.languageCapabilities,
      };
    }
    case "warehouse_provider": {
      const [detail] = await db
        .select()
        .from(warehouseRfqRequirementDetail)
        .where(eq(warehouseRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "warehouse_provider",
        storageTypes: detail.storageTypes,
        temperatureControlled: detail.temperatureControlled,
        bondedStatusRequired: detail.bondedStatusRequired,
        capacityUnits: detail.capacityUnits,
      };
    }
    case "foreign_exchange_facilitator": {
      const [detail] = await db
        .select()
        .from(foreignExchangeRfqRequirementDetail)
        .where(eq(foreignExchangeRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      if (!detail) return null;
      return {
        providerKind: "foreign_exchange_facilitator",
        currencyPairs: detail.currencyPairs,
        settlementRails: detail.settlementRails,
        notionalAmountInCents: detail.notionalAmountInCents,
        notionalCurrency: detail.notionalCurrency,
      };
    }
    default: {
      const exhaustiveCheck: never = serviceLine.providerKind;
      throw new Error(`Unhandled provider kind: ${String(exhaustiveCheck)}`);
    }
  }
}

async function serviceLineHasRequirementRow(
  transaction: DatabaseTransaction,
  serviceLine: ServiceLineRow,
): Promise<boolean> {
  switch (serviceLine.providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const [row] = await transaction
        .select({ serviceLineId: freightRfqRequirementDetail.serviceLineId })
        .from(freightRfqRequirementDetail)
        .where(eq(freightRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "customs_broker": {
      const [row] = await transaction
        .select({ serviceLineId: customsBrokerageRfqRequirementDetail.serviceLineId })
        .from(customsBrokerageRfqRequirementDetail)
        .where(eq(customsBrokerageRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "insurance_provider": {
      const [row] = await transaction
        .select({ serviceLineId: insuranceRfqRequirementDetail.serviceLineId })
        .from(insuranceRfqRequirementDetail)
        .where(eq(insuranceRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "inspection_agency": {
      const [row] = await transaction
        .select({ serviceLineId: inspectionRfqRequirementDetail.serviceLineId })
        .from(inspectionRfqRequirementDetail)
        .where(eq(inspectionRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "testing_certification_lab": {
      const [row] = await transaction
        .select({ serviceLineId: testingCertificationRfqRequirementDetail.serviceLineId })
        .from(testingCertificationRfqRequirementDetail)
        .where(eq(testingCertificationRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "marketing_agency": {
      const [row] = await transaction
        .select({ serviceLineId: marketingRfqRequirementDetail.serviceLineId })
        .from(marketingRfqRequirementDetail)
        .where(eq(marketingRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "warehouse_provider": {
      const [row] = await transaction
        .select({ serviceLineId: warehouseRfqRequirementDetail.serviceLineId })
        .from(warehouseRfqRequirementDetail)
        .where(eq(warehouseRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    case "foreign_exchange_facilitator": {
      const [row] = await transaction
        .select({ serviceLineId: foreignExchangeRfqRequirementDetail.serviceLineId })
        .from(foreignExchangeRfqRequirementDetail)
        .where(eq(foreignExchangeRfqRequirementDetail.serviceLineId, serviceLine.id))
        .limit(1);
      return row !== undefined;
    }
    default: {
      const exhaustiveCheck: never = serviceLine.providerKind;
      throw new Error(`Unhandled provider kind: ${String(exhaustiveCheck)}`);
    }
  }
}

async function projectRfqDetail(
  rfq: RfqRow,
  callerRelation: RfqDetailProjection["callerRelation"],
): Promise<RfqDetailProjection> {
  const [productLines, serviceLines, documents, invitations] = await Promise.all([
    db
      .select()
      .from(commerceRfqProductLine)
      .where(eq(commerceRfqProductLine.rfqId, rfq.id))
      .orderBy(asc(commerceRfqProductLine.siblingOrder)),
    db
      .select()
      .from(commerceRfqServiceLine)
      .where(eq(commerceRfqServiceLine.rfqId, rfq.id))
      .orderBy(asc(commerceRfqServiceLine.siblingOrder)),
    db
      .select({
        id: commerceRfqDocument.id,
        encryptedDocumentId: commerceRfqDocument.encryptedDocumentId,
        createdAt: commerceRfqDocument.createdAt,
      })
      .from(commerceRfqDocument)
      .where(eq(commerceRfqDocument.rfqId, rfq.id)),
    db
      .select({
        id: commerceRfqInvitation.id,
        providerOrganizationId: commerceRfqInvitation.providerOrganizationId,
        state: commerceRfqInvitation.state,
        sentAt: commerceRfqInvitation.sentAt,
        createdAt: commerceRfqInvitation.createdAt,
      })
      .from(commerceRfqInvitation)
      .where(eq(commerceRfqInvitation.rfqId, rfq.id)),
  ]);

  const serviceLinesWithRequirements: ServiceLineWithRequirementProjection[] = [];
  for (const serviceLine of serviceLines) {
    const requirementDetail = await loadRequirementDetailForServiceLine(serviceLine);
    serviceLinesWithRequirements.push({
      id: serviceLine.id,
      rfqId: serviceLine.rfqId,
      providerKind: serviceLine.providerKind,
      serviceOfferingId: serviceLine.serviceOfferingId,
      linkedProductLineId: serviceLine.linkedProductLineId,
      requirementSummary: serviceLine.requirementSummary,
      siblingOrder: serviceLine.siblingOrder,
      createdAt: serviceLine.createdAt.toISOString(),
      requirementDetail,
    });
  }

  return {
    id: rfq.id,
    buyerOrganizationId: rfq.buyerOrganizationId,
    createdByMemberId: rfq.createdByMemberId,
    title: rfq.title,
    description: rfq.description,
    state: rfq.state,
    visibility: rfq.visibility,
    responseDeadlineAt: toIsoOrNull(rfq.responseDeadlineAt),
    desiredDeliveryStartsAt: toIsoOrNull(rfq.desiredDeliveryStartsAt),
    desiredDeliveryEndsAt: toIsoOrNull(rfq.desiredDeliveryEndsAt),
    destinationAddressId: rfq.destinationAddressId,
    destinationCountryCode: rfq.destinationCountryCode,
    destinationLocality: rfq.destinationLocality,
    settlementCurrency: rfq.settlementCurrency,
    openedAt: toIsoOrNull(rfq.openedAt),
    closedAt: toIsoOrNull(rfq.closedAt),
    awardedAt: toIsoOrNull(rfq.awardedAt),
    createdAt: rfq.createdAt.toISOString(),
    updatedAt: rfq.updatedAt.toISOString(),
    productLines,
    serviceLines: serviceLinesWithRequirements,
    documents: documents.map((document) => ({
      id: document.id,
      encryptedDocumentId: document.encryptedDocumentId,
      createdAt: document.createdAt.toISOString(),
    })),
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      providerOrganizationId: invitation.providerOrganizationId,
      state: invitation.state,
      sentAt: toIsoOrNull(invitation.sentAt),
      createdAt: invitation.createdAt.toISOString(),
    })),
    callerRelation,
  };
}

async function resolveCallerRelation(input: {
  readonly rfq: RfqRow;
  readonly callerOrganizationId: string;
}): Promise<RfqDetailProjection["callerRelation"] | null> {
  if (input.rfq.buyerOrganizationId === input.callerOrganizationId) {
    return "buyer";
  }

  const [invitation] = await db
    .select({ id: commerceRfqInvitation.id })
    .from(commerceRfqInvitation)
    .where(
      and(
        eq(commerceRfqInvitation.rfqId, input.rfq.id),
        eq(commerceRfqInvitation.providerOrganizationId, input.callerOrganizationId),
      ),
    )
    .limit(1);
  if (invitation) return "invited_provider";

  if (input.rfq.visibility === "matched_providers" && input.rfq.state === "open") {
    const matchingKinds = await db
      .select({ providerKind: commerceRfqServiceLine.providerKind })
      .from(commerceRfqServiceLine)
      .where(eq(commerceRfqServiceLine.rfqId, input.rfq.id));
    if (matchingKinds.length === 0) return null;

    const [verifiedLink] = await db
      .select({ id: commerceProviderKindLink.id })
      .from(commerceProviderKindLink)
      .innerJoin(
        commerceProviderProfile,
        eq(commerceProviderProfile.organizationId, commerceProviderKindLink.organizationId),
      )
      .innerJoin(
        commerceOrganization,
        eq(commerceOrganization.id, commerceProviderKindLink.organizationId),
      )
      .where(
        and(
          eq(commerceProviderKindLink.organizationId, input.callerOrganizationId),
          eq(commerceProviderKindLink.verificationState, "verified"),
          eq(commerceProviderProfile.acceptingRequests, true),
          eq(commerceOrganization.tradeState, "active"),
          eq(commerceOrganization.visibility, "public"),
          inArray(
            commerceProviderKindLink.providerKind,
            matchingKinds.map((kind) => kind.providerKind),
          ),
        ),
      )
      .limit(1);
    if (verifiedLink) return "matched_provider";
  }

  return null;
}

export async function createDraftRfq(input: {
  readonly buyerOrganizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly body: CreateDraftRfqInput;
}): Promise<Result<RfqDetailProjection, CommerceRfqsError>> {
  const responseDeadlineAt = parseIsoDate(input.body.responseDeadlineAt, "responseDeadlineAt");
  if (!responseDeadlineAt.success) return responseDeadlineAt;
  const deliveryStartsAt = optionalIsoDate(
    input.body.desiredDeliveryStartsAt,
    "desiredDeliveryStartsAt",
  );
  if (!deliveryStartsAt.success) return deliveryStartsAt;
  const deliveryEndsAt = optionalIsoDate(input.body.desiredDeliveryEndsAt, "desiredDeliveryEndsAt");
  if (!deliveryEndsAt.success) return deliveryEndsAt;

  if (
    (deliveryStartsAt.value === undefined) !== (deliveryEndsAt.value === undefined) ||
    (deliveryStartsAt.value === null) !== (deliveryEndsAt.value === null)
  ) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "desiredDeliveryStartsAt and desiredDeliveryEndsAt must be set together.",
      },
    };
  }
  if (
    deliveryStartsAt.value instanceof Date &&
    deliveryEndsAt.value instanceof Date &&
    deliveryEndsAt.value < deliveryStartsAt.value
  ) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "desiredDeliveryEndsAt must be on or after desiredDeliveryStartsAt.",
      },
    };
  }

  try {
    const createdRfq = await db.transaction(async (transaction) => {
      if (input.body.destinationAddressId !== undefined) {
        const addressCheck = await assertOwnedAddress(
          transaction,
          input.buyerOrganizationId,
          input.body.destinationAddressId,
        );
        if (!addressCheck.success) abortRfqTransaction(addressCheck.error);
      }
      if (input.body.documentIds !== undefined) {
        const documentCheck = await assertOwnedDocuments(
          transaction,
          input.buyerOrganizationId,
          input.body.documentIds,
        );
        if (!documentCheck.success) abortRfqTransaction(documentCheck.error);
      }

      const [rfq] = await transaction
        .insert(commerceRfq)
        .values({
          buyerOrganizationId: input.buyerOrganizationId,
          createdByMemberId: input.memberId,
          title: input.body.title,
          description: input.body.description,
          state: "draft",
          visibility: input.body.visibility,
          responseDeadlineAt: responseDeadlineAt.value,
          desiredDeliveryStartsAt: deliveryStartsAt.value ?? null,
          desiredDeliveryEndsAt: deliveryEndsAt.value ?? null,
          destinationAddressId: input.body.destinationAddressId,
          destinationCountryCode: input.body.destinationCountryCode,
          destinationLocality: input.body.destinationLocality,
          settlementCurrency: input.body.settlementCurrency,
        })
        .returning();
      if (!rfq) throw new Error("RFQ insert returned no row.");

      const linesResult = await insertRfqLines(
        transaction,
        rfq.id,
        input.body.productLines,
        input.body.serviceLines,
      );
      if (!linesResult.success) abortRfqTransaction(linesResult.error);

      if (input.body.documentIds !== undefined) {
        const documentsResult = await replaceRfqDocuments(transaction, {
          rfqId: rfq.id,
          buyerOrganizationId: input.buyerOrganizationId,
          memberId: input.memberId,
          documentIds: input.body.documentIds,
        });
        if (!documentsResult.success) abortRfqTransaction(documentsResult.error);
      }

      return rfq;
    });

    return {
      success: true,
      value: await projectRfqDetail(createdRfq, "buyer"),
    };
  } catch (error: unknown) {
    if (isRfqTransactionAbort(error)) {
      return { success: false, error: error.error };
    }
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "RFQ line uniqueness conflict." },
      };
    }
    throw error;
  }
}

export async function listMyRfqs(input: {
  readonly buyerOrganizationId: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<Result<RfqListPage, CommerceRfqsError>> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceRfq.createdAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceRfq.createdAt, new Date(decodedCursor.sortKey)),
            gt(commerceRfq.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select()
    .from(commerceRfq)
    .where(and(eq(commerceRfq.buyerOrganizationId, input.buyerOrganizationId), cursorPredicate))
    .orderBy(desc(commerceRfq.createdAt), asc(commerceRfq.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({
          sortKey: lastRow.createdAt.toISOString(),
          id: lastRow.id,
        })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map(summarizeRfq),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

export async function getRfq(input: {
  readonly rfqId: string;
  readonly callerOrganizationId: string;
}): Promise<Result<RfqDetailProjection, CommerceRfqsError>> {
  const [rfq] = await db.select().from(commerceRfq).where(eq(commerceRfq.id, input.rfqId)).limit(1);
  if (!rfq) return { success: false, error: { type: "NOT_FOUND" } };

  const callerRelation = await resolveCallerRelation({
    rfq,
    callerOrganizationId: input.callerOrganizationId,
  });
  if (callerRelation === null) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  return { success: true, value: await projectRfqDetail(rfq, callerRelation) };
}

export async function updateDraftRfq(input: {
  readonly rfqId: string;
  readonly buyerOrganizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly patch: UpdateDraftRfqInput;
}): Promise<Result<RfqDetailProjection, CommerceRfqsError>> {
  const responseDeadlineAt = optionalIsoDate(input.patch.responseDeadlineAt, "responseDeadlineAt");
  if (!responseDeadlineAt.success) return responseDeadlineAt;
  const deliveryStartsAt = optionalIsoDate(
    input.patch.desiredDeliveryStartsAt,
    "desiredDeliveryStartsAt",
  );
  if (!deliveryStartsAt.success) return deliveryStartsAt;
  const deliveryEndsAt = optionalIsoDate(
    input.patch.desiredDeliveryEndsAt,
    "desiredDeliveryEndsAt",
  );
  if (!deliveryEndsAt.success) return deliveryEndsAt;

  try {
    const updatedRfq = await db.transaction(async (transaction) => {
      const [rfq] = await transaction
        .select()
        .from(commerceRfq)
        .where(
          and(
            eq(commerceRfq.id, input.rfqId),
            eq(commerceRfq.buyerOrganizationId, input.buyerOrganizationId),
          ),
        )
        .for("update");
      if (!rfq) abortRfqTransaction({ type: "NOT_FOUND" });
      if (rfq.state !== "draft") {
        abortRfqTransaction({ type: "INVALID_STATE", message: "Only draft RFQs can be updated." });
      }

      if (input.patch.destinationAddressId) {
        const addressCheck = await assertOwnedAddress(
          transaction,
          input.buyerOrganizationId,
          input.patch.destinationAddressId,
        );
        if (!addressCheck.success) abortRfqTransaction(addressCheck.error);
      }

      const nextStartsAt =
        deliveryStartsAt.value === undefined ? rfq.desiredDeliveryStartsAt : deliveryStartsAt.value;
      const nextEndsAt =
        deliveryEndsAt.value === undefined ? rfq.desiredDeliveryEndsAt : deliveryEndsAt.value;
      if ((nextStartsAt === null) !== (nextEndsAt === null)) {
        abortRfqTransaction({
          type: "VALIDATION_FAILED",
          message: "desiredDeliveryStartsAt and desiredDeliveryEndsAt must be set together.",
        });
      }
      if (nextStartsAt !== null && nextEndsAt !== null && nextEndsAt < nextStartsAt) {
        abortRfqTransaction({
          type: "VALIDATION_FAILED",
          message: "desiredDeliveryEndsAt must be on or after desiredDeliveryStartsAt.",
        });
      }

      const [nextRfq] = await transaction
        .update(commerceRfq)
        .set({
          title: input.patch.title,
          description: input.patch.description,
          visibility: input.patch.visibility,
          responseDeadlineAt:
            responseDeadlineAt.value === undefined ? undefined : responseDeadlineAt.value,
          desiredDeliveryStartsAt: deliveryStartsAt.value,
          desiredDeliveryEndsAt: deliveryEndsAt.value,
          destinationAddressId: input.patch.destinationAddressId,
          destinationCountryCode: input.patch.destinationCountryCode,
          destinationLocality: input.patch.destinationLocality,
          settlementCurrency: input.patch.settlementCurrency,
          updatedAt: new Date(),
        })
        .where(eq(commerceRfq.id, rfq.id))
        .returning();
      if (!nextRfq) throw new Error("RFQ update returned no row.");

      if (input.patch.productLines !== undefined || input.patch.serviceLines !== undefined) {
        const nextProductLines = input.patch.productLines ?? [];
        const nextServiceLines = input.patch.serviceLines ?? [];
        await transaction
          .delete(commerceRfqServiceLine)
          .where(eq(commerceRfqServiceLine.rfqId, rfq.id));
        await transaction
          .delete(commerceRfqProductLine)
          .where(eq(commerceRfqProductLine.rfqId, rfq.id));
        const linesResult = await insertRfqLines(
          transaction,
          rfq.id,
          nextProductLines,
          nextServiceLines,
        );
        if (!linesResult.success) abortRfqTransaction(linesResult.error);
      }

      if (input.patch.documentIds !== undefined) {
        const documentsResult = await replaceRfqDocuments(transaction, {
          rfqId: rfq.id,
          buyerOrganizationId: input.buyerOrganizationId,
          memberId: input.memberId,
          documentIds: input.patch.documentIds,
        });
        if (!documentsResult.success) abortRfqTransaction(documentsResult.error);
      }

      return nextRfq;
    });

    return { success: true, value: await projectRfqDetail(updatedRfq, "buyer") };
  } catch (error: unknown) {
    if (isRfqTransactionAbort(error)) {
      return { success: false, error: error.error };
    }
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "RFQ line uniqueness conflict." },
      };
    }
    throw error;
  }
}

export async function openRfq(input: {
  readonly rfqId: string;
  readonly buyerOrganizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
}): Promise<Result<RfqDetailProjection, CommerceRfqsError>> {
  try {
    const openedRfq = await db.transaction(async (transaction) => {
      const [rfq] = await transaction
        .select()
        .from(commerceRfq)
        .where(
          and(
            eq(commerceRfq.id, input.rfqId),
            eq(commerceRfq.buyerOrganizationId, input.buyerOrganizationId),
          ),
        )
        .for("update");
      if (!rfq) abortRfqTransaction({ type: "NOT_FOUND" });
      if (rfq.state !== "draft") {
        abortRfqTransaction({ type: "INVALID_STATE", message: "Only draft RFQs can be opened." });
      }

      const [buyerOrganization] = await transaction
        .select({ tradeState: commerceOrganization.tradeState })
        .from(commerceOrganization)
        .where(eq(commerceOrganization.id, input.buyerOrganizationId))
        .limit(1);
      if (!buyerOrganization || buyerOrganization.tradeState !== "active") {
        abortRfqTransaction({ type: "ORGANIZATION_NOT_ACTIVE" });
      }

      if (rfq.responseDeadlineAt === null || rfq.responseDeadlineAt.getTime() <= Date.now()) {
        abortRfqTransaction({ type: "DEADLINE_INVALID" });
      }

      const [productLines, serviceLines] = await Promise.all([
        transaction
          .select()
          .from(commerceRfqProductLine)
          .where(eq(commerceRfqProductLine.rfqId, rfq.id)),
        transaction
          .select()
          .from(commerceRfqServiceLine)
          .where(eq(commerceRfqServiceLine.rfqId, rfq.id)),
      ]);
      if (productLines.length === 0 && serviceLines.length === 0) {
        abortRfqTransaction({ type: "LINES_REQUIRED" });
      }

      for (const serviceLine of serviceLines) {
        const hasRequirement = await serviceLineHasRequirementRow(transaction, serviceLine);
        if (!hasRequirement) {
          abortRfqTransaction({
            type: "VALIDATION_FAILED",
            message: "Every service line must have a typed requirement detail row.",
          });
        }
      }

      if (rfq.destinationAddressId !== null) {
        const addressCheck = await assertOwnedAddress(
          transaction,
          input.buyerOrganizationId,
          rfq.destinationAddressId,
        );
        if (!addressCheck.success) abortRfqTransaction(addressCheck.error);
      }

      const attachedDocuments = await transaction
        .select({
          encryptedDocumentId: commerceRfqDocument.encryptedDocumentId,
        })
        .from(commerceRfqDocument)
        .where(eq(commerceRfqDocument.rfqId, rfq.id));
      if (attachedDocuments.length > 0) {
        const documentCheck = await assertOwnedDocuments(
          transaction,
          input.buyerOrganizationId,
          attachedDocuments.map((document) => document.encryptedDocumentId),
        );
        if (!documentCheck.success) abortRfqTransaction(documentCheck.error);
      }

      const openedAt = new Date();
      const [nextRfq] = await transaction
        .update(commerceRfq)
        .set({
          state: "open",
          openedAt,
          updatedAt: openedAt,
        })
        .where(and(eq(commerceRfq.id, rfq.id), eq(commerceRfq.state, "draft")))
        .returning();
      if (!nextRfq) {
        abortRfqTransaction({ type: "CONFLICT", message: "RFQ open raced with another update." });
      }

      await appendAuditOrThrow(transaction, {
        organizationId: input.buyerOrganizationId,
        eventKind: "rfq_opened",
        actorUserId: input.actorUserId,
        actorMemberRoleSnapshot: input.memberRole,
        targetEntityType: "commerce_rfq",
        targetEntityId: rfq.id,
        payload: {
          visibility: nextRfq.visibility,
          productLineCount: String(productLines.length),
          serviceLineCount: String(serviceLines.length),
        },
        occurredAt: openedAt,
      });

      return nextRfq;
    });

    return { success: true, value: await projectRfqDetail(openedRfq, "buyer") };
  } catch (error: unknown) {
    if (isRfqTransactionAbort(error)) {
      return { success: false, error: error.error };
    }
    throw error;
  }
}

async function assertProviderEligibleForInvitation(
  transaction: DatabaseTransaction,
  input: {
    readonly providerOrganizationId: string;
    readonly requiredProviderKinds: readonly ProviderKind[];
  },
): Promise<Result<true, CommerceRfqsError>> {
  if (input.requiredProviderKinds.length === 0) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "RFQ must include at least one service line before inviting providers.",
      },
    };
  }

  const [eligible] = await transaction
    .select({ organizationId: commerceOrganization.id })
    .from(commerceOrganization)
    .innerJoin(
      commerceProviderProfile,
      eq(commerceProviderProfile.organizationId, commerceOrganization.id),
    )
    .innerJoin(
      commerceProviderKindLink,
      eq(commerceProviderKindLink.organizationId, commerceOrganization.id),
    )
    .where(
      and(
        eq(commerceOrganization.id, input.providerOrganizationId),
        eq(commerceOrganization.tradeState, "active"),
        eq(commerceOrganization.visibility, "public"),
        eq(commerceProviderProfile.acceptingRequests, true),
        eq(commerceProviderKindLink.verificationState, "verified"),
        inArray(commerceProviderKindLink.providerKind, [...input.requiredProviderKinds]),
      ),
    )
    .limit(1);

  if (!eligible) {
    return {
      success: false,
      error: {
        type: "PROVIDER_INELIGIBLE",
        providerOrganizationId: input.providerOrganizationId,
      },
    };
  }
  return { success: true, value: true };
}

export async function inviteProviders(input: {
  readonly rfqId: string;
  readonly buyerOrganizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly providerOrganizationIds: readonly string[];
}): Promise<
  Result<{ readonly invitations: readonly RfqInvitationProjection[] }, CommerceRfqsError>
> {
  const uniqueProviderOrganizationIds = [...new Set(input.providerOrganizationIds)];
  if (uniqueProviderOrganizationIds.length === 0) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "providerOrganizationIds must include at least one organization.",
      },
    };
  }

  try {
    const createdInvitations = await db.transaction(async (transaction) => {
      const [rfq] = await transaction
        .select()
        .from(commerceRfq)
        .where(
          and(
            eq(commerceRfq.id, input.rfqId),
            eq(commerceRfq.buyerOrganizationId, input.buyerOrganizationId),
          ),
        )
        .for("update");
      if (!rfq) abortRfqTransaction({ type: "NOT_FOUND" });
      if (rfq.state !== "open") {
        abortRfqTransaction({
          type: "INVALID_STATE",
          message: "Providers can only be invited to open RFQs.",
        });
      }

      const serviceLines = await transaction
        .select({ providerKind: commerceRfqServiceLine.providerKind })
        .from(commerceRfqServiceLine)
        .where(eq(commerceRfqServiceLine.rfqId, rfq.id));
      const requiredProviderKinds = [
        ...new Set(serviceLines.map((serviceLine) => serviceLine.providerKind)),
      ];

      const sentAt = new Date();
      const invitations: InvitationRow[] = [];
      for (const providerOrganizationId of uniqueProviderOrganizationIds) {
        const eligibility = await assertProviderEligibleForInvitation(transaction, {
          providerOrganizationId,
          requiredProviderKinds,
        });
        if (!eligibility.success) abortRfqTransaction(eligibility.error);

        const [invitation] = await transaction
          .insert(commerceRfqInvitation)
          .values({
            rfqId: rfq.id,
            providerOrganizationId,
            state: "sent",
            invitedByMemberId: input.memberId,
            sentAt,
          })
          .returning();
        if (!invitation) throw new Error("RFQ invitation insert returned no row.");
        invitations.push(invitation);
      }

      return invitations;
    });

    return {
      success: true,
      value: {
        invitations: createdInvitations.map((invitation) => ({
          id: invitation.id,
          providerOrganizationId: invitation.providerOrganizationId,
          state: invitation.state,
          sentAt: toIsoOrNull(invitation.sentAt),
          createdAt: invitation.createdAt.toISOString(),
        })),
      },
    };
  } catch (error: unknown) {
    if (isRfqTransactionAbort(error)) {
      return { success: false, error: error.error };
    }
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "Provider is already invited to this RFQ." },
      };
    }
    throw error;
  }
}

export async function closeRfq(input: {
  readonly rfqId: string;
  readonly buyerOrganizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
}): Promise<Result<RfqDetailProjection, CommerceRfqsError>> {
  try {
    const closedRfq = await db.transaction(async (transaction) => {
      const [rfq] = await transaction
        .select()
        .from(commerceRfq)
        .where(
          and(
            eq(commerceRfq.id, input.rfqId),
            eq(commerceRfq.buyerOrganizationId, input.buyerOrganizationId),
          ),
        )
        .for("update");
      if (!rfq) abortRfqTransaction({ type: "NOT_FOUND" });
      if (rfq.state !== "open") {
        abortRfqTransaction({ type: "INVALID_STATE", message: "Only open RFQs can be closed." });
      }

      const closedAt = new Date();
      const [nextRfq] = await transaction
        .update(commerceRfq)
        .set({
          state: "closed",
          closedAt,
          updatedAt: closedAt,
        })
        .where(and(eq(commerceRfq.id, rfq.id), eq(commerceRfq.state, "open")))
        .returning();
      if (!nextRfq) {
        abortRfqTransaction({ type: "CONFLICT", message: "RFQ close raced with another update." });
      }

      await appendAuditOrThrow(transaction, {
        organizationId: input.buyerOrganizationId,
        eventKind: "rfq_closed",
        actorUserId: input.actorUserId,
        actorMemberRoleSnapshot: input.memberRole,
        targetEntityType: "commerce_rfq",
        targetEntityId: rfq.id,
        payload: { previousState: "open" },
        occurredAt: closedAt,
      });

      return nextRfq;
    });

    return { success: true, value: await projectRfqDetail(closedRfq, "buyer") };
  } catch (error: unknown) {
    if (isRfqTransactionAbort(error)) {
      return { success: false, error: error.error };
    }
    throw error;
  }
}

export async function listProviderRfqs(input: {
  readonly providerOrganizationId: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<Result<RfqListPage, CommerceRfqsError>> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceRfq.createdAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceRfq.createdAt, new Date(decodedCursor.sortKey)),
            gt(commerceRfq.id, decodedCursor.id),
          ),
        );

  const invitedExists = exists(
    db
      .select({ id: commerceRfqInvitation.id })
      .from(commerceRfqInvitation)
      .where(
        and(
          eq(commerceRfqInvitation.rfqId, commerceRfq.id),
          eq(commerceRfqInvitation.providerOrganizationId, input.providerOrganizationId),
        ),
      ),
  );

  const matchedExists = exists(
    db
      .select({ id: commerceRfqServiceLine.id })
      .from(commerceRfqServiceLine)
      .innerJoin(
        commerceProviderKindLink,
        and(
          eq(commerceProviderKindLink.providerKind, commerceRfqServiceLine.providerKind),
          eq(commerceProviderKindLink.organizationId, input.providerOrganizationId),
          eq(commerceProviderKindLink.verificationState, "verified"),
        ),
      )
      .innerJoin(
        commerceProviderProfile,
        and(
          eq(commerceProviderProfile.organizationId, input.providerOrganizationId),
          eq(commerceProviderProfile.acceptingRequests, true),
        ),
      )
      .where(
        and(
          eq(commerceRfqServiceLine.rfqId, commerceRfq.id),
          eq(commerceRfq.visibility, "matched_providers"),
          eq(commerceRfq.state, "open"),
        ),
      ),
  );

  const rows = await db
    .select()
    .from(commerceRfq)
    .where(and(or(invitedExists, matchedExists), cursorPredicate))
    .orderBy(desc(commerceRfq.createdAt), asc(commerceRfq.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({
          sortKey: lastRow.createdAt.toISOString(),
          id: lastRow.id,
        })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map(summarizeRfq),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}
