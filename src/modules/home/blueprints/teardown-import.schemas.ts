import { z } from "zod";

import {
  AssetUrlSchema,
  ExternalUrlSchema,
} from "#src/modules/home/blueprints/blueprint-url.schemas.js";

/**
 * The shape a teardown must have before it may enter this database.
 *
 * ⚠️ THIS IS A BACKEND-OWNED MIRROR of the frontend's `TeardownBlueprintSchema`
 * (`qatoto-frontend/src/lib/blueprints/schemas.ts`, the teardown arm and its `superRefine`). It is
 * a copy, and the duplication is deliberate: that module has RUNTIME imports — a URL factory, a
 * YouTube id parser, a shared page shape — so it cannot be imported across the repository boundary
 * the way the fixture file can. Keep the two in step by hand; the tests pin the rules, not the prose.
 *
 * ⚠️ IT IS ALSO, TODAY, THE ONLY WRITE GATE THIS SURFACE HAS. Teardowns have no authoring route, so
 * the seed is the only writer and this schema stands where a controller's `safeParse` normally
 * stands. It lives in `src/modules/` rather than in `scripts/` for that reason: the authoring path
 * should adopt it rather than find a throwaway copy beside a seed.
 *
 * WHAT IT CARRIES THAT THE DATABASE CANNOT. Five rules need to see more than one row, and a
 * Postgres CHECK may not reference another row, another table or a subquery:
 *
 *   1. the part tree is acyclic (the column CHECK catches only a part parenting itself);
 *   2. an assembly has at least one part — and the frontend's shape has `.min(1)`, so a zero-part
 *      assembly on the wire is a broken detail page rather than a degraded one;
 *   3. step numbers are a dense sequence from 1 in array order, not merely unique;
 *   4. explosion layering is all-or-nothing: an axis means every part carries a layer, no axis
 *      means none does;
 *   5. survey methods do not repeat.
 *
 * `.strict()` everywhere, and that is the rule worth keeping. The fixture file lives in another
 * repository and is edited by someone who is not looking at this schema; a field this backend does
 * not model should stop the seed loudly rather than be dropped on the floor.
 */

/**
 * Anything a URL parser and a browser might read differently.
 *
 * Written as explicit escapes rather than literal bytes so the range is readable: NUL through
 * space, plus DEL. Byte-matches `ILLEGAL_CHARACTERS` in `src/lib/external-url.ts`.
 */
// oxlint-disable-next-line no-control-regex -- control characters ARE the payload here
const KEBAB_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The addresses a category segment or a route on this surface already owns.
 *
 * ⚠️ TWO SPELLINGS OF ONE RULE. `teardown_slug_ck` repeats this list as SQL literals, because a
 * CHECK cannot read a TS const. `db:verify-teardown-constraints` reads the constraint back out of
 * `pg_get_constraintdef` and asserts it contains every member of this array — without that, an edit
 * to one spelling and not the other lets the slug minter hand out an address the table refuses.
 *
 * `mine` joined the list when `GET /blueprints/teardowns/mine` did: a literal route above
 * `/:teardownSlug` permanently shadows a teardown published at that slug.
 */
export const RESERVED_TEARDOWN_SLUGS = [
  "teardowns",
  "showcase",
  "case-studies",
  "new",
  "slugs",
  "options",
  "mine",
] as const;

export const TEARDOWN_MANUFACTURING_METHODS = [
  "cnc_milled",
  "injection_molded",
  "sheet_metal",
  "fdm_printed",
  "pcb_assembly",
  "cast",
  "off_the_shelf",
] as const;

/** The four methods that are measurements. The other two are statements about not measuring. */
const MEASURED_ANALYSIS_METHODS = ["xrf", "oes", "eds", "icp_oes"] as const;

