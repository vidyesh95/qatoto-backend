import { describe, expect, it } from "vitest";

import { derivePromisedDeliveryAt, latestPromisedDeliveryAt } from "#src/lib/commerce-promised-delivery.js";

const ORDERED_AT = new Date("2026-08-07T12:00:00.000Z");

describe("derivePromisedDeliveryAt (A13)", () => {
  it("adds the declared lead time in whole UTC days", () => {
    expect(derivePromisedDeliveryAt({ orderedAt: ORDERED_AT, leadTimeMaxDays: 14 })).toEqual(
      new Date("2026-08-21T12:00:00.000Z"),
    );
  });

  it("treats a same-day lead time as the ordering instant", () => {
    expect(derivePromisedDeliveryAt({ orderedAt: ORDERED_AT, leadTimeMaxDays: 0 })).toEqual(ORDERED_AT);
  });

  /**
   * The distinction the whole metric rests on: a seller who declared nothing has promised
   * nothing, and must not be scored as having promised same-day delivery.
   */
  it("returns null — not the ordering instant — when no lead time was declared", () => {
    expect(
      derivePromisedDeliveryAt({
        orderedAt: ORDERED_AT,
        leadTimeMaxDays: null,
      }),
    ).toBeNull();
  });

  it("refuses a negative or fractional lead time rather than inventing a date", () => {
    expect(derivePromisedDeliveryAt({ orderedAt: ORDERED_AT, leadTimeMaxDays: -3 })).toBeNull();
    expect(derivePromisedDeliveryAt({ orderedAt: ORDERED_AT, leadTimeMaxDays: 2.5 })).toBeNull();
  });

  it("crosses a DST boundary without shifting, because the arithmetic is UTC", () => {
    // 2026-03-29 is the European DST transition; a calendar-field addition would drift.
    const beforeTransition = new Date("2026-03-28T23:00:00.000Z");
    expect(
      derivePromisedDeliveryAt({
        orderedAt: beforeTransition,
        leadTimeMaxDays: 2,
      }),
    ).toEqual(new Date("2026-03-30T23:00:00.000Z"));
  });
});

describe("latestPromisedDeliveryAt (A13)", () => {
  it("takes the slowest line, because the order is done when its last part lands", () => {
    expect(
      latestPromisedDeliveryAt([
        new Date("2026-08-10T00:00:00.000Z"),
        new Date("2026-08-28T00:00:00.000Z"),
        new Date("2026-08-14T00:00:00.000Z"),
      ]),
    ).toEqual(new Date("2026-08-28T00:00:00.000Z"));
  });

  it("is null when no line carried a promise", () => {
    expect(latestPromisedDeliveryAt([null, null])).toBeNull();
    expect(latestPromisedDeliveryAt([])).toBeNull();
  });

  /**
   * A partially-declared order is still promised by the lines that declared. Dropping the
   * promise entirely would let a seller escape measurement by blanking one line's lead
   * time.
   */
  it("ignores undeclared lines rather than voiding the whole order's promise", () => {
    expect(latestPromisedDeliveryAt([null, new Date("2026-09-01T00:00:00.000Z"), null])).toEqual(
      new Date("2026-09-01T00:00:00.000Z"),
    );
  });
});
