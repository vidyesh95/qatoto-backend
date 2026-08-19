import { describe, expect, it } from "vitest";

import {
  boundingBoxMicrodegrees,
  COSINE_SCALE,
  COSINE_SCALED_BY_LATITUDE_BAND,
  cosineScaledForLatitudeBand,
  deltaLongitudeMicrodegrees,
  isWithinRadius,
  meanCentroidMicrodegrees,
  normalizeLongitudeMicrodegrees,
  squaredDistanceScaled,
  type BoundingBoxMicrodegrees,
  type GeoPointMicrodegrees,
} from "#src/modules/rnd/geo.js";

/**
 * A deterministic linear congruential generator. `Math.random()` is banned in this
 * suite: a property test that fails once and passes on re-run is worse than no test,
 * because it teaches the reader to ignore it.
 *
 * The state update goes through `Math.imul` and `>>> 0` rather than plain `*` and `%`,
 * and that is not a style preference — it is the same MAX_SAFE_INTEGER argument the
 * module under test is built around, applied to the test harness.
 *
 * The obvious formulation, `(state * 1_103_515_245 + 12_345) % 2_147_483_648`, has a
 * state below 2^31 and a multiplier above 2^30, so the product reaches ~2.4e18 — about
 * 260x `Number.MAX_SAFE_INTEGER`. The multiply therefore rounds to the nearest double
 * and throws away the low bits BEFORE the modulo can look at them. The recurrence stops
 * being the LCG it is written as: measured period collapses from 2^31 to 10,466 states,
 * and the 10,000-iteration superset property below degenerates to 8,101 distinct pairs
 * while still reporting 10,000. It fails silently and in the safe direction — the test
 * passes either way — which is exactly why it survived review.
 *
 * `Math.imul` is exact 32-bit integer multiplication with no float step, so this version
 * has the full 2^32 period it claims to have.
 */
function createPseudoRandomSequence(seed: number): (bound: number) => number {
  let generatorState = seed >>> 0;
  return (bound: number): number => {
    generatorState = (Math.imul(generatorState, 1_664_525) + 1_013_904_223) >>> 0;
    return generatorState % bound;
  };
}

function isInsideAnyBox(boxes: readonly BoundingBoxMicrodegrees[], point: GeoPointMicrodegrees): boolean {
  const normalizedLongitude = normalizeLongitudeMicrodegrees(point.longitudeMicrodegrees);
  return boxes.some(
    (box) =>
      point.latitudeMicrodegrees >= box.minLatitudeMicrodegrees &&
      point.latitudeMicrodegrees <= box.maxLatitudeMicrodegrees &&
      normalizedLongitude >= box.minLongitudeMicrodegrees &&
      normalizedLongitude <= box.maxLongitudeMicrodegrees,
  );
}

// Real coordinates, rounded to whole microdegrees at the source. Every expectation
// below is stated as an integer bracket derived by hand from the module's own
// arithmetic — no float formula is evaluated anywhere in this file.
const MUMBAI: GeoPointMicrodegrees = {
  latitudeMicrodegrees: 19_076_000,
  longitudeMicrodegrees: 72_877_700,
};
const PUNE: GeoPointMicrodegrees = {
  latitudeMicrodegrees: 18_520_400,
  longitudeMicrodegrees: 73_856_700,
};
const LONDON: GeoPointMicrodegrees = {
  latitudeMicrodegrees: 51_507_400,
  longitudeMicrodegrees: -127_800,
};
const PARIS: GeoPointMicrodegrees = {
  latitudeMicrodegrees: 48_856_600,
  longitudeMicrodegrees: 2_352_200,
};

describe("COSINE_SCALED_BY_LATITUDE_BAND", () => {
  it("has exactly 91 entries — one per whole degree of latitude, 0 through 90", () => {
    expect(COSINE_SCALED_BY_LATITUDE_BAND.length).toBe(91);
  });

  it("pins both endpoints: cos 0° = 1 and cos 90° = 0", () => {
    // Entry 90 being exactly 0 is load-bearing: it is what forces the
    // degenerate-pole branch in boundingBoxMicrodegrees to exist.
    expect(COSINE_SCALED_BY_LATITUDE_BAND.at(0)).toBe(10_000);
    expect(COSINE_SCALED_BY_LATITUDE_BAND.at(90)).toBe(0);
    expect(COSINE_SCALED_BY_LATITUDE_BAND.at(0)).toBe(Number(COSINE_SCALE));
  });

  it("decreases monotonically, as cosine does across the first quadrant", () => {
    for (let bandIndex = 1; bandIndex < COSINE_SCALED_BY_LATITUDE_BAND.length; bandIndex += 1) {
      const previousEntry = COSINE_SCALED_BY_LATITUDE_BAND.at(bandIndex - 1) ?? -1;
      const currentEntry = COSINE_SCALED_BY_LATITUDE_BAND.at(bandIndex) ?? -1;
      expect(currentEntry).toBeLessThan(previousEntry);
    }
  });

  it("pins the two exactly-representable interior values", () => {
    // cos 60° = 0.5 exactly and cos 45° = 0.70710678…; both are checked so an
    // accidental off-by-one shift of the whole table cannot pass.
    expect(COSINE_SCALED_BY_LATITUDE_BAND.at(60)).toBe(5000);
    expect(COSINE_SCALED_BY_LATITUDE_BAND.at(45)).toBe(7071);
  });
});

