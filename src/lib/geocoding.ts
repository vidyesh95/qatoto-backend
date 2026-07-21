import { and, eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { discoveryRegion, geocodeCache } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * Forward geocoding: a free-text location becomes coordinates, a country and a region.
 *
 * WHY THE SERVER DOES THIS AND NOT THE CLIENT (R_AND_D_BACKEND_STRUCTURE.md §6). The
 * report sheet collects a free-text location and has no coordinate capture at all, and §6
 * forbids client-claimed geography by name — `countryCode` feeds the opportunity score, so
 * a client that could assert it could manufacture a crisis in a country it has never
 * visited. There is no coordinate field in any request body, so there is nothing to forge.
 *
 * WHY EVERY RESULT IS CACHED PERMANENTLY, and why that is the most important line in this
 * module. §4c requires a job to be a pure function of `(data, asOf)` — but a geocoder is
 * NOT a pure function: providers re-tile, re-rank and re-license their data, so the same
 * query returns different coordinates months apart. Re-running the clustering job would
 * then silently move a report into a different cluster and change a PUBLISHED opportunity
 * score, with no code change and no audit trail. Geocoding once and replaying from the
 * cached row forever is what makes the job replayable at all.
 *
 * MISSES ARE CACHED TOO. Re-asking a provider that already answered "no such place" burns
 * the rate limit on a call that always fails, and against Nominatim's 1 req/s budget that
 * is the difference between a draining queue and a stalled one.
 */

export type GeocodingError =
  | { type: "GEOCODER_NOT_CONFIGURED" }
  | { type: "GEOCODER_UNAVAILABLE"; detail: string }
  | { type: "LOCATION_NOT_FOUND"; normalizedQuery: string };

export interface GeocodeResolution {
  readonly latitudeMicrodegrees: number;
  readonly longitudeMicrodegrees: number;
  readonly countryCode: string;
  /** NULL when the resolved country has no seeded `discovery_region` row. */
  readonly regionId: string | null;
  readonly resolvedLabel: string;
  /** True when this came from `geocode_cache` rather than the provider. */
  readonly fromCache: boolean;
}

/**
 * The cache key.
 *
 * NFKC so full-width and half-width forms of the same text collapse; lowercased and
 * whitespace-collapsed so `"Nakuru County, Kenya"` and `"  nakuru  county,kenya "` share
 * one row and therefore one provider call. Applied at BOTH write and read, so a lookup
 * can never miss a row it should have hit.
 */
export function normalizeGeocodeQuery(rawQuery: string): string {
  return rawQuery.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Degrees (float, from the provider) to integer microdegrees, rounded half away from zero. */
function toMicrodegrees(degrees: number): number {
  // This is the ONE place a float legitimately becomes an integer: the provider's wire
  // format is decimal degrees and there is no integer form to ask for. §4c permits
  // exactly this — "a documented integer quantization applied exactly once, at the
  // boundary" — and everything downstream is integer arithmetic over the stored value.
  //
  // Math.round is avoided because it rounds -0.5 towards +0, which would bias southern
  // and western coordinates differently from northern and eastern ones.
  const scaled = degrees * 1_000_000;
  return scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
}

interface NominatimSearchResult {
  readonly lat: string;
  readonly lon: string;
  readonly display_name: string;
  readonly address?: { readonly country_code?: string };
}

function isNominatimSearchResult(candidate: unknown): candidate is NominatimSearchResult {
  if (typeof candidate !== "object" || candidate === null) return false;
  const record: Record<string, unknown> = { ...candidate };
  return (
    typeof record.lat === "string" &&
    typeof record.lon === "string" &&
    typeof record.display_name === "string"
  );
}

/**
 * Serializes provider calls to honour the rate limit.
 *
 * Nominatim's usage policy permits at most one request per second, and exceeding it gets
 * the whole deployment blocked rather than throttled. A module-level promise chain is
 * enough because the worker is one process — if the worker is ever scaled horizontally
 * this becomes a distributed-limiter problem and this comment is where to start.
 */
let providerCallChain: Promise<unknown> = Promise.resolve();

function scheduleProviderCall<TResult>(call: () => Promise<TResult>): Promise<TResult> {
  const scheduled = providerCallChain.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, config.GEOCODING_MIN_INTERVAL_MS));
    return call();
  });
  // Keep the chain alive even when this call rejects, or one failure stalls every
  // subsequent geocode forever.
  providerCallChain = scheduled.catch(() => undefined);
  return scheduled;
}

