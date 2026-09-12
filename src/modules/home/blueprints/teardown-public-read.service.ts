import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  teardown,
  teardownAssembly,
  teardownAssemblyStep,
  teardownDocument,
  teardownFastener,
  teardownManufacturingFile,
  teardownMaterial,
  teardownMaterialElement,
  teardownPart,
  teardownPartListing,
  teardownStats,
} from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import type { TeardownImport } from "#src/modules/home/blueprints/teardown-import.schemas.js";
import type { TeardownMediaFilter } from "#src/modules/home/blueprints/teardown-public.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * The PUBLIC reads behind `/blueprints/teardowns` — the index, the options, the prerender slugs,
 * one teardown, and the claim targets the report page needs.
 *
 * ⚠️ THERE ARE TWO VISIBILITY GATES AND THEY ARE NOT THE SAME PREDICATE. Conflating them is the
 * one bug this file exists to prevent, so they are separate functions with separate constants and
 * neither delegates to the other:
 *
 *   * **LIST** — `published, flagged`. What a teardown may appear IN: the index, the tag facets,
 *     the composer's select. A quarantined teardown is under an unresolved rights claim, so it is
 *     not advertised.
 *   * **READABLE** — `published, flagged, quarantined`. What a teardown may be reached AT. A
 *     quarantine WITHHOLDS files; it does not delete an address. Dropping the row here would 404 a
 *     link that already exists in somebody's bookmarks and in search results — the exact failure
 *     "withheld rather than removed" is for. It is also why the prerender slug list returns the
 *     quarantined slug.
 *
 * Neither gate admits `pending_review`, and the enum's `draft`, `rejected` and `removed` reach
 * neither. `draft` never arrives at all — it lives in a browser.
 *
 * ⚠️ THE QUARANTINE WITHHOLDING IS SERVER-SIDE, AND THAT IS A MOVE RATHER THAN A COPY. It used to
 * live in `teardown-moderation-notice.tsx`, where the disputed files were already on the wire and a
 * component chose not to render them — which CLAUDE.md §1.1 says is not a control at all. Moving it
 * here also closes a live leak: the frontend gated nine fields and NOT `repairabilityIndex`, which
 * is invisible today only because the one quarantined fixture happens to carry none.
 *
 * NOTHING HERE READS THE CALLER. The payload is identical for every visitor, so these routes take
 * no session — there is nothing to personalise and nothing to leak.
 */

/** Where a teardown may APPEAR. */
const LIST_VISIBLE_MODERATION_STATES = ["published", "flagged"] as const;

/** Where a teardown may be REACHED. A quarantine withholds files, not the address. */
const READABLE_MODERATION_STATES = ["published", "flagged", "quarantined"] as const;

/**
 * The index, the facets and the options gate.
 *
 * ⚠️ DO NOT FACTOR THIS TOGETHER WITH `readableTeardownCondition` into one shared predicate with a
 * parameter. The two lists differ by exactly one label, which is precisely the edit somebody makes
 * "to remove duplication" — and the result is either a quarantined teardown advertised on the index
 * or a live URL that 404s. There is a test whose only job is to fail if these two ever agree.
 */
function listVisibleTeardownCondition(): SQL {
  return inArray(teardown.moderationState, [...LIST_VISIBLE_MODERATION_STATES]);
}

/** The detail and claim-target gate — see the warning on the sibling above. */
function readableTeardownCondition(): SQL {
  return inArray(teardown.moderationState, [...READABLE_MODERATION_STATES]);
}

/**
 * One teardown on the wire, and the type is the import contract ON PURPOSE.
 *
 * `TeardownImportSchema` is the gate everything written to these tables passed through, so typing
 * the read as its output makes read and write the same shape by construction: a field added to the
 * contract is a compile error here until this file serves it. The alternative — a hand-written
 * parallel interface — is the duplicate §3.1 forbids for request types, for the same reason.
 *
 * The three instants travel as ISO strings because that is what the contract says and what the
 * frontend's `z.iso.datetime()` parses; `JSON.stringify` would produce the same bytes from a `Date`,
 * but the type would then be lying about what a caller receives.
 */
export type PublicTeardownView = TeardownImport;

/** One tag and how many LISTABLE teardowns carry it. Mirrors the frontend's `FacetBucket`. */
export interface TeardownTagFacet {
  readonly value: string;
  readonly count: number;
}