describe("normalizeLongitudeMicrodegrees", () => {
  const cases: ReadonlyArray<{
    readonly input: number;
    readonly expected: number;
    readonly why: string;
  }> = [
    { input: 0, expected: 0, why: "prime meridian is a fixed point" },
    { input: 72_877_700, expected: 72_877_700, why: "already in range, untouched" },
    { input: -127_800, expected: -127_800, why: "small negative, untouched" },
    { input: -180_000_000, expected: -180_000_000, why: "lower bound is the canonical form" },
    // The decision the spec left open: the range is HALF-OPEN, so the two names for
    // the antimeridian collapse to one.
    { input: 180_000_000, expected: -180_000_000, why: "+180 collapses onto -180" },
    { input: 190_000_000, expected: -170_000_000, why: "190E is 170W" },
    { input: -190_000_000, expected: 170_000_000, why: "190W is 170E" },
    { input: 360_000_000, expected: 0, why: "a full turn returns to origin" },
    { input: -360_000_000, expected: 0, why: "a full turn backwards returns to origin" },
    { input: 540_000_000, expected: -180_000_000, why: "one and a half turns" },
    // 719_999_999 is two full turns MINUS one microdegree, so it lands one
    // microdegree WEST of the prime meridian — not just short of the date line.
    { input: 719_999_999, expected: -1, why: "one microdegree short of two full turns" },
  ];

  for (const { input, expected, why } of cases) {
    it(`${input} -> ${expected} (${why})`, () => {
      expect(normalizeLongitudeMicrodegrees(input)).toBe(expected);
    });
  }

  it("is idempotent — normalizing twice changes nothing", () => {
    const nextPseudoRandom = createPseudoRandomSequence(1_337);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const rawLongitude = nextPseudoRandom(2_000_000_000) - 1_000_000_000;
      const once = normalizeLongitudeMicrodegrees(rawLongitude);
      expect(normalizeLongitudeMicrodegrees(once)).toBe(once);
      expect(once).toBeGreaterThanOrEqual(-180_000_000);
      expect(once).toBeLessThan(180_000_000);
    }
  });

  it("stays exact for inputs near Number.MAX_SAFE_INTEGER", () => {
    // The modulo runs BEFORE the +180e6 shift precisely so this cannot overflow into
    // a rounded double. 9_007_199_254_740_991 mod 360_000_000 = 334_740_991, which is
    // > 180e6, so it wraps to 334_740_991 - 360_000_000 = -25_259_009.
    expect(normalizeLongitudeMicrodegrees(Number.MAX_SAFE_INTEGER)).toBe(-25_259_009);
  });

  it("throws on a non-integer longitude rather than letting a float through", () => {
    expect(() => normalizeLongitudeMicrodegrees(1.5)).toThrow(/must be a safe integer/);
    expect(() => normalizeLongitudeMicrodegrees(Number.NaN)).toThrow(/must be a safe integer/);
    expect(() => normalizeLongitudeMicrodegrees(Number.POSITIVE_INFINITY)).toThrow(/must be a safe integer/);
  });
});

describe("deltaLongitudeMicrodegrees", () => {
  it("is a plain difference away from the date line", () => {
    expect(deltaLongitudeMicrodegrees(10_000_000, 12_000_000)).toBe(2_000_000);
    expect(deltaLongitudeMicrodegrees(12_000_000, 10_000_000)).toBe(2_000_000);
    expect(deltaLongitudeMicrodegrees(-5_000_000, 5_000_000)).toBe(10_000_000);
  });

  it("wraps across the antimeridian instead of going the long way round", () => {
    // THE bug this function exists to prevent: |179.9E - 179.9W| is 359.8 degrees,
    // but the two points are 0.2 degrees apart.
    expect(deltaLongitudeMicrodegrees(179_900_000, -179_900_000)).toBe(200_000);
    expect(deltaLongitudeMicrodegrees(-179_900_000, 179_900_000)).toBe(200_000);
  });

  it("holds at the exact 180-degree boundary, which must NOT wrap", () => {
    // raw === 180e6 is the antipode: the wrap condition is `> 180e6`, not `>=`, so
    // the answer stays 180e6 rather than collapsing to 0.
    expect(deltaLongitudeMicrodegrees(0, 180_000_000)).toBe(180_000_000);
    expect(deltaLongitudeMicrodegrees(0, -180_000_000)).toBe(180_000_000);
    expect(deltaLongitudeMicrodegrees(90_000_000, -90_000_000)).toBe(180_000_000);
  });

  it("is one microdegree either side of the wrap boundary", () => {
    expect(deltaLongitudeMicrodegrees(-1, 179_999_999)).toBe(180_000_000);
    expect(deltaLongitudeMicrodegrees(-2, 179_999_999)).toBe(179_999_999);
    expect(deltaLongitudeMicrodegrees(0, 179_999_999)).toBe(179_999_999);
  });

  it("normalizes out-of-range inputs instead of returning a negative separation", () => {
    // 350E is really 10W. Without the internal normalize, raw would be 340e6 and the
    // wrap would still fire, but a 720e6 input would produce a negative answer.
    expect(deltaLongitudeMicrodegrees(350_000_000, 0)).toBe(10_000_000);
    expect(deltaLongitudeMicrodegrees(720_000_000, 0)).toBe(0);
  });

  it("is symmetric and always in [0, 180e6]", () => {
    const nextPseudoRandom = createPseudoRandomSequence(4_242);
    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const leftLongitude = nextPseudoRandom(360_000_000) - 180_000_000;
      const rightLongitude = nextPseudoRandom(360_000_000) - 180_000_000;
      const forward = deltaLongitudeMicrodegrees(leftLongitude, rightLongitude);
      expect(deltaLongitudeMicrodegrees(rightLongitude, leftLongitude)).toBe(forward);
      expect(forward).toBeGreaterThanOrEqual(0);
      expect(forward).toBeLessThanOrEqual(180_000_000);
    }
  });

  it("throws on a non-integer longitude", () => {
    expect(() => deltaLongitudeMicrodegrees(0.5, 0)).toThrow(/must be a safe integer/);
    expect(() => deltaLongitudeMicrodegrees(0, 0.5)).toThrow(/must be a safe integer/);
  });
});

