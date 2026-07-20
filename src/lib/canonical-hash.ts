import { createHash } from "node:crypto";

/**
 * The ONE canonical serialization used by every hash chain in the domain
 * (R_AND_D_BACKEND_STRUCTURE.md §4c, §9.9). SHA-256 over RFC 8785 (JSON
 * Canonicalization Scheme) bytes.
 *
 * Why JCS rather than hand-rolled concatenation with a delimiter: a delimiter is an
 * injection surface — a `detailNote` containing it forges a chain — and hand-rolled
 * key ordering drifts between the Node implementation and the Kotlin/Swift verifiers
 * that must independently re-derive these hashes. JCS is a published spec with
 * implementations on every platform, so "the client can verify our chain without
 * trusting our bytes" is actually true.
 *
 * SCOPE NOTE: this module ships in Phase 0 as a SERIALIZER ONLY. It deliberately
 * declares no domain document shapes and no chain-append logic — nothing is hashed in
 * Phase 1. §7's `escrow_journal_entry` and §9's `project_audit_entry` each own their
 * own fixed field order, declared with the table that stores them.
 *
 * Three rules callers must honour:
 *
 *   - Emit keys in a FIXED DECLARED ORDER at the call site. JCS sorts keys for you,
 *     but the *set* of keys is the contract; adding one silently changes every hash.
 *   - Integers as decimal strings, instants as ISO-8601 UTC with fixed millisecond
 *     precision, `null` explicit. `null` and `""` and an absent key are three
 *     different documents and must stay that way.
 *   - Store a `hashVersion` alongside every chained row, so the algorithm can evolve
 *     without invalidating history.
 *
 * Hashes are stored and compared FULL LENGTH (64 lowercase hex chars). The 6-character
 * form the UI shows is a rendering: at 24 bits collisions hit 50% around 4,800 entries,
 * so it must never be used as a key, a cache key, or an equality test.
 */

/** A value that can appear in a canonical document. Floats are deliberately absent. */
export type CanonicalValue =
  | string
  | boolean
  | bigint
  | null
  | Date
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * RFC 8785 §3.2.2.2 string serialization: the JSON escapes, with everything else
 * emitted literally as UTF-8. Notably this escapes control characters as \u00XX in
 * lowercase hex, and does NOT escape non-ASCII.
 */
const JCS_STRING_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

function serializeString(value: string): string {
  let serialized = '"';
  for (const character of value) {
    const escape = JCS_STRING_ESCAPES.get(character);
    if (escape !== undefined) {
      serialized += escape;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20) {
      serialized += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    serialized += character;
  }
  return `${serialized}"`;
}

/**
 * Instants serialize as ISO-8601 UTC with EXACTLY millisecond precision.
 *
 * `toISOString()` already emits that shape, but it throws on an invalid Date and
 * silently widens the year field past year 9999 — both of which would produce a hash
 * over a string no other platform would reproduce.
 */
function serializeInstant(value: Date): string {
  const epochMilliseconds = value.getTime();
  if (Number.isNaN(epochMilliseconds)) {
    throw new Error("canonicalize: Date is Invalid Date");
  }
  const isoString = value.toISOString();
  if (isoString.length !== 24) {
    throw new Error(`canonicalize: Date outside the 4-digit-year range: ${isoString}`);
  }
  return serializeString(isoString);
}

/**
 * Orders object entries by key, comparing UTF-16 CODE UNITS as RFC 8785 §3.2.3
 * requires.
 *
 * This is one of the few places UTF-16 order is correct rather than a bug — the spec
 * says so explicitly, precisely so every platform agrees. JS's default string
 * comparison is already UTF-16 code-unit order, so the comparator is a plain `<`.
 */
function sortEntriesPerJcs(
  entries: ReadonlyArray<readonly [string, CanonicalValue]>,
): ReadonlyArray<readonly [string, CanonicalValue]> {
  return entries.toSorted(([leftKey], [rightKey]) => {
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
}

function canonicalize(value: CanonicalValue, path: string): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return serializeString(value);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (value instanceof Date) {
    return serializeInstant(value);
  }
  if (Array.isArray(value)) {
    // Arrays keep their order — it is data. Callers must sort child collections by a
    // documented unique key BEFORE handing them over (§4c).
    const elements: string[] = value.map((element, index) =>
      canonicalize(element, `${path}[${index}]`),
    );
    return `[${elements.join(",")}]`;
  }

  // Everything that is NOT an object by this point is rejected explicitly. Without
  // this guard a plain `number` reaches the object branch, `Object.keys(12.5)` is
  // `[]`, and the float serializes silently as `{}` — a corrupt hash over a document
  // that looked fine. Fail loudly instead: floats are banned from this domain (§4c),
  // JCS's double serialization is easy to get subtly wrong across platforms, and
  // integers must arrive as `bigint`.
  if (typeof value !== "object") {
    throw new Error(
      `canonicalize: unsupported ${typeof value} at "${path}" — use bigint for integers, ` +
        "a decimal string for quantities, and never a float",
    );
  }

  // Object.entries rather than an index lookup: it keeps the value's type as
  // CanonicalValue without a cast, and `Array.isArray` does not narrow a `readonly`
  // array out of the union above.
  const serializedEntries = sortEntriesPerJcs(Object.entries(value)).map(([key, entryValue]) => {
    if (entryValue === undefined) {
      throw new Error(`canonicalize: key "${path}.${key}" is undefined — use null explicitly`);
    }
    return `${serializeString(key)}:${canonicalize(entryValue, `${path}.${key}`)}`;
  });
  return `{${serializedEntries.join(",")}}`;
}

/**
 * Serializes a document to its RFC 8785 canonical form.
 *
 * A plain `number` anywhere in the document throws, naming its path. That is
 * deliberate and is the whole point: JCS mandates a specific double serialization
 * that is easy to get subtly wrong across platforms, and §4c bans floats from this
 * domain outright. Integers must arrive as `bigint`, quantities as decimal strings.
 */
export function canonicalizeDocument(document: CanonicalValue): string {
  return canonicalize(document, "$");
}

/**
 * SHA-256 of the canonical bytes, as 64 lowercase hex characters.
 *
 * Expose the canonical STRING too (via `canonicalizeDocument`) wherever a hash is
 * returned: a server that grades its own homework proves nothing, and a client that
 * can re-canonicalize the fields itself does not have to trust our bytes.
 */
export function canonicalHashHex(document: CanonicalValue): string {
  return createHash("sha256").update(canonicalizeDocument(document), "utf8").digest("hex");
}
