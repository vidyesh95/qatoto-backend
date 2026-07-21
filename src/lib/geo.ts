/**
 * Integer-only geographic proximity for problem-report clustering
 * (R_AND_D_BACKEND_STRUCTURE.md §6).
 *
 * Haversine is BANNED here. `sin`, `cos`, `sqrt` and `atan2` are float, and §4c rule 2
 * forbids floats in anything a job recomputes — cluster centroids are recomputed by the
 * `cluster-problem-submission` job and must be reproducible bit-for-bit. This module
 * replaces the great-circle formula with an equirectangular approximation evaluated
 * entirely in `bigint`, using a checked-in cosine lookup table.
 *
 * Three rules this file exists to enforce:
 *
 *   1. Coordinates are integer MICRODEGREES (degrees × 1e6), never floats. Latitude
 *      lives in [-90_000_000, 90_000_000], longitude in [-180_000_000, 180_000_000].
 *      The scale is 1e6 and not 1e7 for exactly one reason: 180e6 fits in a Postgres
 *      `int4` (max 2.147e9) and 1.8e9 leaves no headroom. The column type is the
 *      constraint, not the desired precision.
 *   2. EVERY intermediate is `bigint`, never `number`. This is not defensive
 *      programming, it is arithmetic necessity: the worst-case single operand is
 *      180_000_000 × 11_132 × 10_000 = 2.004e16, which ALREADY exceeds
 *      `Number.MAX_SAFE_INTEGER` (9.007e15) BEFORE it is squared. Squared it reaches
 *      ~4.0e32 (~109 bits). Even a realistic 25 km radius squares to ~6.25e26. With
 *      `number` the results still LOOK plausible — they are silently rounded to the
 *      nearest representable double — so two runs of identical code over identical
 *      data can disagree. That is the worst failure mode available to us: wrong, and
 *      invisible.
 *   3. `Math.cos` is never called at runtime. `COSINE_SCALED_BY_LATITUDE_BAND` is a
 *      literal table generated once, offline, and checked in. A libm call is a
 *      platform-dependent float; a table lookup is a pure integer function. That is
 *      the entire point of the table, and inlining a `Math.cos` call "just for this
 *      one case" silently reintroduces the nondeterminism the module exists to remove.
 *
 * Distances are compared as SQUARED quantities so no square root is ever taken. Both
 * squared terms are expressed on one common unit — MILLIMETRES × 1e6 — reached with
 * zero divisions, so no rounding happens anywhere inside the comparison.
 *
 * What this module does NOT claim: the equirectangular approximation is not a
 * great-circle distance. It is accurate to well under a percent at the neighbourhood
 * scale that clustering operates on, and it degrades over long spans and near the
 * poles. It is chosen because clustering asks "is this report near that cluster?", a
 * question a reproducible approximation answers correctly and a float great-circle
 * answers irreproducibly.
 */

import { divRoundHalfAwayFromZero } from "#src/lib/money.js";

/**
 * A point on the globe in integer microdegrees.
 *
 * Deliberately not `{ latitude: number; longitude: number }` in degrees: the unit is
 * part of the type's meaning, and the one bug this naming prevents is a caller passing
 * degrees where microdegrees are expected — an error of 1e6× that produces a coordinate
 * still inside the valid range, so no range check would ever catch it.
 */
export interface GeoPointMicrodegrees {
  readonly latitudeMicrodegrees: number;
  readonly longitudeMicrodegrees: number;
}

/**
 * An inclusive latitude/longitude rectangle, for use as an index-friendly SQL prefilter.
 *
 * A box is always a STRICT SUPERSET of the circle it was derived from, so a `BETWEEN`
 * on indexed integer columns can narrow the candidate set without ever excluding a true
 * match. The exact test (`isWithinRadius`) still runs on whatever survives.
 */
export interface BoundingBoxMicrodegrees {
  readonly minLatitudeMicrodegrees: number;
  readonly maxLatitudeMicrodegrees: number;
  readonly minLongitudeMicrodegrees: number;
  readonly maxLongitudeMicrodegrees: number;
}

