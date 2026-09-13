/**
 * The order an assembly's parts must be inserted in, and the model columns one part becomes.
 *
 * ⚠️ SHARED BY THE PUBLISH AND THE SEED SO THE TWO CANNOT DISAGREE. Both write the same four
 * tables, and the ordering rule below is the kind that fails as a foreign-key violation at 3am
 * rather than as a test — so having one copy is worth a module. The seed had it first; the publish
 * imports it rather than growing a second.
 */

/** What the two callers know about a part, whichever schema produced it. */
export interface OrderablePart {
  readonly id: string;
  readonly parentPartId: string | null;
}

/**
 * Parents before children, ties broken by the author's own order.
 *
 * ⚠️ THE COMPOSITE SELF-FOREIGN-KEY IS CHECKED PER STATEMENT, so a child inserted ahead of its
 * parent is a 23503. Sorting by depth is what makes the inserts legal at all — it is not a
 * presentation choice, and `position` still carries the author's ordering onto the row.
 *
 * Terminates because both gates have already proved the tree acyclic:
 * `refineTeardownCrossSectionRules` walks it, which a CHECK cannot do.
 */
export function orderPartsParentsFirst<PartShape extends OrderablePart>(
  parts: readonly PartShape[],
): readonly { readonly part: PartShape; readonly position: number }[] {
  const parentByPartId = new Map(parts.map((part) => [part.id, part.parentPartId]));

  function depthOf(partId: string): number {
    let depth = 0;
    let ancestorId = parentByPartId.get(partId) ?? null;
    while (ancestorId !== null) {
      depth += 1;
      ancestorId = parentByPartId.get(ancestorId) ?? null;
    }
    return depth;
  }

  return parts
    .map((part, position) => ({ part, position }))
    .toSorted(
      (left, right) =>
        depthOf(left.part.id) - depthOf(right.part.id) || left.position - right.position,
    );
}

/** The five model columns a row carries, on whichever arm it sits. */
export interface TeardownModelColumns {
  readonly modelUrl: string | null;
  readonly modelByteSize: number | null;
  readonly modelSource: "pasted_link" | "uploaded" | null;
  readonly modelObjectStorageKey: string | null;
  readonly modelContentSha256: string | null;
}

/** Every column NULL — the composite part arm, and the individual-parts assembly arm. */
export function noModelColumns(): TeardownModelColumns {
  return {
    modelUrl: null,
    modelByteSize: null,
    modelSource: null,
    modelObjectStorageKey: null,
    modelContentSha256: null,
  };
}

/**
 * A model the SEED pasted: a URL and a fixture byte size.
 *
 * ⚠️ `modelSource` IS WRITTEN EXPLICITLY RATHER THAN LEFT TO A DEFAULT, and there is no column
 * default to leave it to. `teardown_assembly_kind_shape_ck` requires the source on any arm that
 * carries a model, and a NULL one used to slip through because a CHECK passes on NULL — the bug
 * migration 0191 fixed. Writing it here is what keeps the seed from re-creating those rows.
 */
export function pastedModelColumns(model: {
  readonly url: string;
  readonly byteSize: number;
}): TeardownModelColumns {
  return {
    modelUrl: model.url,
    modelByteSize: model.byteSize,
    modelSource: "pasted_link",
    modelObjectStorageKey: null,
    modelContentSha256: null,
  };
}

/**
 * A model an AUTHOR uploaded: an object key and the size measured at intake.
 *
 * No URL — the address is computed per request by the read service, because a presigned URL
 * expires in 300 seconds and cannot be stored.
 */
export function uploadedModelColumns(upload: {
  readonly objectStorageKey: string;
  readonly contentSha256: string;
  readonly byteSize: number;
}): TeardownModelColumns {
  return {
    modelUrl: null,
    modelByteSize: upload.byteSize,
    modelSource: "uploaded",
    modelObjectStorageKey: upload.objectStorageKey,
    modelContentSha256: upload.contentSha256,
  };
}