const CompositionElementSchema = z
  .object({
    symbol: z.string().min(1).max(3),
    weightPercentRange: z
      .object({
        minimumPercent: z.number().min(0).max(100),
        maximumPercent: z.number().min(0).max(100),
      })
      .strict()
      .refine((range) => range.maximumPercent >= range.minimumPercent, {
        path: ["maximumPercent"],
        message: "The upper bound cannot be below the lower one.",
      })
      /** NULL is "present but not quantified", a different claim from zero percent. */
      .nullable(),
    analysisMethod: z.enum([
      "xrf",
      "oes",
      "eds",
      "icp_oes",
      "declared_not_measured",
      "synthetic_example",
    ]),
    instrumentLabel: z.string().min(1).max(120).nullable(),
    operatorNote: z.string().min(1).max(400).nullable(),
  })
  .strict()
  /**
   * An instrument may only accompany a measurement. Naming a spectrometer beside
   * `declared_not_measured` claims it read a number nobody measured. One-directional: a measured
   * row may still leave the instrument unnamed.
   */
  .refine(
    (element) =>
      element.instrumentLabel === null ||
      MEASURED_ANALYSIS_METHODS.some((method) => method === element.analysisMethod),
    {
      path: ["instrumentLabel"],
      message: "Only a measured analysis method may name an instrument.",
    },
  );

const MaterialSchema = z
  .object({
    id: z.string().min(1).max(120),
    appliesToLabel: z.string().min(1).max(120),
    partId: z.string().min(1).max(120).nullable(),
    designation: z.string().min(1).max(120),
    designationSource: z.enum([
      "measured_spectroscopy",
      "manufacturer_marking",
      "public_datasheet",
      "supplier_declared",
      "contributor_freetext",
    ]),
    materialClass: z.enum([
      "metal_alloy",
      "polymer",
      "elastomer",
      "composite",
      "ceramic",
      "glass",
      "laminate",
      "semiconductor_package",
      "coating",
      "other",
    ]),
    process: z.enum(TEARDOWN_MANUFACTURING_METHODS).nullable(),
    finish: z.string().min(1).max(120).nullable(),
    elements: z.array(CompositionElementSchema),
  })
  .strict();

const DocumentSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["schematic", "bill_of_materials", "assembly_guide", "datasheet"]),
    title: z.string().min(1).max(200),
    url: AssetUrlSchema,
    /**
     * NULL means unmeasured, which is not zero bytes.
     *
     * ⚠️ NULLABLE SINCE THE AUTHORING ROUTE LANDED, and the column followed. The seed's fixtures
     * carry a figure; the wizard sends a pasted link and no size, and the two ways to invent one
     * were a network HEAD inside the publish transaction or a moderator typing a number about a
     * file they never opened.
     */
    byteSize: z.number().int().nonnegative().nullable(),
    pageCount: z.number().int().positive().nullable(),
  })
  .strict();

const ManufacturingFileSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum([
      "step",
      "stl",
      "dxf",
      "gerber",
      "drill",
      "pick_and_place",
      "bill_of_materials_csv",
    ]),
    title: z.string().min(1).max(200),
    url: AssetUrlSchema,
    /**
     * Positive, unlike a document's byte size — the contract draws that distinction — and nullable
     * for the same reason the document's is.
     */
    byteSize: z.number().int().positive().nullable(),
  })
  .strict();

const FastenerSchema = z
  .object({
    standardCode: z.string().min(1).max(80).nullable(),
    sizeLabel: z.string().min(1).max(80),
    drive: z.enum([
      "torx",
      "hex_socket",
      "phillips",
      "slotted",
      "adhesive",
      "snap_fit",
      "press_fit",
    ]),
    quantity: z.number().int().positive(),
    supplier: z
      .object({ label: z.string().min(1).max(80), url: ExternalUrlSchema })
      .strict()
      .nullable(),
  })
  .strict();

const AssemblyStepSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    focusedPartId: z.string().min(1).max(120).nullable(),
  })
  .strict();

const ThreeComponentVectorSchema = z.tuple([z.number(), z.number(), z.number()]);

/** A direction of `[0,0,0]` explodes nothing, which differs from stating no direction at all. */
const NonZeroVectorSchema = ThreeComponentVectorSchema.refine(
  (vector) => vector.some((component) => component !== 0),
  { message: "A direction vector may not be the zero vector." },
);

const ModelFileSchema = z
  .object({ url: AssetUrlSchema, byteSize: z.number().int().positive() })
  .strict();