/**
 * One microdegree of LATITUDE is 111.32 mm, expressed as an exact integer fraction
 * (11132 / 100) so the conversion never introduces a float.
 *
 * This is a meridional constant: unlike longitude it does not vary with latitude (to
 * within the flattening of the ellipsoid, which is far below the resolution clustering
 * needs), which is why it appears in both the north-south and the east-west term.
 */
const MILLIMETERS_PER_MICRODEGREE_LATITUDE_NUMERATOR = 11_132n;
const MILLIMETERS_PER_MICRODEGREE_LATITUDE_DENOMINATOR = 100n;

/**
 * The fixed-point scale of every entry in `COSINE_SCALED_BY_LATITUDE_BAND`: a stored
 * value of 5000 means cos = 0.5000.
 *
 * Exported because the `bigint` returned by `cosineScaledForLatitudeBand` is
 * meaningless without it — a caller cannot interpret `6293n` unless it knows the
 * denominator. 1e4 gives four decimal places, which at the equator is a ~11 m error
 * budget on a 111 km degree: three orders of magnitude finer than any clustering radius.
 */
export const COSINE_SCALE = 10_000n;

/**
 * cos(latitude) × 10000, indexed by WHOLE DEGREES of |latitude|, 0 through 90.
 *
 * Generated once, offline, and checked in as a literal:
 *
 *   node -e "console.log(JSON.stringify(Array.from({length:91},(_,d)=>Math.round(Math.cos(d*Math.PI/180)*10000))))"
 *
 * It is a literal and not a computed table because a computed table would mean calling
 * `Math.cos` at module load, and `Math.cos` is float — implementation-defined to within
 * an ulp across engines and versions. The whole determinism argument collapses if a
 * Node upgrade can move a cluster boundary. Reviewing this table is a diff, not a
 * runtime behaviour.
 *
 * Entry 0 is exactly 10000 (cos 0° = 1) and entry 90 is exactly 0 (cos 90° = 0); both
 * are asserted in the test suite, because entry 90 being 0 is what forces the
 * degenerate-pole branch in `boundingBoxMicrodegrees` to exist at all.
 */
export const COSINE_SCALED_BY_LATITUDE_BAND: readonly number[] = [
  10000, 9998, 9994, 9986, 9976, 9962, 9945, 9925, 9903, 9877, 9848, 9816, 9781, 9744, 9703, 9659,
  9613, 9563, 9511, 9455, 9397, 9336, 9272, 9205, 9135, 9063, 8988, 8910, 8829, 8746, 8660, 8572,
  8480, 8387, 8290, 8192, 8090, 7986, 7880, 7771, 7660, 7547, 7431, 7314, 7193, 7071, 6947, 6820,
  6691, 6561, 6428, 6293, 6157, 6018, 5878, 5736, 5592, 5446, 5299, 5150, 5000, 4848, 4695, 4540,
  4384, 4226, 4067, 3907, 3746, 3584, 3420, 3256, 3090, 2924, 2756, 2588, 2419, 2250, 2079, 1908,
  1736, 1564, 1392, 1219, 1045, 872, 698, 523, 349, 175, 0,
];

/**
 * The same table pre-converted to `bigint`, built once at module load.
 *
 * Derived rather than written twice so the two can never drift apart; the exported
 * `number` form is the reviewable literal, this is the form the arithmetic actually
 * consumes.
 */
const COSINE_SCALED_BY_LATITUDE_BAND_AS_BIGINT: readonly bigint[] =
  COSINE_SCALED_BY_LATITUDE_BAND.map((cosineScaled) => BigInt(cosineScaled));

const MICRODEGREES_PER_WHOLE_DEGREE = 1_000_000n;
const HIGHEST_LATITUDE_BAND_INDEX = 90;

// Latitude is only ever clamped inside bigint arithmetic, so it needs no `number`
// twin; longitude is compared and emitted in both forms.
const MAXIMUM_LATITUDE_MICRODEGREES_AS_BIGINT = 90_000_000n;
const MAXIMUM_LONGITUDE_MICRODEGREES = 180_000_000;
const MAXIMUM_LONGITUDE_MICRODEGREES_AS_BIGINT = 180_000_000n;
const FULL_LONGITUDE_CIRCLE_MICRODEGREES = 360_000_000;

