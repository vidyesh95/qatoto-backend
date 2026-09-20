import { isWithinRadius, type GeoPointMicrodegrees } from "#src/modules/rnd/geo.js";

/**
 * Choosing where a report sits, kept apart from the job that does it.
 *
 * ⚠️ **THIS MODULE IMPORTS NO DATABASE AND MUST NOT START.** It was inside
 * `geocode-and-cluster-submission.ts`, which reaches `db` and therefore `config`, so importing it
 * from a test demanded a live environment to check pure geometry. The radius comparison is the one
 * branch of the pin feature that can be wrong in a way nothing else would reveal, so it is worth a
 * file of its own.
 */

/**
 * Two reports within this distance MAY describe the same problem.
 *
 * ⚠️ **IT IS NOT ON THE WIRE AND MUST NOT BE HARDCODED IN A CLIENT** (`todo.md` §19.10). A pin on
 * the public map marks the middle of a catchment this wide; drawing a ring for it would be the most
 * honest possible rendering, and also a lie the day this constant is tuned.
 */
export const CLUSTER_RADIUS_MILLIMETRES = 25_000_000; // 25 km

/**
 * Where a report actually sits: the reporter's coarse pin when they dropped one and it agrees with
 * the geocode, the geocoded point otherwise.
 *
 * ⚠️ **THIS IS THE WHOLE VALUE OF THE PIN.** `locationText` is free text, so "Mumbai" resolves to a
 * city centroid and every report from that city arrives at the same coordinates. Inside the 25 km
 * matcher that makes two reports about different junctions indistinguishable, so they always merge.
 * A pin is what separates them.
 *
 * ⚠️ **AND THE PIN IS HONOURED ONLY WHEN IT AGREES WITH THE GEOCODE**, within that same radius.
 * Beyond it the two describe different places, and the geocode is the one `countryCode` and
 * `regionId` were derived from — so honouring a distant pin would produce a row centred in one
 * country carrying another country's code, which no later reader could tell was wrong. The geocode
 * wins and the pin is ignored. Nothing is FAILED over it: a reporter mis-tapping a map is not an
 * error worth refusing a report for, and the free text they also gave is still good.
 *
 * ⚠️ **IT REFINES POSITION AND NOTHING ELSE.** The caller keeps taking `countryCode`, `regionId`
 * and the label from the geocode. There is no reverse geocoder, and `regionId` is a pure function
 * of the country, so a pin could not supply either even if this wanted it to — and a region-less
 * cluster scores zero on the geographic-spread ladder and is excluded from demand signals outright.
 *
 * It CHOOSES between the two points and never blends them: a midpoint would be a coordinate nobody
 * reported.
 */
export function chooseSubmissionPoint(
  geocodedPoint: GeoPointMicrodegrees,
  pinnedPoint: GeoPointMicrodegrees | null,
): GeoPointMicrodegrees {
  if (pinnedPoint === null) return geocodedPoint;
  return isWithinRadius(geocodedPoint, pinnedPoint, CLUSTER_RADIUS_MILLIMETRES)
    ? pinnedPoint
    : geocodedPoint;
}