const PartBaseShape = {
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  parentPartId: z.string().min(1).max(120).nullable(),
  material: z.string().min(1).max(120),
  manufacturingMethod: z.enum(TEARDOWN_MANUFACTURING_METHODS),
  explosionDirection: NonZeroVectorSchema.nullable(),
  explosionDistanceMm: z.number().positive().nullable(),
  /** Zero is legal, and so are duplicates — three buttons can share one plane. */
  layerIndex: z.number().int().nonnegative().nullable(),
  /** An author-assigned heat-map weight, never a solver result. */
  stressRating: z.number().min(0).max(1).nullable(),
  calloutText: z.string().min(1).max(400).nullable(),
};

const CompositePartSchema = z
  .object({ ...PartBaseShape, nodeName: z.string().min(1).max(120) })
  .strict();

const IndividualPartSchema = z
  .object({
    ...PartBaseShape,
    model: ModelFileSchema,
    placement: z
      .object({
        positionMm: ThreeComponentVectorSchema,
        rotationDegrees: ThreeComponentVectorSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const AssemblySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("composite"),
      explosionAxis: NonZeroVectorSchema.nullable(),
      model: ModelFileSchema,
      parts: z.array(CompositePartSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("individual_parts"),
      explosionAxis: NonZeroVectorSchema.nullable(),
      parts: z.array(IndividualPartSchema).min(1),
    })
    .strict(),
]);

export const RepairabilityCriterionSchema = z
  .object({ scoreOutOfTen: z.number().int().min(0).max(10), note: z.string().min(1).max(400) })
  .strict();

export const ProvenanceSchema = z
  .object({
    kind: z.enum([
      "licensed_open_source",
      "authorized_by_manufacturer",
      "community_reverse_engineered",
    ]),
    subjectProductName: z.string().min(1).max(200),
    unitAcquisition: z.enum([
      "retail_purchase",
      "secondary_market",
      "manufacturer_supplied",
      "donated_unit",
    ]),
    surveyMethods: z
      .array(z.enum(["dimensional_survey", "empirical_teardown", "material_spectroscopy"]))
      .min(1)
      /** A CHECK cannot hold the subquery distinctness needs, so it is enforced here. */
      .refine((methods) => new Set(methods).size === methods.length, {
        message: "Each survey method appears once.",
      }),
    surveyedAt: z.iso.datetime(),
    licence: z
      .object({ name: z.string().min(1).max(120), url: ExternalUrlSchema })
      .strict()
      .nullable(),
    authorizationNote: z.string().min(1).max(4000).nullable(),
    attestationAcceptedAt: z.iso.datetime(),
    notes: z.string().min(1).max(4000).nullable(),
  })
  .strict()
  /**
   * THE PERMISSION TRUTH TABLE, all three arms, each refusing both the missing required field and
   * the present forbidden one. This duplicates `teardown_provenance_permission_ck` on purpose — the
   * CHECK is the backstop, and a 23514 names a constraint while this names a fixture field.
   */
  .superRefine((provenance, context) => {
    const expectations: Record<
      typeof provenance.kind,
      { readonly licence: boolean; readonly authorizationNote: boolean }
    > = {
      licensed_open_source: { licence: true, authorizationNote: false },
      authorized_by_manufacturer: { licence: false, authorizationNote: true },
      community_reverse_engineered: { licence: false, authorizationNote: false },
    };
    const expected = expectations[provenance.kind];

    if (expected.licence !== (provenance.licence !== null)) {
      context.addIssue({
        code: "custom",
        path: ["licence"],
        message: expected.licence
          ? "This provenance kind must name its licence."
          : "This provenance kind may not name a licence.",
      });
    }
    if (expected.authorizationNote !== (provenance.authorizationNote !== null)) {
      context.addIssue({
        code: "custom",
        path: ["authorizationNote"],
        message: expected.authorizationNote
          ? "This provenance kind must record its authorization."
          : "This provenance kind may not record an authorization note.",
      });
    }
  });

/**
 * The document shape, WITHOUT the cross-row rules.
 *
 * Split out from `TeardownImportSchema` so the authoring path can reuse the refinement without
 * inheriting the seed's fields. `.superRefine()` returns a `ZodEffects`, which has no `.omit()` and
 * no `.extend()` — so a schema that needs a different field set has to compose from the object, and
 * the object has to exist separately for that to be possible.
 */
export const TeardownImportDocumentShape = z
  .object({
    id: z.string().min(1).max(120),
    slug: z
      .string()
      .min(3)
      .max(120)
      .regex(KEBAB_SLUG_PATTERN, "A teardown address is lowercase, digits and single hyphens.")
      .refine(
        (slug) => !RESERVED_TEARDOWN_SLUGS.some((reserved) => reserved === slug),
        "That address is already a route on this surface.",
      ),
    category: z.literal("teardown"),
    title: z.string().min(8).max(160),
    summary: z.string().min(40).max(2000),
    thumbnailUrl: AssetUrlSchema,
    author: z
      .object({
        displayName: z.string().min(1).max(80),
        handle: z.string().min(1).max(64).regex(HANDLE_PATTERN).nullable(),
        avatarUrl: AssetUrlSchema.nullable(),
      })
      .strict(),
    viewCount: z.number().int().nonnegative(),
    likeCount: z.number().int().nonnegative(),
    commentCount: z.number().int().nonnegative(),
    saveCount: z.number().int().nonnegative(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]),
    cadFormat: z.string().min(1).max(120).nullable(),
    billOfMaterialsCostRange: z
      .object({
        minimumInCents: z.number().int().nonnegative().max(100_000_000),
        maximumInCents: z.number().int().nonnegative().max(100_000_000),
        currency: z.literal("USD"),
      })
      .strict()
      /** The frontend's shape has no such refine; this is the backend tightening, deliberately. */
      .refine((range) => range.maximumInCents >= range.minimumInCents, {
        path: ["maximumInCents"],
        message: "The upper bound cannot be below the lower one.",
      })
      .nullable(),
    tags: z.array(z.string().min(1).max(40)).max(12),
    createdAt: z.iso.datetime(),
    /** The four states a teardown can be in. `draft` lives in a browser and never arrives here. */
    moderationState: z.enum(["published", "flagged", "quarantined", "pending_review"]),
    subjectKind: z.literal("existing_physical_product"),
    provenance: ProvenanceSchema,
    materials: z.array(MaterialSchema),
    storeProductClass: z
      .object({
        categorySlug: z.string().min(1).max(120).regex(KEBAB_SLUG_PATTERN),
        label: z.string().min(1).max(80),
      })
      .strict()
      .nullable(),
    walkthroughVideo: z
      .object({
        posterUrl: AssetUrlSchema,
        durationSeconds: z.number().int().positive().nullable(),
        /** One arm. A `hosted` value is a detail-page parse failure, not a field the page ignores. */
        source: z.literal("youtube"),
        youtubeVideoId: z.string().regex(YOUTUBE_VIDEO_ID_PATTERN),
      })
      .strict()
      .nullable(),
    documents: z.array(DocumentSchema),
    /** Never zero — a zero-part teardown is not a teardown. NULL means nobody counted. */
    partCount: z.number().int().positive().nullable(),
    assembly: AssemblySchema.nullable(),
    fasteners: z.array(FastenerSchema),
    manufacturingFiles: z.array(ManufacturingFileSchema),
    assemblySteps: z.array(AssemblyStepSchema),
    repairabilityIndex: z
      .object({
        fastenerUniformity: RepairabilityCriterionSchema,
        toolAccessibility: RepairabilityCriterionSchema,
        disassemblyStepCount: RepairabilityCriterionSchema,
        modularIndependence: RepairabilityCriterionSchema,
        /** Stored, never averaged — the four criteria are not equally weighted. */
        overallScoreOutOfTen: z.number().int().min(0).max(10),
      })
      .strict()
      .nullable(),
    /**
     * The parts an author LISTED, as a table of contents — not as an assembly.
     *
     * ⚠️ `.default([])` IS WHAT KEEPS THE SEED WORKING. `.strict()` rejects unknown keys, not absent
     * ones, so the twelve fixtures — written before this field existed and edited in another
     * repository — parse to `[]`. And because `TeardownImport` is the OUTPUT type, the field is
     * required on the read and optional on the wire: the public serializer must always emit it, and
     * no fixture has to be touched to supply it.
     *
     * A listing is not an assembly. See `teardown_part_listing` in the schema for the eight places
     * that forcing one through the other's shape would have cost.
     */
    partsList: z
      .array(
        z
          .object({ label: z.string().min(1).max(120), material: z.string().min(1).max(120) })
          .strict(),
      )
      .default([]),
    simulationTelemetry: z
      .object({
        factorOfSafety: z.number().positive(),
        peakVonMisesStressMegapascals: z.number().nonnegative(),
        maxDisplacementMicrometres: z.number().int().nonnegative(),
        /** Signed — a thermal delta can be a drop. */
        thermalDeltaKelvin: z.number(),
        ratedLoadNewtons: z.number().positive(),
        source: z.literal("author_reported"),
      })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * The five rules a Postgres CHECK cannot express, because each needs to see more than one row.
 *
 * Exported as a function rather than left inline so the authoring gate can apply the same rules to
 * a different field set. Its parameter type is inferred from the shape above — never hand-written,
 * or the two drift and the refinement starts reading fields the document no longer has.
 */
export function refineTeardownCrossSectionRules(
  teardown: z.infer<typeof TeardownImportDocumentShape>,
  context: z.core.$RefinementCtx,
): void {
  const parts = teardown.assembly?.parts ?? [];
  const partIds = new Set(parts.map((part) => part.id));
  const parentByPartId = new Map(parts.map((part) => [part.id, part.parentPartId]));

  // 1. The part tree is acyclic. The column CHECK catches a part parenting itself; a longer cycle
  //    needs the walk, bounded by the part count so a cycle terminates rather than hangs.
  for (const part of parts) {
    let ancestorId = part.parentPartId;
    let stepsWalked = 0;
    while (ancestorId !== null && stepsWalked <= parts.length) {
      if (ancestorId === part.id) {
        context.addIssue({
          code: "custom",
          path: ["assembly", "parts"],
          message: `Part ${part.id} is its own ancestor.`,
        });
        break;
      }
      ancestorId = parentByPartId.get(ancestorId) ?? null;
      stepsWalked += 1;
    }
  }

  // 2. Every named parent resolves. A dangling parent renders as a part that never appears.
  for (const part of parts) {
    if (part.parentPartId !== null && !partIds.has(part.parentPartId)) {
      context.addIssue({
        code: "custom",
        path: ["assembly", "parts"],
        message: `Part ${part.id} names a parent that is not in this assembly.`,
      });
    }
  }

  // 3. Layering is all-or-nothing. An axis with no layers scatters the exploded view; layers with
  //    no axis are an ordering along no direction.
  if (teardown.assembly !== null) {
    const hasExplosionAxis = teardown.assembly.explosionAxis !== null;
    for (const part of parts) {
      if (hasExplosionAxis === (part.layerIndex === null)) {
        context.addIssue({
          code: "custom",
          path: ["assembly", "parts"],
          message: hasExplosionAxis
            ? `Part ${part.id} carries no layer index, but the assembly states an explosion axis.`
            : `Part ${part.id} carries a layer index, but the assembly states no explosion axis.`,
        });
      }
    }
  }

  // 4. Step numbers are a dense sequence from 1 in array order. A UNIQUE permits 1, 2, 4.
  teardown.assemblySteps.forEach((step, index) => {
    if (step.stepNumber !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["assemblySteps", index, "stepNumber"],
        message: `Steps are numbered from 1 in array order; position ${String(index)} carries ${String(step.stepNumber)}.`,
      });
    }
    if (step.focusedPartId !== null && !partIds.has(step.focusedPartId)) {
      context.addIssue({
        code: "custom",
        path: ["assemblySteps", index, "focusedPartId"],
        message: "This step focuses a part that is not in this assembly.",
      });
    }
  });

  // 5. A material's part, likewise.
  teardown.materials.forEach((material, index) => {
    if (material.partId !== null && !partIds.has(material.partId)) {
      context.addIssue({
        code: "custom",
        path: ["materials", index, "partId"],
        message: `Material ${material.id} names a part that is not in this assembly.`,
      });
    }
  });
}

export const TeardownImportSchema = TeardownImportDocumentShape.superRefine(
  refineTeardownCrossSectionRules,
);

export type TeardownImport = z.infer<typeof TeardownImportSchema>;