describe("cosineScaledForLatitudeBand", () => {
  const bandCases: ReadonlyArray<{
    readonly latitudeMicrodegrees: number;
    readonly expected: bigint;
    readonly why: string;
  }> = [
    { latitudeMicrodegrees: 0, expected: 10_000n, why: "equator, cos 0 = 1" },
    { latitudeMicrodegrees: 999_999, expected: 10_000n, why: "top of band 0" },
    { latitudeMicrodegrees: 1_000_000, expected: 9_998n, why: "bottom of band 1" },
    { latitudeMicrodegrees: 1_999_999, expected: 9_998n, why: "top of band 1" },
    { latitudeMicrodegrees: 60_000_000, expected: 5_000n, why: "cos 60 = 0.5 exactly" },
    { latitudeMicrodegrees: 60_999_999, expected: 5_000n, why: "still band 60" },
    { latitudeMicrodegrees: 61_000_000, expected: 4_848n, why: "band 61" },
    { latitudeMicrodegrees: 89_000_000, expected: 175n, why: "band 89, the last non-zero" },
    { latitudeMicrodegrees: 89_999_999, expected: 175n, why: "top of band 89" },
    { latitudeMicrodegrees: 90_000_000, expected: 0n, why: "the pole, cos 90 = 0" },
    // Cosine is even, so the southern hemisphere mirrors the northern exactly.
    { latitudeMicrodegrees: -60_000_000, expected: 5_000n, why: "60S mirrors 60N" },
    { latitudeMicrodegrees: -1, expected: 10_000n, why: "one microdegree south is band 0" },
    { latitudeMicrodegrees: -90_000_000, expected: 0n, why: "south pole" },
    // Out-of-range latitudes clamp rather than throw: the DB CHECK constraint owns
    // range, and clamping keeps the band a total function.
    { latitudeMicrodegrees: 95_000_000, expected: 0n, why: "beyond the pole clamps to band 90" },
    { latitudeMicrodegrees: -95_000_000, expected: 0n, why: "beyond the south pole clamps too" },
  ];

  for (const { latitudeMicrodegrees, expected, why } of bandCases) {
    it(`${latitudeMicrodegrees} -> ${expected} (${why})`, () => {
      expect(cosineScaledForLatitudeBand(latitudeMicrodegrees)).toBe(expected);
    });
  }

  it("agrees with the exported table at every one of the 91 band floors", () => {
    for (let bandIndex = 0; bandIndex <= 90; bandIndex += 1) {
      const expected = BigInt(COSINE_SCALED_BY_LATITUDE_BAND.at(bandIndex) ?? -1);
      expect(cosineScaledForLatitudeBand(bandIndex * 1_000_000)).toBe(expected);
      expect(cosineScaledForLatitudeBand(-bandIndex * 1_000_000)).toBe(expected);
    }
  });

  it("is a pure function of the stored integer — the same input never varies", () => {
    // The approximation/nondeterminism distinction, asserted rather than argued: the
    // band is coarse (19.9 degrees is evaluated with cos 19) but never variable.
    expect(cosineScaledForLatitudeBand(19_900_000)).toBe(cosineScaledForLatitudeBand(19_000_000));
    for (let repetition = 0; repetition < 100; repetition += 1) {
      expect(cosineScaledForLatitudeBand(19_900_000)).toBe(9_455n);
    }
  });

  it("throws on a non-integer latitude", () => {
    expect(() => cosineScaledForLatitudeBand(19.5)).toThrow(/must be a safe integer/);
  });
});

