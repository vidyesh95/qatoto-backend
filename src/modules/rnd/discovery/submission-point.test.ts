import { describe, expect, it } from "vitest";

import { chooseSubmissionPoint } from "#src/modules/rnd/discovery/submission-point.js";
import type { GeoPointMicrodegrees } from "#src/modules/rnd/geo.js";

/**
 * Mumbai, as the forward geocoder resolves the free text "Mumbai" — a city centroid, which is the
 * whole reason the pin exists. Every report typed as "Mumbai" arrives here.
 */
const MUMBAI_CENTROID: GeoPointMicrodegrees = {
  latitudeMicrodegrees: 19_076_000,
  longitudeMicrodegrees: 72_877_000,
};

/** Metres of latitude per microdegree — exact enough to place a test point deliberately. */
const METRES_PER_MICRODEGREE_OF_LATITUDE = 0.1113;

function movedNorthBy(point: GeoPointMicrodegrees, metres: number): GeoPointMicrodegrees {
  return {
    latitudeMicrodegrees: point.latitudeMicrodegrees + Math.round(metres / METRES_PER_MICRODEGREE_OF_LATITUDE),
    longitudeMicrodegrees: point.longitudeMicrodegrees,
  };
}

describe("chooseSubmissionPoint", () => {
  it("falls back to the geocoded point when no pin was dropped", () => {
    // The overwhelmingly common case, and the one that must not change: a report with no pin
    // behaves exactly as it did before the pin existed.
    expect(chooseSubmissionPoint(MUMBAI_CENTROID, null)).toEqual(MUMBAI_CENTROID);
  });

  it("prefers a pin that agrees with the geocode", () => {
    // A junction 4km from the city centroid — the case the whole feature is for. Without the pin
    // this report sits on the same coordinates as every other report typed "Mumbai".
    const junction = movedNorthBy(MUMBAI_CENTROID, 4_000);

    expect(chooseSubmissionPoint(MUMBAI_CENTROID, junction)).toEqual(junction);
  });

  it("ignores a pin further from the geocode than the clustering radius", () => {
    // 40km out: beyond the matcher, so the pin and the text describe different places. The geocode
    // wins because it is what `countryCode` and `regionId` were derived from — honouring the pin
    // would centre the row in one place while labelling it another, and nothing downstream could
    // tell which half was wrong.
    const elsewhere = movedNorthBy(MUMBAI_CENTROID, 40_000);

    expect(chooseSubmissionPoint(MUMBAI_CENTROID, elsewhere)).toEqual(MUMBAI_CENTROID);
  });

  it("keeps a pin inside the radius and drops one past it", () => {
    // The boundary is the one place an off-by-one hides, and neither side of it is observable in
    // any other test.
    const insideTheRadius = movedNorthBy(MUMBAI_CENTROID, 24_900);
    const pastTheRadius = movedNorthBy(MUMBAI_CENTROID, 25_100);

    expect(chooseSubmissionPoint(MUMBAI_CENTROID, insideTheRadius)).toEqual(insideTheRadius);
    expect(chooseSubmissionPoint(MUMBAI_CENTROID, pastTheRadius)).toEqual(MUMBAI_CENTROID);
  });

  it("never returns a point neither side supplied", () => {
    // It CHOOSES and must never blend: a midpoint would be a coordinate nobody reported, which is
    // the fabrication this whole domain refuses.
    const junction = movedNorthBy(MUMBAI_CENTROID, 1_000);

    expect([MUMBAI_CENTROID, junction]).toContainEqual(chooseSubmissionPoint(MUMBAI_CENTROID, junction));
    expect([MUMBAI_CENTROID, movedNorthBy(MUMBAI_CENTROID, 90_000)]).toContainEqual(
      chooseSubmissionPoint(MUMBAI_CENTROID, movedNorthBy(MUMBAI_CENTROID, 90_000)),
    );
  });
});