/**
 * Rejects any coordinate that is not a safe integer before it reaches `BigInt(...)`.
 *
 * `BigInt(19.5)` throws a bare `RangeError` with no indication of which parameter was
 * wrong; this turns that into a named, greppable failure. Out-of-RANGE values are
 * deliberately NOT rejected — the band lookup clamps and the longitude wrap normalizes,
 * because the database CHECK constraint is the authority on range and duplicating it
 * here would mean two places to keep in sync.
 *
 * @throws if `coordinateMicrodegrees` is not a safe integer — an unrecoverable
 *         programmer error (CLAUDE.md §3.3): a float coordinate means a float leaked
 *         past the Zod boundary, and every downstream integer is already suspect.
 */
function assertCoordinateIsSafeInteger(
  coordinateMicrodegrees: number,
  parameterName: string,
): void {
  if (!Number.isSafeInteger(coordinateMicrodegrees)) {
    throw new Error(
      `geo: ${parameterName} must be a safe integer number of microdegrees, got ${coordinateMicrodegrees}`,
    );
  }
}

/**
 * @throws if `radiusMillimetres` is negative or not a safe integer — an unrecoverable
 *         programmer error. A negative radius has no geometric meaning and would square
 *         to a positive threshold, silently matching everything within |radius|.
 */
function assertRadiusIsUsable(radiusMillimetres: number): void {
  if (!Number.isSafeInteger(radiusMillimetres) || radiusMillimetres < 0) {
    throw new Error(
      `geo: radiusMillimetres must be a non-negative safe integer, got ${radiusMillimetres}`,
    );
  }
}

/**
 * Wraps a longitude into the canonical half-open range [-180e6, 180e6).
 *
 * HALF-OPEN, not closed, and that is a deliberate decision the spec left open: +180e6
 * and -180e6 denote the SAME meridian, and a canonical form has to pick one or two
 * equal points compare unequal. Exactly +180_000_000 therefore normalizes to
 * -180_000_000. Anything that stores a normalized longitude gets a single
 * representative per physical meridian, which is what makes centroid comparison and
 * bounding-box containment decidable.
 *
 * The modulo is applied BEFORE the +180e6 shift, not after. Shifting first would
 * overflow `Number.MAX_SAFE_INTEGER` for inputs near the safe-integer limit and return
 * a rounded answer; this ordering keeps every intermediate exact for any safe-integer
 * input.
 *
 * @throws if `longitudeMicrodegrees` is not a safe integer.
 */
export function normalizeLongitudeMicrodegrees(longitudeMicrodegrees: number): number {
  assertCoordinateIsSafeInteger(longitudeMicrodegrees, "longitudeMicrodegrees");

  const withinOneCircle = longitudeMicrodegrees % FULL_LONGITUDE_CIRCLE_MICRODEGREES;
  const shiftedToPositiveOrigin = withinOneCircle + MAXIMUM_LONGITUDE_MICRODEGREES;
  const nonNegativeOffset =
    ((shiftedToPositiveOrigin % FULL_LONGITUDE_CIRCLE_MICRODEGREES) +
      FULL_LONGITUDE_CIRCLE_MICRODEGREES) %
    FULL_LONGITUDE_CIRCLE_MICRODEGREES;

  return nonNegativeOffset - MAXIMUM_LONGITUDE_MICRODEGREES;
}

/**
 * The absolute angular separation of two longitudes, in microdegrees, WITH ANTIMERIDIAN
 * WRAP. Always in [0, 180e6].
 *
 * The wrap is the entire reason this function exists. A naive `|left - right|` reads
 * 179.9°E and 179.9°W as 359.8° apart — roughly 40,000 km — when they are ~22 km apart
 * across the date line. Two problem reports on opposite banks of the antimeridian must
 * cluster together, and without this they never would; worse, the bug is invisible
 * anywhere except the one longitude band where it matters, so it survives every test
 * written over European or American coordinates.
 *
 * Both inputs are normalized first so that out-of-range values (a client sending 350°
 * instead of -10°) produce the correct separation rather than a nonsensical negative
 * one — `360e6 - raw` is only meaningful when `raw` cannot exceed 360e6.
 *
 * @throws if either longitude is not a safe integer.
 */