describe("squaredDistanceScaled", () => {
  it("computes one degree of latitude at the equator exactly", () => {
    // 1_000_000 microdegrees x 11132 x 10000 = 11_132_000_000_000_0 -> squared.
    // 11132^2 = 123_921_424, so the answer is 123921424 x 1e20.
    const oneDegreeNorth = squaredDistanceScaled(
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: 0 },
      { latitudeMicrodegrees: 1_000_000, longitudeMicrodegrees: 0 },
    );
    expect(oneDegreeNorth).toBe(12_392_142_400_000_000_000_000_000_000n);
    expect(oneDegreeNorth).toBe((1_000_000n * 11_132n * 10_000n) ** 2n);
  });

  it("computes one degree of longitude at 60N as exactly half the equatorial degree", () => {
    // cos 60 = 0.5 exactly, so this is the one latitude where the table introduces no
    // approximation at all and the expected value can be stated with certainty.
    const oneDegreeEast = squaredDistanceScaled(
      { latitudeMicrodegrees: 60_000_000, longitudeMicrodegrees: 0 },
      { latitudeMicrodegrees: 60_000_000, longitudeMicrodegrees: 1_000_000 },
    );
    expect(oneDegreeEast).toBe((1_000_000n * 11_132n * 5_000n) ** 2n);
    expect(oneDegreeEast * 4n).toBe(12_392_142_400_000_000_000_000_000_000n);
  });

  it("is zero for a point against itself", () => {
    expect(squaredDistanceScaled(MUMBAI, MUMBAI)).toBe(0n);
  });

  it("reads the antimeridian as ~22 km, not ~40,000 km", () => {
    const eastOfLine: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 0,
      longitudeMicrodegrees: 179_900_000,
    };
    const westOfLine: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 0,
      longitudeMicrodegrees: -179_900_000,
    };

    // 200_000 microdegrees x 11132 x 10000 = 22_264_000_000_000, i.e. 22_264_000 mm
    // = 22.264 km. 22264^2 = 495_685_696.
    expect(squaredDistanceScaled(eastOfLine, westOfLine)).toBe(495_685_696_000_000_000_000_000_000n);
    expect(squaredDistanceScaled(eastOfLine, westOfLine)).toBe(22_264_000_000_000n ** 2n);

    // The bug it replaces: 359.8 degrees would be ~40,053 km, whose square is more
    // than three million times larger.
    const goingTheLongWay = (359_800_000n * 11_132n * 10_000n) ** 2n;
    expect(squaredDistanceScaled(eastOfLine, westOfLine) * 1_000_000n).toBeLessThan(goingTheLongWay);
  });

  it("exceeds Number.MAX_SAFE_INTEGER in the SINGLE OPERAND, before squaring", () => {
    // This is the whole justification for bigint. The largest east-west operand is
    // 180_000_000 x 11_132 x 10_000 = 20_037_600_000_000_000, which is already 2.2x
    // MAX_SAFE_INTEGER (9_007_199_254_740_991). A `number` implementation is wrong
    // here without any symptom.
    const largestOperand = 180_000_000n * 11_132n * 10_000n;
    expect(largestOperand).toBe(20_037_600_000_000_000n);
    expect(largestOperand).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const antipodal = squaredDistanceScaled(
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: 0 },
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: 180_000_000 },
    );
    expect(antipodal).toBe(largestOperand ** 2n);
    // Round-tripping through a double loses digits; the bigint does not.
    expect(BigInt(Number(antipodal))).not.toBe(antipodal);
  });

  it("throws on a non-integer coordinate on either point", () => {
    expect(() => squaredDistanceScaled({ latitudeMicrodegrees: 0.5, longitudeMicrodegrees: 0 }, MUMBAI)).toThrow(
      /must be a safe integer/,
    );
    expect(() => squaredDistanceScaled(MUMBAI, { latitudeMicrodegrees: 0.5, longitudeMicrodegrees: 0 })).toThrow(
      /must be a safe integer/,
    );
    expect(() => squaredDistanceScaled(MUMBAI, { latitudeMicrodegrees: 0, longitudeMicrodegrees: 0.5 })).toThrow(
      /must be a safe integer/,
    );
  });
});

