import { describe, expect, it } from "vitest";

import { TeardownImportSchema } from "#src/modules/home/blueprints/teardown-import.schemas.js";

/**
 * UNIT tests for the teardown import gate — the only thing standing between a fixture file in
 * another repository and this database.
 *
 * ⚠️ THE FIXTURES ARE NOT READ HERE, deliberately. The seed parses all twelve real teardowns before
 * it writes anything, which is the right place for that assertion: it runs where the data actually
 * arrives, and it cannot make this suite fail on a machine that has no sibling frontend checked
 * out. What this file owns instead is the RULES — each one exercised against a teardown built here
 * and then broken in exactly one way.
 *
 * THE CASES THAT MATTER MOST ARE THE FIVE THE DATABASE CANNOT ENFORCE. A CHECK may not look at
 * another row, so an acyclic tree, a dense step sequence, all-or-nothing layering, a non-empty
 * assembly and distinct survey methods are only ever guarded here. If one of those regresses, the
 * row still inserts happily and the detail page fails at the reader instead.
 */

function buildProvenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "community_reverse_engineered",
    subjectProductName: "400 L off-grid chest freezer control board (invented unit)",
    unitAcquisition: "retail_purchase",
    surveyMethods: ["dimensional_survey", "empirical_teardown"],
    surveyedAt: "2026-07-29T00:00:00.000Z",
    licence: null,
    authorizationNote: null,
    attestationAcceptedAt: "2026-08-14T09:10:00.000Z",
    notes: null,
    ...overrides,
  };
}

function buildCompositePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "part-001",
    label: "Enclosure lid",
    parentPartId: null,
    material: "6063-T5 aluminium",
    manufacturingMethod: "sheet_metal",
    explosionDirection: null,
    explosionDistanceMm: null,
    layerIndex: null,
    stressRating: null,
    calloutText: null,
    nodeName: "enclosure_lid",
    ...overrides,
  };
}

/** A teardown with no assembly — the common shape, and the base most cases start from. */
function buildTeardown(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bp-001",
    slug: "solar-cold-storage-controller-teardown",
    category: "teardown",
    title: "Solar cold-storage controller, board and all",
    summary: "A 400-litre off-grid freezer controller, surveyed board by board over one long weekend.",
    thumbnailUrl: "/dummy/thumbnail_image01.avif",
    author: {
      displayName: "Amara Okonkwo",
      handle: "amara-builds",
      avatarUrl: "/dummy/profile_image_01.avif",
    },
    viewCount: 28_940,
    likeCount: 412,
    commentCount: 37,
    saveCount: 96,
    difficulty: "intermediate",
    cadFormat: "STEP / Fusion 360",
    billOfMaterialsCostRange: { minimumInCents: 12_000, maximumInCents: 48_000, currency: "USD" },
    tags: ["solar", "cold-chain"],
    createdAt: "2026-08-14T09:12:00.000Z",
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: buildProvenance(),
    materials: [],
    storeProductClass: null,
    walkthroughVideo: null,
    documents: [],
    partCount: 148,
    assembly: null,
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
    ...overrides,
  };
}

/** A composite assembly with a two-level tree, which most assembly cases start from. */
function buildCompositeAssembly(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "composite",
    explosionAxis: null,
    model: { url: "/dummy/blueprints/controller.glb", byteSize: 482_000 },
    parts: [
      buildCompositePart({ id: "part-001", parentPartId: null }),
      buildCompositePart({ id: "part-002", parentPartId: "part-001", nodeName: "main_board" }),
    ],
    ...overrides,
  };
}

function parseTeardown(teardown: Record<string, unknown>) {
  return TeardownImportSchema.safeParse(teardown);
}