export function deltaLongitudeMicrodegrees(
  leftLongitudeMicrodegrees: number,
  rightLongitudeMicrodegrees: number,
): number {
  const leftNormalized = normalizeLongitudeMicrodegrees(leftLongitudeMicrodegrees);
  const rightNormalized = normalizeLongitudeMicrodegrees(rightLongitudeMicrodegrees);

  // Subtracting the smaller from the larger rather than calling Math.abs: no Math.*
  // function appears anywhere in this module, so there is nothing to audit later.
  const rawSeparation =
    leftNormalized >= rightNormalized
      ? leftNormalized - rightNormalized
      : rightNormalized - leftNormalized;

  return rawSeparation > MAXIMUM_LONGITUDE_MICRODEGREES
    ? FULL_LONGITUDE_CIRCLE_MICRODEGREES - rawSeparation
    : rawSeparation;
}

/**
 * Looks up cos(latitude) × `COSINE_SCALE` for the whole-degree BAND containing
 * `latitudeMicrodegrees`. Band index = floor(|latitude| / 1e6), clamped to 0..90.
 *
 * THIS IS AN APPROXIMATION, NOT A SOURCE OF NONDETERMINISM — and that distinction is
 * the objection a reviewer will raise, so it is answered here. Banding introduces
 * ERROR: a point at 19.9° is evaluated with cos(19°), overstating its east-west
 * distance by roughly 1%. It introduces no VARIANCE: the band is a pure integer
 * function (truncating division) of an integer column, so the same stored row always
 * yields the same band, on every machine, in every run, forever. §4c forbids the second
 * property, not the first. A bounded, documented, reproducible bias is a design
 * choice; a float that differs in the last bit between two runs is a defect.
 *
 * The bias runs in a mostly-safe direction, stated precisely rather than generously:
 * the tabulated value is the cosine at the FLOOR of the band, and cosine falls across
 * the band, so east-west distances are over-estimated almost everywhere in the band and
 * `isWithinRadius` errs toward excluding a borderline match. The exception is a sliver
 * at the very bottom of any band whose entry rounded DOWN (cos 19° = 0.9455190 stores
 * as 0.9455), where the reading is short by up to 5e-5 relative — four orders of
 * magnitude smaller than the banding error itself, but not zero, so it is not claimed
 * to be zero.
 *
 * None of that touches the superset guarantee, which does not depend on the table being
 * accurate in any direction. `boundingBoxMicrodegrees` divides by the SAME tabulated
 * value that `squaredDistanceScaled` multiplies by, so the box and the exact test
 * always agree about which cosine they are using — the guarantee is internal
 * consistency, not geographic truth, and it therefore holds exactly rather than
 * usually.
 *
 * Absolute latitude is used because cosine is even: cos(-51°) = cos(51°).
 *
 * @throws if `latitudeMicrodegrees` is not a safe integer.
 * @throws if the clamped band index somehow falls outside the table. This is
 *         physically impossible — the index is clamped to 0..90 and the table has 91
 *         entries — and is asserted rather than assumed because silently substituting a
 *         default cosine would corrupt every distance computed after it.
 */
export function cosineScaledForLatitudeBand(latitudeMicrodegrees: number): bigint {
  assertCoordinateIsSafeInteger(latitudeMicrodegrees, "latitudeMicrodegrees");

  const latitudeAsBigInt = BigInt(latitudeMicrodegrees);
  const absoluteLatitude = latitudeAsBigInt < 0n ? -latitudeAsBigInt : latitudeAsBigInt;

  // BigInt division truncates toward zero, which on a non-negative value IS floor —
  // so this is the spec's floor() with no Math.floor and no float in sight.
  const unclampedBandIndex = Number(absoluteLatitude / MICRODEGREES_PER_WHOLE_DEGREE);
  const bandIndex =
    unclampedBandIndex > HIGHEST_LATITUDE_BAND_INDEX
      ? HIGHEST_LATITUDE_BAND_INDEX
      : unclampedBandIndex;

  const cosineScaled = COSINE_SCALED_BY_LATITUDE_BAND_AS_BIGINT.at(bandIndex);
  if (cosineScaled === undefined) {
    throw new Error(
      `cosineScaledForLatitudeBand: band index ${bandIndex} is outside the ${COSINE_SCALED_BY_LATITUDE_BAND_AS_BIGINT.length}-entry cosine table`,
    );
  }

  return cosineScaled;
}