describe("isWithinRadius — known city pairs", () => {
  // Mumbai -> Pune. Hand-derived from the module's own integers:
  //   dLat = 555_600 -> 555_600 x 111.32 mm     =  61_849_392 mm  (61.85 km)
  //   dLng = 979_000 at band 19 (cos = 0.9455)  = 103_042_745 mm  (103.04 km)
  //   hypotenuse = 120_179_676 mm (120.18 km). Published road-independent great-circle
  //   figure for Mumbai-Pune is ~120 km, so the approximation is doing its job.
  it("puts Mumbai and Pune between 120 km and 121 km apart", () => {
    expect(isWithinRadius(MUMBAI, PUNE, 121_000_000)).toBe(true);
    expect(isWithinRadius(MUMBAI, PUNE, 120_000_000)).toBe(false);
  });

  // London -> Paris. Hand-derived the same way:
  //   dLat = 2_650_800 -> 295_087_056 mm (295.09 km)
  //   dLng = 2_480_000 at band 51 (cos = 0.6293) -> 173_706_640 mm (173.71 km)
  //   hypotenuse = 342_431_841 mm (342.43 km) against a great-circle ~344 km — the
  //   equirectangular under-read over a 340 km span, which is the documented tradeoff.
  it("puts London and Paris between 342 km and 343 km apart", () => {
    expect(isWithinRadius(LONDON, PARIS, 343_000_000)).toBe(true);
    expect(isWithinRadius(LONDON, PARIS, 342_000_000)).toBe(false);
  });

  it("clusters two points on opposite banks of the date line at a 25 km radius", () => {
    const eastOfLine: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 0,
      longitudeMicrodegrees: 179_900_000,
    };
    const westOfLine: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 0,
      longitudeMicrodegrees: -179_900_000,
    };
    // The separation is 22.264 km, so 25 km includes it and 22 km does not.
    expect(isWithinRadius(eastOfLine, westOfLine, 25_000_000)).toBe(true);
    expect(isWithinRadius(eastOfLine, westOfLine, 22_000_000)).toBe(false);
  });

  it("treats the radius boundary as INCLUSIVE", () => {
    // Exactly one degree of latitude north of the equator is exactly 111_320_000 mm.
    const equator: GeoPointMicrodegrees = { latitudeMicrodegrees: 0, longitudeMicrodegrees: 0 };
    const oneDegreeNorth: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 1_000_000,
      longitudeMicrodegrees: 0,
    };
    expect(isWithinRadius(equator, oneDegreeNorth, 111_320_000)).toBe(true);
    expect(isWithinRadius(equator, oneDegreeNorth, 111_319_999)).toBe(false);
  });

  it("accepts a zero radius only for the identical point", () => {
    expect(isWithinRadius(MUMBAI, MUMBAI, 0)).toBe(true);
    expect(isWithinRadius(MUMBAI, PUNE, 0)).toBe(false);
  });

  it("throws on a negative or non-integer radius", () => {
    expect(() => isWithinRadius(MUMBAI, PUNE, -1)).toThrow(/non-negative safe integer/);
    expect(() => isWithinRadius(MUMBAI, PUNE, 1.5)).toThrow(/non-negative safe integer/);
  });

  it("is symmetric for points in the SAME latitude band", () => {
    // Same band means the same cosine, which is the precondition for symmetry — the
    // anchor asymmetry is documented, not accidental, so it is pinned here rather
    // than asserted away.
    const nextPseudoRandom = createPseudoRandomSequence(20_260_721);
    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const sharedBandDegrees = nextPseudoRandom(90);
      const anchor: GeoPointMicrodegrees = {
        latitudeMicrodegrees: sharedBandDegrees * 1_000_000 + nextPseudoRandom(1_000_000),
        longitudeMicrodegrees: nextPseudoRandom(360_000_000) - 180_000_000,
      };
      const other: GeoPointMicrodegrees = {
        latitudeMicrodegrees: sharedBandDegrees * 1_000_000 + nextPseudoRandom(1_000_000),
        longitudeMicrodegrees: nextPseudoRandom(360_000_000) - 180_000_000,
      };
      const radiusMillimetres = 1_000_000 + nextPseudoRandom(50_000_000);

      expect(isWithinRadius(anchor, other, radiusMillimetres)).toBe(isWithinRadius(other, anchor, radiusMillimetres));
      expect(squaredDistanceScaled(anchor, other)).toBe(squaredDistanceScaled(other, anchor));
    }
  });
});

