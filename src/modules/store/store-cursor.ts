/**
 * Opaque cursor helpers for store list endpoints.
 * Format: `<sortKey>_<id>` where sortKey is URL-safe text (often an ISO timestamp
 * or padded integer). Always ends with a unique id so equal sort keys cannot skip rows.
 *
 * ⚠️ **BOTH HALVES ESCAPE `_`, AND THAT IS WHAT MAKES THE SPLIT UNAMBIGUOUS.**
 * `encodeURIComponent` does NOT escape `_` — it is an RFC 3986 unreserved character. Without the
 * extra escaping below, an id containing an underscore (`store_demo_rail_placement_x`) puts extra
 * separators into the string and `lastIndexOf` then splits INSIDE the id, yielding a corrupt sort
 * key and a truncated id. Escaping to `%5F` here leaves exactly ONE literal `_` in any cursor this
 * module mints, so the split cannot land anywhere else. `decodeURIComponent` turns `%5F` back into
 * `_`, so the round trip is exact.
 *
 * The split stays `lastIndexOf` rather than `indexOf` deliberately. The sibling codecs
 * (`src/lib/instant-cursor.ts`, `src/modules/rnd/date-cursor.ts`) split on the FIRST separator, but
 * their sort keys are regex-pinned digits or dates. This module's sort keys include free text —
 * product and pathway titles — so `lastIndexOf` is what keeps a pre-escaping cursor with an
 * underscored TITLE decoding correctly across a deploy.
 */

export interface StoreCursorParts {
  readonly sortKey: string;
  readonly id: string;
}

export interface StoreTimestampCursorParts {
  readonly sortKey: Date;
  readonly id: string;
}

/** Percent-encode a cursor half, including the `_` separator that `encodeURIComponent` leaves bare. */
function encodeCursorPart(part: string): string {
  return encodeURIComponent(part).replace(/_/g, "%5F");
}

export function encodeStoreCursor(parts: StoreCursorParts): string {
  return `${encodeCursorPart(parts.sortKey)}_${encodeCursorPart(parts.id)}`;
}

export function decodeStoreCursor(cursor: string): StoreCursorParts | null {
  const separatorIndex = cursor.lastIndexOf("_");
  if (separatorIndex <= 0 || separatorIndex >= cursor.length - 1) {
    return null;
  }
  let sortKey: string;
  let id: string;
  try {
    sortKey = decodeURIComponent(cursor.slice(0, separatorIndex));
    id = decodeURIComponent(cursor.slice(separatorIndex + 1));
  } catch (error: unknown) {
    if (error instanceof URIError) return null;
    throw error;
  }
  if (sortKey.length === 0 || id.length === 0) {
    return null;
  }
  return { sortKey, id };
}

export function decodeTimestampStoreCursor(cursor: string): StoreTimestampCursorParts | null {
  const decodedCursor = decodeStoreCursor(cursor);
  if (!decodedCursor) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(decodedCursor.sortKey)) {
    return null;
  }

  const sortKey = new Date(decodedCursor.sortKey);
  if (
    Number.isNaN(sortKey.getTime()) ||
    sortKey.toISOString() !== decodedCursor.sortKey ||
    sortKey.getUTCFullYear() < 1970 ||
    sortKey.getUTCFullYear() > 9999
  ) {
    return null;
  }
  return { sortKey, id: decodedCursor.id };
}

export function slugifyPublicTitle(title: string, entityId: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  const suffix = entityId.replace(/-/g, "").slice(0, 8);
  const stem = base.length >= 3 ? base : `item-${suffix}`;
  return `${stem}-${suffix}`.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