/**
 * The SQUARED planar distance between two points, on the unit MILLIMETRES² × 1e12
 * (i.e. each term is millimetres × 1e6 before squaring).
 *
 * Squared, because a square root is float and there is no integer square root that
 * agrees with one. Every question clustering asks — "nearer than R?", "which of these
 * is nearest?" — is answerable by comparing squares, so the root is never needed.
 *
 * The common unit is reached with ZERO DIVISIONS, which is the whole trick:
 *
 *   northSouthScaled = |Δlat| × 11132 × 10000      (Δlat × 111.32 mm, then × 1e6)
 *   eastWestScaled   = Δlng   × 11132 × cosScaled  (Δlng × 111.32 mm × cos, then × 1e6)
 *
 * Both land on millimetres × 1e6 because 100 (the latitude denominator) × 10000 (the
 * cosine scale) = 1e6, so scaling by the two denominators rather than dividing by them
 * leaves both terms on the same footing. Dividing instead would round twice, and the
 * two roundings would not be equal — the north-south term would round against 11132
 * and the east-west term against 11132 × cos.
 *
 * THE ANCHOR SUPPLIES THE COSINE BAND. This is asymmetric, so it must be unambiguous:
 * at every call site in the clustering job the anchor is the CLUSTER CENTROID and the
 * other point is the candidate submission. The centroid is the stable, shared reference
 * that every candidate in a given comparison round is measured against, which is what
 * keeps the round internally consistent. Consequently `squaredDistanceScaled(a, b)` and
 * `squaredDistanceScaled(b, a)` may differ slightly when `a` and `b` sit in different
 * latitude bands — never pass a candidate as the anchor to "check" a result.
 *
 * @throws if any of the four coordinates is not a safe integer.
 */
export function squaredDistanceScaled(
  anchor: GeoPointMicrodegrees,
  other: GeoPointMicrodegrees,
): bigint {
  assertCoordinateIsSafeInteger(anchor.latitudeMicrodegrees, "anchor.latitudeMicrodegrees");
  assertCoordinateIsSafeInteger(other.latitudeMicrodegrees, "other.latitudeMicrodegrees");

  const anchorLatitude = BigInt(anchor.latitudeMicrodegrees);
  const otherLatitude = BigInt(other.latitudeMicrodegrees);
  const latitudeSeparation =
    anchorLatitude >= otherLatitude
      ? anchorLatitude - otherLatitude
      : otherLatitude - anchorLatitude;

  const longitudeSeparation = BigInt(
    deltaLongitudeMicrodegrees(anchor.longitudeMicrodegrees, other.longitudeMicrodegrees),
  );

  const northSouthScaled =
    latitudeSeparation * MILLIMETERS_PER_MICRODEGREE_LATITUDE_NUMERATOR * COSINE_SCALE;
  const eastWestScaled =
    longitudeSeparation *
    MILLIMETERS_PER_MICRODEGREE_LATITUDE_NUMERATOR *
    cosineScaledForLatitudeBand(anchor.latitudeMicrodegrees);

  return northSouthScaled ** 2n + eastWestScaled ** 2n;
}

/**
 * Whether `other` lies within `radiusMillimetres` of `anchor`.
 *
 * The radius is scaled onto the same millimetres × 1e6 axis and squared, so the
 * comparison is exact integer against exact integer with no rounding on either side.
 * The boundary is INCLUSIVE (`<=`): a point at exactly the radius is inside, which is
 * the only choice that makes a radius quoted in whole metres behave the way an operator
 * setting a 25 km cluster threshold expects.
 *
 * Inherits the anchor asymmetry of `squaredDistanceScaled`: pass the cluster centroid
 * as `anchor`.
 *
 * @throws if any coordinate is not a safe integer, or if `radiusMillimetres` is
 *         negative or not a safe integer.
 */
