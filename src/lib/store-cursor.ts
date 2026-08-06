/**
 * Opaque cursor helpers for store list endpoints.
 * Format: `<sortKey>_<id>` where sortKey is URL-safe text (often an ISO timestamp
 * or padded integer). Always ends with a unique id so equal sort keys cannot skip rows.
 */

export interface StoreCursorParts {
  readonly sortKey: string;
  readonly id: string;
}

export interface StoreTimestampCursorParts {
  readonly sortKey: Date;
  readonly id: string;
}

export function encodeStoreCursor(parts: StoreCursorParts): string {
  return `${encodeURIComponent(parts.sortKey)}_${encodeURIComponent(parts.id)}`;
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
