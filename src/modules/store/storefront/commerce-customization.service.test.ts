import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

/**
 * The resolver runs two reads: the product's active options, then the buyer's documents.
 * Queueing their results lets the whole validation ladder be exercised without a
 * database, which is where every rule in A18 actually lives.
 */
const queuedResults = vi.hoisted(() => ({ rows: [] as unknown[][] }));

function buildQueryStub() {
  /**
   * `where()` returns a real Promise with `orderBy` attached, so both call shapes the
   * resolver uses — `.where(...)` awaited directly, and `.where(...).orderBy(...)` —
   * resolve to the SAME queued row set and shift the queue exactly once.
   */
  let pendingRows: Promise<unknown[]> | null = null;
  const resolveRows = (): Promise<unknown[]> => {
    pendingRows ??= Promise.resolve(queuedResults.rows.shift() ?? []);
    return pendingRows;
  };
  const stub = {
    from: () => stub,
    where: () => Object.assign(resolveRows(), { orderBy: resolveRows }),
  };
  return stub;
}

vi.mock("#src/db/index.js", () => ({
  db: { select: () => buildQueryStub() },
  pool: {},
}));

const { resolveCustomizationSelections } =
  await import("#src/modules/store/storefront/commerce-customization.service.js");
const { db } = await import("#src/db/index.js");

const LOGO_OPTION = {
  id: "option_logo",
  productId: "prd_1",
  slotKey: "logo",
  label: "Your logo",
  customizationKind: "file_upload",
  acceptedMediaTypes: ["image/png"],
  choiceValues: [],
  minimumOrderQuantity: 50,
  isRequired: false,
  position: 0,
  state: "active",
};

const PACKAGING_OPTION = {
  ...LOGO_OPTION,
  id: "option_packaging",
  slotKey: "packaging_material",
  label: "Packaging material",
  customizationKind: "choice",
  acceptedMediaTypes: [],
  choiceValues: ["kraft", "corrugated"],
  minimumOrderQuantity: 200,
  isRequired: true,
  position: 1,
};

const SCANNED_ARTWORK = { id: "doc_1", documentKind: "customization_artwork" };

function queue(optionRows: unknown[], documentRows: unknown[] = []): void {
  queuedResults.rows = [optionRows, documentRows];
}

describe("customization selections (A18)", () => {
  /**
   * The rule the whole entry exists for: a per-slot minimum order quantity is a
   * COMMERCIAL TERM. A logo at 50 units changes what the buyer may order, and the mock
   * this replaces enforced nothing.
   */
  it("refuses a quantity below the slot's minimum order quantity", async () => {
    queue([LOGO_OPTION], [SCANNED_ARTWORK]);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 20,
      selections: [{ slotKey: "logo", encryptedDocumentId: "doc_1" }],
      requireRequiredOptions: false,
    });

    expect(resolved).toEqual({
      success: false,
      error: {
        type: "BELOW_CUSTOMIZATION_MINIMUM",
        slotKey: "logo",
        minimumOrderQuantity: 50,
        quantity: 20,
      },
    });
  });

  it("accepts a scanned artwork upload at or above the minimum", async () => {
    queue([LOGO_OPTION], [SCANNED_ARTWORK]);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 50,
      selections: [{ slotKey: "logo", encryptedDocumentId: "doc_1" }],
      requireRequiredOptions: false,
    });

    expect(resolved.success).toBe(true);
    expect(resolved).toMatchObject({
      value: [
        {
          customizationOptionId: "option_logo",
          slotKeySnapshot: "logo",
          labelSnapshot: "Your logo",
          encryptedDocumentId: "doc_1",
          choiceValue: null,
        },
      ],
    });
  });

  /**
   * A document that is not the buyer's, or has not cleared scanning, never reaches the
   * query result — so "unowned" and "unscanned" are one rejection, which is also what
   * stops a buyer probing which document ids exist.
   */
  it("refuses a document the buyer does not own or that is unscanned", async () => {
    queue([LOGO_OPTION], []);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 50,
      selections: [{ slotKey: "logo", encryptedDocumentId: "doc_someone_else" }],
      requireRequiredOptions: false,
    });

    expect(resolved).toEqual({
      success: false,
      error: { type: "DOCUMENT_NOT_OWNED", encryptedDocumentId: "doc_someone_else" },
    });
  });

  it("refuses a document of the wrong kind", async () => {
    queue([LOGO_OPTION], [{ id: "doc_1", documentKind: "tax_registration" }]);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 50,
      selections: [{ slotKey: "logo", encryptedDocumentId: "doc_1" }],
      requireRequiredOptions: false,
    });

    expect(resolved).toEqual({
      success: false,
      error: { type: "DOCUMENT_KIND_INVALID", encryptedDocumentId: "doc_1" },
    });
  });

  it("refuses a choice value the seller never offered", async () => {
    queue([PACKAGING_OPTION]);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 200,
      selections: [{ slotKey: "packaging_material", choiceValue: "gold_leaf" }],
      requireRequiredOptions: false,
    });

    expect(resolved).toEqual({
      success: false,
      error: { type: "CHOICE_VALUE_INVALID", slotKey: "packaging_material" },
    });
  });

  it("refuses an upload slot supplied with a value", async () => {
    queue([LOGO_OPTION]);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 50,
      selections: [{ slotKey: "logo", choiceValue: "kraft" }],
      requireRequiredOptions: false,
    });

    expect(resolved).toEqual({
      success: false,
      error: { type: "OPTION_SUPPLY_MISMATCH", slotKey: "logo" },
    });
  });

  it("refuses a slot that is not this product's or has been retired", async () => {
    queue([LOGO_OPTION]);

    const resolved = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 50,
      selections: [{ slotKey: "engraving", choiceValue: "serif" }],
      requireRequiredOptions: false,
    });

    expect(resolved).toEqual({
      success: false,
      error: { type: "OPTION_NOT_AVAILABLE", slotKeys: ["engraving"] },
    });
  });

  /**
   * A buyer may build a cart before uploading artwork, but must not confirm an order
   * missing something the seller declared mandatory — which is why the same function
   * takes this as a parameter rather than deciding it.
   */
  it("only demands required slots when checkout asks it to", async () => {
    queue([PACKAGING_OPTION]);
    const inCart = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 200,
      selections: [],
      requireRequiredOptions: false,
    });
    expect(inCart).toEqual({ success: true, value: [] });

    queue([PACKAGING_OPTION]);
    const atCheckout = await resolveCustomizationSelections(db, {
      productId: "prd_1",
      buyerOrganizationId: "commerce_org_buyer",
      quantity: 200,
      selections: [],
      requireRequiredOptions: true,
    });
    expect(atCheckout).toEqual({
      success: false,
      error: { type: "REQUIRED_OPTION_MISSING", slotKeys: ["packaging_material"] },
    });
  });
});