async function callNominatim(
  normalizedQuery: string,
): Promise<Result<NominatimSearchResult | null, GeocodingError>> {
  const url = new URL("/search", config.GEOCODING_BASE_URL);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  // `addressdetails` is what yields `address.country_code`; without it the country would
  // have to be parsed out of the display name, which is locale-dependent prose.
  url.searchParams.set("addressdetails", "1");

  try {
    const response = await scheduleProviderCall(() =>
      fetch(url, {
        headers: {
          // Nominatim BLOCKS requests without a genuine identifying User-Agent. This is
          // a hard requirement of their usage policy, not politeness.
          "User-Agent": config.GEOCODING_USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(config.GEOCODING_TIMEOUT_MS),
      }),
    );

    if (!response.ok) {
      return {
        success: false,
        error: {
          type: "GEOCODER_UNAVAILABLE",
          detail: `provider responded ${response.status}`,
        },
      };
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) {
      return { success: true, value: null };
    }

    const [firstResult] = payload;
    if (!isNominatimSearchResult(firstResult)) {
      return { success: true, value: null };
    }

    return { success: true, value: firstResult };
  } catch (error: unknown) {
    // A timeout, a DNS failure or a socket reset. RETRYABLE — the caller lets pg-boss
    // back off rather than marking the submission permanently un-geocodable, because the
    // location string is probably fine and the network is not.
    return {
      success: false,
      error: {
        type: "GEOCODER_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "unknown network failure",
      },
    };
  }
}

/** Resolves an ISO alpha-2 country to its seeded region row, if one exists. */
async function findRegionIdForCountryCode(countryCode: string): Promise<string | null> {
  const [row] = await db
    .select({ id: discoveryRegion.id })
    .from(discoveryRegion)
    .where(and(eq(discoveryRegion.countryCode, countryCode), eq(discoveryRegion.kind, "country")))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Resolves a location string, consulting the cache first and the provider only on a miss.
 *
 * The cache is checked, then written, without a lock: two workers racing the same new
 * location both call the provider and both write, and the second write loses to
 * `ON CONFLICT DO NOTHING`. That is a wasted call, not a correctness problem — and taking
 * a lock across a network call to a third party would be considerably worse.
 */
export async function resolveLocation(
  rawQuery: string,
): Promise<Result<GeocodeResolution, GeocodingError>> {
  const normalizedQuery = normalizeGeocodeQuery(rawQuery);

  const [cached] = await db
    .select({
      status: geocodeCache.status,
      latitudeMicrodegrees: geocodeCache.latitudeMicrodegrees,
      longitudeMicrodegrees: geocodeCache.longitudeMicrodegrees,
      countryCode: geocodeCache.countryCode,
      regionId: geocodeCache.regionId,
      resolvedLabel: geocodeCache.resolvedLabel,
    })
    .from(geocodeCache)
    .where(eq(geocodeCache.normalizedQuery, normalizedQuery));

  if (cached) {
    if (
      cached.status === "not_found" ||
      cached.latitudeMicrodegrees === null ||
      cached.longitudeMicrodegrees === null ||
      cached.countryCode === null
    ) {
      return { success: false, error: { type: "LOCATION_NOT_FOUND", normalizedQuery } };
    }
    return {
      success: true,
      value: {
        latitudeMicrodegrees: cached.latitudeMicrodegrees,
        longitudeMicrodegrees: cached.longitudeMicrodegrees,
        countryCode: cached.countryCode,
        regionId: cached.regionId,
        resolvedLabel: cached.resolvedLabel ?? normalizedQuery,
        fromCache: true,
      },
    };
  }

  if (config.GEOCODING_PROVIDER === "none") {
    // Explicitly disabled rather than broken. Distinguished from UNAVAILABLE so the job
    // can dead-letter instead of retrying a provider that will never answer.
    return { success: false, error: { type: "GEOCODER_NOT_CONFIGURED" } };
  }

  const providerResult = await callNominatim(normalizedQuery);
  if (!providerResult.success) {
    // NOT cached. A transport failure says nothing about whether the place exists, and
    // caching it would poison the row permanently for a momentary outage.
    return providerResult;
  }

  if (providerResult.value === null) {
    await db
      .insert(geocodeCache)
      .values({
        normalizedQuery,
        originalQuery: rawQuery,
        status: "not_found",
        provider: config.GEOCODING_PROVIDER,
      })
      .onConflictDoNothing({ target: geocodeCache.normalizedQuery });

    return { success: false, error: { type: "LOCATION_NOT_FOUND", normalizedQuery } };
  }

  const searchResult = providerResult.value;
  const latitudeDegrees = Number(searchResult.lat);
  const longitudeDegrees = Number(searchResult.lon);
  const rawCountryCode = searchResult.address?.country_code;

  if (
    !Number.isFinite(latitudeDegrees) ||
    !Number.isFinite(longitudeDegrees) ||
    typeof rawCountryCode !== "string" ||
    !/^[a-z]{2}$/i.test(rawCountryCode)
  ) {
    // The provider answered but not usably. Treated as not-found and cached as such:
    // asking again produces the same unusable answer.
    await db
      .insert(geocodeCache)
      .values({
        normalizedQuery,
        originalQuery: rawQuery,
        status: "not_found",
        provider: config.GEOCODING_PROVIDER,
      })
      .onConflictDoNothing({ target: geocodeCache.normalizedQuery });

    return { success: false, error: { type: "LOCATION_NOT_FOUND", normalizedQuery } };
  }

  // Uppercase to match `discovery_region.countryCode` and the schema's `^[A-Z]{2}$` CHECK.
  const countryCode = rawCountryCode.toUpperCase();
  const latitudeMicrodegrees = toMicrodegrees(latitudeDegrees);
  const longitudeMicrodegrees = toMicrodegrees(longitudeDegrees);
  const regionId = await findRegionIdForCountryCode(countryCode);

  await db
    .insert(geocodeCache)
    .values({
      normalizedQuery,
      originalQuery: rawQuery,
      status: "resolved",
      latitudeMicrodegrees,
      longitudeMicrodegrees,
      countryCode,
      regionId,
      resolvedLabel: searchResult.display_name,
      provider: config.GEOCODING_PROVIDER,
    })
    .onConflictDoNothing({ target: geocodeCache.normalizedQuery });

  return {
    success: true,
    value: {
      latitudeMicrodegrees,
      longitudeMicrodegrees,
      countryCode,
      regionId,
      resolvedLabel: searchResult.display_name,
      fromCache: false,
    },
  };
}
