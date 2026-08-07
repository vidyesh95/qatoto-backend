import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceEncryptedDocument, commerceProductCustomizationOption } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Buyer-supplied customization selections (Appendix A18).
 *
 * THE RULE THIS FILE EXISTS FOR: a slot's `minimumOrderQuantity` is a COMMERCIAL TERM,
 * not a display hint. A logo at 50 units and packaging artwork at 200 change what the
 * buyer may order, so the server checks it when the line enters the cart and again when
 * checkout is prepared. The mock this replaces enforced nothing.
 */

export type CommerceCustomizationError =
  /** Names a slot that is not this product's, or has been retired. */
  | { type: "OPTION_NOT_AVAILABLE"; slotKeys: readonly string[] }
  /** An upload slot given a value, or a choice slot given a document. */
  | { type: "OPTION_SUPPLY_MISMATCH"; slotKey: string }
  | { type: "CHOICE_VALUE_INVALID"; slotKey: string }
  /** The document is not the buyer's, or has not cleared scanning. */
  | { type: "DOCUMENT_NOT_OWNED"; encryptedDocumentId: string }
  | { type: "DOCUMENT_KIND_INVALID"; encryptedDocumentId: string }
  | {
      type: "BELOW_CUSTOMIZATION_MINIMUM";
      slotKey: string;
      minimumOrderQuantity: number;
      quantity: number;
    }
  /** A slot the seller marked required was not supplied. */
  | { type: "REQUIRED_OPTION_MISSING"; slotKeys: readonly string[] };

export interface CustomizationSelectionInput {
  readonly slotKey: string;
  readonly encryptedDocumentId?: string | undefined;
  readonly choiceValue?: string | undefined;
}

/** A selection that has been checked against the seller's plan and the buyer's documents. */
export interface ResolvedCustomizationSelection {
  readonly customizationOptionId: string;
  readonly slotKeySnapshot: string;
  readonly labelSnapshot: string;
  readonly encryptedDocumentId: string | null;
  readonly choiceValue: string | null;
}

/**
 * Validates a line's selections against the product's ACTIVE plan.
 *
 * `requireRequiredOptions` is false in the cart and true at checkout preparation: a
 * buyer should be able to build a cart before uploading artwork, but must not be able to
 * confirm an order missing something the seller declared mandatory.
 */
export async function resolveCustomizationSelections(
  databaseExecutor: DatabaseTransaction | typeof db,
  input: {
    readonly productId: string;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly selections: readonly CustomizationSelectionInput[];
    readonly requireRequiredOptions: boolean;
  },
): Promise<Result<readonly ResolvedCustomizationSelection[], CommerceCustomizationError>> {
  const activeOptions = await databaseExecutor
    .select()
    .from(commerceProductCustomizationOption)
    .where(
      and(
        eq(commerceProductCustomizationOption.productId, input.productId),
        eq(commerceProductCustomizationOption.state, "active"),
      ),
    )
    .orderBy(asc(commerceProductCustomizationOption.position));

  const optionBySlotKey = new Map(activeOptions.map((option) => [option.slotKey, option]));

  const unknownSlotKeys = input.selections
    .map((selection) => selection.slotKey)
    .filter((slotKey) => !optionBySlotKey.has(slotKey));
  if (unknownSlotKeys.length > 0) {
    return {
      success: false,
      error: { type: "OPTION_NOT_AVAILABLE", slotKeys: [...new Set(unknownSlotKeys)] },
    };
  }

  if (input.requireRequiredOptions) {
    const suppliedSlotKeys = new Set(input.selections.map((selection) => selection.slotKey));
    const missing = activeOptions
      .filter((option) => option.isRequired && !suppliedSlotKeys.has(option.slotKey))
      .map((option) => option.slotKey);
    if (missing.length > 0) {
      return { success: false, error: { type: "REQUIRED_OPTION_MISSING", slotKeys: missing } };
    }
  }

  const documentIds = input.selections.flatMap((selection) =>
    selection.encryptedDocumentId === undefined ? [] : [selection.encryptedDocumentId],
  );
  /**
   * Ownership AND `available` state, the gate `commerce-messages.service.ts` uses for
   * message attachments. A document still `pending_scan` has not cleared the scanner,
   * and one owned by another organization is not the buyer's to attach.
   */
  const ownedDocuments =
    documentIds.length === 0
      ? []
      : await databaseExecutor
          .select({
            id: commerceEncryptedDocument.id,
            documentKind: commerceEncryptedDocument.documentKind,
          })
          .from(commerceEncryptedDocument)
          .where(
            and(
              inArray(commerceEncryptedDocument.id, [...new Set(documentIds)]),
              eq(commerceEncryptedDocument.organizationId, input.buyerOrganizationId),
              eq(commerceEncryptedDocument.state, "available"),
            ),
          );
  const ownedDocumentById = new Map(ownedDocuments.map((row) => [row.id, row]));

  const resolved: ResolvedCustomizationSelection[] = [];
  for (const selection of input.selections) {
    const option = optionBySlotKey.get(selection.slotKey);
    if (option === undefined) continue;

    if (input.quantity < option.minimumOrderQuantity) {
      return {
        success: false,
        error: {
          type: "BELOW_CUSTOMIZATION_MINIMUM",
          slotKey: option.slotKey,
          minimumOrderQuantity: option.minimumOrderQuantity,
          quantity: input.quantity,
        },
      };
    }

    if (option.customizationKind === "file_upload") {
      if (selection.encryptedDocumentId === undefined || selection.choiceValue !== undefined) {
        return {
          success: false,
          error: { type: "OPTION_SUPPLY_MISMATCH", slotKey: option.slotKey },
        };
      }
      const document = ownedDocumentById.get(selection.encryptedDocumentId);
      if (document === undefined) {
        return {
          success: false,
          error: { type: "DOCUMENT_NOT_OWNED", encryptedDocumentId: selection.encryptedDocumentId },
        };
      }
      if (document.documentKind !== "customization_artwork") {
        // A buyer must not be able to attach its own tax registration as artwork.
        return {
          success: false,
          error: {
            type: "DOCUMENT_KIND_INVALID",
            encryptedDocumentId: selection.encryptedDocumentId,
          },
        };
      }
      resolved.push({
        customizationOptionId: option.id,
        slotKeySnapshot: option.slotKey,
        labelSnapshot: option.label,
        encryptedDocumentId: selection.encryptedDocumentId,
        choiceValue: null,
      });
      continue;
    }

    if (selection.choiceValue === undefined || selection.encryptedDocumentId !== undefined) {
      return { success: false, error: { type: "OPTION_SUPPLY_MISMATCH", slotKey: option.slotKey } };
    }
    if (!option.choiceValues.includes(selection.choiceValue)) {
      return { success: false, error: { type: "CHOICE_VALUE_INVALID", slotKey: option.slotKey } };
    }
    resolved.push({
      customizationOptionId: option.id,
      slotKeySnapshot: option.slotKey,
      labelSnapshot: option.label,
      encryptedDocumentId: null,
      choiceValue: selection.choiceValue,
    });
  }

  return { success: true, value: resolved };
}