describe("boundingBoxMicrodegrees", () => {
  it("returns one box away from the date line", () => {
    const boxes = boundingBoxMicrodegrees(MUMBAI, 25_000_000);
    expect(boxes.length).toBe(1);

    // latitudeDelta = round(25_000_000 x 100 / 11_132) + 1 = 224_578 + 1 = 224_579.
    const box = boxes.at(0);
    expect(box?.minLatitudeMicrodegrees).toBe(19_076_000 - 224_579);
    expect(box?.maxLatitudeMicrodegrees).toBe(19_076_000 + 224_579);
    // longitudeDelta = round(25_000_000 x 100 x 10_000 / (11_132 x 9_455)) + 1
    //                = round(2.5e13 / 105_253_060) + 1 = 237_523 + 1 = 237_524.
    // Pinned to the exact integer rather than left as a loose `toBeLessThan`: an
    // inequality here passes for ANY positive delta, so it would not notice the cosine
    // dropping out of the divisor entirely — a 9,455x error in the box width.
    expect(box?.minLongitudeMicrodegrees).toBe(72_877_700 - 237_524);
    expect(box?.maxLongitudeMicrodegrees).toBe(72_877_700 + 237_524);
  });

  it("rejects a non-integer longitude on EVERY branch, not just the ordinary one", () => {
    // Regression: longitude validation used to happen lazily, at its first use, which
    // sits BELOW the two early returns. A float longitude was therefore accepted at the
    // pole and in the half-circle-collapse case and rejected everywhere else, so whether
    // the guard ran depended on the latitude of the point being guarded.
    expect(() =>
      boundingBoxMicrodegrees({ latitudeMicrodegrees: 90_000_000, longitudeMicrodegrees: 1.5 }, 25_000_000),
    ).toThrow(/must be a safe integer/);
    expect(() =>
      boundingBoxMicrodegrees({ latitudeMicrodegrees: -90_000_000, longitudeMicrodegrees: 1.5 }, 25_000_000),
    ).toThrow(/must be a safe integer/);
    // The collapse branch: at 89N a 2000 km radius pads past a half circle.
    expect(() =>
      boundingBoxMicrodegrees({ latitudeMicrodegrees: 89_000_000, longitudeMicrodegrees: 1.5 }, 2_000_000_000),
    ).toThrow(/must be a safe integer/);
    // And the ordinary branch, which always rejected — pinned so the three cannot drift.
    expect(() => boundingBoxMicrodegrees({ latitudeMicrodegrees: 0, longitudeMicrodegrees: 1.5 }, 25_000_000)).toThrow(
      /must be a safe integer/,
    );
  });

  it("splits into TWO ranges when the box crosses the antimeridian eastward", () => {
    const nearTheLine: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 0,
      longitudeMicrodegrees: 179_900_000,
    };
    const boxes = boundingBoxMicrodegrees(nearTheLine, 25_000_000);
    expect(boxes.length).toBe(2);
    expect(boxes.at(0)?.maxLongitudeMicrodegrees).toBe(180_000_000);
    expect(boxes.at(1)?.minLongitudeMicrodegrees).toBe(-180_000_000);
    // The far bank of the line must be inside one of them.
    expect(isInsideAnyBox(boxes, { latitudeMicrodegrees: 0, longitudeMicrodegrees: -179_900_000 })).toBe(true);
  });

  it("splits into TWO ranges when the box crosses the antimeridian westward", () => {
    const nearTheLine: GeoPointMicrodegrees = {
      latitudeMicrodegrees: 0,
      longitudeMicrodegrees: -179_900_000,
    };
    const boxes = boundingBoxMicrodegrees(nearTheLine, 25_000_000);
    expect(boxes.length).toBe(2);
    expect(isInsideAnyBox(boxes, { latitudeMicrodegrees: 0, longitudeMicrodegrees: 179_900_000 })).toBe(true);
  });

  it("emits the full longitude range at the poles instead of dividing by zero", () => {
    for (const poleLatitude of [90_000_000, -90_000_000]) {
      const boxes = boundingBoxMicrodegrees(
        { latitudeMicrodegrees: poleLatitude, longitudeMicrodegrees: 12_345 },
        25_000_000,
      );
      expect(boxes.length).toBe(1);
      expect(boxes.at(0)?.minLongitudeMicrodegrees).toBe(-180_000_000);
      expect(boxes.at(0)?.maxLongitudeMicrodegrees).toBe(180_000_000);
    }
  });

  it("clamps latitude to the poles rather than emitting an impossible latitude", () => {
    const boxes = boundingBoxMicrodegrees({ latitudeMicrodegrees: 90_000_000, longitudeMicrodegrees: 0 }, 25_000_000);
    expect(boxes.at(0)?.maxLatitudeMicrodegrees).toBe(90_000_000);

    const southernBoxes = boundingBoxMicrodegrees(
      { latitudeMicrodegrees: -90_000_000, longitudeMicrodegrees: 0 },
      25_000_000,
    );
    expect(southernBoxes.at(0)?.minLatitudeMicrodegrees).toBe(-90_000_000);
  });

  it("collapses to the full longitude range when the pad already spans a half circle", () => {
    // At 89N a 25 km radius is ~12.8 degrees of longitude, but a 2000 km radius is
    // well past 180 degrees — splitting that would produce two overlapping ranges.
    const boxes = boundingBoxMicrodegrees(
      { latitudeMicrodegrees: 89_000_000, longitudeMicrodegrees: 100_000_000 },
      2_000_000_000,
    );
    expect(boxes.length).toBe(1);
    expect(boxes.at(0)?.minLongitudeMicrodegrees).toBe(-180_000_000);
    expect(boxes.at(0)?.maxLongitudeMicrodegrees).toBe(180_000_000);
  });

  it("throws on a negative radius or a non-integer centre", () => {
    expect(() => boundingBoxMicrodegrees(MUMBAI, -1)).toThrow(/non-negative safe integer/);
    expect(() => boundingBoxMicrodegrees({ latitudeMicrodegrees: 0.5, longitudeMicrodegrees: 0 }, 1_000)).toThrow(
      /must be a safe integer/,
    );
  });

  // -------------------------------------------------------------------------------
  // The property that makes the prefilter safe to put in front of a SQL query.
  // -------------------------------------------------------------------------------

  it("is a STRICT SUPERSET of the circle over 10,000 deterministically varied pairs", () => {
    const nextPseudoRandom = createPseudoRandomSequence(987_654_321);
    let pairsInsideTheRadius = 0;
    let pairsFilteredByASplitBox = 0;
    let pairsFilteredByAFullLongitudeBox = 0;
    let firstEscapingPair:
      | {
          readonly iteration: number;
          readonly anchor: GeoPointMicrodegrees;
          readonly other: GeoPointMicrodegrees;
          readonly radiusMillimetres: number;
          readonly boxes: readonly BoundingBoxMicrodegrees[];
        }
      | undefined;

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      // Every fifth pair is planted next to the date line and every seventh at a
      // pole, so the two branches that a uniform sample would almost never reach get
      // thousands of trials each.
      const anchorLongitude =
        iteration % 5 === 0
          ? 180_000_000 - nextPseudoRandom(1_000_000)
          : iteration % 5 === 1
            ? -180_000_000 + nextPseudoRandom(1_000_000)
            : nextPseudoRandom(360_000_000) - 180_000_000;
      // Cases 0 and 1 are the EXACT poles, where the tabulated cosine is 0 and the
      // full-longitude-range branch fires; cases 2 and 3 are just short of the poles,
      // in band 89, where the longitude delta is at its widest without degenerating.
      // Sampling uniformly reaches an exact pole with probability ~0, so these are
      // planted rather than hoped for.
      const anchorLatitude =
        iteration % 7 === 0
          ? 90_000_000
          : iteration % 7 === 1
            ? -90_000_000
            : iteration % 7 === 2
              ? 90_000_000 - nextPseudoRandom(500_000)
              : iteration % 7 === 3
                ? -90_000_000 + nextPseudoRandom(500_000)
                : nextPseudoRandom(180_000_001) - 90_000_000;

      const latitudeOffset = nextPseudoRandom(800_001) - 400_000;
      const longitudeOffset = nextPseudoRandom(4_000_001) - 2_000_000;

      const otherLatitudeUnclamped = anchorLatitude + latitudeOffset;
      const otherLatitude =
        otherLatitudeUnclamped > 90_000_000
          ? 90_000_000
          : otherLatitudeUnclamped < -90_000_000
            ? -90_000_000
            : otherLatitudeUnclamped;

      const anchor: GeoPointMicrodegrees = {
        latitudeMicrodegrees: anchorLatitude,
        longitudeMicrodegrees: anchorLongitude,
      };
      const other: GeoPointMicrodegrees = {
        latitudeMicrodegrees: otherLatitude,
        longitudeMicrodegrees: normalizeLongitudeMicrodegrees(anchorLongitude + longitudeOffset),
      };
      const radiusMillimetres = 1_000_000 + nextPseudoRandom(50_000_000);

      if (!isWithinRadius(anchor, other, radiusMillimetres)) {
        continue;
      }

      pairsInsideTheRadius += 1;
      const boxes = boundingBoxMicrodegrees(anchor, radiusMillimetres);
      if (boxes.length === 2) {
        pairsFilteredByASplitBox += 1;
      }
      if (boxes.at(0)?.minLongitudeMicrodegrees === -180_000_000 && boxes.length === 1) {
        pairsFilteredByAFullLongitudeBox += 1;
      }
      if (!isInsideAnyBox(boxes, other) && firstEscapingPair === undefined) {
        // Capture the reproducing case rather than asserting inside the loop: the
        // assertion below then reports the exact anchor/other/radius that escaped,
        // which is the difference between a fixable failure and a bare `false`.
        firstEscapingPair = { iteration, anchor, other, radiusMillimetres, boxes };
      }
    }

    expect(firstEscapingPair).toBeUndefined();

    // Guards against the test silently becoming vacuous if the generator or the
    // radius range is ever changed. Each of the three box shapes must actually have
    // been exercised — a superset property that only ever saw the easy single-box
    // case would prove nothing about the branches that are hard to get right.
    expect(pairsInsideTheRadius).toBeGreaterThan(1_000);
    expect(pairsFilteredByASplitBox).toBeGreaterThan(100);
    expect(pairsFilteredByAFullLongitudeBox).toBeGreaterThan(100);
  });
});