export function isWithinRadius(
  anchor: GeoPointMicrodegrees,
  other: GeoPointMicrodegrees,
  radiusMillimetres: number,
): boolean {
  assertRadiusIsUsable(radiusMillimetres);

  const radiusScaled = BigInt(radiusMillimetres) * 1_000_000n;
  return squaredDistanceScaled(anchor, other) <= radiusScaled ** 2n;
}

/**
 * The index-friendly SQL prefilter for a radius search: one or two inclusive rectangles
 * that together contain every point within `radiusMillimetres` of `center`.
 *
 * Returns an ARRAY, and callers must handle both lengths. A box that crosses the
 * antimeridian cannot be expressed as a single `longitude BETWEEN min AND max` — the
 * range would run backwards and match nothing — so it is emitted as two ranges to be
 * OR'd together. Collapsing this to one box is the bug that makes a Fiji cluster
 * return zero candidates while every test over Europe passes.
 *
 * The +1 microdegree pad on each delta is what upgrades "roughly contains" to STRICT
 * SUPERSET. `divRoundHalfAwayFromZero` can round the delta DOWN by up to half a
 * microdegree; adding one guarantees the integer delta strictly exceeds the real one,
 * so a true match sitting exactly on the circle can never be filtered out before the
 * exact test ever sees it. A prefilter that occasionally drops a real match is far
 * worse than one that occasionally admits a false one — the false one is rejected a
 * microsecond later by `isWithinRadius`, the dropped one is simply never found.
 *
 * The longitude delta divides by the tabulated cosine, so at |latitude| = 90 it would
 * divide by ZERO. That is not an edge case to be defended against but a real geometric
 * fact: at the pole every longitude names the same point, so the honest answer is the
 * full longitude range, and that is what the guard emits.
 *
 * The latitude clamp to ±90e6 assumes the points being filtered are themselves in
 * range — which the database CHECK constraint guarantees. The superset property is
 * stated over valid latitudes only: clamping to 90e6 would exclude a (nonexistent)
 * point at 91°.
 *
 * @throws if any coordinate is not a safe integer, or if `radiusMillimetres` is
 *         negative or not a safe integer.
 */
