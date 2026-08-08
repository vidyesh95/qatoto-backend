import { randomUUID } from "node:crypto";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Freight and logistics adapter seam (STORE_BACKEND_STRUCTURE.md §3, Phase 14c).
 *
 * Rates, bookings and tracking from a forwarder or carrier — the shape Alibaba's Logistics
 * Marketplace and Amazon's Buy Shipping API both expose, and the connector this backend is
 * most likely to contract first.
 *
 * ## A RATE IS NOT A PRICE ON AN ORDER
 *
 * A16 established that `shippingInCents` stays `0` and that an indicative estimate never
 * reaches a total, because billing from an advertised range with no booking behind it puts
 * an invented number into an immutable order. Nothing here changes that. A quote returned by
 * this adapter becomes a charge only once a booking exists and a carrier has committed to
 * it, and that step is not built.
 *
 * ## What is NOT wired
 *
 * A seam only. No carrier is contracted; the fake is the sole implementation and no
 * shipment-leg transition calls it. `commerce_shipment_leg` already carries carrier
 * references and append-only events, so the landing site exists — the wiring does not.
 */

export const LOGISTICS_PROVIDER_NAMES = ["fake"] as const;

export type LogisticsProviderName = (typeof LOGISTICS_PROVIDER_NAMES)[number];

export type LogisticsProviderError =
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "ROUTE_NOT_SERVED"; originCountryCode: string; destinationCountryCode: string }
  | { type: "BOOKING_NOT_CANCELLABLE"; providerBookingRef: string };

export type TransportMode = "air" | "sea" | "land" | "rail" | "multimodal";

export type NormalizedBookingState =
  | "requested"
  | "confirmed"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "exception";

/**
 * Package geometry, in the integers A5 insisted on.
 *
 * Millimetres and grams, never a formatted string. The mock A5 replaced rendered
 * "52 × 46 × 12 cm" as prose, which cannot be filtered, compared, or freight-rated — and
 * freight rating is precisely what this adapter does.
 */
export interface PackageGeometry {
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly grossWeightGrams: number;
  readonly packageCount: number;
}

export interface RequestFreightRatesInput {
  readonly idempotencyKey: string;
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly packages: readonly PackageGeometry[];
  readonly currency: string;
}

export interface FreightRateOption {
  readonly providerRateRef: string;
  readonly transportMode: TransportMode;
  readonly amountInCents: number;
  readonly currency: string;
  readonly estimatedTransitDays: number;
  /**
   * When the carrier stops honouring this figure. An expired rate is not a cheaper rate —
   * it is no rate, and booking against one is how a quote becomes a surprise invoice.
   */
  readonly rateExpiresAt: Date;
}

export interface BookShipmentInput {
  readonly idempotencyKey: string;
  readonly providerRateRef: string;
  readonly shipmentId: string;
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
}

export interface BookingResult {
  readonly providerBookingRef: string;
  readonly state: NormalizedBookingState;
  readonly carrierReference: string | null;
  readonly trackingNumber: string | null;
}

export interface TrackingEvent {
  readonly occurredAt: Date;
  readonly state: NormalizedBookingState;
  readonly locationLabel: string | null;
  readonly detail: string;
}

export interface LogisticsProviderAdapter {
  readonly providerName: LogisticsProviderName;
  requestRates(
    input: RequestFreightRatesInput,
  ): Promise<Result<readonly FreightRateOption[], LogisticsProviderError>>;
  bookShipment(input: BookShipmentInput): Promise<Result<BookingResult, LogisticsProviderError>>;
  retrieveTracking(
    providerBookingRef: string,
  ): Promise<Result<readonly TrackingEvent[], LogisticsProviderError>>;
  cancelBooking(
    providerBookingRef: string,
  ): Promise<Result<BookingResult, LogisticsProviderError>>;
}

/**
 * Deterministic fake. Two modes at obviously synthetic prices.
 *
 * The figures are round numbers rather than plausible freight rates, for the reason the FX
 * fake uses a flat 1:1: a fixture that looks like a real quote is one somebody eventually
 * reconciles against.
 */