describe("meanCentroidMicrodegrees", () => {
  it("averages a simple pair", () => {
    expect(
      meanCentroidMicrodegrees([
        { latitudeMicrodegrees: 10_000_000, longitudeMicrodegrees: 20_000_000 },
        { latitudeMicrodegrees: 20_000_000, longitudeMicrodegrees: 40_000_000 },
      ]),
    ).toEqual({ latitudeMicrodegrees: 15_000_000, longitudeMicrodegrees: 30_000_000 });
  });

  it("returns the point itself for a singleton cluster", () => {
    expect(meanCentroidMicrodegrees([MUMBAI])).toEqual(MUMBAI);
  });

  it("rounds halves AWAY FROM ZERO, matching Postgres and not JS", () => {
    // Mean latitude is -0.5 microdegrees. Math.round(-0.5) is -0; Postgres
    // round(-0.5) is -1. This module must agree with Postgres.
    expect(
      meanCentroidMicrodegrees([
        { latitudeMicrodegrees: 0, longitudeMicrodegrees: 0 },
        { latitudeMicrodegrees: -1, longitudeMicrodegrees: 0 },
      ]).latitudeMicrodegrees,
    ).toBe(-1);

    expect(
      meanCentroidMicrodegrees([
        { latitudeMicrodegrees: 0, longitudeMicrodegrees: 0 },
        { latitudeMicrodegrees: 1, longitudeMicrodegrees: 0 },
      ]).latitudeMicrodegrees,
    ).toBe(1);
  });

  it("averages ACROSS the date line instead of landing in the Gulf of Guinea", () => {
    // The naive mean of 179.9E and 179.9W is 0 — a quarter of the planet away from
    // both inputs. The correct midpoint is the antimeridian itself.
    const centroid = meanCentroidMicrodegrees([
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: 179_900_000 },
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: -179_900_000 },
    ]);
    expect(centroid.longitudeMicrodegrees).toBe(-180_000_000);
    expect(centroid.longitudeMicrodegrees).not.toBe(0);
  });

  it("averages an asymmetric date-line cluster to the correct side", () => {
    // Two points at 179.8E and one at 179.9W (= 180.1E unwrapped). The reference is
    // the lexicographic minimum, -179_900_000; the two eastern points are 0.3 degrees
    // WEST of it across the line, so the offsets are -300_000, -300_000, 0. The mean
    // offset is -200_000, and -179_900_000 - 200_000 = -180_100_000, which normalizes
    // to 179_900_000. Cross-check in unwrapped terms: (179.8 + 179.8 + 180.1) / 3 =
    // 179.9, i.e. 179.9E. The centroid stays on the eastern side, where two of the
    // three points are.
    const centroid = meanCentroidMicrodegrees([
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: 179_800_000 },
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: 179_800_000 },
      { latitudeMicrodegrees: 0, longitudeMicrodegrees: -179_900_000 },
    ]);
    expect(centroid.longitudeMicrodegrees).toBe(179_900_000);
  });

  it("normalizes +180 inputs to the canonical -180 before averaging", () => {
    expect(
      meanCentroidMicrodegrees([
        { latitudeMicrodegrees: 0, longitudeMicrodegrees: 180_000_000 },
        { latitudeMicrodegrees: 0, longitudeMicrodegrees: -180_000_000 },
      ]).longitudeMicrodegrees,
    ).toBe(-180_000_000);
  });

  it("throws on an empty cluster rather than putting a phantom pin in the Atlantic", () => {
    expect(() => meanCentroidMicrodegrees([])).toThrow(/must not be empty/);
  });

  it("throws on a non-integer coordinate", () => {
    expect(() => meanCentroidMicrodegrees([{ latitudeMicrodegrees: 0.5, longitudeMicrodegrees: 0 }])).toThrow(
      /must be a safe integer/,
    );
    expect(() => meanCentroidMicrodegrees([{ latitudeMicrodegrees: 0, longitudeMicrodegrees: 0.5 }])).toThrow(
      /must be a safe integer/,
    );
  });

  it("does not mutate the caller's array", () => {
    const points: readonly GeoPointMicrodegrees[] = [PARIS, LONDON, MUMBAI];
    const snapshot = [...points];
    meanCentroidMicrodegrees(points);
    expect(points).toEqual(snapshot);
  });

  // -------------------------------------------------------------------------------
  // §17 step 2 — the determinism suite. This is the reason running-mean updates are
  // banned, restated as an executable claim.
  // -------------------------------------------------------------------------------

  it("is invariant under 1,000 deterministic shuffles", () => {
    const points: readonly GeoPointMicrodegrees[] = [
      MUMBAI,
      PUNE,
      LONDON,
      PARIS,
      { latitudeMicrodegrees: -33_868_800, longitudeMicrodegrees: 151_209_300 },
      { latitudeMicrodegrees: 35_689_500, longitudeMicrodegrees: 139_691_700 },
      { latitudeMicrodegrees: -22_906_800, longitudeMicrodegrees: -43_172_900 },
      { latitudeMicrodegrees: 64_146_600, longitudeMicrodegrees: -21_942_600 },
    ];

    const baseline = meanCentroidMicrodegrees(points);
    const nextPseudoRandom = createPseudoRandomSequence(555_666_777);

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const order = points.map((_unusedPoint, index) => index);
      // Fisher-Yates driven by the LCG, so any failure reproduces exactly.
      for (let position = order.length - 1; position > 0; position -= 1) {
        const swapWith = nextPseudoRandom(position + 1);
        const held = order.at(position) ?? 0;
        order[position] = order.at(swapWith) ?? 0;
        order[swapWith] = held;
      }

      const shuffledPoints = order.map((index) => points.at(index) ?? MUMBAI);
      expect(meanCentroidMicrodegrees(shuffledPoints)).toEqual(baseline);
    }
  });

  it("is invariant under 1,000 shuffles for a cluster STRADDLING the date line", () => {
    // Order-independence is easy to accidentally lose here, because the reference
    // meridian is chosen from the input. It must be chosen from the SET.
    const points: readonly GeoPointMicrodegrees[] = [
      { latitudeMicrodegrees: -16_500_000, longitudeMicrodegrees: 179_950_000 },
      { latitudeMicrodegrees: -16_600_000, longitudeMicrodegrees: -179_980_000 },
      { latitudeMicrodegrees: -16_400_000, longitudeMicrodegrees: 179_800_000 },
      { latitudeMicrodegrees: -16_550_000, longitudeMicrodegrees: -179_900_000 },
      { latitudeMicrodegrees: -16_450_000, longitudeMicrodegrees: 180_000_000 },
    ];

    const baseline = meanCentroidMicrodegrees(points);
    expect(baseline.longitudeMicrodegrees).toBeGreaterThan(179_000_000);

    const nextPseudoRandom = createPseudoRandomSequence(111_222_333);
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const order = points.map((_unusedPoint, index) => index);
      for (let position = order.length - 1; position > 0; position -= 1) {
        const swapWith = nextPseudoRandom(position + 1);
        const held = order.at(position) ?? 0;
        order[position] = order.at(swapWith) ?? 0;
        order[swapWith] = held;
      }
      const shuffledPoints = order.map((index) => points.at(index) ?? MUMBAI);
      expect(meanCentroidMicrodegrees(shuffledPoints)).toEqual(baseline);
    }
  });

  it("is invariant under shuffling for 500 deterministically generated clusters", () => {
    const nextPseudoRandom = createPseudoRandomSequence(24_680);

    for (let clusterIndex = 0; clusterIndex < 500; clusterIndex += 1) {
      const memberCount = 2 + nextPseudoRandom(9);
      const clusterLongitudeSeed = nextPseudoRandom(360_000_000) - 180_000_000;
      const clusterLatitudeSeed = nextPseudoRandom(180_000_001) - 90_000_000;

      const points: readonly GeoPointMicrodegrees[] = Array.from({ length: memberCount }, (): GeoPointMicrodegrees => ({
        latitudeMicrodegrees: clusterLatitudeSeed,
        longitudeMicrodegrees: normalizeLongitudeMicrodegrees(
          clusterLongitudeSeed + nextPseudoRandom(2_000_001) - 1_000_000,
        ),
      }));

      const baseline = meanCentroidMicrodegrees(points);
      const reversed = meanCentroidMicrodegrees(points.toReversed());
      const rotated = meanCentroidMicrodegrees([...points.slice(1), ...points.slice(0, 1)]);

      expect(reversed).toEqual(baseline);
      expect(rotated).toEqual(baseline);
    }
  });
});