export function boundingBoxMicrodegrees(
  center: GeoPointMicrodegrees,
  radiusMillimetres: number,
): readonly BoundingBoxMicrodegrees[] {
  assertRadiusIsUsable(radiusMillimetres);
  assertCoordinateIsSafeInteger(center.latitudeMicrodegrees, "center.latitudeMicrodegrees");
  // Longitude is validated HERE, up front, not at its first use. Two branches below
  // return early without ever touching the longitude (the pole, where cosine is 0, and
  // the collapse case, where the pad already spans every longitude) — so validating
  // lazily let a non-integer longitude through on exactly those paths while the normal
  // path rejected it. A guard that depends on which branch you take is not a guard.
  assertCoordinateIsSafeInteger(center.longitudeMicrodegrees, "center.longitudeMicrodegrees");

  const radiusAsBigInt = BigInt(radiusMillimetres);
  const centerLatitude = BigInt(center.latitudeMicrodegrees);

  const latitudeDelta =
    divRoundHalfAwayFromZero(
      radiusAsBigInt * MILLIMETERS_PER_MICRODEGREE_LATITUDE_DENOMINATOR,
      MILLIMETERS_PER_MICRODEGREE_LATITUDE_NUMERATOR,
    ) + 1n;

  const unclampedMinLatitude = centerLatitude - latitudeDelta;
  const unclampedMaxLatitude = centerLatitude + latitudeDelta;
  const minLatitudeMicrodegrees = Number(
    unclampedMinLatitude < -MAXIMUM_LATITUDE_MICRODEGREES_AS_BIGINT
      ? -MAXIMUM_LATITUDE_MICRODEGREES_AS_BIGINT
      : unclampedMinLatitude,
  );
  const maxLatitudeMicrodegrees = Number(
    unclampedMaxLatitude > MAXIMUM_LATITUDE_MICRODEGREES_AS_BIGINT
      ? MAXIMUM_LATITUDE_MICRODEGREES_AS_BIGINT
      : unclampedMaxLatitude,
  );

  const cosineScaled = cosineScaledForLatitudeBand(center.latitudeMicrodegrees);
  const wholeLongitudeRange: readonly BoundingBoxMicrodegrees[] = [
    {
      minLatitudeMicrodegrees,
      maxLatitudeMicrodegrees,
      minLongitudeMicrodegrees: -MAXIMUM_LONGITUDE_MICRODEGREES,
      maxLongitudeMicrodegrees: MAXIMUM_LONGITUDE_MICRODEGREES,
    },
  ];

  if (cosineScaled === 0n) {
    return wholeLongitudeRange;
  }

  const longitudeDelta =
    divRoundHalfAwayFromZero(
      radiusAsBigInt * MILLIMETERS_PER_MICRODEGREE_LATITUDE_DENOMINATOR * COSINE_SCALE,
      MILLIMETERS_PER_MICRODEGREE_LATITUDE_NUMERATOR * cosineScaled,
    ) + 1n;

  // A half-circle of padding already reaches every longitude; splitting such a box in
  // two would produce two overlapping ranges that still cover everything, so say so
  // directly instead.
  if (longitudeDelta >= MAXIMUM_LONGITUDE_MICRODEGREES_AS_BIGINT) {
    return wholeLongitudeRange;
  }

  const centerLongitude = BigInt(normalizeLongitudeMicrodegrees(center.longitudeMicrodegrees));
  const unclampedMinLongitude = centerLongitude - longitudeDelta;
  const unclampedMaxLongitude = centerLongitude + longitudeDelta;

  if (unclampedMinLongitude < -MAXIMUM_LONGITUDE_MICRODEGREES_AS_BIGINT) {
    return [
      {
        minLatitudeMicrodegrees,
        maxLatitudeMicrodegrees,
        minLongitudeMicrodegrees: -MAXIMUM_LONGITUDE_MICRODEGREES,
        maxLongitudeMicrodegrees: Number(unclampedMaxLongitude),
      },
      {
        minLatitudeMicrodegrees,
        maxLatitudeMicrodegrees,
        minLongitudeMicrodegrees: Number(
          unclampedMinLongitude + BigInt(FULL_LONGITUDE_CIRCLE_MICRODEGREES),
        ),
        maxLongitudeMicrodegrees: MAXIMUM_LONGITUDE_MICRODEGREES,
      },
    ];
  }

  if (unclampedMaxLongitude > MAXIMUM_LONGITUDE_MICRODEGREES_AS_BIGINT) {
    return [
      {
        minLatitudeMicrodegrees,
        maxLatitudeMicrodegrees,
        minLongitudeMicrodegrees: Number(unclampedMinLongitude),
        maxLongitudeMicrodegrees: MAXIMUM_LONGITUDE_MICRODEGREES,
      },
      {
        minLatitudeMicrodegrees,
        maxLatitudeMicrodegrees,
        minLongitudeMicrodegrees: -MAXIMUM_LONGITUDE_MICRODEGREES,
        maxLongitudeMicrodegrees: Number(
          unclampedMaxLongitude - BigInt(FULL_LONGITUDE_CIRCLE_MICRODEGREES),
        ),
      },
    ];
  }

  return [
    {
      minLatitudeMicrodegrees,
      maxLatitudeMicrodegrees,
      minLongitudeMicrodegrees: Number(unclampedMinLongitude),
      maxLongitudeMicrodegrees: Number(unclampedMaxLongitude),
    },
  ];
}

