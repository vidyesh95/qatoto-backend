/**
 * Opaque cursor helpers for store list endpoints.
 * Format: `<sortKey>_<id>` where sortKey is URL-safe text (often an ISO timestamp
 * or padded integer). Always ends with a unique id so equal sort keys cannot skip rows.
 */

export interface StoreCursorParts {
  readonly sortKey: string;
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
  const sortKey = decodeURIComponent(cursor.slice(0, separatorIndex));
  const id = decodeURIComponent(cursor.slice(separatorIndex + 1));
  if (sortKey.length === 0 || id.length === 0) {
    return null;
  }
  return { sortKey, id };
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
