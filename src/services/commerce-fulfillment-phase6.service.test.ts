import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { CreateShipmentWithLegsSchema, ServiceEngagementCommandSchema, ShipmentLegCommandSchema } =
  await import("#src/schemas/commerce-fulfillment.schemas.js");
const { buildFulfillmentRequestFingerprint, computeFulfillmentProgress, isShipmentLegCommandAllowed } =
  await import("#src/services/commerce-fulfillment-phase6.service.js");

describe("commerce fulfillment Phase 6 schemas", () => {
  it("rejects create-shipment bodies with unknown keys", () => {
    const parsed = CreateShipmentWithLegsSchema.safeParse({
      lines: [{ orderProductLineId: "opl_1", quantity: 1 }],
      packageCount: 1,
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts optional immutable legs on shipment creation", () => {
    const parsed = CreateShipmentWithLegsSchema.safeParse({
      lines: [{ orderProductLineId: "opl_1", quantity: 2 }],
      packageCount: 1,
      legs: [
        {
          sequence: 0,
          mode: "air",
          originCountryCode: "US",
          destinationCountryCode: "DE",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("requires expectedVersion on every shipment-leg command", () => {
    const parsed = ShipmentLegCommandSchema.safeParse({
      command: "book",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires typed initialize details matching a provider kind", () => {
    const missing = ServiceEngagementCommandSchema.safeParse({
      command: "initialize",
      expectedVersion: 0,
      deliverables: [],
    });
    expect(missing.success).toBe(false);

    const ok = ServiceEngagementCommandSchema.safeParse({
      command: "initialize",
      expectedVersion: 0,
      details: {
        kind: "customs_broker",
        jurisdictions: ["US-CBP"],
      },
      deliverables: [{ sequence: 0, title: "Entry filing", isRequired: true }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects deliverable results that omit kind", () => {
    const parsed = ServiceEngagementCommandSchema.safeParse({
      command: "submit_deliverable",
      expectedVersion: 1,
      deliverableId: "del_1",
      result: { filingKind: "import_entry" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("commerce fulfillment Phase 6 workflow helpers", () => {
  it("fingerprints ignore key order and drop undefined", () => {
    const left = buildFulfillmentRequestFingerprint({
      path: "/commerce/shipment-legs/leg-1/commands",
      body: { command: "book", expectedVersion: 0, note: undefined },
    });
    const right = buildFulfillmentRequestFingerprint({
      body: { expectedVersion: 0, command: "book" },
      path: "/commerce/shipment-legs/leg-1/commands",
    });
    expect(left).toBe(right);

    const conflict = buildFulfillmentRequestFingerprint({
      path: "/commerce/shipment-legs/leg-1/commands",
      body: { command: "book", expectedVersion: 1 },
    });
    expect(conflict).not.toBe(left);
  });

  it("enforces legal shipment-leg transitions", () => {
    expect(isShipmentLegCommandAllowed("planned", "book")).toBe(true);
    expect(isShipmentLegCommandAllowed("planned", "depart")).toBe(false);
    expect(isShipmentLegCommandAllowed("booked", "depart")).toBe(true);
    expect(isShipmentLegCommandAllowed("in_transit", "arrive")).toBe(true);
    expect(isShipmentLegCommandAllowed("arrived", "complete")).toBe(true);
    expect(isShipmentLegCommandAllowed("completed", "cancel")).toBe(false);
    expect(isShipmentLegCommandAllowed("cancelled", "book")).toBe(false);
  });

  it("derives deterministic progress from legs and engagements", () => {
    const progress = computeFulfillmentProgress({
      orderState: "in_fulfillment",
      productLines: [{ quantityOrdered: 10, quantityFulfilled: 10, quantityCancelled: 0 }],
      shipments: [{ id: "ship_1", state: "in_transit" }],
      legs: [
        { shipmentId: "ship_1", state: "completed" },
        { shipmentId: "ship_1", state: "in_transit" },
        { shipmentId: "ship_1", state: "cancelled" },
      ],
      engagements: [{ state: "awaiting_buyer" }, { state: "completed" }, { state: "cancelled" }],
    });

    // product (complete) + 2 non-cancelled legs + 2 non-cancelled engagements = 5
    expect(progress.totalUnits).toBe(5);
    expect(progress.completedUnits).toBe(3);
    expect(progress.basisPoints).toBe(6000);
    expect(progress.overallState).toBe("awaiting_buyer");
  });

  it("marks disputed engagements as attention_required", () => {
    const progress = computeFulfillmentProgress({
      orderState: "in_fulfillment",
      productLines: [],
      shipments: [],
      legs: [],
      engagements: [{ state: "disputed" }],
    });
    expect(progress.overallState).toBe("attention_required");
    expect(progress.basisPoints).toBe(0);
  });

  it("returns full basis points when there is no active work", () => {
    const progress = computeFulfillmentProgress({
      orderState: "confirmed",
      productLines: [],
      shipments: [],
      legs: [],
      engagements: [],
    });
    expect(progress).toEqual({
      completedUnits: 0,
      totalUnits: 0,
      basisPoints: 10_000,
      overallState: "not_started",
    });
  });
});