export class FakeLogisticsProviderAdapter implements LogisticsProviderAdapter {
  readonly providerName = "fake" as const;

  async requestRates(
    input: RequestFreightRatesInput,
  ): Promise<Result<readonly FreightRateOption[], LogisticsProviderError>> {
    if (input.packages.length === 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "no_packages_to_rate" },
      };
    }
    if (input.originCountryCode === input.destinationCountryCode) {
      /**
       * Domestic is not "unserved" in reality, but the fake refuses it so that the
       * ROUTE_NOT_SERVED branch has an exercisable trigger. A branch no test can reach is a
       * branch nobody has read.
       */
      return {
        success: false,
        error: {
          type: "ROUTE_NOT_SERVED",
          originCountryCode: input.originCountryCode,
          destinationCountryCode: input.destinationCountryCode,
        },
      };
    }

    const totalGrams = input.packages.reduce(
      (runningTotal, singlePackage) =>
        runningTotal + singlePackage.grossWeightGrams * singlePackage.packageCount,
      0,
    );
    if (totalGrams <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "package_weight_missing" },
      };
    }

    const rateExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    return {
      success: true,
      value: [
        {
          providerRateRef: `fake_rate_sea_${input.idempotencyKey}`,
          transportMode: "sea",
          amountInCents: 100_000,
          currency: input.currency,
          estimatedTransitDays: 30,
          rateExpiresAt,
        },
        {
          providerRateRef: `fake_rate_air_${input.idempotencyKey}`,
          transportMode: "air",
          amountInCents: 500_000,
          currency: input.currency,
          estimatedTransitDays: 5,
          rateExpiresAt,
        },
      ],
    };
  }

  async bookShipment(
    input: BookShipmentInput,
  ): Promise<Result<BookingResult, LogisticsProviderError>> {
    if (!input.providerRateRef.startsWith("fake_rate_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_rate_reference" },
      };
    }
    /**
     * `requested`, never `confirmed`. A carrier confirms asynchronously and the confirmation
     * arrives as an event — the same discipline the escrow adapter follows, and for the same
     * reason: a booking call that returned `confirmed` would tempt a caller to write a
     * shipment state from a command's return value.
     */
    return {
      success: true,
      value: {
        providerBookingRef: `fake_booking_${input.idempotencyKey}`,
        state: "requested",
        carrierReference: null,
        trackingNumber: null,
      },
    };
  }

  async retrieveTracking(
    providerBookingRef: string,
  ): Promise<Result<readonly TrackingEvent[], LogisticsProviderError>> {
    if (!providerBookingRef.startsWith("fake_booking_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_booking_reference" },
      };
    }
    // Stateless, so it reports nothing rather than inventing a journey.
    return { success: true, value: [] };
  }

  async cancelBooking(
    providerBookingRef: string,
  ): Promise<Result<BookingResult, LogisticsProviderError>> {
    if (!providerBookingRef.startsWith("fake_booking_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_booking_reference" },
      };
    }
    return {
      success: true,
      value: {
        providerBookingRef,
        state: "cancelled",
        carrierReference: null,
        trackingNumber: null,
      },
    };
  }
}

export function mintLogisticsIdempotencyKey(purpose: "rate" | "booking" | "cancel"): string {
  return `logistics_${purpose}_${randomUUID()}`;
}

export function resolveLogisticsProvider(
  providerSlug: string,
): Result<LogisticsProviderAdapter, LogisticsProviderError> {
  if (providerSlug !== "fake") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason: `Logistics provider "${providerSlug}" is not implemented yet.`,
      },
    };
  }
  if (config.NODE_ENV === "production") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          'The "fake" logistics provider is refuse-closed in production; its rates are synthetic and no carrier is behind its bookings.',
      },
    };
  }
  return { success: true, value: new FakeLogisticsProviderAdapter() };
}