describe("TeardownImportSchema", () => {
  it("accepts a teardown with no assembly, no files and no measurements", () => {
    const parsed = parseTeardown(buildTeardown());

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("accepts a composite assembly with a parent and a child", () => {
    const parsed = parseTeardown(buildTeardown({ assembly: buildCompositeAssembly() }));

    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  describe("the five rules no CHECK can enforce", () => {
    /**
     * A cycle inserts perfectly happily — every row satisfies its own constraint — and then the
     * viewer walks the tree forever. The column CHECK catches only a part that parents itself.
     */
    it("refuses a two-part cycle", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly({
            parts: [
              buildCompositePart({ id: "part-001", parentPartId: "part-002" }),
              buildCompositePart({ id: "part-002", parentPartId: "part-001", nodeName: "board" }),
            ],
          }),
        }),
      );

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("own ancestor");
    });

    it("refuses a part that is its own parent", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly({
            parts: [buildCompositePart({ id: "part-001", parentPartId: "part-001" })],
          }),
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("refuses a parent that is not in this assembly", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly({
            parts: [buildCompositePart({ id: "part-001", parentPartId: "part-from-elsewhere" })],
          }),
        }),
      );

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("not in this assembly");
    });

    /** The frontend's shape has `.min(1)`, so an empty assembly is a broken page, not a bare one. */
    it("refuses an assembly with no parts", () => {
      const parsed = parseTeardown(buildTeardown({ assembly: buildCompositeAssembly({ parts: [] }) }));

      expect(parsed.success).toBe(false);
    });

    /** A UNIQUE on (teardown, step_number) permits 1, 2, 4. Only this catches the gap. */
    it("refuses a step sequence with a gap", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assemblySteps: [
            { stepNumber: 1, title: "Open it", description: "Six screws.", focusedPartId: null },
            { stepNumber: 2, title: "Lift", description: "Gently.", focusedPartId: null },
            { stepNumber: 4, title: "Board", description: "Two clips.", focusedPartId: null },
          ],
        }),
      );

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("numbered from 1 in array order");
    });

    it("refuses a step focusing a part that is not in this assembly", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly(),
          assemblySteps: [{ stepNumber: 1, title: "Open it", description: "Six screws.", focusedPartId: "part-9" }],
        }),
      );

      expect(parsed.success).toBe(false);
    });

    /**
     * Layering is all-or-nothing in BOTH directions: an axis with an unlayered part scatters the
     * exploded view, and a layered part with no axis is an ordering along no direction.
     */
    it.each([
      [
        "an axis with a part carrying no layer",
        { explosionAxis: [0, 1, 0], parts: [buildCompositePart({ layerIndex: null })] },
      ],
      ["no axis with a part carrying a layer", { explosionAxis: null, parts: [buildCompositePart({ layerIndex: 2 })] }],
    ])("refuses %s", (_label, assemblyOverrides) => {
      const parsed = parseTeardown(buildTeardown({ assembly: buildCompositeAssembly(assemblyOverrides) }));

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("layer index");
    });

    it("accepts an axis when every part carries a layer, including layer zero", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly({
            explosionAxis: [0, 1, 0],
            parts: [
              buildCompositePart({ id: "part-001", layerIndex: 0 }),
              buildCompositePart({ id: "part-002", nodeName: "board", layerIndex: 0 }),
            ],
          }),
        }),
      );

      expect(parsed.error?.issues ?? []).toEqual([]);
    });

    it("refuses a repeated survey method", () => {
      const parsed = parseTeardown(
        buildTeardown({
          provenance: buildProvenance({
            surveyMethods: ["dimensional_survey", "dimensional_survey"],
          }),
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("refuses a material naming a part that is not in this assembly", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly(),
          materials: [
            {
              id: "mat-001",
              appliesToLabel: "Heatsink",
              partId: "part-from-elsewhere",
              designation: "6063-T5",
              designationSource: "contributor_freetext",
              materialClass: "metal_alloy",
              process: null,
              finish: null,
              elements: [],
            },
          ],
        }),
      );

      expect(parsed.success).toBe(false);
    });
  });

  describe("the assembly union's two arms", () => {
    it("refuses a composite part carrying its own model", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly({
            parts: [
              {
                ...buildCompositePart(),
                model: { url: "/dummy/blueprints/lid.glb", byteSize: 1000 },
              },
            ],
          }),
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("refuses an individual-parts assembly carrying an assembly-level model", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: {
            kind: "individual_parts",
            explosionAxis: null,
            model: { url: "/dummy/blueprints/whole.glb", byteSize: 1000 },
            parts: [],
          },
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("refuses an individual part that names a composite node", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: {
            kind: "individual_parts",
            explosionAxis: null,
            parts: [
              {
                ...buildCompositePart(),
                model: { url: "/dummy/blueprints/lid.glb", byteSize: 1000 },
                placement: null,
              },
            ],
          },
        }),
      );

      expect(parsed.success).toBe(false);
    });
  });

  describe("the provenance permission table", () => {
    /** Each arm is refused BOTH ways: the required field missing, and the forbidden one present. */
    it.each([
      ["licensed_open_source with no licence", { kind: "licensed_open_source" }],
      [
        "licensed_open_source carrying an authorization note",
        {
          kind: "licensed_open_source",
          licence: { name: "CERN-OHL-S v2", url: "https://example.com/licences/cern-ohl-s-2" },
          authorizationNote: "Also permitted by e-mail.",
        },
      ],
      ["authorized_by_manufacturer with no note", { kind: "authorized_by_manufacturer" }],
      [
        "authorized_by_manufacturer carrying a licence",
        {
          kind: "authorized_by_manufacturer",
          licence: { name: "CERN-OHL-S v2", url: "https://example.com/licences/cern-ohl-s-2" },
          authorizationNote: "Permitted by e-mail.",
        },
      ],
      [
        "community_reverse_engineered carrying a licence",
        {
          kind: "community_reverse_engineered",
          licence: { name: "CERN-OHL-S v2", url: "https://example.com/licences/cern-ohl-s-2" },
        },
      ],
      [
        "community_reverse_engineered carrying an authorization note",
        { kind: "community_reverse_engineered", authorizationNote: "They said it was fine." },
      ],
    ])("refuses %s", (_label, provenanceOverrides) => {
      const parsed = parseTeardown(buildTeardown({ provenance: buildProvenance(provenanceOverrides) }));

      expect(parsed.success).toBe(false);
    });

    it("accepts each arm in its correct shape", () => {
      const openSource = parseTeardown(
        buildTeardown({
          provenance: buildProvenance({
            kind: "licensed_open_source",
            licence: { name: "CERN-OHL-S v2", url: "https://example.com/licences/cern-ohl-s-2" },
          }),
        }),
      );
      const authorized = parseTeardown(
        buildTeardown({
          provenance: buildProvenance({
            kind: "authorized_by_manufacturer",
            authorizationNote: "The manufacturer permitted this survey by e-mail in March.",
          }),
        }),
      );

      expect(openSource.error?.issues ?? []).toEqual([]);
      expect(authorized.error?.issues ?? []).toEqual([]);
    });
  });

  describe("addresses", () => {
    /** A browser reads both spellings as "same scheme, different host". */
    it.each([
      ["a protocol-relative thumbnail", "//evil.test/x.avif"],
      ["the backslash spelling", "/\\evil.test/x.avif"],
      ["an http thumbnail", "http://evil.test/x.avif"],
      ["a javascript scheme", "javascript:alert(1)"],
    ])("refuses %s", (_label, thumbnailUrl) => {
      expect(parseTeardown(buildTeardown({ thumbnailUrl })).success).toBe(false);
    });

    it("accepts a site-relative asset and an https one", () => {
      expect(parseTeardown(buildTeardown({ thumbnailUrl: "/dummy/x.avif" })).success).toBe(true);
      expect(parseTeardown(buildTeardown({ thumbnailUrl: "https://cdn.test/x.avif" })).success).toBe(true);
    });

    /** A supplier link leaves this site, so there is no same-site case to allow. */
    it("refuses a site-relative supplier link", () => {
      const parsed = parseTeardown(
        buildTeardown({
          fasteners: [
            {
              standardCode: "ISO 14581",
              sizeLabel: "M3 × 8",
              drive: "torx",
              quantity: 6,
              supplier: { label: "McMaster", url: "/dummy/supplier" },
            },
          ],
        }),
      );

      expect(parsed.success).toBe(false);
    });
  });

  describe("the shapes a renderer would break on", () => {
    /** The frontend's video shape is a ONE-ARM union: `hosted` is a parse failure, not a variant. */
    it("refuses a hosted walkthrough video", () => {
      const parsed = parseTeardown(
        buildTeardown({
          walkthroughVideo: {
            posterUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
            durationSeconds: null,
            source: "hosted",
            youtubeVideoId: "aaaaaaaaaaa",
          },
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("refuses a watch URL where an eleven-character video id belongs", () => {
      const parsed = parseTeardown(
        buildTeardown({
          walkthroughVideo: {
            posterUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
            durationSeconds: null,
            source: "youtube",
            youtubeVideoId: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
          },
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("accepts a video whose duration is unknown, which is every YouTube row", () => {
      const parsed = parseTeardown(
        buildTeardown({
          walkthroughVideo: {
            posterUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
            durationSeconds: null,
            source: "youtube",
            youtubeVideoId: "aaaaaaaaaaa",
          },
        }),
      );

      expect(parsed.error?.issues ?? []).toEqual([]);
    });

    it("refuses an instrument beside a method that measured nothing", () => {
      const parsed = parseTeardown(
        buildTeardown({
          materials: [
            {
              id: "mat-001",
              appliesToLabel: "Heatsink",
              partId: null,
              designation: "6063-T5",
              designationSource: "contributor_freetext",
              materialClass: "metal_alloy",
              process: null,
              finish: null,
              elements: [
                {
                  symbol: "Al",
                  weightPercentRange: null,
                  analysisMethod: "declared_not_measured",
                  instrumentLabel: "Bruker S1 Titan",
                  operatorNote: null,
                },
              ],
            },
          ],
        }),
      );

      expect(parsed.success).toBe(false);
    });

    it("refuses a zero explosion direction, which explodes nothing", () => {
      const parsed = parseTeardown(
        buildTeardown({
          assembly: buildCompositeAssembly({
            parts: [buildCompositePart({ explosionDirection: [0, 0, 0] })],
          }),
        }),
      );

      expect(parsed.success).toBe(false);
    });
  });

  describe("the fields the contract says are the author's", () => {
    /** 148 parts counted against 9 modelled is correct — the model shows what is worth exploding. */
    it("accepts a part count far larger than the modelled parts", () => {
      const parsed = parseTeardown(buildTeardown({ partCount: 148, assembly: buildCompositeAssembly() }));

      expect(parsed.error?.issues ?? []).toEqual([]);
    });

    it("refuses a part count of zero, because a zero-part teardown is not a teardown", () => {
      expect(parseTeardown(buildTeardown({ partCount: 0 })).success).toBe(false);
    });
  });

  describe("strictness", () => {
    /**
     * THE FIXTURE FILE LIVES IN ANOTHER REPOSITORY and is edited by someone who is not looking at
     * this schema. A field this backend does not model should stop the seed rather than vanish.
     */
    it("refuses a field this backend does not model", () => {
      expect(parseTeardown(buildTeardown({ upvoteCount: 12 })).success).toBe(false);
    });

    it("refuses a slug that is already a route on this surface", () => {
      expect(parseTeardown(buildTeardown({ slug: "slugs" })).success).toBe(false);
      expect(parseTeardown(buildTeardown({ slug: "new" })).success).toBe(false);
    });

    it("refuses a moderation state a teardown cannot be in", () => {
      expect(parseTeardown(buildTeardown({ moderationState: "draft" })).success).toBe(false);
    });
  });
});