/**
 * The arithmetic-mean centroid of a set of points, as integer microdegrees.
 *
 * §4c BANS running-mean updates (`mean += (point - mean) / n`), and this function is
 * their replacement. A running mean is wrong twice over: it is float, and it is
 * ORDER-DEPENDENT — feeding the same cluster's members in the order Postgres happened
 * to return them produces a different centroid than the order a re-run returns them in,
 * so the centroid moves without any member changing. Here every coordinate is summed
 * as `bigint` and divided ONCE at the end. Integer addition is commutative and
 * associative, so the result is a pure function of the SET of points; input order
 * cannot reach the answer.
 *
 * LONGITUDE CANNOT BE AVERAGED DIRECTLY. The mean of 179°E and 179°W is 0° — the Gulf
 * of Guinea, a quarter of the planet from either input. So longitudes are converted to
 * signed offsets from a reference meridian, the OFFSETS are averaged, and the result is
 * added back and re-normalized.
 *
 * Choosing that reference is the one genuinely arbitrary decision in this module, and
 * it is made deterministically: the points are sorted by (latitude, longitude)
 * ascending on their normalized values, and the FIRST is the reference. The byte-wise
 * ordering used elsewhere for tie-breaks does not apply to numbers, so the numeric
 * lexicographic minimum stands in; it is a pure function of the set (duplicate minima
 * carry identical coordinates, so a tie cannot change the reference VALUE), which is
 * the only property required.
 *
 * The honest limitation: for a cluster spanning more than 180° of longitude, the
 * offset-mean depends on which reference was picked, and no choice is more correct than
 * another — the mean of a set of points spread around the whole globe is not
 * well-defined. Clusters are neighbourhood-scale, so this is not reached in practice;
 * it is documented because a reader deserves to know the guarantee is determinism, not
 * geometric canonicity.
 *
 * @throws if `points` is empty. The centroid of nothing has no answer, and returning
 *         (0, 0) would put a phantom cluster in the Atlantic — an unrecoverable
 *         programmer error (CLAUDE.md §3.3), not an operational failure.
 * @throws if any coordinate is not a safe integer.
 */
export function meanCentroidMicrodegrees(
  points: readonly GeoPointMicrodegrees[],
): GeoPointMicrodegrees {
  if (points.length === 0) {
    throw new Error("meanCentroidMicrodegrees: points must not be empty");
  }

  const normalizedPoints: readonly GeoPointMicrodegrees[] = points.map((point) => {
    assertCoordinateIsSafeInteger(point.latitudeMicrodegrees, "point.latitudeMicrodegrees");
    return {
      latitudeMicrodegrees: point.latitudeMicrodegrees,
      longitudeMicrodegrees: normalizeLongitudeMicrodegrees(point.longitudeMicrodegrees),
    };
  });

  const pointCount = BigInt(normalizedPoints.length);

  const latitudeSum = normalizedPoints.reduce(
    (runningSum, point) => runningSum + BigInt(point.latitudeMicrodegrees),
    0n,
  );

  // toSorted, not sort: `points` is readonly and the caller's array must not move.
  const orderedPoints = normalizedPoints.toSorted((leftPoint, rightPoint) => {
    if (leftPoint.latitudeMicrodegrees !== rightPoint.latitudeMicrodegrees) {
      return leftPoint.latitudeMicrodegrees < rightPoint.latitudeMicrodegrees ? -1 : 1;
    }
    if (leftPoint.longitudeMicrodegrees !== rightPoint.longitudeMicrodegrees) {
      return leftPoint.longitudeMicrodegrees < rightPoint.longitudeMicrodegrees ? -1 : 1;
    }
    return 0;
  });

  const referencePoint = orderedPoints.at(0);
  if (referencePoint === undefined) {
    throw new Error("meanCentroidMicrodegrees: sorted points are empty despite a non-empty input");
  }
  const referenceLongitude = referencePoint.longitudeMicrodegrees;

  const longitudeOffsetSum = normalizedPoints.reduce(
    (runningSum, point) =>
      runningSum +
      BigInt(normalizeLongitudeMicrodegrees(point.longitudeMicrodegrees - referenceLongitude)),
    0n,
  );

  const meanLatitude = divRoundHalfAwayFromZero(latitudeSum, pointCount);
  const meanLongitudeOffset = divRoundHalfAwayFromZero(longitudeOffsetSum, pointCount);

  return {
    latitudeMicrodegrees: Number(meanLatitude),
    longitudeMicrodegrees: normalizeLongitudeMicrodegrees(
      referenceLongitude + Number(meanLongitudeOffset),
    ),
  };
}