export interface PublicTeardownIndexPage {
  readonly items: readonly PublicTeardownView[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
  readonly tagFacets: readonly TeardownTagFacet[];
}

/** One choice in the launch composer's "Built from a teardown" select. */
export interface TeardownOption {
  readonly slug: string;
  readonly title: string;
}

/**
 * What an IP claim can be ABOUT: ids and titles, provably no URLs.
 *
 * ⚠️ THIS ROUTE EXISTS BECAUSE THE WITHHOLDING WOULD OTHERWISE BREAK THE RIGHTS-CLAIM FLOW. The
 * report page builds its radio list from `documents`, `manufacturingFiles` and `assembly.parts`, and
 * a quarantined teardown still accepts a claim — a second rights holder may have an entirely
 * different objection from the first. Withhold the payload and that claimant can only say "the whole
 * teardown", which uses one quarantine to blunt the control that produced it. Nothing crashes; the
 * highest-stakes flow on the surface silently degrades.
 *
 * Half-withholding was not available: `BlueprintDocumentSchema.url` is not nullable, so a document
 * cannot travel without its link. Naming one can.
 */
export interface TeardownClaimTargets {
  readonly documents: readonly { readonly id: string; readonly title: string }[];
  readonly manufacturingFiles: readonly { readonly id: string; readonly title: string }[];
  readonly parts: readonly { readonly id: string; readonly label: string }[];
}

export type TeardownIndexError = { readonly type: "TEARDOWN_INDEX_CURSOR_MALFORMED" };
export type TeardownDetailError = { readonly type: "TEARDOWN_NOT_FOUND" };

type TeardownRow = typeof teardown.$inferSelect;
type TeardownChildRows = {
  readonly statsRows: readonly (typeof teardownStats.$inferSelect)[];
  readonly assemblyRows: readonly (typeof teardownAssembly.$inferSelect)[];
  readonly partRows: readonly (typeof teardownPart.$inferSelect)[];
  readonly documentRows: readonly (typeof teardownDocument.$inferSelect)[];
  readonly manufacturingFileRows: readonly (typeof teardownManufacturingFile.$inferSelect)[];
  readonly fastenerRows: readonly (typeof teardownFastener.$inferSelect)[];
  readonly stepRows: readonly (typeof teardownAssemblyStep.$inferSelect)[];
  readonly materialRows: readonly (typeof teardownMaterial.$inferSelect)[];
  readonly elementRows: readonly (typeof teardownMaterialElement.$inferSelect)[];
  readonly partListingRows: readonly (typeof teardownPartListing.$inferSelect)[];
};

/** Reassembles a stored `_x/_y/_z` triple, which is present as three columns or as none. */
function toVector(
  xComponent: number | null,
  yComponent: number | null,
  zComponent: number | null,
): [number, number, number] | null {
  if (xComponent === null || yComponent === null || zComponent === null) return null;
  return [xComponent, yComponent, zComponent];
}

/**
 * The stored state, narrowed to the four a teardown can actually be in.
 *
 * ⚠️ THIS IS A PARSE, NOT A CAST, and the three throwing arms are the reason it exists rather than
 * an `as`. `blueprint_moderation_state` is a seven-label enum shared with launches;
 * `teardown_moderation_state_ck` narrows the table to four, and both gates above narrow the read to
 * three. So the throw is unreachable twice over — and if either narrowing is ever loosened, a 500 is
 * the correct failure, because the alternative is publishing a `removed` teardown.
 */
function toContractModerationState(
  moderationState: TeardownRow["moderationState"],
): PublicTeardownView["moderationState"] {
  switch (moderationState) {
    case "published":
    case "flagged":
    case "quarantined":
    case "pending_review":
      return moderationState;
    case "draft":
    case "rejected":
    case "removed":
      throw new Error(`A ${moderationState} teardown must never reach a public read.`);
    default: {
      const exhaustiveCheck: never = moderationState;
      throw new Error(`Unhandled teardown moderation state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The subject kind, narrowed to the one arm that exists.
 *
 * `teardown_subject_kind_ck` pins the column; the enum carries `proposed_design` because the
 * contract calls this the first arm of a future union. When that arm lands, this function is the
 * compile error that says the view type has to grow a discriminator — which is the whole point of
 * spending a function on a one-label narrowing.
 */
function toContractSubjectKind(
  subjectKind: TeardownRow["subjectKind"],
): PublicTeardownView["subjectKind"] {
  switch (subjectKind) {
    case "existing_physical_product":
      return subjectKind;
    case "proposed_design":
      throw new Error("A proposed-design teardown has no contract arm to serve it.");
    default: {
      const exhaustiveCheck: never = subjectKind;
      throw new Error(`Unhandled teardown subject kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function buildProvenance(row: TeardownRow): PublicTeardownView["provenance"] {
  return {
    kind: row.provenanceKind,
    subjectProductName: row.provenanceSubjectProductName,
    unitAcquisition: row.provenanceUnitAcquisition,
    surveyMethods: row.provenanceSurveyMethods,
    surveyedAt: row.provenanceSurveyedAt.toISOString(),
    licence:
      row.provenanceLicenceName !== null && row.provenanceLicenceUrl !== null
        ? { name: row.provenanceLicenceName, url: row.provenanceLicenceUrl }
        : null,
    authorizationNote: row.provenanceAuthorizationNote,
    attestationAcceptedAt: row.provenanceAttestationAcceptedAt.toISOString(),
    notes: row.provenanceNotes,
  };
}

function buildRepairabilityIndex(row: TeardownRow): PublicTeardownView["repairabilityIndex"] {
  // Nine columns that travel together — `teardown_repairability_ck` says so, and half an index is
  // not an index. One NULL among them is the whole block absent.
  if (
    row.repairabilityFastenerUniformityScore === null ||
    row.repairabilityFastenerUniformityNote === null ||
    row.repairabilityToolAccessibilityScore === null ||
    row.repairabilityToolAccessibilityNote === null ||
    row.repairabilityDisassemblyStepCountScore === null ||
    row.repairabilityDisassemblyStepCountNote === null ||
    row.repairabilityModularIndependenceScore === null ||
    row.repairabilityModularIndependenceNote === null ||
    row.repairabilityOverallScore === null
  ) {
    return null;
  }

  return {
    fastenerUniformity: {
      scoreOutOfTen: row.repairabilityFastenerUniformityScore,
      note: row.repairabilityFastenerUniformityNote,
    },
    toolAccessibility: {
      scoreOutOfTen: row.repairabilityToolAccessibilityScore,
      note: row.repairabilityToolAccessibilityNote,
    },
    disassemblyStepCount: {
      scoreOutOfTen: row.repairabilityDisassemblyStepCountScore,
      note: row.repairabilityDisassemblyStepCountNote,
    },
    modularIndependence: {
      scoreOutOfTen: row.repairabilityModularIndependenceScore,
      note: row.repairabilityModularIndependenceNote,
    },
    overallScoreOutOfTen: row.repairabilityOverallScore,
  };
}

function buildSimulationTelemetry(row: TeardownRow): PublicTeardownView["simulationTelemetry"] {
  if (
    row.telemetryFactorOfSafety === null ||
    row.telemetryPeakVonMisesStressMegapascals === null ||
    row.telemetryMaxDisplacementMicrometres === null ||
    row.telemetryThermalDeltaKelvin === null ||
    row.telemetryRatedLoadNewtons === null ||
    row.telemetrySource !== "author_reported"
  ) {
    return null;
  }

  return {
    factorOfSafety: row.telemetryFactorOfSafety,
    peakVonMisesStressMegapascals: row.telemetryPeakVonMisesStressMegapascals,
    maxDisplacementMicrometres: row.telemetryMaxDisplacementMicrometres,
    thermalDeltaKelvin: row.telemetryThermalDeltaKelvin,
    ratedLoadNewtons: row.telemetryRatedLoadNewtons,
    source: "author_reported",
  };
}

/**
 * The walkthrough video, and the `source` test is load-bearing rather than defensive.
 *
 * `video_source` is a shared enum carrying `hosted`, but `BlueprintVideoSchema` is a ONE-ARM union —
 * a `hosted` row would be a detail-page parse failure in the browser, not a field the page ignores.
 * `teardown_walkthrough_video_ck` pins the column, so this arm is unreachable; it is written out
 * anyway because the day the CHECK is widened, a dropped video is a better answer than a page that
 * will not parse.
 */
function buildWalkthroughVideo(row: TeardownRow): PublicTeardownView["walkthroughVideo"] {
  if (
    row.walkthroughVideoSource !== "youtube" ||
    row.walkthroughYoutubeVideoId === null ||
    row.walkthroughPosterUrl === null
  ) {
    return null;
  }

  return {
    source: "youtube",
    youtubeVideoId: row.walkthroughYoutubeVideoId,
    posterUrl: row.walkthroughPosterUrl,
    // Nullable INSIDE a present block: YouTube's oEmbed returns no duration and nothing on either
    // side of the wire can measure one.
    durationSeconds: row.walkthroughDurationSeconds,
  };
}

/**
 * The assembly, or `null` when there is no model — and `null` also when there are no parts.
 *
 * ⚠️ AN ASSEMBLY WITH ZERO PARTS MUST NOT SERIALISE AS `{ parts: [] }`. The frontend's
 * `AssemblySchema` carries `.min(1)`, so an empty array is a page that refuses to parse rather than
 * a viewer with nothing in it. A row whose children all vanished is the same fact as no assembly.
 */
function buildAssembly(
  assemblyRow: typeof teardownAssembly.$inferSelect | undefined,
  partRows: readonly (typeof teardownPart.$inferSelect)[],
): PublicTeardownView["assembly"] {
  if (assemblyRow === undefined || partRows.length === 0) return null;

  const explosionAxis = toVector(
    assemblyRow.explosionAxisX,
    assemblyRow.explosionAxisY,
    assemblyRow.explosionAxisZ,
  );
  const basePartFields = (partRow: typeof teardownPart.$inferSelect) => ({
    id: partRow.id,
    label: partRow.label,
    parentPartId: partRow.parentPartId,
    material: partRow.material,
    manufacturingMethod: partRow.manufacturingMethod,
    explosionDirection: toVector(
      partRow.explosionDirectionX,
      partRow.explosionDirectionY,
      partRow.explosionDirectionZ,
    ),
    explosionDistanceMm: partRow.explosionDistanceMm,
    layerIndex: partRow.layerIndex,
    stressRating: partRow.stressRating,
    calloutText: partRow.calloutText,
  });

  switch (assemblyRow.kind) {
    case "composite": {
      // Non-null on this arm: `teardown_assembly_kind_shape_ck` ties the model to the discriminator.
      if (assemblyRow.modelUrl === null || assemblyRow.modelByteSize === null) return null;
      const parts = partRows.flatMap((partRow) =>
        partRow.nodeName === null
          ? []
          : [{ ...basePartFields(partRow), nodeName: partRow.nodeName }],
      );
      if (parts.length === 0) return null;

      return {
        kind: "composite",
        explosionAxis,
        model: { url: assemblyRow.modelUrl, byteSize: assemblyRow.modelByteSize },
        parts,
      };
    }
    case "individual_parts": {
      const parts = partRows.flatMap((partRow) =>
        partRow.modelUrl === null || partRow.modelByteSize === null
          ? []
          : [
              {
                ...basePartFields(partRow),
                model: { url: partRow.modelUrl, byteSize: partRow.modelByteSize },
                placement: buildPlacement(partRow),
              },
            ],
      );
      if (parts.length === 0) return null;

      return { kind: "individual_parts", explosionAxis, parts };
    }
    default: {
      const exhaustiveCheck: never = assemblyRow.kind;
      throw new Error(`Unhandled teardown assembly kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function buildPlacement(partRow: typeof teardownPart.$inferSelect): {
  readonly positionMm: [number, number, number];
  readonly rotationDegrees: [number, number, number];
} | null {
  const positionMm = toVector(
    partRow.placementPositionX,
    partRow.placementPositionY,
    partRow.placementPositionZ,
  );
  const rotationDegrees = toVector(
    partRow.placementRotationX,
    partRow.placementRotationY,
    partRow.placementRotationZ,
  );
  if (positionMm === null || rotationDegrees === null) return null;
  return { positionMm, rotationDegrees };
}

function buildMaterials(
  materialRows: readonly (typeof teardownMaterial.$inferSelect)[],
  elementRows: readonly (typeof teardownMaterialElement.$inferSelect)[],
): PublicTeardownView["materials"] {
  return materialRows.map((materialRow) => ({
    id: materialRow.id,
    appliesToLabel: materialRow.appliesToLabel,
    partId: materialRow.partId,
    designation: materialRow.designation,
    designationSource: materialRow.designationSource,
    materialClass: materialRow.materialClass,
    process: materialRow.process,
    finish: materialRow.finish,
    elements: elementRows
      .filter((elementRow) => elementRow.materialId === materialRow.id)
      .map((elementRow) => ({
        symbol: elementRow.symbol,
        // A NULL range is "present but not quantified" — a different claim from zero percent.
        weightPercentRange:
          elementRow.minimumPercent === null || elementRow.maximumPercent === null
            ? null
            : {
                minimumPercent: elementRow.minimumPercent,
                maximumPercent: elementRow.maximumPercent,
              },
        analysisMethod: elementRow.analysisMethod,
        instrumentLabel: elementRow.instrumentLabel,
        operatorNote: elementRow.operatorNote,
      })),
  }));
}

/**
 * Everything a quarantine withholds, as one list rather than ten scattered ternaries.
 *
 * Every field here is already nullable or an empty array in the frontend's own contract, which is
 * what makes withholding a legal payload rather than a broken one.
 */
function withheldPayload(): Pick<
  PublicTeardownView,
  | "assembly"
  | "assemblySteps"
  | "billOfMaterialsCostRange"
  | "documents"
  | "fasteners"
  | "manufacturingFiles"
  | "materials"
  | "partsList"
  | "repairabilityIndex"
  | "simulationTelemetry"
  | "walkthroughVideo"
> {
  return {
    assembly: null,
    assemblySteps: [],
    billOfMaterialsCostRange: null,
    documents: [],
    fasteners: [],
    manufacturingFiles: [],
    materials: [],
    partsList: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
    walkthroughVideo: null,
  };
}

/**
 * One teardown, with the quarantine decision applied.
 *
 * ⚠️ WHAT SURVIVES A QUARANTINE IS AS DELIBERATE AS WHAT DOES NOT. Every field outside
 * `withheldPayload()` renders on the quarantined page: the notice itself needs `moderationState`,
 * the header needs `thumbnailUrl` (an unconditional `<Image>`), the byline needs `author`, the
 * decision row needs `difficulty`, and the chip derives from `provenance` — which is not nullable in
 * the contract, so withholding it would be a parse failure rather than a redaction.
 *
 * `partCount`, `cadFormat` and `storeProductClass` survive on the frontend's own stated reasoning: a
 * quarantine is a claim about the publisher's FILES; it says nothing about whether a market for the
 * product exists.
 */
function buildTeardownView(row: TeardownRow, childRows: TeardownChildRows): PublicTeardownView {
  const statsRow = childRows.statsRows.find((candidate) => candidate.teardownId === row.id);
  const assemblyRow = childRows.assemblyRows.find((candidate) => candidate.teardownId === row.id);
  const partRows =
    assemblyRow === undefined
      ? []
      : childRows.partRows.filter((candidate) => candidate.assemblyId === assemblyRow.id);
  const materialRows = childRows.materialRows.filter(
    (candidate) => candidate.teardownId === row.id,
  );

  const visiblePayload =
    row.moderationState === "quarantined"
      ? withheldPayload()
      : {
          assembly: buildAssembly(assemblyRow, partRows),
          assemblySteps: childRows.stepRows
            .filter((candidate) => candidate.teardownId === row.id)
            .map((stepRow) => ({
              stepNumber: stepRow.stepNumber,
              title: stepRow.title,
              description: stepRow.description,
              focusedPartId: stepRow.focusedPartId,
            })),
          billOfMaterialsCostRange:
            row.billOfMaterialsMinimumCents !== null &&
            row.billOfMaterialsMaximumCents !== null &&
            row.billOfMaterialsCurrency === "USD"
              ? {
                  minimumInCents: row.billOfMaterialsMinimumCents,
                  maximumInCents: row.billOfMaterialsMaximumCents,
                  currency: "USD" as const,
                }
              : null,
          documents: childRows.documentRows
            .filter((candidate) => candidate.teardownId === row.id)
            .map((documentRow) => ({
              id: documentRow.id,
              kind: documentRow.kind,
              title: documentRow.title,
              url: documentRow.url,
              byteSize: documentRow.byteSize,
              pageCount: documentRow.pageCount,
            })),
          fasteners: childRows.fastenerRows
            .filter((candidate) => candidate.teardownId === row.id)
            .map((fastenerRow) => ({
              standardCode: fastenerRow.standardCode,
              sizeLabel: fastenerRow.sizeLabel,
              drive: fastenerRow.drive,
              quantity: fastenerRow.quantity,
              supplier:
                fastenerRow.supplierLabel !== null && fastenerRow.supplierUrl !== null
                  ? { label: fastenerRow.supplierLabel, url: fastenerRow.supplierUrl }
                  : null,
            })),
          manufacturingFiles: childRows.manufacturingFileRows
            .filter((candidate) => candidate.teardownId === row.id)
            .map((manufacturingFileRow) => ({
              id: manufacturingFileRow.id,
              kind: manufacturingFileRow.kind,
              title: manufacturingFileRow.title,
              url: manufacturingFileRow.url,
              byteSize: manufacturingFileRow.byteSize,
            })),
          materials: buildMaterials(materialRows, childRows.elementRows),
          /*
           * WITHHELD BY A QUARANTINE, beside `materials` and for the same reason. A listing carries
           * no file, so the "it withholds files" shorthand does not decide it — but what a rights
           * claim disputes is the SURVEY, and a part list is the survey's findings about somebody
           * else's product in the plainest form it takes. Withholding the composition table while
           * publishing the parts it describes would be a distinction nobody could defend.
           */
          partsList: childRows.partListingRows
            .filter((candidate) => candidate.teardownId === row.id)
            .map((partListingRow) => ({
              label: partListingRow.label,
              material: partListingRow.material,
            })),
          repairabilityIndex: buildRepairabilityIndex(row),
          simulationTelemetry: buildSimulationTelemetry(row),
          walkthroughVideo: buildWalkthroughVideo(row),
        };

  return {
    id: row.id,
    slug: row.slug,
    category: "teardown",
    title: row.title,
    summary: row.summary,
    thumbnailUrl: row.thumbnailUrl,
    author: {
      displayName: row.authorDisplayName,
      handle: row.authorHandle,
      avatarUrl: row.authorAvatarUrl,
    },
    // `coalesce` at the query would hide a missing sidecar; the seed writes one per teardown, so a
    // missing row is a bug rather than a legal zero. Zero is still the honest answer to serve.
    viewCount: statsRow?.viewCount ?? 0,
    likeCount: statsRow?.likeCount ?? 0,
    commentCount: statsRow?.commentCount ?? 0,
    saveCount: statsRow?.saveCount ?? 0,
    difficulty: row.difficulty,
    cadFormat: row.cadFormat,
    tags: row.tags,
    partCount: row.partCount,
    subjectKind: toContractSubjectKind(row.subjectKind),
    moderationState: toContractModerationState(row.moderationState),
    provenance: buildProvenance(row),
    storeProductClass:
      row.storeProductClassCategorySlug !== null && row.storeProductClassLabel !== null
        ? { categorySlug: row.storeProductClassCategorySlug, label: row.storeProductClassLabel }
        : null,
    createdAt: row.createdAt.toISOString(),
    ...visiblePayload,
  };
}

/**
 * `?media=` as predicates over the data, never as stored booleans.
 *
 * A denormalised `has_assembly` would be a cached fact with no source of truth on a read-only
 * surface — the same thing the house refused for `showcase_launch_stats`. Two of the three are
 * semi-joins riding indexes the page loads need anyway.
 */
function buildMediaCondition(media: TeardownMediaFilter): SQL {
  switch (media) {
    case "assembly":
      return exists(
        db
          .select({ present: sql`1` })
          .from(teardownAssembly)
          .where(eq(teardownAssembly.teardownId, teardown.id)),
      );
    case "video":
      // The CHECK ties the three video columns together, so any one of them answers the question.
      return isNotNull(teardown.walkthroughYoutubeVideoId);
    case "documents":
      return exists(
        db
          .select({ present: sql`1` })
          .from(teardownDocument)
          .where(eq(teardownDocument.teardownId, teardown.id)),
      );
    default: {
      const exhaustiveCheck: never = media;
      throw new Error(`Unhandled teardown media filter: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Loads every child a page of teardowns needs — nine queries for N teardowns, never 9N.
 *
 * The element query keys off the material ids rather than the teardown ids, because
 * `teardown_material_element` has no teardown column: it hangs off a material, which is the two-hop
 * shape the rest of this schema uses.
 */
async function loadTeardownChildren(teardownIds: readonly string[]): Promise<TeardownChildRows> {
  if (teardownIds.length === 0) {
    return {
      statsRows: [],
      assemblyRows: [],
      partRows: [],
      documentRows: [],
      manufacturingFileRows: [],
      fastenerRows: [],
      stepRows: [],
      materialRows: [],
      elementRows: [],
      partListingRows: [],
    };
  }

  const ids = [...teardownIds];
  const [
    statsRows,
    assemblyRows,
    documentRows,
    manufacturingFileRows,
    fastenerRows,
    stepRows,
    materialRows,
    partListingRows,
  ] = await Promise.all([
    db.select().from(teardownStats).where(inArray(teardownStats.teardownId, ids)),
    db.select().from(teardownAssembly).where(inArray(teardownAssembly.teardownId, ids)),
    db
      .select()
      .from(teardownDocument)
      .where(inArray(teardownDocument.teardownId, ids))
      .orderBy(asc(teardownDocument.teardownId), asc(teardownDocument.position)),
    db
      .select()
      .from(teardownManufacturingFile)
      .where(inArray(teardownManufacturingFile.teardownId, ids))
      .orderBy(asc(teardownManufacturingFile.teardownId), asc(teardownManufacturingFile.position)),
    db
      .select()
      .from(teardownFastener)
      .where(inArray(teardownFastener.teardownId, ids))
      .orderBy(asc(teardownFastener.teardownId), asc(teardownFastener.position)),
    // Ordered by number, so a gap that somehow reached the table still comes back in sequence.
    db
      .select()
      .from(teardownAssemblyStep)
      .where(inArray(teardownAssemblyStep.teardownId, ids))
      .orderBy(asc(teardownAssemblyStep.teardownId), asc(teardownAssemblyStep.stepNumber)),
    db
      .select()
      .from(teardownMaterial)
      .where(inArray(teardownMaterial.teardownId, ids))
      .orderBy(asc(teardownMaterial.teardownId), asc(teardownMaterial.position)),
    db
      .select()
      .from(teardownPartListing)
      .where(inArray(teardownPartListing.teardownId, ids))
      .orderBy(asc(teardownPartListing.teardownId), asc(teardownPartListing.position)),
  ]);

  const assemblyIds = assemblyRows.map((assemblyRow) => assemblyRow.id);
  const materialIds = materialRows.map((materialRow) => materialRow.id);

  const [partRows, elementRows] = await Promise.all([
    assemblyIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(teardownPart)
          .where(inArray(teardownPart.assemblyId, assemblyIds))
          .orderBy(asc(teardownPart.assemblyId), asc(teardownPart.position)),
    materialIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(teardownMaterialElement)
          .where(inArray(teardownMaterialElement.materialId, materialIds))
          .orderBy(asc(teardownMaterialElement.materialId), asc(teardownMaterialElement.position)),
  ]);

  return {
    statsRows,
    assemblyRows,
    partRows,
    documentRows,
    manufacturingFileRows,
    fastenerRows,
    stepRows,
    materialRows,
    elementRows,
    partListingRows,
  };
}

/**
 * Tag counts across every LISTABLE teardown — the whole category, never the page and never the
 * active filter.
 *
 * Counting the page would make the chips disagree with the list the moment there is a second page,
 * which is the one thing a facet count cannot do. Counting under the current `?tag=` would make
 * every chip but the selected one read zero.
 */
async function loadTeardownTagFacets(): Promise<readonly TeardownTagFacet[]> {
  const tagExpression = sql<string>`unnest(${teardown.tags})`;
  const facetRows = await db
    .select({ value: tagExpression, count: count() })
    .from(teardown)
    .where(listVisibleTeardownCondition())
    .groupBy(tagExpression)
    .orderBy(desc(count()), asc(tagExpression));

  return facetRows.map((facetRow) => ({ value: facetRow.value, count: Number(facetRow.count) }));
}

/**
 * The index page, its filters and the tag facets beside it.
 *
 * ⚠️ THE KEYSET IS MIXED-DIRECTION — `created_at DESC, id ASC` — because the frontend's comparator
 * breaks ties on the id ascending. The predicate mirrors the ORDER BY pair for pair, or a page
 * boundary landing mid-tie skips or repeats a teardown. `teardown_public_newest_idx` is declared in
 * the same directions and partial on this exact gate.
 *
 * NO SORT CONTROL, which is why this reuses `instant-cursor.ts` rather than minting a third codec.
 * `showcase-feed-cursor.ts` exists only because that surface offers two orders, and says so.
 */
export async function listPublicTeardowns(input: {
  readonly difficulty: (typeof teardown.$inferSelect)["difficulty"] | undefined;
  readonly media: TeardownMediaFilter | undefined;
  readonly tag: string | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
}): Promise<Result<PublicTeardownIndexPage, TeardownIndexError>> {
  const conditions: SQL[] = [listVisibleTeardownCondition()];

  if (input.difficulty !== undefined) conditions.push(eq(teardown.difficulty, input.difficulty));
  if (input.media !== undefined) conditions.push(buildMediaCondition(input.media));
  if (input.tag !== undefined) {
    // `@>` so the tag matches as an array ELEMENT rather than as a substring of one.
    conditions.push(sql`${teardown.tags} @> ARRAY[${input.tag}]::text[]`);
  }

  if (input.cursor !== undefined) {
    const cursor = decodeInstantCursor(input.cursor);
    // A cursor this server did not mint. Refused rather than dropped: a feed that silently restarts
    // shows the reader duplicates and reads as a backend bug.
    if (cursor === null) {
      return { success: false, error: { type: "TEARDOWN_INDEX_CURSOR_MALFORMED" } };
    }
    const keysetCondition = or(
      lt(teardown.createdAt, cursor.instant),
      and(eq(teardown.createdAt, cursor.instant), gt(teardown.id, cursor.id)),
    );
    if (keysetCondition === undefined) {
      return { success: false, error: { type: "TEARDOWN_INDEX_CURSOR_MALFORMED" } };
    }
    conditions.push(keysetCondition);
  }

  const [teardownRows, tagFacets] = await Promise.all([
    db
      .select()
      .from(teardown)
      .where(and(...conditions))
      .orderBy(desc(teardown.createdAt), asc(teardown.id))
      // One more than asked for, so "is there another page" needs no second count query.
      .limit(input.limit + 1),
    loadTeardownTagFacets(),
  ]);

  const hasMore = teardownRows.length > input.limit;
  const pageRows = hasMore ? teardownRows.slice(0, input.limit) : teardownRows;
  const childRows = await loadTeardownChildren(pageRows.map((row) => row.id));
  const items = pageRows.map((row) => buildTeardownView(row, childRows));

  // Minted from the last RETURNED row, never the over-fetched one: encoding the extra row would
  // skip a teardown on every page boundary.
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.id }) : null;

  return { success: true, value: { items, page: { nextCursor, hasMore }, tagFacets } };
}

/**
 * One teardown by its address, under the READABLE gate.
 *
 * A quarantined teardown answers 200 with its payload withheld — see `buildTeardownView`. A
 * `pending_review` one answers as if it did not exist, because to a reader it does not.
 */
export async function getPublicTeardownBySlug(
  slug: string,
): Promise<Result<PublicTeardownView, TeardownDetailError>> {
  const [teardownRow] = await db
    .select()
    .from(teardown)
    .where(and(readableTeardownCondition(), eq(teardown.slug, slug)))
    .limit(1);

  if (!teardownRow) return { success: false, error: { type: "TEARDOWN_NOT_FOUND" } };

  const childRows = await loadTeardownChildren([teardownRow.id]);
  return { success: true, value: buildTeardownView(teardownRow, childRows) };
}

/**
 * Every readable slug, for the frontend's `generateStaticParams`.
 *
 * ⚠️ THE READABLE GATE, SO A QUARANTINED SLUG IS IN THE LIST. Prerendering only the advertised ones
 * would leave the quarantined page to a runtime miss — and the whole point of withholding rather
 * than deleting is that the address keeps working.
 *
 * Unpaged on purpose: one short string per readable teardown, and the caller needs all of them at
 * once to prerender. A cursor here would mean a build step that pages.
 */
export async function listPublicTeardownSlugs(): Promise<readonly string[]> {
  const slugRows = await db
    .select({ slug: teardown.slug })
    .from(teardown)
    .where(readableTeardownCondition())
    .orderBy(desc(teardown.createdAt), asc(teardown.id));

  return slugRows.map((slugRow) => slugRow.slug);
}

/**
 * Every LISTABLE teardown as a slug and a title, for the launch composer's select.
 *
 * THE LIST GATE, not the readable one: naming a teardown as what you built from is a recommendation,
 * and a quarantined teardown is one nobody should be steered toward while the claim is open.
 *
 * Sorted by title to match the frontend's `localeCompare`, so the select's order does not change
 * the day this stops being a fixture read.
 */
export async function listTeardownOptions(): Promise<readonly TeardownOption[]> {
  const optionRows = await db
    .select({ slug: teardown.slug, title: teardown.title })
    .from(teardown)
    .where(listVisibleTeardownCondition())
    .orderBy(asc(teardown.title), asc(teardown.slug));

  return optionRows;
}

/**
 * What a rights claim can name, under the READABLE gate — ids and titles, no URLs.
 *
 * See `TeardownClaimTargets` for why this route exists at all. The select lists are the guarantee:
 * there is no column here that could carry a link, so the withholding cannot be walked around by
 * asking this route instead.
 */
export async function getTeardownClaimTargets(
  slug: string,
): Promise<Result<TeardownClaimTargets, TeardownDetailError>> {
  const [teardownRow] = await db
    .select({ id: teardown.id })
    .from(teardown)
    .where(and(readableTeardownCondition(), eq(teardown.slug, slug)))
    .limit(1);

  if (!teardownRow) return { success: false, error: { type: "TEARDOWN_NOT_FOUND" } };

  const [documents, manufacturingFiles, parts] = await Promise.all([
    db
      .select({ id: teardownDocument.id, title: teardownDocument.title })
      .from(teardownDocument)
      .where(eq(teardownDocument.teardownId, teardownRow.id))
      .orderBy(asc(teardownDocument.position)),
    db
      .select({ id: teardownManufacturingFile.id, title: teardownManufacturingFile.title })
      .from(teardownManufacturingFile)
      .where(eq(teardownManufacturingFile.teardownId, teardownRow.id))
      .orderBy(asc(teardownManufacturingFile.position)),
    db
      .select({ id: teardownPart.id, label: teardownPart.label })
      .from(teardownPart)
      .innerJoin(teardownAssembly, eq(teardownAssembly.id, teardownPart.assemblyId))
      .where(eq(teardownAssembly.teardownId, teardownRow.id))
      .orderBy(asc(teardownPart.position)),
  ]);

  return { success: true, value: { documents, manufacturingFiles, parts } };
}
