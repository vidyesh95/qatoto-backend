// The demo seed corpus for the Blueprints surface.
//
// NOTHING HERE IS REAL. These are invented builds with invented numbers, and they exist so the
// hub has something to render before there is inventory to fill it. This is a decision to be
// revisited when the first real teardown is published, not a staging area that quietly becomes
// production.
//
// ⚠️ THIS IS WHY `/blueprints` IS STILL `noindex` ON THE FRONTEND. Twelve fabricated teardowns and
// ten fabricated case studies are seeded from this file under invented author names, several of
// them surveying real named commercial products. Indexing them would publish invented engineering
// findings as genuine. The `robots` flag on the nine content routes and the `/blueprints`
// exclusion in `sitemap.ts` both lift when real SUBMITTED blueprints exist — not when this file
// is merely present.
//
// ⚠️ IT LIVED IN THE FRONTEND UNTIL NOW, AT `qatoto-frontend/src/mocks/blueprints-mocks.ts`.
// It was the design fixture AND the seed corpus while the UI was being built; once every
// blueprints read went to Express it stopped being the first thing, and a 3,000-line file with no
// importer in its own repo reads exactly like dead code. It is read by
// `scripts/seed-blueprint-teardowns.ts` and `scripts/seed-blueprint-case-studies.ts`, which now
// import it directly rather than reaching across a repository boundary by filesystem path.
//
// ⚠️ THE ASSET URLS STILL POINT INTO THE FRONTEND'S `public/dummy/`, and the seeds store them
// VERBATIM — `AssetUrlSchema` accepts a site-relative path and nothing rewrites one. So the 29
// generated files under `qatoto-frontend/public/dummy/blueprints/` and the `thumbnail_image0N.avif`
// beside them are a live dependency of every seeded row, not leftovers. Deleting them 404s every
// seeded teardown's documents and models.
//
// ⚠️ ONLY `teardown` AND `case_study` ROWS ARE READ. The ten `showcase` rows have no seed — a
// launch is written straight into `showcase_launch` by its own authoring route and there is no
// import gate for one — so they are carried rather than consumed. They are kept because teardown
// rows reference launches by slug and because the split below is load-bearing.
//
// EVERY ROW IS PARSED THROUGH THE SAME IMPORT GATE THE AUTHORING ROUTES USE before anything is
// written, and a single rejected fixture aborts the whole seed before the first INSERT.
//
// THE SPLIT HERE IS 12 / 10 / 10, NOT 70/20/10, and that is deliberate. The 70/20/10 ratio is a
// content target for REAL builds; applied to fixtures it gave two showcases and two case studies,
// and a launch feed of two rows or a lesson list of two rows does not exercise its own
// design — it reads as broken. The two small buckets are over-sampled so the layouts can be built
// against something that looks like use. There are TEN showcases rather than five because the
// launch feed has a Newest | Top toggle, and a toggle has to show two visibly different orders and
// still page under both — five rows did neither.
//
// ⚠️ THERE ARE TEN CASE STUDIES, TWO PER DISCIPLINE, and the reason changed when the index did. It
// used to be exactly five, one per discipline, because each card carried a discipline TINT and a
// discipline with no fixture was a colour nobody ever saw. The tint is gone — a colour-coded card
// grid was two `docs/Design.md` §6 violations at once — so the count is now set by the list: two
// per discipline is what makes a filtered view show more than one row, and ten against a page
// limit of six is what makes the paging control render at all.
//
// ⚠️ EVERY COMPANY NAME IN THESE ROWS IS INVENTED AND MUST STAY INVENTED. Fabricating a teardown is
// covered by the surface's de-indexing; attaching a fabricated failure to a real company's name is
// not the same thing and is not covered by anything. `sources[]` URLs stay on `example.com` for the
// same reason — a real URL beside an invented figure claims that URL says it.
//
// TWO ROWS HAVE `sources: []`, THREE HAVE `outcomeSummary: null` AND FOUR HAVE `capitalRaised: null`,
// which is not sampling noise. Each is a distinct renderer branch: an empty source list is the one
// absence on this surface that renders COPY rather than nothing, and the other two must render
// nothing at all rather than "Unknown" or a zero.
//
// SIX CASE STUDIES ARE `authorRelationship: "first_hand"` AND FOUR ARE `"public_sources"`, so both
// reader notes render. ⚠️ THE TWO ROWS WITH `sources: []` ARE AMONG THE SIX: a case study written from
// public sources has to link them (`case-study-authoring.schemas.ts`), so an empty source list on one
// would be a row the write contract could never have produced.
//
// ONE COMPANY HAS `name: null`, the mould shop on `aluminium-tool-before-steel`, so the withheld-name
// row renders. It sits on a first-hand case study because only a first-hand writer may withhold one.
//
// THE LAUNCH DATES ARE STATIC LITERALS inside the three weeks before 2026-09-08, and they drift
// into the past one day at a time. Accepted: a `new Date()`-relative fixture would bake a
// different order into every `"use cache"` entry, and `RelativeTime` renders whatever the gap is.
// Re-date them when the feed starts to read as abandoned.

/** USD throughout; a real payload would carry the seller's own currency per row. */
const UNITED_STATES_DOLLAR = "USD";

/**
 * The one non-USD currency in the fixtures, and it is here to be exercised rather than for flavour.
 *
 * A money field that only ever holds one currency lets a renderer hardcode the symbol and stay
 * green. `capitalRaised` on the Chennai and Coimbatore rows is INR, so `formatCentsLabel` has to
 * take the currency from the row — which is the entire argument for storing integer minor units
 * plus a code instead of the display string "₹1 Cr".
 *
 * ⚠️ THE MINOR UNIT IS THE PAISE, so ₹1 crore is 1_000_000_000. A crore is 10^7 rupees and a rupee
 * is 100 paise; the first draft of this fixture wrote 10^8 and rendered ten lakh, which the build
 * accepted silently because a wrong integer is still an integer.
 *
 * ⚠️ IT GROUPS AS ₹10,000,000 AND NOT ₹1,00,00,000. `formatCentsLabel` is pinned to `en-US`, so
 * every currency in the repo takes Western grouping. That is a house-wide decision in
 * `src/lib/store/format.ts` rather than a bug in this row, and changing it moves every money label
 * in the product.
 */
const INDIAN_RUPEE = "INR";

/**
 * EVERY FIXTURE VIDEO IS THE SAME YOUTUBE VIDEO, and there is only one kind of video to be.
 *
 * `eRsGyueVLvQ` is the Blender Foundation's own upload of Sintel, resolved against YouTube's oEmbed
 * endpoint when it was added. Reusing one id across all eight is the same discipline the fixtures
 * kept when they all pointed at one local clip: a made-up id parses fine and then gives a dead
 * player, leaving the whole surface untestable, and eight invented ids would be eight of those.
 *
 * WHY AN INSTITUTION'S UPLOAD AND NOT A TEARDOWN CHANNEL. An individual creator's video breaks the
 * day they delete it; Blender's has been up since 2010, is CC-BY, and is not going to have
 * embedding switched off by someone reorganising a channel. It is a stand-in for a walkthrough, not
 * a claim about the subject — exactly as the Sintel clip was.
 *
 * ⚠️ THE DURATION IS THE FILM'S TRUE RUNTIME, READ OFF THE PLAYER, not typed from memory. The badge
 * shows it, and a badge reading "8:12" over a video of another length is a lie the first person to
 * click it discovers. ⚠️ AND IT IS A LUXURY THIS FILE HAS AND A REAL BACKEND DOES NOT: oEmbed
 * reports no duration, so `durationSeconds` is nullable and a real row will usually carry `null`.
 * A fixture that always supplies one would leave the badge-less case unexercised, which is why
 * `placeholderYoutubeVideo` takes the runtime as an argument that defaults to `null`.
 */
const PLACEHOLDER_YOUTUBE_VIDEO_ID = "eRsGyueVLvQ";
const PLACEHOLDER_YOUTUBE_DURATION_SECONDS = 888;

/**
 * THE POSTER IS DERIVED FROM THE ID, WITH NO NETWORK CALL — the same expression
 * `studio/upload/thumbnail-picker.tsx` uses for a pasted link. `hqdefault` rather than
 * `maxresdefault`, which 404s on anything not uploaded in HD and answers with a grey 120x90 stub.
 * `**.ytimg.com` is already allowed by `next.config.ts`'s `images.remotePatterns`.
 *
 * ⚠️ NO `posterUrl` ARGUMENT, and that is a change worth noticing: while videos were self-hosted
 * each fixture passed its own thumbnail, because a served mp4 has no still of its own. A YouTube
 * video does, so passing a Qatoto image here would put a picture of a circuit board over a video of
 * a Blender film — a mismatch the old fixtures hid.
 */
function placeholderYoutubeVideo(durationSeconds: number | null = null) {
  return {
    source: "youtube",
    youtubeVideoId: PLACEHOLDER_YOUTUBE_VIDEO_ID,
    posterUrl: `https://i.ytimg.com/vi/${PLACEHOLDER_YOUTUBE_VIDEO_ID}/hqdefault.jpg`,
    durationSeconds,
  };
}

/**
 * The generated placeholder PDFs in `public/dummy/blueprints/`.
 *
 * `byteSize` and `pageCount` are MEASURED FROM THE FILES ON DISK, not invented. A fixture that
 * claims 4.1 MB over a 1 KB file teaches the renderer nothing about how a real size wraps.
 */
const PLACEHOLDER_DOCUMENTS = {
  solarSchematic: {
    id: "doc-001",
    kind: "schematic",
    title: "Controller schematic, sheets 1-3",
    url: "/dummy/blueprints/solar-cold-storage-schematic.pdf",
    byteSize: 1465,
    pageCount: 3,
  },
  solarBillOfMaterials: {
    id: "doc-002",
    kind: "bill_of_materials",
    title: "Bill of materials, 48 line items",
    url: "/dummy/blueprints/solar-cold-storage-bom.pdf",
    byteSize: 1136,
    pageCount: 2,
  },
  brushlessSchematic: {
    id: "doc-003",
    kind: "schematic",
    title: "Driver schematic and layout notes",
    url: "/dummy/blueprints/brushless-driver-schematic.pdf",
    byteSize: 1120,
    pageCount: 2,
  },
  boreholeAssembly: {
    id: "doc-004",
    kind: "assembly_guide",
    title: "Housing assembly and torque sequence",
    url: "/dummy/blueprints/borehole-pump-assembly.pdf",
    byteSize: 1778,
    pageCount: 4,
  },
  batteryManagementSchematic: {
    id: "doc-005",
    kind: "schematic",
    title: "Balancing and protection schematic",
    url: "/dummy/blueprints/battery-management-schematic.pdf",
    byteSize: 1113,
    pageCount: 2,
  },
  batteryManagementBillOfMaterials: {
    id: "doc-006",
    kind: "bill_of_materials",
    title: "Bill of materials",
    url: "/dummy/blueprints/battery-management-bom.pdf",
    byteSize: 758,
    pageCount: 1,
  },
  sensorNodeDatasheet: {
    id: "doc-007",
    kind: "datasheet",
    title: "Measured power budget",
    url: "/dummy/blueprints/esp32-sensor-node-datasheet.pdf",
    byteSize: 1118,
    pageCount: 2,
  },
  heatExchangerSchematic: {
    id: "doc-008",
    kind: "schematic",
    title: "Plate stack schematic",
    url: "/dummy/blueprints/milk-chiller-heat-exchanger-schematic.pdf",
    byteSize: 758,
    pageCount: 1,
  },
};

/**
 * The generated placeholder fabrication files and `.glb` models in `public/dummy/blueprints/`,
 * written by `scripts/generate-blueprint-fixture-models.mts` (`pnpm fixtures:blueprint-models`).
 *
 * EVERY `byteSize` BELOW IS WHAT THE SCRIPT PRINTED, measured off disk, never typed from memory —
 * the same rule the PDFs above follow. Each text file opens in the tool its extension claims
 * (a STEP header, a DXF entities section, a Gerber, an Excellon drill, two CSVs) and says
 * "placeholder" inside; the models are procedural boxes and cylinders whose node names are the
 * fixture's `nodeName`s, and they are committed exactly as the PDFs were.
 */
const PLACEHOLDER_MANUFACTURING_FILES = {
  solarEnclosureStep: {
    id: "mfg-001",
    kind: "step",
    title: "Enclosure, lid and base",
    url: "/dummy/blueprints/solar-cold-storage-enclosure.step",
    byteSize: 308,
  },
  solarLidGasketDxf: {
    id: "mfg-002",
    kind: "dxf",
    title: "Lid gasket cut path",
    url: "/dummy/blueprints/solar-cold-storage-lid-gasket.dxf",
    byteSize: 132,
  },
  solarTopCopperGerber: {
    id: "mfg-003",
    kind: "gerber",
    title: "Top copper",
    url: "/dummy/blueprints/solar-cold-storage-top-copper.gtl",
    byteSize: 130,
  },
  solarDrill: {
    id: "mfg-004",
    kind: "drill",
    title: "Plated through-holes",
    url: "/dummy/blueprints/solar-cold-storage-drill.drl",
    byteSize: 96,
  },
  solarPickAndPlace: {
    id: "mfg-005",
    kind: "pick_and_place",
    title: "Pick and place, top side",
    url: "/dummy/blueprints/solar-cold-storage-pick-and-place.csv",
    byteSize: 145,
  },
  solarBillOfMaterialsCsv: {
    id: "mfg-006",
    kind: "bill_of_materials_csv",
    title: "Bill of materials, 48 line items",
    url: "/dummy/blueprints/solar-cold-storage-bom.csv",
    byteSize: 163,
  },

  // ELECTRONICS ONLY, on `brushless-motor-driver-schematic`. `TEARDOWN_MANUFACTURING_FILE_BUNDLES`
  // sorts these four into the Electronics bundle and none into Mechanical, so the bundle list
  // renders ONE heading — the branch that returns `null` for an unpublished bundle.
  brushlessTopCopperGerber: {
    id: "mfg-007",
    kind: "gerber",
    title: "Top copper",
    url: "/dummy/blueprints/brushless-driver-top-copper.gtl",
    byteSize: 129,
  },
  brushlessDrill: {
    id: "mfg-008",
    kind: "drill",
    title: "Plated through-holes",
    url: "/dummy/blueprints/brushless-driver-drill.drl",
    byteSize: 104,
  },
  brushlessPickAndPlace: {
    id: "mfg-009",
    kind: "pick_and_place",
    title: "Pick and place, top side",
    url: "/dummy/blueprints/brushless-driver-pick-and-place.csv",
    byteSize: 139,
  },
  brushlessBillOfMaterialsCsv: {
    id: "mfg-010",
    kind: "bill_of_materials_csv",
    title: "Bill of materials, 22 line items",
    url: "/dummy/blueprints/brushless-driver-bom.csv",
    byteSize: 195,
  },

  // MECHANICAL ONLY, on `hand-pump-gearbox-teardown` — the mirror of the set above, and the three
  // kinds a machinist actually receives.
  //
  // ⚠️ NOT ON `borehole-pump-housing-tolerances`, WHICH WAS THE OBVIOUS HOME AND IS SPOKEN FOR.
  // That fixture is the documented "a viewport and nothing else" case: `fasteners`,
  // `manufacturingFiles`, `assemblySteps` all empty and `repairabilityIndex` null TOGETHER, on a
  // teardown that does carry a model and telemetry. Attaching files to it would delete the one row
  // that proves every other section can be absent on its own.
  gearboxCaseStep: {
    id: "mfg-011",
    kind: "step",
    title: "Gearbox case, upper and lower",
    url: "/dummy/blueprints/hand-pump-gearbox-case.step",
    byteSize: 305,
  },
  gearboxIdlerStl: {
    id: "mfg-012",
    kind: "stl",
    title: "Idler gear, printable",
    url: "/dummy/blueprints/hand-pump-gearbox-idler.stl",
    byteSize: 203,
  },
  gearboxShimDxf: {
    id: "mfg-013",
    kind: "dxf",
    title: "Shim stack cut path",
    url: "/dummy/blueprints/hand-pump-gearbox-shim.dxf",
    byteSize: 129,
  },
};

const PUMP_PART_MODEL_DIRECTORY = "/dummy/blueprints/borehole-pump-housing";

/**
 * Twenty-seven builds across the three arms.
 *
 * DELIBERATE ABSENCES, each one there so its branch renders during development rather than the
 * first time real data arrives:
 *
 * - `billOfMaterialsCostRange: null` on `thermal-camera-module-teardown` and
 *   `nairobi-injection-molding-case-study` — an uncosted build is an ordinary state, and the
 *   renderer must show an absence rather than a $0 band.
 * - `walkthroughVideo: null` AND `documents: []` together on `thermal-camera-module-teardown` and
 *   `low-cost-spectrometer-optical-path` — a teardown that published nothing. The media sections
 *   must be ABSENT, not empty boxes.
 * - `builtFromBlueprintSlug: null` on `dairy-chiller-retrofit-pilot` — a launch built from
 *   something that was never published here.
 * - `cadFormat: null` on `dairy-chiller-retrofit-pilot` and `off-grid-mesh-nodes-kumasi-market` —
 *   a build with no published CAD, so the spec list must omit the row rather than print "—".
 * - `upvoteCount: 96` on BOTH `hand-pump-gearbox-replacement-kit` and
 *   `grain-moisture-meter-field-units` — a deliberate tie, so the `top` comparator's tie-break is
 *   exercised on the second page of `?sort=top` rather than only described in a comment.
 * - `callToAction: null` on several showcases — most launches link nowhere. A launch's videos live
 *   inside its Markdown `writeUp`, as a YouTube link on its own line; there is no separate demo field.
 * - `partCount: null` where nobody counted. Not zero: a zero-part teardown is not a teardown.
 * - `assembly: null` on ten of the twelve teardowns — most published no model, and the exploded
 *   view must be ABSENT rather than an empty viewport. The two that carry one take DIFFERENT
 *   modes: `solar-cold-storage-controller-teardown` is ONE composite `.glb` addressed by node
 *   name; `borehole-pump-housing-tolerances` is SIX per-part files, the shape an upload takes,
 *   with one part (`seal_carrier`) exported at its own origin so the explicit `placement` branch
 *   renders too.
 * - `fasteners: []`, `manufacturingFiles: []`, `assemblySteps: []` and `repairabilityIndex: null`
 *   TOGETHER on `borehole-pump-housing-tolerances`, which does carry a model and telemetry — a
 *   teardown with a viewport and nothing else, so every other section proves it can be absent on
 *   its own. ⚠️ DO NOT ATTACH FILES TO THIS ROW to exercise something; it is the only one holding
 *   that combination, and the mechanical file set went to `hand-pump-gearbox-teardown` for exactly
 *   this reason.
 * - `manufacturingFiles` ON THREE OF TWELVE, in three different mixes, because the index card now
 *   NAMES the formats rather than counting files. `solar-cold-storage-controller-teardown` has all
 *   six kinds, which is the only row that overflows the card's four-name cap and renders its "+2";
 *   `brushless-motor-driver-schematic` has four ELECTRONICS kinds and `hand-pump-gearbox-teardown`
 *   three MECHANICAL ones, so `ManufacturingFileBundles` renders a single-bundle page both ways
 *   round. One row out of twelve would have left all three branches unexercised on eleven cards.
 * - `simulationTelemetry` on exactly the two modelled teardowns, at factors of safety 3.1 and 1.6,
 *   so both the safe and the marginal colour bands render somewhere.
 * - `calloutText: null` on one MOSFET, so a part with no pin sits beside parts with pins.
 */

export const BLUEPRINT_SEED_CORPUS: readonly unknown[] = [
  {
    id: "bp-001",
    slug: "solar-cold-storage-controller-teardown",
    title: "Solar cold-storage controller, board and all",
    category: "teardown",
    // STATE: designation_scanned_full. Every material carries an element table, and every row in
    // every one of them is `synthetic_example` — see the file header. This is the richest row on
    // the surface and therefore the one most able to masquerade as lab output, so it is the row
    // that has to say loudest that it is not.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "400 L off-grid chest freezer control board (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["dimensional_survey", "empirical_teardown", "material_spectroscopy"],
      surveyedAt: "2026-07-29T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-08-14T09:10:00.000Z",
      notes: "Two units bought; the second was left assembled as a reference.",
    },
    storeProductClass: { categorySlug: "solar-refrigeration", label: "Solar refrigeration" },
    materials: [
      {
        id: "mat-001",
        appliesToLabel: "Enclosure base and lid",
        partId: "part-001",
        designation: "ABS, UL94 V-0",
        designationSource: "manufacturer_marking",
        materialClass: "polymer",
        process: "injection_molded",
        finish: "Moulded texture, no secondary finish",
        elements: [],
      },
      {
        id: "mat-002",
        appliesToLabel: "Heatsink extrusion",
        partId: "part-004",
        designation: "6063-T5",
        designationSource: "measured_spectroscopy",
        materialClass: "metal_alloy",
        process: "cnc_milled",
        finish: "Clear anodised",
        elements: [
          {
            symbol: "Al",
            weightPercentRange: { minimumPercent: 97.5, maximumPercent: 99.35 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: "Invented figure. Nobody ran this scan.",
          },
          {
            symbol: "Mg",
            weightPercentRange: { minimumPercent: 0.45, maximumPercent: 0.9 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: null,
          },
          {
            symbol: "Si",
            weightPercentRange: { minimumPercent: 0.2, maximumPercent: 0.6 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: null,
          },
          {
            // IDENTIFIED BUT NOT QUANTIFIED — the ordinary result on a trace element, and a
            // different statement from zero percent.
            symbol: "Fe",
            weightPercentRange: null,
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: "Present as a trace; not quantified.",
          },
        ],
      },
      {
        id: "mat-003",
        appliesToLabel: "Control board substrate",
        partId: "part-003",
        designation: "FR-4, 1.6 mm, four layers",
        designationSource: "public_datasheet",
        materialClass: "laminate",
        process: "pcb_assembly",
        finish: "ENIG",
        elements: [
          {
            symbol: "Cu",
            weightPercentRange: { minimumPercent: 28, maximumPercent: 34 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: "Invented figure, quoted here to exercise the table.",
          },
        ],
      },
    ],
    summary:
      "The full control board from a 400 L off-grid chest freezer: MPPT stage, compressor driver, and why the thermistor placement costs it four percent of its duty cycle.",
    thumbnailUrl: "/dummy/thumbnail_image01.avif",
    author: {
      displayName: "Amara Okonkwo",
      handle: "amara-builds",
      avatarUrl: "/dummy/profile_image_01.avif",
    },
    viewCount: 48210,
    likeCount: 3104,
    commentCount: 218,
    saveCount: 1147,
    difficulty: "advanced",
    cadFormat: "STEP / KiCad 8",
    billOfMaterialsCostRange: {
      minimumInCents: 4500,
      maximumInCents: 6000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["cold-chain", "solar", "power-electronics", "mppt"],
    createdAt: "2026-08-14T09:12:00.000Z",
    walkthroughVideo: placeholderYoutubeVideo(PLACEHOLDER_YOUTUBE_DURATION_SECONDS),
    documents: [PLACEHOLDER_DOCUMENTS.solarSchematic, PLACEHOLDER_DOCUMENTS.solarBillOfMaterials],
    // The author's tally. Nine of these are modelled below; 148 is not nine and must not become nine.
    partCount: 148,
    assembly: {
      kind: "composite",
      // THE STACK IS VERTICAL, so the axis is Y: clip, base, board, board-mounted parts, heatsink,
      // lid. Six planes rather than nine directions, which is what makes an exploded diagram
      // readable — the camera angle, not the axis, is what makes it read wide on screen.
      explosionAxis: [0, 1, 0],
      model: {
        url: "/dummy/blueprints/solar-cold-storage-controller.glb",
        byteSize: 351872,
      },
      // `parentPartId` MIRRORS THE NODE TREE IN THE .glb — the generator nests the meshes the same
      // way. A child explodes away from its parent, so the two trees must agree or the lid moves
      // with the board.
      parts: [
        {
          id: "part-001",
          nodeName: "enclosure_base",
          label: "Enclosure base",
          parentPartId: null,
          material: "ABS, UL94 V-0",
          manufacturingMethod: "injection_molded",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 1,
          stressRating: null,
          calloutText: "Two-piece ABS shell; the base carries every mounting boss.",
        },
        {
          id: "part-002",
          nodeName: "enclosure_lid",
          label: "Enclosure lid",
          parentPartId: null,
          material: "ABS, UL94 V-0",
          manufacturingMethod: "injection_molded",
          // Pinned: the lid lifts straight up. Not unit length on purpose — the engine normalises.
          explosionDirection: [0, 2, 0],
          explosionDistanceMm: 60,
          layerIndex: 5,
          stressRating: null,
          calloutText: "Lifts straight up once the four M3 cap screws are out.",
        },
        {
          id: "part-003",
          nodeName: "pcb",
          label: "Control board",
          parentPartId: "part-001",
          material: "FR-4, 1.6 mm, 2 oz copper, four layers",
          manufacturingMethod: "pcb_assembly",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 2,
          stressRating: 0.2,
          calloutText: "MPPT stage on the left, compressor driver on the right.",
        },
        {
          id: "part-004",
          nodeName: "heatsink",
          label: "Heatsink",
          parentPartId: "part-003",
          material: "6063-T5 aluminium extrusion, cut to length and drilled",
          manufacturingMethod: "cnc_milled",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 4,
          stressRating: 0.55,
          calloutText: "Undersized by the author's own measurement — 38 K rise at rated load.",
        },
        {
          id: "part-005",
          nodeName: "mosfet_q1",
          label: "MOSFET Q1 (high side)",
          parentPartId: "part-003",
          material: "IRFP4668, TO-247",
          manufacturingMethod: "off_the_shelf",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 3,
          stressRating: 0.85,
          calloutText: "The hottest part on the board.",
        },
        {
          id: "part-006",
          nodeName: "mosfet_q2",
          label: "MOSFET Q2 (low side)",
          parentPartId: "part-003",
          material: "IRFP4668, TO-247",
          manufacturingMethod: "off_the_shelf",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 3,
          stressRating: 0.8,
          calloutText: null,
        },
        {
          id: "part-007",
          nodeName: "terminal_block",
          label: "Terminal block",
          parentPartId: "part-003",
          material: "PA66 housing, brass contacts, 10 mm pitch",
          manufacturingMethod: "off_the_shelf",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 3,
          stressRating: null,
          calloutText: "Battery, panel and compressor all land here.",
        },
        {
          id: "part-008",
          nodeName: "thermistor_harness",
          label: "Thermistor harness",
          parentPartId: "part-003",
          material: "10 kΩ NTC on twisted pair, PVC jacket",
          manufacturingMethod: "off_the_shelf",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: 3,
          stressRating: null,
          calloutText:
            "Placed 40 mm from the evaporator plate — the four percent from the summary.",
        },
        {
          id: "part-009",
          nodeName: "din_clip",
          label: "DIN rail clip",
          parentPartId: "part-001",
          material: "Zinc-plated spring steel",
          manufacturingMethod: "sheet_metal",
          explosionDirection: [0, -1, 0],
          explosionDistanceMm: 25,
          layerIndex: 0,
          stressRating: null,
          calloutText: null,
        },
      ],
    },
    partsList: [],
    fasteners: [
      {
        standardCode: "ISO 4762",
        sizeLabel: "M3 × 8",
        drive: "hex_socket",
        quantity: 4,
        supplier: { label: "McMaster-Carr", url: "https://www.mcmaster.com/91290A113/" },
      },
      {
        standardCode: "ISO 7045",
        sizeLabel: "M3 × 6",
        drive: "phillips",
        quantity: 4,
        supplier: null,
      },
      {
        standardCode: "ISO 4762",
        sizeLabel: "M3 × 12",
        drive: "hex_socket",
        quantity: 2,
        supplier: { label: "McMaster-Carr", url: "https://www.mcmaster.com/91290A120/" },
      },
      {
        standardCode: "ISO 14583",
        sizeLabel: "M3 × 8",
        drive: "torx",
        quantity: 2,
        supplier: { label: "Bossard", url: "https://www.bossard.com/eshop/" },
      },
      {
        standardCode: null,
        sizeLabel: "12 mm × 40 mm strip",
        drive: "adhesive",
        quantity: 1,
        supplier: { label: "3M VHB 5952", url: "https://www.3m.com/" },
      },
      {
        standardCode: null,
        sizeLabel: "35 mm DIN",
        drive: "snap_fit",
        quantity: 1,
        supplier: null,
      },
    ],
    manufacturingFiles: [
      PLACEHOLDER_MANUFACTURING_FILES.solarEnclosureStep,
      PLACEHOLDER_MANUFACTURING_FILES.solarLidGasketDxf,
      PLACEHOLDER_MANUFACTURING_FILES.solarTopCopperGerber,
      PLACEHOLDER_MANUFACTURING_FILES.solarDrill,
      PLACEHOLDER_MANUFACTURING_FILES.solarPickAndPlace,
      PLACEHOLDER_MANUFACTURING_FILES.solarBillOfMaterialsCsv,
    ],
    assemblySteps: [
      {
        stepNumber: 1,
        title: "Release the lid",
        description: "Four M3 cap screws, one in each corner. The gasket stays with the lid.",
        focusedPartId: "part-002",
      },
      {
        stepNumber: 2,
        title: "Lift the board",
        description:
          "Four Phillips screws into the standoffs. Unplug the thermistor harness before lifting or it tears at the crimp.",
        focusedPartId: "part-003",
      },
      {
        stepNumber: 3,
        title: "Unbolt the heatsink",
        description:
          "Two M3 × 12 through the board into the extrusion. The MOSFETs stay clamped to it.",
        focusedPartId: "part-004",
      },
      {
        stepNumber: 4,
        title: "Free the terminal block",
        description: "Press-fit into the board; lever from the underside, never pull.",
        focusedPartId: "part-007",
      },
    ],
    repairabilityIndex: {
      fastenerUniformity: { scoreOutOfTen: 8, note: "All metric, all M3, two drive types." },
      toolAccessibility: {
        scoreOutOfTen: 7,
        note: "Nothing hidden under a label; the heatsink screws need a long driver.",
      },
      disassemblyStepCount: {
        scoreOutOfTen: 7,
        note: "Four steps to the board, nine to the last component.",
      },
      modularIndependence: {
        scoreOutOfTen: 6,
        note: "MOSFETs clamp rather than solder to the heatsink; the harness is potted.",
      },
      overallScoreOutOfTen: 7,
    },
    simulationTelemetry: {
      factorOfSafety: 3.1,
      peakVonMisesStressMegapascals: 24,
      maxDisplacementMicrometres: 310,
      thermalDeltaKelvin: 38,
      ratedLoadNewtons: 50,
      source: "author_reported",
    },
  },
  {
    id: "bp-002",
    slug: "thermal-camera-module-teardown",
    title: "What is actually inside a $180 thermal camera module",
    category: "teardown",
    // STATE: no_designation_held. The floor row of the whole surface — no BOM, no part count, no
    // media — and it holds no composition either. `materials: []` renders NO SECTION: not "no data",
    // not an empty table. It is also the row with NO MARKET SIGNAL of any kind, which suppresses
    // that entire block rather than printing "no listings".
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Handheld thermal camera module (invented unit)",
      unitAcquisition: "secondary_market",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-06-11T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-06-18T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: null,
    materials: [],
    summary:
      "Desoldering the sensor package to find a two-generation-old microbolometer behind a new part number, plus the calibration table it ships with.",
    thumbnailUrl: "/dummy/thumbnail_image02.avif",
    author: {
      displayName: "Rahul Mehta",
      handle: "rahul-teardown",
      avatarUrl: "/dummy/profile_image_02.avif",
    },
    viewCount: 91455,
    likeCount: 7822,
    commentCount: 604,
    saveCount: 2960,
    difficulty: "advanced",
    cadFormat: null,
    billOfMaterialsCostRange: null,
    tags: ["thermal-imaging", "sensors", "reverse-engineering"],
    createdAt: "2026-08-02T16:40:00.000Z",
    walkthroughVideo: null,
    documents: [],
    partCount: null,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-003",
    slug: "brushless-motor-driver-schematic",
    title: "A 24 V brushless driver you can actually source in Lagos",
    category: "teardown",
    // STATE: designation_freetext — a real class and process, with a designation the publisher
    // wrote in their own words because no standard designation fits. NOT the same as the legacy
    // state below: this row knows what the material IS, it just cannot name it to a standard.
    //
    // Also the LICENSED / OPEN SOURCE provenance arm — a public licence with a name and a URL a
    // reader can open, which is exactly what the manufacturer-authorized arm below does NOT have.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "licensed_open_source",
      subjectProductName: "Open-hardware three-phase driver board (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-05-30T00:00:00.000Z",
      licence: { name: "CERN-OHL-S v2", url: "https://example.com/licences/cern-ohl-s-2" },
      authorizationNote: null,
      attestationAcceptedAt: "2026-06-02T00:00:00.000Z",
      notes: "Published under the original design's own licence; the licence text is unmodified.",
    },
    storeProductClass: null,
    materials: [
      {
        id: "mat-010",
        appliesToLabel: "Gate-driver potting compound",
        partId: null,
        designation: "Soft grey two-part silicone, unbranded",
        designationSource: "contributor_freetext",
        materialClass: "elastomer",
        process: "cast",
        finish: null,
        elements: [],
      },
    ],
    summary:
      "Schematic and layout for a 15 A BLDC driver built entirely from parts with three or more local distributors — the substitution table is the interesting half.",
    thumbnailUrl: "/dummy/thumbnail_image03.avif",
    author: {
      displayName: "Chidi Eze",
      handle: "chidi-motors",
      avatarUrl: "/dummy/profile_image_03.avif",
    },
    viewCount: 33780,
    likeCount: 2611,
    commentCount: 143,
    saveCount: 812,
    difficulty: "intermediate",
    cadFormat: "KiCad 8 / Gerber",
    billOfMaterialsCostRange: {
      minimumInCents: 1850,
      maximumInCents: 2400,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["motors", "bldc", "sourcing", "power-electronics"],
    createdAt: "2026-07-28T11:05:00.000Z",
    // ⚠️ THE ONLY FIXTURE WHOSE STEPS CARRY NO AFFORDANCE AT ALL — no part to focus, because it
    // published no assembly, and no moment to seek, because no blueprint video can be seeked. That
    // is the row `assembly-step-list.tsx` renders as prose, and this is what exercises it.
    walkthroughVideo: placeholderYoutubeVideo(PLACEHOLDER_YOUTUBE_DURATION_SECONDS),
    documents: [PLACEHOLDER_DOCUMENTS.brushlessSchematic],
    partCount: 62,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [
      PLACEHOLDER_MANUFACTURING_FILES.brushlessTopCopperGerber,
      PLACEHOLDER_MANUFACTURING_FILES.brushlessDrill,
      PLACEHOLDER_MANUFACTURING_FILES.brushlessPickAndPlace,
      PLACEHOLDER_MANUFACTURING_FILES.brushlessBillOfMaterialsCsv,
    ],
    // `focusedPartId` IS NULL ON EVERY STEP, and it has to be: the contract only allows a part id
    // that exists in `assembly.parts`, and this teardown published no assembly.
    assemblySteps: [
      {
        stepNumber: 1,
        title: "What the driver has to survive",
        description:
          "Stall current, the supply rail it actually sees on a long cable run, and the two failures that follow from getting either wrong.",
        focusedPartId: null,
      },
      {
        stepNumber: 2,
        title: "Choosing the gate driver",
        description:
          "Why the obvious part is the one nobody stocks locally, and what the substitution table trades away.",
        focusedPartId: null,
      },
      {
        stepNumber: 3,
        title: "Current sense and the shunt placement",
        description:
          "Low-side sensing, the ground bounce it introduces, and the layout that keeps it measurable.",
        focusedPartId: null,
      },
      {
        stepNumber: 4,
        title: "What to check before you order boards",
        description:
          "The three footprints worth re-reading against the datasheet, and the one clearance that fails a cheap fab.",
        focusedPartId: null,
      },
    ],
    repairabilityIndex: null,
    // ⚠️ TELEMETRY WITH NO ASSEMBLY, WHICH IS THE POINT OF PUTTING IT HERE. The contract has always
    // allowed the combination — a bench test on something nobody modelled is the ordinary case for
    // a board — but until this fixture existed both telemetried teardowns also had models, which
    // hid the fact that `TelemetryReadouts` was mounted INSIDE the 3D viewer and therefore rendered
    // nothing on the unmodelled path. The panel now lives on the detail page; this is what keeps
    // that honest. Delete the model from a fixture and you lose the check, not just the model.
    //
    // These are thermal and electrical bench figures rather than a structural analysis, so the
    // mechanical readouts are the small numbers you would expect of a PCB: a board flexes microns
    // under its own connectors and is rated in the tens of newtons of connector insertion force.
    simulationTelemetry: {
      factorOfSafety: 1.9,
      peakVonMisesStressMegapascals: 41.5,
      maxDisplacementMicrometres: 95,
      thermalDeltaKelvin: 54,
      ratedLoadNewtons: 35,
      source: "author_reported",
    },
  },
  {
    id: "bp-004",
    slug: "borehole-pump-housing-tolerances",
    title: "Borehole pump housing: the four tolerances that matter",
    category: "teardown",
    // STATE: designation_scanned_partial. Four materials, two scanned and two not, which is what a
    // real survey looks like: a publisher runs the analyser on the parts they doubt and reads the
    // rest off a marking. The section must not make the unscanned rows look like failures.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "4-inch borehole pump wet end (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["dimensional_survey", "material_spectroscopy"],
      surveyedAt: "2026-07-02T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-07-08T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: { categorySlug: "borehole-pumps", label: "Borehole pumps" },
    materials: [
      {
        id: "mat-020",
        appliesToLabel: "Housing casting",
        partId: "part-010",
        designation: "316 stainless",
        designationSource: "measured_spectroscopy",
        materialClass: "metal_alloy",
        process: "cast",
        finish: "As-cast, bore machined",
        elements: [
          {
            symbol: "Cr",
            weightPercentRange: { minimumPercent: 16, maximumPercent: 18 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: "Invented figure.",
          },
          {
            symbol: "Ni",
            weightPercentRange: { minimumPercent: 10, maximumPercent: 14 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: null,
          },
          {
            symbol: "Mo",
            weightPercentRange: { minimumPercent: 2, maximumPercent: 3 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: null,
          },
        ],
      },
      {
        id: "mat-021",
        appliesToLabel: "Drive shaft",
        partId: "part-011",
        designation: "17-4 PH, H900",
        designationSource: "supplier_declared",
        materialClass: "metal_alloy",
        process: "cnc_milled",
        finish: "Ground",
        elements: [],
      },
      {
        id: "mat-022",
        appliesToLabel: "Impeller",
        partId: "part-012",
        designation: "CC480K bronze",
        designationSource: "measured_spectroscopy",
        materialClass: "metal_alloy",
        process: "cast",
        finish: null,
        elements: [
          {
            symbol: "Cu",
            weightPercentRange: { minimumPercent: 84, maximumPercent: 88 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: "Invented figure.",
          },
          {
            symbol: "Sn",
            weightPercentRange: { minimumPercent: 9, maximumPercent: 11 },
            analysisMethod: "synthetic_example",
            instrumentLabel: null,
            operatorNote: null,
          },
        ],
      },
      {
        id: "mat-023",
        appliesToLabel: "Seal carrier, as replaced by the publisher",
        partId: "part-013",
        designation: "PETG",
        designationSource: "contributor_freetext",
        materialClass: "polymer",
        process: "fdm_printed",
        finish: null,
        elements: [],
      },
    ],
    summary:
      "CAD breakdown of a submersible pump housing, with the fits that decide whether it survives a season of silt and the three that do not matter at all.",
    thumbnailUrl: "/dummy/thumbnail_image04.avif",
    author: {
      displayName: "Grace Wanjiru",
      handle: "grace-mech",
      avatarUrl: "/dummy/profile_image_04.avif",
    },
    viewCount: 27340,
    likeCount: 1988,
    commentCount: 176,
    saveCount: 733,
    difficulty: "intermediate",
    cadFormat: "STEP / Fusion 360",
    billOfMaterialsCostRange: {
      minimumInCents: 12000,
      maximumInCents: 15500,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["pumps", "tolerances", "cad", "water"],
    createdAt: "2026-07-19T08:22:00.000Z",
    walkthroughVideo: null,
    documents: [PLACEHOLDER_DOCUMENTS.boreholeAssembly],
    partCount: 24,
    // ONE FILE PER PART — the shape an upload takes. Five files were exported in assembly
    // coordinates and trust `placement: null`; the seal carrier was exported at its own origin
    // and is put back by an explicit placement, so both branches of the loader render.
    //
    // THE INTERNALS ARE CHILDREN OF THE SHAFT, NOT THE HOUSING, and the housing is pinned to drop
    // straight down: a child rides its parent's explosion, so bearings parented to the housing
    // would sink with it and stay hidden inside a solid casting. Parented to the shaft they lift
    // out with it, which is also how the pump comes apart on a bench.
    assembly: {
      kind: "individual_parts",
      // DELIBERATELY RADIAL. One fixture must keep exercising the centroid path, or it becomes
      // unverified code the day the layered one lands.
      explosionAxis: null,
      parts: [
        {
          id: "part-010",
          label: "Housing",
          parentPartId: null,
          material: "Cast 316 stainless, machined bore",
          manufacturingMethod: "cast",
          explosionDirection: [0, -1, 0],
          explosionDistanceMm: 220,
          layerIndex: null,
          stressRating: 0.3,
          calloutText: "All four tolerances from the title live on this part.",
          model: { url: `${PUMP_PART_MODEL_DIRECTORY}/housing.glb`, byteSize: 48608 },
          placement: null,
        },
        {
          id: "part-011",
          label: "Drive shaft",
          parentPartId: null,
          material: "17-4 PH stainless, ground",
          manufacturingMethod: "cnc_milled",
          // Pinned upward: the shaft and the housing are coaxial, so an auto direction from the
          // assembly centre would send both the same way and never separate them.
          explosionDirection: [0, 1, 0],
          explosionDistanceMm: null,
          layerIndex: null,
          stressRating: 0.6,
          calloutText: null,
          model: { url: `${PUMP_PART_MODEL_DIRECTORY}/shaft.glb`, byteSize: 12640 },
          placement: null,
        },
        {
          id: "part-012",
          label: "Impeller",
          parentPartId: "part-011",
          material: "Cast bronze, CC480K",
          manufacturingMethod: "cast",
          // Far enough to clear the dropped housing rather than end up inside it: it rides the
          // shaft 140 mm up first, then drops 420 of its own.
          explosionDirection: [0, -1, 0],
          explosionDistanceMm: 420,
          layerIndex: null,
          stressRating: 0.45,
          calloutText: "Silt wear shows here first.",
          model: { url: `${PUMP_PART_MODEL_DIRECTORY}/impeller.glb`, byteSize: 34636 },
          placement: null,
        },
        {
          id: "part-013",
          label: "Seal carrier",
          parentPartId: "part-011",
          material: "PETG, printed in place of the machined carrier",
          manufacturingMethod: "fdm_printed",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: null,
          stressRating: null,
          calloutText: "Printed to prove the fit before committing to the machined part.",
          model: { url: `${PUMP_PART_MODEL_DIRECTORY}/seal_carrier.glb`, byteSize: 17328 },
          placement: { positionMm: [0, 140, 0], rotationDegrees: [0, 0, 0] },
        },
        {
          id: "part-014",
          label: "Upper bearing",
          parentPartId: "part-011",
          material: "6203-2RS",
          manufacturingMethod: "off_the_shelf",
          explosionDirection: null,
          explosionDistanceMm: null,
          layerIndex: null,
          stressRating: 0.7,
          calloutText: null,
          model: { url: `${PUMP_PART_MODEL_DIRECTORY}/bearing_upper.glb`, byteSize: 32120 },
          placement: null,
        },
        {
          id: "part-015",
          label: "Lower bearing",
          parentPartId: "part-011",
          material: "6203-2RS",
          manufacturingMethod: "off_the_shelf",
          explosionDirection: [0, -1, 0],
          explosionDistanceMm: 40,
          layerIndex: null,
          stressRating: 0.75,
          calloutText: "The one that failed — the silt pattern is in the assembly guide.",
          model: { url: `${PUMP_PART_MODEL_DIRECTORY}/bearing_lower.glb`, byteSize: 32124 },
          placement: null,
        },
      ],
    },
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: {
      factorOfSafety: 1.6,
      peakVonMisesStressMegapascals: 118,
      maxDisplacementMicrometres: 42,
      thermalDeltaKelvin: 6.5,
      ratedLoadNewtons: 3200,
      source: "author_reported",
    },
  },
  {
    id: "bp-005",
    slug: "battery-management-system-teardown",
    title: "A 7S BMS teardown, cell by cell",
    category: "teardown",
    // STATE: designation_only. The required three are present and `process` and `finish` are BOTH
    // null — the publisher identified the materials off their markings and could not say how the
    // parts were made. That is the point of those two being nullable inside a required set: the
    // alternative is a guess wearing the same type as a fact.
    //
    // MARKET SIGNAL: showcase only. Its store class holds no listings, so the store half is absent
    // and the block still renders on the showcase alone.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "16S lithium battery management board (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-06-25T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-06-30T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: {
      categorySlug: "battery-management-modules",
      label: "Battery management modules",
    },
    materials: [
      {
        id: "mat-030",
        appliesToLabel: "Cell-tap harness insulation",
        partId: null,
        designation: "PVC, 105 °C",
        designationSource: "manufacturer_marking",
        materialClass: "polymer",
        process: null,
        finish: null,
        elements: [],
      },
      {
        id: "mat-031",
        appliesToLabel: "Balance-resistor board",
        partId: null,
        designation: "FR-4",
        designationSource: "manufacturer_marking",
        materialClass: "laminate",
        process: null,
        finish: null,
        elements: [],
      },
    ],
    summary:
      "Balancing topology, the MOSFET selection nobody explains, and a measured comparison of the protection thresholds against what the datasheet claims.",
    thumbnailUrl: "/dummy/thumbnail_image05.avif",
    author: {
      displayName: "Tobias Lindqvist",
      handle: "tobias-cells",
      avatarUrl: "/dummy/profile_image_05.avif",
    },
    viewCount: 62190,
    likeCount: 5471,
    commentCount: 389,
    saveCount: 2104,
    difficulty: "advanced",
    cadFormat: "Altium / STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 2900,
      maximumInCents: 3800,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["batteries", "bms", "safety", "power-electronics"],
    createdAt: "2026-07-11T14:33:00.000Z",
    walkthroughVideo: placeholderYoutubeVideo(),
    documents: [
      PLACEHOLDER_DOCUMENTS.batteryManagementSchematic,
      PLACEHOLDER_DOCUMENTS.batteryManagementBillOfMaterials,
    ],
    partCount: 91,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-006",
    slug: "low-cost-spectrometer-optical-path",
    title: "Folding a spectrometer's optical path into 60 mm",
    category: "teardown",
    // STATE: legacy_free_text. A row that predates the composition contract: its material knowledge
    // was one unstructured string per part and it was migrated verbatim rather than re-typed by
    // somebody who never held the unit. `materialClass: "other"`, everything else null, and the
    // source says whose words these are. DISTINCT FROM designation_freetext, which knows the class
    // and the process and only lacks a standard name.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Benchtop visible-range spectrometer (invented unit)",
      unitAcquisition: "donated_unit",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-04-18T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-04-20T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: null,
    materials: [
      {
        id: "mat-040",
        appliesToLabel: "Slit assembly",
        partId: null,
        designation: "thin stainless shim stock, unknown grade, laser cut",
        designationSource: "contributor_freetext",
        materialClass: "other",
        process: null,
        finish: null,
        elements: [],
      },
      {
        id: "mat-041",
        appliesToLabel: "Body",
        partId: null,
        designation: "black printed plastic, matte, smells like PLA when sanded",
        designationSource: "contributor_freetext",
        materialClass: "other",
        process: null,
        finish: null,
        elements: [],
      },
    ],
    summary:
      "The grating mount, the slit, and the printed baffle that took stray light from unusable to tolerable. Includes the alignment jig.",
    thumbnailUrl: "/dummy/thumbnail_image06.avif",
    author: {
      displayName: "Priya Raghavan",
      handle: "priya-optics",
      avatarUrl: "/dummy/profile_image_06.avif",
    },
    viewCount: 19870,
    likeCount: 1642,
    commentCount: 97,
    saveCount: 508,
    difficulty: "advanced",
    cadFormat: "STEP / FreeCAD",
    billOfMaterialsCostRange: {
      minimumInCents: 7200,
      maximumInCents: 9900,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["optics", "instrumentation", "3d-printing"],
    createdAt: "2026-06-30T10:15:00.000Z",
    walkthroughVideo: null,
    documents: [],
    partCount: 19,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-007",
    slug: "esp32-sensor-node-power-budget",
    title: "An ESP32 sensor node that lasts a year on two AAs",
    category: "teardown",
    // THE MANUFACTURER-AUTHORIZED ARM, and it is the row that proves the split was worth making.
    // It wears the same "Authorized / open source" chip as the licensed row above — the shorthand
    // does not distinguish them — and the detail page then says the thing that matters: the
    // permission was granted to THIS publisher and does not travel to a reader with the files.
    // `licence` is null, which the old merged contract made impossible to express.
    //
    // Also a second `materials: []`. An empty composition list is the ORDINARY case and it should
    // look ordinary rather than appearing once on the deliberately-bare floor row.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "authorized_by_manufacturer",
      subjectProductName: "ESP32 field sensor node (invented unit)",
      unitAcquisition: "manufacturer_supplied",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-05-02T00:00:00.000Z",
      licence: null,
      authorizationNote:
        "The maker gave written permission to publish this teardown after the product was discontinued. Permission covers this write-up only, not reuse of the design.",
      attestationAcceptedAt: "2026-05-05T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: null,
    materials: [],
    summary:
      "Measured current in every state, the regulator swap that mattered more than the firmware, and the deep-sleep figure the datasheet does not give you.",
    thumbnailUrl: "/dummy/thumbnail_image07.avif",
    author: {
      displayName: "Marco Ferreira",
      handle: "marco-lowpower",
      avatarUrl: "/dummy/profile_image_07.avif",
    },
    viewCount: 74920,
    likeCount: 6903,
    commentCount: 512,
    saveCount: 2455,
    difficulty: "beginner",
    cadFormat: "KiCad 8",
    billOfMaterialsCostRange: {
      minimumInCents: 620,
      maximumInCents: 940,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["iot", "low-power", "esp32", "firmware"],
    createdAt: "2026-06-21T07:48:00.000Z",
    walkthroughVideo: null,
    documents: [PLACEHOLDER_DOCUMENTS.sensorNodeDatasheet],
    partCount: 31,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-008",
    slug: "milk-chiller-heat-exchanger-teardown",
    title: "Heat exchanger from a dairy chiller, cut in half",
    category: "teardown",
    // STATE: designation_process_finish. All five required fields non-null and NO element table —
    // the state a competent publisher reaches without owning an analyser, and the one the section
    // must render as complete rather than as a table with its numbers missing.
    //
    // MARKET SIGNAL: store listings only. No showcase was ever built from it, so the block renders
    // on the commerce half alone.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "500 L bulk milk cooler plate pack (invented unit)",
      unitAcquisition: "secondary_market",
      surveyMethods: ["dimensional_survey", "empirical_teardown"],
      surveyedAt: "2026-03-14T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-03-20T00:00:00.000Z",
      notes: "Unit was scrap; the plate pack had already been split when it was acquired.",
    },
    storeProductClass: { categorySlug: "dairy-cooling", label: "Dairy cooling" },
    materials: [
      {
        id: "mat-050",
        appliesToLabel: "Heat-exchanger plates",
        partId: null,
        designation: "316L stainless, 0.5 mm",
        designationSource: "manufacturer_marking",
        materialClass: "metal_alloy",
        process: "sheet_metal",
        finish: "Pressed, pickled and passivated",
        elements: [],
      },
      {
        id: "mat-051",
        appliesToLabel: "Plate gaskets",
        partId: null,
        designation: "NBR, food contact",
        designationSource: "supplier_declared",
        materialClass: "elastomer",
        process: "injection_molded",
        finish: "Glue-free clip-in",
        elements: [],
      },
    ],
    summary:
      "Plate spacing, braze quality and the fouling pattern after eighteen months in service — with the pressure-drop measurements that explain the pump sizing.",
    thumbnailUrl: "/dummy/thumbnail_image08.avif",
    author: {
      displayName: "Fatima Al-Rashid",
      handle: "fatima-thermal",
      avatarUrl: "/dummy/profile_image_08.avif",
    },
    viewCount: 21460,
    likeCount: 1477,
    commentCount: 131,
    saveCount: 622,
    difficulty: "intermediate",
    cadFormat: "STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 34000,
      maximumInCents: 41000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["cold-chain", "thermal", "dairy", "maintenance"],
    createdAt: "2026-06-09T13:57:00.000Z",
    walkthroughVideo: null,
    documents: [PLACEHOLDER_DOCUMENTS.heatExchangerSchematic],
    partCount: 8,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-013",
    slug: "hand-pump-gearbox-teardown",
    title: "The gearbox in a village hand pump, after nine years",
    category: "teardown",
    // A second designation_freetext row, on a mechanical subject rather than an electronic one.
    moderationState: "published",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Village hand-pump gearbox (invented unit)",
      unitAcquisition: "donated_unit",
      surveyMethods: ["dimensional_survey", "empirical_teardown"],
      surveyedAt: "2026-02-08T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-02-12T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: null,
    materials: [
      {
        id: "mat-060",
        appliesToLabel: "Gear pair",
        partId: null,
        designation: "Case-hardened plain carbon steel, grade not marked",
        designationSource: "contributor_freetext",
        materialClass: "metal_alloy",
        process: "cnc_milled",
        finish: "Black oxide, mostly worn off",
        elements: [],
      },
    ],
    summary:
      "Wear patterns on a cast bronze worm drive that outlived its rated life by six years, and the two bearings that did not.",
    thumbnailUrl: "/dummy/thumbnail_image09.avif",
    author: {
      displayName: "Grace Wanjiru",
      handle: "grace-mech",
      avatarUrl: "/dummy/profile_image_04.avif",
    },
    viewCount: 15230,
    likeCount: 1204,
    commentCount: 68,
    saveCount: 396,
    difficulty: "beginner",
    cadFormat: "STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 8800,
      maximumInCents: 11200,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["water", "mechanical", "wear", "maintenance"],
    createdAt: "2026-08-06T10:30:00.000Z",
    walkthroughVideo: null,
    documents: [],
    partCount: 17,
    assembly: null,
    partsList: [
      {
        label: "Gearbox housing",
        material: "Cast aluminium, sand-cast and unfinished",
      },
      {
        label: "Input shaft",
        material: "Case-hardened steel, 12 mm",
      },
      {
        label: "Reduction gear, 41 tooth",
        material: "Sintered steel",
      },
      {
        label: "Reduction gear, 13 tooth",
        material: "Sintered steel",
      },
      {
        label: "Thrust washer",
        material: "Bronze",
      },
      {
        label: "Lip seal",
        material: "Nitrile rubber",
      },
      {
        label: "Housing bolts",
        material: "Zinc-plated steel, M8",
      },
    ],
    fasteners: [],
    manufacturingFiles: [
      PLACEHOLDER_MANUFACTURING_FILES.gearboxCaseStep,
      PLACEHOLDER_MANUFACTURING_FILES.gearboxIdlerStl,
      PLACEHOLDER_MANUFACTURING_FILES.gearboxShimDxf,
    ],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-014",
    slug: "grain-moisture-meter-teardown",
    title: "A grain moisture meter and the capacitance bridge inside it",
    category: "teardown",
    // STATE: disputed_quarantined. A rights holder raised a claim and it was substantiated, so the
    // row is WITHHELD RATHER THAN DELETED: absent from every index, still answering on its own URL
    // with a stated notice, and its files, model and composition unreachable. The composition below
    // is present in the fixture precisely so that the renderer has something it must refuse to show.
    moderationState: "quarantined",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Capacitive grain moisture meter (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown", "material_spectroscopy"],
      surveyedAt: "2026-01-22T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-01-25T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: {
      categorySlug: "agricultural-instruments",
      label: "Agricultural instruments",
    },
    materials: [
      {
        id: "mat-070",
        appliesToLabel: "Sensing plate",
        partId: null,
        designation: "Tinned brass",
        designationSource: "measured_spectroscopy",
        materialClass: "metal_alloy",
        process: "sheet_metal",
        finish: "Bright tin",
        elements: [],
      },
    ],
    summary:
      "Why the calibration is per-crop rather than universal, where the temperature compensation happens, and the op-amp choice that sets the whole error budget.",
    thumbnailUrl: "/dummy/thumbnail_image10.avif",
    author: {
      displayName: "Rahul Mehta",
      handle: "rahul-teardown",
      avatarUrl: "/dummy/profile_image_02.avif",
    },
    viewCount: 28940,
    likeCount: 2317,
    commentCount: 204,
    saveCount: 901,
    difficulty: "intermediate",
    cadFormat: "KiCad 8",
    billOfMaterialsCostRange: {
      minimumInCents: 2100,
      maximumInCents: 3300,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["agriculture", "instrumentation", "analog", "sensors"],
    createdAt: "2026-07-16T09:05:00.000Z",
    walkthroughVideo: placeholderYoutubeVideo(),
    documents: [],
    partCount: 44,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-015",
    slug: "off-grid-router-power-rail-teardown",
    title: "The power rail in an off-grid mesh router",
    category: "teardown",
    // STATE: flagged. Somebody has reported an IP concern and NOBODY HAS RULED ON IT, so the public
    // view is UNCHANGED apart from a stated notice — the files, the model and the composition all
    // still render. Delisting on the strength of an unexamined report would turn the report control
    // into a takedown control, which is the failure every notice-and-takedown system is judged on.
    moderationState: "flagged",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Solar-powered outdoor router (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-01-09T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-01-14T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: null,
    materials: [
      {
        id: "mat-080",
        appliesToLabel: "Enclosure",
        partId: null,
        designation: "ASA, UV stabilised",
        designationSource: "manufacturer_marking",
        materialClass: "polymer",
        process: "injection_molded",
        finish: "Grained, UV stable",
        elements: [],
      },
    ],
    summary:
      "Three buck stages, one of them doing nothing useful, and the brownout behaviour that explains a year of unexplained reboots in the field.",
    thumbnailUrl: "/dummy/thumbnail_image11.avif",
    author: {
      displayName: "Marco Ferreira",
      handle: "marco-lowpower",
      avatarUrl: "/dummy/profile_image_07.avif",
    },
    viewCount: 41870,
    likeCount: 3925,
    commentCount: 271,
    saveCount: 1533,
    difficulty: "advanced",
    cadFormat: "Altium",
    billOfMaterialsCostRange: {
      minimumInCents: 1450,
      maximumInCents: 2050,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["networking", "power-electronics", "reliability", "off-grid"],
    createdAt: "2026-07-03T14:12:00.000Z",
    walkthroughVideo: null,
    documents: [],
    partCount: 77,
    assembly: null,
    partsList: [],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-016",
    slug: "irrigation-valve-actuator-teardown",
    title: "A latching irrigation valve that runs on one coin cell a season",
    category: "teardown",
    // STATE: pending_review. Submitted by a contributor and not yet cleared by a `moderate_content`
    // holder, so EVERY public read returns null and the route 404s. It is in this file rather than
    // omitted because the gate in `src/lib/blueprints/api.ts` is the rule "moderator approval before
    // public display", and a rule with no row that tests it is a rule nobody has run.
    moderationState: "pending_review",
    subjectKind: "existing_physical_product",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Latching irrigation valve actuator (invented unit)",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["dimensional_survey", "empirical_teardown"],
      surveyedAt: "2026-08-30T00:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-09-01T00:00:00.000Z",
      notes: null,
    },
    storeProductClass: null,
    materials: [],
    summary:
      "The latching solenoid, the drive pulse it actually needs versus the one the controller sends, and where the remaining energy goes.",
    thumbnailUrl: "/dummy/thumbnail_image12.avif",
    author: {
      displayName: "Fatima Al-Rashid",
      handle: "fatima-thermal",
      avatarUrl: "/dummy/profile_image_08.avif",
    },
    viewCount: 12680,
    likeCount: 989,
    commentCount: 54,
    saveCount: 311,
    difficulty: "beginner",
    cadFormat: null,
    billOfMaterialsCostRange: {
      minimumInCents: 1900,
      maximumInCents: 2600,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["agriculture", "low-power", "actuators", "water"],
    createdAt: "2026-06-14T11:44:00.000Z",
    walkthroughVideo: null,
    documents: [],
    partCount: null,
    assembly: null,
    partsList: [
      {
        label: "Actuator shell, upper",
        material: "Glass-filled nylon",
      },
      {
        label: "Actuator shell, lower",
        material: "Glass-filled nylon",
      },
      {
        label: "Solenoid coil",
        material: "Enamelled copper on a steel bobbin",
      },
      {
        label: "Plunger",
        material: "Stainless steel, magnetised",
      },
      {
        label: "Return spring",
        material: "Music wire",
      },
      {
        label: "Diaphragm",
        material: "EPDM",
      },
      {
        label: "Control board",
        material: "FR-4, single sided",
      },
    ],
    fasteners: [],
    manufacturingFiles: [],
    assemblySteps: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
  },
  {
    id: "bp-009",
    slug: "solar-cold-storage-field-prototype",
    title: "Solar cold store running for 90 days in Nakuru",
    category: "showcase",
    summary:
      "The controller from the first teardown, built into a working 400 L unit and left in a market for three months. Temperature logs, two failures, one fix.",
    thumbnailUrl: "/dummy/placeholder-freezers.avif",
    author: {
      displayName: "Amara Okonkwo",
      handle: "amara-builds",
      avatarUrl: "/dummy/profile_image_01.avif",
    },
    viewCount: 58330,
    likeCount: 6218,
    difficulty: "advanced",
    cadFormat: "STEP / Fusion 360",
    billOfMaterialsCostRange: {
      minimumInCents: 82000,
      maximumInCents: 96000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["cold-chain", "solar", "field-trial", "east-africa"],
    createdAt: "2026-08-30T12:00:00.000Z",
    tagline: "Holds 4 °C for 62 hours with no sun, in 41 °C ambient",
    writeUp:
      // THE ONE FIXTURE THAT EXERCISES THE MARKDOWN RENDERER'S BLOCKS: a pasted YouTube link on its own
      // line (the embedded video), a heading, a list with bold, and a site-relative image.
      "We put the controller from the teardown into a 400 L chest unit and left it in Nakuru market for ninety days. The trader who runs the stall kept it loaded the whole time, which is the only version of this test worth reporting: an empty cabinet coasting on its own insulation holds a number nobody can use.\n\n" +
      `https://www.youtube.com/watch?v=${PLACEHOLDER_YOUTUBE_VIDEO_ID}\n\n` +
      "The headline is 62 hours at 4 °C with no sun, measured with 380 L of produce loaded at 6 °C and an ambient that peaked at 41 °C. Empty, the same cabinet runs past 90 hours. We stopped quoting that figure after the first week because it flatters the design and tells a buyer nothing.\n\n" +
      "![The chest unit loaded at the Nakuru stall](/dummy/placeholder-freezers.avif)\n\n" +
      "## What failed\n\n" +
      "- **A compressor start relay**, at week three. It was rated for the current and not for forty starts a day, and nothing in its datasheet distinguishes the two.\n" +
      "- **A door gasket** took a permanent set in the heat and stopped sealing at the top corner, which cost about four hours of hold time before anyone noticed it.\n\n" +
      "The battery is lead-acid, and that is the decision people argue with most. LiFePO4 would give better cycle life and would not derate at 41 °C. It would also mean a trader whose pack dies has a unit out of service until something ships, where a lead-acid battery is a same-afternoon walk to a shop they already use. A pack nobody local can source is a cold store that dies the first time it needs one.\n\n" +
      "Next is the gasket, in a material that does not take a set, and a start relay chosen on cycles rather than amps. Neither moves the bill of materials by more than a few dollars.",
    // Sizes measured from the file on disk (800 by 800), as an upload would record them.
    // The blur is a 16px WebP made from the same file with sharp, the way the upload route will.
    writeUpImages: [
      {
        url: "/dummy/placeholder-freezers.avif",
        widthPx: 800,
        heightPx: 800,
        blurDataUrl:
          "data:image/webp;base64,UklGRjgAAABXRUJQVlA4ICwAAACwAQCdASoQABAAA4BaJZwAAlxV5ySAAP72E80teuzDQqpnssmU9aqtiZwIAA==",
      },
    ],
    launchedAt: "2026-09-01T08:00:00.000Z",
    upvoteCount: 214,
    commentCount: 7,
    team: [
      {
        displayName: "Amara Okonkwo",
        handle: "amara-builds",
        role: "Electronics",
      },
      {
        displayName: "Grace Wanjiru",
        handle: "grace-mech",
        role: "Mechanical",
      },
    ],
    builtFromBlueprintSlug: "solar-cold-storage-controller-teardown",
    callToAction: {
      label: "Read the 90-day field log",
      url: "https://example.com/qatoto/nakuru-field-log",
    },
  },
  {
    id: "bp-010",
    slug: "handheld-soil-analyser-prototype",
    title: "Handheld soil analyser, third prototype",
    category: "showcase",
    summary:
      "The folded spectrometer in an enclosure a field agent can hold, with the calibration workflow and the readings compared against a lab reference.",
    thumbnailUrl: "/dummy/placeholder-instruments.avif",
    author: {
      displayName: "Priya Raghavan",
      handle: "priya-optics",
      avatarUrl: "/dummy/profile_image_06.avif",
    },
    viewCount: 36105,
    likeCount: 3390,
    difficulty: "advanced",
    cadFormat: "STEP / FreeCAD",
    billOfMaterialsCostRange: {
      minimumInCents: 14500,
      maximumInCents: 18000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["agriculture", "optics", "instrumentation", "prototype"],
    createdAt: "2026-08-27T15:26:00.000Z",
    tagline: "Nitrogen and organic carbon in 40 seconds, without a lab",
    writeUp:
      "Third prototype, and the first one an agronomist can carry all day. Nitrogen and organic carbon in about forty seconds, against a district lab reference on the same samples.",
    writeUpImages: [],
    launchedAt: "2026-08-28T09:30:00.000Z",
    upvoteCount: 147,
    commentCount: 0,
    team: [
      {
        displayName: "Priya Raghavan",
        handle: "priya-optics",
        role: "Optics and firmware",
      },
    ],
    builtFromBlueprintSlug: "low-cost-spectrometer-optical-path",
    callToAction: null,
  },
  {
    id: "bp-017",
    slug: "brushless-cargo-trike-drivetrain",
    title: "Cargo trike drivetrain on the Lagos-sourced driver",
    category: "showcase",
    summary:
      "Two of the 15 A drivers in a 300 kg cargo trike, six months of delivery rounds, and the thermal derating that ended up mattering more than peak torque.",
    thumbnailUrl: "/dummy/thumbnail_image03.avif",
    author: {
      displayName: "Chidi Eze",
      handle: "chidi-motors",
      avatarUrl: "/dummy/profile_image_03.avif",
    },
    viewCount: 44210,
    likeCount: 4103,
    difficulty: "intermediate",
    cadFormat: "STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 61000,
      maximumInCents: 74000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["mobility", "motors", "logistics", "west-africa"],
    createdAt: "2026-09-04T10:10:00.000Z",
    tagline: "300 kg up a 9% grade, on parts you can buy in Ikeja",
    writeUp: null,
    writeUpImages: [],
    launchedAt: "2026-09-05T07:15:00.000Z",
    upvoteCount: 302,
    commentCount: 5,
    team: [
      {
        displayName: "Chidi Eze",
        handle: "chidi-motors",
        role: "Drivetrain",
      },
      {
        displayName: "Tobias Lindqvist",
        handle: "tobias-cells",
        role: "Pack and BMS",
      },
      {
        displayName: "Marco Ferreira",
        handle: "marco-lowpower",
        role: "Telemetry",
      },
    ],
    builtFromBlueprintSlug: "brushless-motor-driver-schematic",
    callToAction: {
      label: "Route and load data",
      url: "https://example.com/qatoto/cargo-trike-routes",
    },
  },
  {
    id: "bp-018",
    slug: "grain-moisture-meter-field-units",
    title: "Forty moisture meters, one harvest season",
    category: "showcase",
    summary:
      "The capacitance bridge rebuilt as a field unit and handed to forty co-op buyers. What broke, what they ignored, and the one reading they did not trust.",
    thumbnailUrl: "/dummy/thumbnail_image10.avif",
    author: {
      displayName: "Rahul Mehta",
      handle: "rahul-teardown",
      avatarUrl: "/dummy/profile_image_02.avif",
    },
    viewCount: 22870,
    likeCount: 2011,
    difficulty: "intermediate",
    cadFormat: "KiCad 8 / STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 3900,
      maximumInCents: 5200,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["agriculture", "instrumentation", "field-trial"],
    createdAt: "2026-08-22T13:40:00.000Z",
    tagline: "Within 0.4% of the lab, in a shed, on a phone charger",
    writeUp:
      "Twenty units went out to buying agents at four collection points. The comparison is against the district lab, on split samples from the same bag.\n\n" +
      "Across 640 readings the units sat within 0.4% of the lab figure. The outliers were not the electronics: they were maize that had been sitting in a truck in the sun, where the surface is dry and the core is not, and a single probe reads whichever one it is touching. Two readings thirty seconds apart at different depths closes most of that gap.\n\n" +
      "The unit runs off a phone charger because every collection point already has one. It was going to be a battery pack until an agent pointed out that the shed loses power for six hours a day, and the charger is what everyone already plugs into a generator.",
    writeUpImages: [],
    launchedAt: "2026-08-24T06:45:00.000Z",
    upvoteCount: 96,
    commentCount: 0,
    team: [
      {
        displayName: "Rahul Mehta",
        handle: "rahul-teardown",
        role: "Hardware",
      },
      {
        displayName: "Priya Raghavan",
        handle: "priya-optics",
        role: "Calibration",
      },
    ],
    builtFromBlueprintSlug: "grain-moisture-meter-teardown",
    callToAction: null,
  },
  {
    id: "bp-019",
    slug: "dairy-chiller-retrofit-pilot",
    title: "Retrofitting eleven dairy chillers instead of replacing them",
    category: "showcase",
    summary:
      "A controller and sensor kit fitted to chillers already in service at eleven collection points, and the energy figures before and after.",
    thumbnailUrl: "/dummy/placeholder-compressors.avif",
    author: {
      displayName: "Fatima Al-Rashid",
      handle: "fatima-thermal",
      avatarUrl: "/dummy/profile_image_08.avif",
    },
    viewCount: 18340,
    likeCount: 1522,
    difficulty: "beginner",
    cadFormat: null,
    billOfMaterialsCostRange: {
      minimumInCents: 21000,
      maximumInCents: 27500,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["cold-chain", "dairy", "retrofit", "energy"],
    createdAt: "2026-08-17T08:55:00.000Z",
    tagline: "23% less energy per litre, without buying a single new chiller",
    writeUp: null,
    writeUpImages: [],
    launchedAt: "2026-08-19T11:20:00.000Z",
    upvoteCount: 58,
    commentCount: 0,
    team: [
      {
        displayName: "Fatima Al-Rashid",
        handle: "fatima-thermal",
        role: "Thermal",
      },
    ],
    // Built from equipment that was never published here as a teardown.
    builtFromBlueprintSlug: null,
    callToAction: {
      label: "Site-by-site energy figures",
      url: "https://example.com/qatoto/chiller-retrofit-energy",
    },
  },
  {
    id: "bp-023",
    slug: "latching-valve-drip-irrigation-pilot",
    title: "Sixty latching valves on a two-hectare drip scheme in Kisumu",
    category: "showcase",
    summary:
      "The latching actuator from the teardown fitted to sixty valves on a drip scheme and run on a schedule from one node for a growing season. Which valves stuck, why the schedule drifted, and the coin cells that did not last.",
    thumbnailUrl: "/dummy/thumbnail_image12.avif",
    author: {
      displayName: "Naledi Dlamini",
      handle: "naledi-agri",
      avatarUrl: "/dummy/profile_image_09.avif",
    },
    viewCount: 27410,
    likeCount: 2488,
    difficulty: "intermediate",
    cadFormat: "STEP / FreeCAD",
    billOfMaterialsCostRange: {
      minimumInCents: 4800,
      maximumInCents: 6100,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["agriculture", "water", "actuators", "field-trial", "east-africa"],
    createdAt: "2026-09-01T15:45:00.000Z",
    tagline: "One coin cell per valve, a full season, zero mains",
    writeUp:
      "Forty valves across two hectares, latching solenoids on a CR2032 each, no mains and no solar. A latching valve draws current only while it changes state, so a season of twice-daily switching comes to a few hundred milliamp-seconds and the cell is oversized for it.\n\n" +
      `https://youtu.be/${PLACEHOLDER_YOUTUBE_VIDEO_ID}\n\n` +
      "The part that took the time was not the valve. It was building a controller that fails closed when a cell finally does go, because a drip line stuck open overnight costs more water than the whole season saves.",
    writeUpImages: [],
    launchedAt: "2026-09-03T08:00:00.000Z",
    upvoteCount: 129,
    commentCount: 0,
    team: [
      {
        displayName: "Naledi Dlamini",
        handle: "naledi-agri",
        role: "Field deployment",
      },
      {
        displayName: "Fatima Al-Rashid",
        handle: "fatima-thermal",
        role: "Actuator firmware",
      },
    ],
    builtFromBlueprintSlug: "irrigation-valve-actuator-teardown",
    callToAction: {
      label: "Watering schedule and soil logs",
      url: "https://example.com/qatoto/kisumu-drip-logs",
    },
  },
  {
    id: "bp-024",
    slug: "seven-cell-pack-for-motorcycle-taxis",
    title: "A 7S pack that survived 400 charge cycles on Kampala boda-bodas",
    category: "showcase",
    summary:
      "The balancing and protection board from the BMS teardown built into a swappable pack and run by six motorcycle taxis for five months. Cycle-by-cycle capacity, the two cells that were replaced, and the connector that wore first.",
    thumbnailUrl: "/dummy/thumbnail_image05.avif",
    author: {
      displayName: "Tobias Lindqvist",
      handle: "tobias-cells",
      avatarUrl: "/dummy/profile_image_05.avif",
    },
    viewCount: 51280,
    likeCount: 5476,
    difficulty: "advanced",
    cadFormat: "STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 38000,
      maximumInCents: 46000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["mobility", "batteries", "energy", "east-africa"],
    createdAt: "2026-08-28T16:05:00.000Z",
    tagline: "Swappable 1.2 kWh, 400 cycles, 91% capacity left",
    writeUp: null,
    writeUpImages: [],
    launchedAt: "2026-08-30T09:30:00.000Z",
    upvoteCount: 263,
    commentCount: 0,
    team: [
      {
        displayName: "Tobias Lindqvist",
        handle: "tobias-cells",
        role: "Pack and BMS",
      },
      {
        displayName: "Chidi Eze",
        handle: "chidi-motors",
        role: "Motor integration",
      },
      {
        displayName: "Wanjiku Kamau",
        handle: "wanjiku-power",
        role: "Field data",
      },
    ],
    builtFromBlueprintSlug: "battery-management-system-teardown",
    callToAction: {
      label: "Cycle-by-cycle capacity data",
      url: "https://example.com/qatoto/boda-pack-cycles",
    },
  },
  {
    id: "bp-025",
    slug: "hand-pump-gearbox-replacement-kit",
    title: "A drop-in gearbox kit for the village hand pump, fitted at twelve wells",
    category: "showcase",
    summary:
      "The worn gear train from the teardown redesigned as a kit that drops into the existing casting, and fitted at twelve wells by the county maintenance crew. Fit times, the one casting it did not fit, and what the crew changed.",
    thumbnailUrl: "/dummy/thumbnail_image09.avif",
    author: {
      displayName: "Grace Wanjiru",
      handle: "grace-mech",
      avatarUrl: "/dummy/profile_image_04.avif",
    },
    viewCount: 15920,
    likeCount: 1364,
    difficulty: "beginner",
    cadFormat: "STEP / Fusion 360",
    billOfMaterialsCostRange: {
      minimumInCents: 6500,
      maximumInCents: 8200,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["water", "mechanical", "retrofit", "east-africa"],
    createdAt: "2026-08-24T13:30:00.000Z",
    tagline: "Fitted in 40 minutes with the tools already on the truck",
    writeUp: null,
    writeUpImages: [],
    launchedAt: "2026-08-26T07:00:00.000Z",
    // Deliberately ties `grain-moisture-meter-field-units` at 96, so `byMostUpvoted`'s tie-break is
    // exercised on the second page of `?sort=top` rather than only in a comment.
    upvoteCount: 96,
    commentCount: 0,
    team: [
      {
        displayName: "Grace Wanjiru",
        handle: "grace-mech",
        role: "Mechanical",
      },
    ],
    builtFromBlueprintSlug: "hand-pump-gearbox-teardown",
    callToAction: null,
  },
  {
    id: "bp-026",
    slug: "machined-borehole-pump-housings-dry-season",
    title: "Twenty borehole pumps on a machined housing, one dry season",
    category: "showcase",
    summary:
      "Housings machined to the four tolerances from the teardown, fitted to twenty pumps across two counties and inspected monthly through a dry season. Seal condition per well, the two housings re-machined, and the tolerance that turned out to be loose.",
    thumbnailUrl: "/dummy/thumbnail_image04.avif",
    author: {
      displayName: "Kwame Mensah",
      handle: "kwame-machining",
      avatarUrl: "/dummy/profile_image_11.avif",
    },
    viewCount: 33640,
    likeCount: 3012,
    difficulty: "intermediate",
    cadFormat: "STEP",
    billOfMaterialsCostRange: {
      minimumInCents: 18500,
      maximumInCents: 23000,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["water", "machining", "field-trial", "west-africa"],
    createdAt: "2026-08-20T09:50:00.000Z",
    tagline: "Zero seal failures across 20 wells and 3,100 pump-hours",
    writeUp:
      "Twenty wells, one dry season, 3,100 recorded pump-hours, no seal failure. The previous housings were failing at roughly one in four before a full season was out, which is what started this.\n\n" +
      `https://www.youtube.com/watch?v=${PLACEHOLDER_YOUTUBE_VIDEO_ID}\n\n` +
      "The change is a tolerance, not a redesign. The seal carrier bore was drawn at a fit the shop could not hold on a manual lathe, so every housing landed somewhere in a band, and the ones at the loose end wept fine sand into the seal face. Reaming the bore as a separate operation costs about ninety seconds a part and pulls the whole band inside the range the seal was designed for.\n\n" +
      "Nothing about this is clever, and that is the part worth taking away. The drawing was right and the process could not hold it, which is a failure that looks exactly like a bad design until somebody measures the parts that came back.",
    writeUpImages: [],
    launchedAt: "2026-08-21T10:10:00.000Z",
    upvoteCount: 188,
    commentCount: 0,
    team: [
      {
        displayName: "Kwame Mensah",
        handle: "kwame-machining",
        role: "Machining",
      },
      {
        displayName: "Grace Wanjiru",
        handle: "grace-mech",
        role: "Tolerances",
      },
    ],
    builtFromBlueprintSlug: "borehole-pump-housing-tolerances",
    callToAction: {
      label: "Pump-hour and seal inspection log",
      url: "https://example.com/qatoto/borehole-seal-log",
    },
  },
  {
    id: "bp-027",
    slug: "off-grid-mesh-nodes-kumasi-market",
    title: "Fourteen mesh nodes across a Kumasi market, running on the rebuilt rail",
    category: "showcase",
    summary:
      "The power rail from the router teardown rebuilt with the panel and cell it should have shipped with, in fourteen nodes strung across a covered market. Uptime per node, the two that browned out in the first week, and the fix.",
    thumbnailUrl: "/dummy/thumbnail_image11.avif",
    author: {
      displayName: "Marco Ferreira",
      handle: "marco-lowpower",
      avatarUrl: "/dummy/profile_image_07.avif",
    },
    viewCount: 8930,
    likeCount: 742,
    difficulty: "intermediate",
    cadFormat: null,
    billOfMaterialsCostRange: {
      minimumInCents: 9800,
      maximumInCents: 12400,
      currency: UNITED_STATES_DOLLAR,
    },
    tags: ["connectivity", "low-power", "solar", "west-africa"],
    createdAt: "2026-09-05T14:20:00.000Z",
    tagline: "Fourteen nodes, 31 days, no mains and no reboot",
    writeUp:
      // A FULL MARKDOWN WRITE-UP: headings, lists, a table, two images and two videos, the shape a
      // maker who documents properly produces. ⚠️ THE IMAGES ARE THE LABELLED PLACEHOLDERS ON
      // PURPOSE. Nothing in `/dummy` shows a market mesh node, and a real photo of something else
      // captioned as this build would be a fabricated record; the alt text says what belongs there.
      // Both videos are the one placeholder clip every fixture uses.
      "Fourteen nodes over about six hundred metres of market, thirty-one days, no mains anywhere on the run, and no node needed a reboot. Each one is a solar panel, a small pack and a radio in a housing a stallholder can hose down.\n\n" +
      `https://www.youtube.com/watch?v=${PLACEHOLDER_YOUTUBE_VIDEO_ID}\n\n` +
      "## What is in a node\n\n" +
      "- **A 10 W panel** clamped to the stall roof rail, angled for the gap between the canopies.\n" +
      "- **A 2S 18650 pack** (7.2 V, 3,000 mAh) on the rebuilt rail from the router teardown, with the undervoltage cutoff the original never had.\n" +
      "- **A 2.4 GHz mesh radio** and a 5 dBi omni antenna, in an IP65 box with a drip loop on every cable.\n\n" +
      "![A node on a stall roof rail: panel, sealed box and antenna](/dummy/placeholder-instruments-wide.avif)\n\n" +
      "## The rail, rebuilt\n\n" +
      "The router in the teardown ran its regulator straight off the panel input with no storage, so it dropped out every time a cloud passed. The rebuild adds the pack and a buck converter sized for the radio's transmit peaks rather than its average draw.\n\n" +
      "![The undervoltage cutoff board on the rebuilt rail](/dummy/placeholder-compressors-small.avif)\n\n" +
      "| Measure | Original rail | Rebuilt rail |\n" +
      "| --- | --- | --- |\n" +
      "| Storage | None | 2S pack, 21.6 Wh |\n" +
      "| Running with no sun | Under a second | About 19 hours |\n" +
      "| After a brownout | Manual power cycle | Back on by itself at 6.4 V |\n\n" +
      "## When the market fills up\n\n" +
      "The question in the discussion is the right one. An empty aisle at dawn and a full market at eleven are different propagation problems, because people and wet produce absorb 2.4 GHz. Across the month the median link margin fell from 18 dB at 06:00 to 9 dB at 11:00, and the mesh routed around the three weakest hops instead of losing them, which is most of why the uptime figure holds.\n\n" +
      `https://youtu.be/${PLACEHOLDER_YOUTUBE_VIDEO_ID}\n\n` +
      "## What went wrong\n\n" +
      "Two nodes browned out in the first week. Both sat under the fish section's tarpaulin, which shaded their panels until mid-morning, and both packs fell below the cutoff overnight. The rebuilt rail brought them back on its own once the sun reached them, so neither needed a visit, but each was dark for about four hours. Moving the two panels to the edge of the tarpaulin fixed it, and neither has dropped since.\n\n" +
      "![The two shaded nodes, before and after the panels moved](/dummy/placeholder-cartons-tall.avif)\n\n" +
      "## What is next\n\n" +
      "- **A month in the rainy season**, which nobody has run yet.\n" +
      "- **A second market with metal roofing**, which reflects the signal rather than absorbing it.\n" +
      "- **The rebuilt rail's schematic**, published beside the original teardown.",
    // Sizes measured from the files on disk, as an upload would record them. ONE IMAGE PER SIZING
    // STATE, so the page shows an upload keeping its shape the way Launch YC and a GitHub README do
    // (the solar launch holds the square one):
    // - wide, 1600 by 900: shrinks to the 768px column as 768 by 432
    // - small, 480 by 360: narrower than the column, so it stays 480 wide and is not enlarged
    // - tall, 900 by 1200: shrinks to 768 by 1024, with no height cap
    // The files are the labelled placeholders padded out on their own flat background, not cropped,
    // so the icon and label stay whole.
    writeUpImages: [
      // Blurs are 16px-wide WebPs made from the same files with sharp, the way the upload route will.
      {
        url: "/dummy/placeholder-instruments-wide.avif",
        widthPx: 1600,
        heightPx: 900,
        blurDataUrl:
          "data:image/webp;base64,UklGRiwAAABXRUJQVlA4ICAAAAAwAQCdASoQAAkAA4BaJZwAA3AA/vIJ2Sogv/AzgQAAAA==",
      },
      {
        url: "/dummy/placeholder-compressors-small.avif",
        widthPx: 480,
        heightPx: 360,
        blurDataUrl:
          "data:image/webp;base64,UklGRjIAAABXRUJQVlA4ICYAAADQAQCdASoQAAwAA4BaJZwAAu19vBy1AAD+9hKqPM+/7DOlGcCAAA==",
      },
      {
        url: "/dummy/placeholder-cartons-tall.avif",
        widthPx: 900,
        heightPx: 1200,
        blurDataUrl:
          "data:image/webp;base64,UklGRj4AAABXRUJQVlA4IDIAAACwAgCdASoQABUAPu1iqU2ppaOiMAgBMB2JaQAAeyAA/u+xz2I8IFUVO7csmmjFE0RQAA==",
      },
    ],
    launchedAt: "2026-09-07T06:30:00.000Z",
    upvoteCount: 41,
    commentCount: 1,
    team: [
      {
        displayName: "Marco Ferreira",
        handle: "marco-lowpower",
        role: "Power",
      },
      {
        displayName: "Adaeze Nwosu",
        handle: "adaeze-networks",
        role: "Network",
      },
    ],
    builtFromBlueprintSlug: "off-grid-router-power-rail-teardown",
    callToAction: null,
  },
  {
    id: "bp-012",
    slug: "find-the-step-that-stopped-scaling",
    title: "Find the step that stopped scaling before you cut the bill of materials.",
    category: "case_study",
    moderationState: "published",
    summary:
      "Four production runs of a sensor node. Cost per unit fell 41% between runs one and three, then 3% between three and four, and the team spent two months quoting cheaper parts before they looked at assembly.",
    author: {
      displayName: "Marco Ferreira",
      handle: "marco-lowpower",
      avatarUrl: "/dummy/profile_image_07.avif",
    },
    viewCount: 51240,
    likeCount: 4863,
    tags: ["manufacturing", "unit-economics", "assembly"],
    createdAt: "2026-09-05T11:18:00.000Z",
    discipline: "unit_economics",
    oneLineAction: "Time each assembly step at two volumes before you requote a single component.",
    authorRelationship: "first_hand",
    outcomeSummary: "Shipped batch four at 512 cents a unit",
    sector: "Hardware",
    evidenceCompanies: [{ name: "Verdant Sensing", locationLabel: "Porto", yearLabel: "2024" }],
    problem:
      "Cost per node had stopped falling and nobody could say which part of the build was responsible. The instinct was to requote the bill of materials, because that is the number a spreadsheet shows.",
    context:
      "A four-person team building a soil-moisture node for smallholder farms. Runs of 100, 250, 250 and 400 units, all through the same contract assembler, over eleven months.",
    actionSteps: [
      "Stopwatched every assembly step on run three and again on run four, at the bench, rather than reading the assembler's quoted line rate.",
      "Split the unit cost into parts, assembly labour and test, and tracked the three separately across all four runs.",
      "Requoted only the components whose share of the total had grown, which was two of thirty-one.",
      "Redesigned the connector interface so the hand-placement step became a single drop-in.",
    ],
    pitfalls: [
      "The cheapest bill of materials was not the cheapest unit. A regulator that saved 18 cents added a test step worth 41.",
      "Quoted line rates flattered assembly by about a third. The bench numbers and the assembler's numbers disagreed for four runs before anybody checked.",
      "Two months went into component requotes that moved the unit cost by under 2%.",
    ],
    timelineLabel: "11 months, four production runs",
    capitalRaised: null,
    outcomeMetrics: [
      { label: "Units shipped", value: { kind: "count", amount: 1000 } },
      {
        label: "Cost per unit, run 4",
        value: { kind: "money", amountInCents: 512, currency: UNITED_STATES_DOLLAR },
      },
      { label: "Cost reduction, runs 1-4", value: { kind: "percentage", basisPoints: 4380 } },
      {
        label: "Assembly time in hand placement",
        value: { kind: "percentage", basisPoints: 3800 },
      },
    ],
    sources: [
      {
        label: "Run-by-run cost breakdown",
        publisherLabel: "Verdant Sensing build log",
        url: "https://example.com/qatoto/sensor-node-cost-runs",
      },
      {
        label: "Bench timings, runs three and four",
        publisherLabel: "Verdant Sensing build log",
        url: "https://example.com/qatoto/sensor-node-bench-timings",
      },
    ],
    relatedLessonSlugs: ["keep-forty-percent-for-batch-two", "budget-for-the-second-mould"],
  },
  {
    id: "bp-028",
    slug: "keep-forty-percent-for-batch-two",
    title: "Keep 40% of the raise for batch two.",
    category: "case_study",
    moderationState: "published",
    summary:
      "A cookware brand put its whole seed round into one production run, sold it out in nine weeks, and then could not pay for the second run until the first had collected.",
    author: {
      displayName: "Priya Raghunathan",
      handle: "priya-builds",
      avatarUrl: "/dummy/profile_image_03.avif",
    },
    viewCount: 38210,
    likeCount: 3902,
    tags: ["unit-economics", "working-capital", "consumer"],
    createdAt: "2026-09-02T09:40:00.000Z",
    discipline: "unit_economics",
    oneLineAction: "Size batch one so the raise still covers batch two at the same unit cost.",
    authorRelationship: "public_sources",
    outcomeSummary: "Recovered on batch three, nine months later than planned",
    sector: "Consumer hardware",
    evidenceCompanies: [
      { name: "Anvil & Ash Cookware", locationLabel: "Chennai", yearLabel: "2023" },
    ],
    problem:
      "Selling out is indistinguishable from succeeding right up to the moment you try to reorder. The money from batch one was in transit, in returns reserve and in retailer terms, and none of it was available to pay a foundry deposit.",
    context:
      "Two founders, one product, a cast iron pan made by a foundry outside Coimbatore. Raised ₹1 crore, spent ₹94 lakh of it on the first run and the tooling that run needed.",
    actionSteps: [
      "Rebuilt the plan around a cash conversion cycle rather than a margin, counting the days between paying the foundry and collecting from the retailer.",
      "Cut batch two to a third of batch one so it fit inside collected revenue.",
      "Moved two retailers from 90-day terms to 45 by giving up four points of margin.",
      "Held the remainder of the raise against the batch three deposit rather than spending it on the shortfall.",
    ],
    pitfalls: [
      "Tooling was counted as a one-off and then needed a repair before batch two, which nobody had reserved for.",
      "Selling out was read as demand proof and used to justify a larger batch two, which the cash could not have covered either way.",
      "The returns reserve was not modelled at all in the first plan.",
    ],
    timelineLabel: "18 months, three production runs",
    capitalRaised: { amountInCents: 1000000000, currency: INDIAN_RUPEE },
    outcomeMetrics: [
      { label: "Batch one sell-through", value: { kind: "percentage", basisPoints: 10000 } },
      { label: "Weeks to sell out", value: { kind: "count", amount: 9 } },
      { label: "Cash conversion cycle, batch one", value: { kind: "count", amount: 127 } },
      { label: "Cash conversion cycle, batch three", value: { kind: "count", amount: 61 } },
    ],
    sources: [
      {
        label: "Batch-one cash timeline",
        publisherLabel: "Anvil & Ash founder write-up",
        url: "https://example.com/qatoto/anvil-ash-cash-timeline",
      },
    ],
    relatedLessonSlugs: ["find-the-step-that-stopped-scaling", "one-city-until-reorders-hold"],
  },
  {
    id: "bp-011",
    slug: "budget-for-the-second-mould",
    title: "Budget for a second mould, not a perfect first one.",
    category: "case_study",
    moderationState: "published",
    summary:
      "An injection-moulding programme in Nairobi spent four months and two revisions trying to get one tool right, and shipped six weeks after switching to a cheap tool it expected to replace.",
    author: {
      displayName: "Wanjiru Kamau",
      handle: "wanjiru-tooling",
      avatarUrl: "/dummy/profile_image_05.avif",
    },
    viewCount: 29870,
    likeCount: 2611,
    tags: ["tooling", "injection-molding", "manufacturing"],
    createdAt: "2026-08-29T14:05:00.000Z",
    discipline: "tooling",
    oneLineAction:
      "Price the first tool as a prototype you will throw away, and hold the difference for the replacement.",
    authorRelationship: "first_hand",
    outcomeSummary: "Shipped on the second tool, four months late",
    sector: "Consumer hardware",
    evidenceCompanies: [{ name: "Rafiki Housewares", locationLabel: "Nairobi", yearLabel: "2023" }],
    problem:
      "The team specified a hardened steel tool for a part whose geometry was still moving. Every design change became a tool change, and a tool change on hardened steel is a welding job.",
    context:
      "A five-person team making a water filter housing. First tool quoted at 8,400 USD with a six-week lead time; two revisions took it past four months.",
    actionSteps: [
      "Cut a soft aluminium tool for the same part at roughly a fifth of the cost and a third of the lead time.",
      "Ran 400 shots off the aluminium tool and froze the geometry against real parts rather than drawings.",
      "Ordered the steel tool only after two consecutive runs needed no change.",
      "Kept the aluminium tool as the backup for short colour runs instead of scrapping it.",
    ],
    pitfalls: [
      "Two of the three geometry changes came from assembly, not from the moulded part, and would not have been caught by more CAD review.",
      "The steel tool's quoted lead time did not include the tryout loop, which added three weeks each time.",
      "Nobody costed the idle line while the tool was away being modified.",
    ],
    timelineLabel: "9 months from first tool order to shipping",
    capitalRaised: null,
    outcomeMetrics: [
      {
        label: "First tool cost",
        value: { kind: "money", amountInCents: 840000, currency: UNITED_STATES_DOLLAR },
      },
      {
        label: "Aluminium tool cost",
        value: { kind: "money", amountInCents: 168000, currency: UNITED_STATES_DOLLAR },
      },
      { label: "Shots off the aluminium tool", value: { kind: "count", amount: 400 } },
    ],
    sources: [
      {
        label: "Tooling quotes and revision log",
        publisherLabel: "Rafiki Housewares programme notes",
        url: "https://example.com/qatoto/rafiki-tooling-log",
      },
    ],
    relatedLessonSlugs: ["aluminium-tool-before-steel", "find-the-step-that-stopped-scaling"],
  },
  {
    id: "bp-029",
    slug: "aluminium-tool-before-steel",
    title: "Cut the tool in aluminium before you cut it in steel.",
    category: "case_study",
    moderationState: "published",
    summary:
      "The same argument as the Nairobi programme, run deliberately rather than by accident: a bracket maker planned two tools from the start and used the first to find eleven changes.",
    author: {
      displayName: "Tomas Bergqvist",
      handle: "tomas-moulds",
      avatarUrl: "/dummy/profile_image_09.avif",
    },
    viewCount: 17420,
    likeCount: 1588,
    tags: ["tooling", "injection-molding", "design-for-manufacture"],
    createdAt: "2026-08-24T08:12:00.000Z",
    discipline: "tooling",
    oneLineAction:
      "Plan the bridge tool into the schedule so the first parts are a test rather than a commitment.",
    authorRelationship: "first_hand",
    outcomeSummary: null,
    sector: "Industrial components",
    evidenceCompanies: [
      { name: "Norrfall Bracketworks", locationLabel: "Gothenburg", yearLabel: "2024" },
      // THE ONE WITHHELD NAME IN THE FIXTURES: the mould shop, which the writer worked with and did
      // not name. First-hand and `sources: []`, so no source names it either.
      { name: null, locationLabel: "Gothenburg", yearLabel: "2024" },
    ],
    problem:
      "A cable bracket had eleven mounting variants and no way to know which ones the market wanted before parts existed. Committing to steel meant committing to a variant list.",
    context:
      "A three-person spin-out from a larger bracket manufacturer, working with a local mould shop that had never quoted a bridge tool before.",
    actionSteps: [
      "Wrote the bridge tool into the first quote as a line item rather than treating it as a contingency.",
      "Ran 1,200 parts across the eleven variants and put them in front of four installers.",
      "Dropped six variants on the evidence and cut the steel tool for five.",
      "Reused the bridge tool's runner layout in the steel tool, which the mould shop had not expected to be possible.",
    ],
    pitfalls: [
      "The mould shop initially quoted the bridge tool as a discount on the steel tool, which hid its real cost and made the comparison meaningless.",
      "Aluminium tools flash sooner than the team expected and the last 200 parts needed hand trimming.",
    ],
    timelineLabel: "7 months, two tools",
    capitalRaised: { amountInCents: 4200000, currency: UNITED_STATES_DOLLAR },
    outcomeMetrics: [
      { label: "Variants tooled in steel", value: { kind: "count", amount: 5 } },
      { label: "Variants dropped after the bridge run", value: { kind: "count", amount: 6 } },
      { label: "Parts off the bridge tool", value: { kind: "count", amount: 1200 } },
    ],
    sources: [],
    relatedLessonSlugs: ["budget-for-the-second-mould"],
  },
  {
    id: "bp-020",
    slug: "qualify-the-second-supplier-early",
    title: "Qualify the second supplier before you need one.",
    category: "case_study",
    moderationState: "published",
    summary:
      "A contract assembler went from responsive to unreachable in three weeks. The switch took four months, and three of them were qualification the team could have done a year earlier.",
    author: {
      displayName: "Adaeze Okoro",
      handle: "adaeze-networks",
      avatarUrl: "/dummy/profile_image_12.avif",
    },
    viewCount: 44190,
    likeCount: 4110,
    tags: ["supply-chain", "contract-manufacturing", "risk"],
    createdAt: "2026-08-20T16:30:00.000Z",
    discipline: "supply_chain",
    oneLineAction: "Run one paid pilot batch a year with a supplier you are not using.",
    authorRelationship: "first_hand",
    outcomeSummary: "Switched assemblers with a seven-week gap in shipments",
    sector: "Networking hardware",
    evidenceCompanies: [{ name: "Mesh & Mortar", locationLabel: "Lagos", yearLabel: "2023" }],
    problem:
      "The only assembler who had ever built the product stopped answering. There was no second source, no transferable test fixture, and no documentation that was not in that assembler's head.",
    context:
      "A router for community networks, built in batches of 500. Single-sourced from the start because the first assembler had been generous with a small team.",
    actionSteps: [
      "Rebuilt the test fixture from the schematic rather than asking for the original back.",
      "Wrote the assembly instructions from a filmed build rather than from memory.",
      "Paid a second assembler for a 50-unit pilot before committing a production batch.",
      "Kept the pilot going at 50 units a quarter after the switch, so a third source was never a cold start.",
    ],
    pitfalls: [
      "The test fixture turned out to encode three undocumented calibration constants, found only when the new assembler's yields came back wrong.",
      "The first assembler's quoted price had been below cost for two years, which nobody discovered until they got a market quote.",
      "Qualification was scoped as a purchasing task and took an engineer full-time for six weeks.",
    ],
    timelineLabel: "4 months to switch, 7 weeks with no shipments",
    capitalRaised: null,
    outcomeMetrics: [
      { label: "Weeks without shipments", value: { kind: "count", amount: 7 } },
      {
        label: "Unit cost change after the switch",
        value: { kind: "percentage", basisPoints: 2200 },
      },
      { label: "Pilot units before committing", value: { kind: "count", amount: 50 } },
    ],
    sources: [
      {
        label: "Assembler transition post-mortem",
        publisherLabel: "Mesh & Mortar engineering notes",
        url: "https://example.com/qatoto/mesh-mortar-transition",
      },
    ],
    relatedLessonSlugs: ["order-long-lead-parts-early", "read-the-returns-first"],
  },
  {
    id: "bp-030",
    slug: "order-long-lead-parts-early",
    title: "Order the long-lead part before the design is finished.",
    category: "case_study",
    moderationState: "published",
    summary:
      "A compressor with a 22-week lead time set the whole schedule, and the team discovered that four months after freezing everything else.",
    author: {
      displayName: "Nadia Haddad",
      handle: "nadia-cold",
      avatarUrl: "/dummy/profile_image_02.avif",
    },
    viewCount: 22350,
    likeCount: 1974,
    tags: ["supply-chain", "lead-times", "cold-chain"],
    createdAt: "2026-08-16T10:55:00.000Z",
    discipline: "supply_chain",
    oneLineAction:
      "List every part over 12 weeks lead time in week one and order the top three on a best guess.",
    authorRelationship: "public_sources",
    outcomeSummary: null,
    sector: "Cold chain",
    evidenceCompanies: [{ name: "Sahel Cold Systems", locationLabel: "Tunis", yearLabel: "2024" }],
    problem:
      "Everything else was ready. The compressor was not, and no amount of engineering effort shortened a 22-week queue at a supplier who had never heard of the company.",
    context:
      "A solar cold-storage unit for market traders. Six-person team, first production run of 40 units, working backwards from a harvest season that does not move.",
    actionSteps: [
      "Built a lead-time list before the bill of materials was complete, ordered by weeks rather than by cost.",
      "Placed a deposit on 40 compressors against a specification that was still 80% settled.",
      "Designed the housing around the compressor that was coming rather than the one that was ideal.",
      "Negotiated a partial-cancellation clause instead of trying to delay the order.",
    ],
    pitfalls: [
      "The 22-week figure was the supplier's standard quote and turned out to be 31 weeks for a first-time buyer, which nobody asked about.",
      "Committing early to the compressor forced two housing changes that cost less than the delay would have, but were not free.",
    ],
    timelineLabel: "One harvest season, 40 units",
    capitalRaised: { amountInCents: 18000000, currency: UNITED_STATES_DOLLAR },
    outcomeMetrics: [
      { label: "Quoted lead time, weeks", value: { kind: "count", amount: 22 } },
      { label: "Actual lead time, weeks", value: { kind: "count", amount: 31 } },
      { label: "Units in the first run", value: { kind: "count", amount: 40 } },
    ],
    sources: [
      {
        label: "Lead-time register, first production run",
        publisherLabel: "Sahel Cold Systems",
        url: "https://example.com/qatoto/sahel-lead-time-register",
      },
    ],
    relatedLessonSlugs: ["qualify-the-second-supplier-early"],
  },
  {
    id: "bp-021",
    slug: "read-the-returns-first",
    title: "Read the returns before you read the reviews.",
    category: "case_study",
    moderationState: "published",
    summary:
      "A chiller manufacturer had four-star reviews and an 11% return rate. The reviews described the product; the returns described one gasket.",
    author: {
      displayName: "Ines Duarte",
      handle: "ines-quality",
      avatarUrl: "/dummy/profile_image_08.avif",
    },
    viewCount: 33640,
    likeCount: 3055,
    tags: ["quality", "warranty", "returns"],
    createdAt: "2026-08-12T13:20:00.000Z",
    discipline: "quality",
    oneLineAction: "Open ten returned units before you commission any customer research.",
    authorRelationship: "public_sources",
    outcomeSummary: "Return rate fell to 3% within two quarters",
    sector: "Appliances",
    evidenceCompanies: [{ name: "Brightwell Chillers", locationLabel: "Porto", yearLabel: "2024" }],
    problem:
      "Reviews were good and returns were expensive, and the two data sets disagreed. Review text talked about noise and looks; nobody who returned a unit wrote a review at all.",
    context:
      "A beverage chiller sold through two retailers. Roughly 2,800 units a year, warranty handled by the retailer and reimbursed monthly, which is why the failures were invisible for three quarters.",
    actionSteps: [
      "Asked the retailer for ten physical returns rather than the return reason codes.",
      "Opened all ten and found the same door gasket deformed on seven.",
      "Traced the gasket to a supplier change made eight months earlier for a 40-cent saving.",
      "Reverted the gasket and added an incoming compression check that takes eleven seconds a unit.",
    ],
    pitfalls: [
      "Return reason codes said customer changed mind on five of the seven gasket failures, because that is the fastest box for a retailer to tick.",
      "The warranty cost was reimbursed as a lump sum and never allocated per unit, so the finance view showed a line item rather than a defect.",
      "The 40-cent saving had been reported as a win and was still in the cost model.",
    ],
    timelineLabel: "3 quarters before the defect was found, 2 to clear it",
    capitalRaised: null,
    outcomeMetrics: [
      { label: "Return rate before", value: { kind: "percentage", basisPoints: 1100 } },
      { label: "Return rate after", value: { kind: "percentage", basisPoints: 300 } },
      {
        label: "Warranty cost per unit, before",
        value: { kind: "money", amountInCents: 1840, currency: UNITED_STATES_DOLLAR },
      },
      { label: "Units a year", value: { kind: "count", amount: 2800 } },
    ],
    sources: [
      {
        label: "Return teardown notes, ten units",
        publisherLabel: "Brightwell Chillers quality log",
        url: "https://example.com/qatoto/brightwell-return-teardowns",
      },
      {
        label: "Gasket supplier change record",
        publisherLabel: "Brightwell Chillers quality log",
        url: "https://example.com/qatoto/brightwell-gasket-change",
      },
    ],
    relatedLessonSlugs: ["test-the-failure-you-fear", "qualify-the-second-supplier-early"],
  },
  {
    id: "bp-031",
    slug: "test-the-failure-you-fear",
    title: "Test the failure you are afraid of, not the one that is easy to test.",
    category: "case_study",
    moderationState: "published",
    summary:
      "Six months of drop testing on a battery pack that had never failed by being dropped. It failed by being charged in a hot van, which nobody had a rig for.",
    author: {
      displayName: "Samuel Adeyemi",
      handle: "samuel-packs",
      avatarUrl: "/dummy/profile_image_06.avif",
    },
    viewCount: 26180,
    likeCount: 2440,
    tags: ["quality", "testing", "batteries"],
    createdAt: "2026-08-08T07:45:00.000Z",
    discipline: "quality",
    oneLineAction:
      "Write down the failure that would end the company, then build the rig for that one first.",
    authorRelationship: "first_hand",
    outcomeSummary: "Two field failures, no injuries, product withdrawn for five weeks",
    sector: "Energy storage",
    evidenceCompanies: [{ name: "Kestrel Power Packs", locationLabel: "Accra", yearLabel: "2023" }],
    problem:
      "The test plan was inherited from a consumer electronics template. It was thorough about drops and vibration and silent about charging at 48 °C, which is the ordinary condition for a pack that lives in a delivery van.",
    context:
      "A swappable battery pack for delivery motorcycles. Eight-person team, 600 packs in the field, charging infrastructure owned by the customer.",
    actionSteps: [
      "Listed the three failures that would end the company and ranked the test plan against that list rather than against a standard.",
      "Built a thermal chamber from a chest freezer and a heat gun for under 400 USD.",
      "Reproduced the field failure in nine days once the rig existed.",
      "Added an ambient cutoff in firmware and shipped it to the fleet before restarting sales.",
    ],
    pitfalls: [
      "The inherited test plan was comprehensive enough to feel like diligence, which delayed the question of whether it tested the right thing.",
      "The first two field reports were logged as user error because the failure was not in the test matrix.",
      "Nobody owned the test plan; it had been written by a contractor who had left.",
    ],
    timelineLabel: "6 months testing, 9 days to reproduce once the rig existed",
    capitalRaised: { amountInCents: 95000000, currency: UNITED_STATES_DOLLAR },
    outcomeMetrics: [
      { label: "Packs in the field at the time", value: { kind: "count", amount: 600 } },
      { label: "Field failures", value: { kind: "count", amount: 2 } },
      { label: "Weeks withdrawn from sale", value: { kind: "count", amount: 5 } },
      {
        label: "Cost of the thermal rig",
        value: { kind: "money", amountInCents: 39500, currency: UNITED_STATES_DOLLAR },
      },
    ],
    sources: [
      {
        label: "Field failure report and firmware fix",
        publisherLabel: "Kestrel Power Packs incident log",
        url: "https://example.com/qatoto/kestrel-field-failure",
      },
    ],
    relatedLessonSlugs: ["read-the-returns-first"],
  },
  {
    id: "bp-022",
    slug: "sell-to-the-installer",
    title: "Sell to the installer, not the end user.",
    category: "case_study",
    moderationState: "published",
    summary:
      "A dairy chiller sold badly to farmers and well to the technicians who service them. The product did not change; the person being asked to say yes did.",
    author: {
      displayName: "Kofi Mensah",
      handle: "kofi-routes",
      avatarUrl: "/dummy/profile_image_10.avif",
    },
    viewCount: 41020,
    likeCount: 3688,
    tags: ["distribution", "channel", "cold-chain"],
    createdAt: "2026-08-04T12:00:00.000Z",
    discipline: "distribution",
    oneLineAction:
      "Find the person who already visits your customer monthly and make them the channel.",
    authorRelationship: "public_sources",
    outcomeSummary: "Sales moved from 4 units a month to 31",
    sector: "Agricultural equipment",
    evidenceCompanies: [{ name: "Kumasi Cold Rooms", locationLabel: "Kumasi", yearLabel: "2024" }],
    problem:
      "Farmers would not buy a chiller from a company they had never heard of, and the sales cycle ran to eleven visits. The technicians who maintained their existing equipment were trusted and were visiting anyway.",
    context:
      "A 200-litre milk chiller for smallholder dairy. Direct sales for fourteen months before the channel changed.",
    actionSteps: [
      "Mapped who already had a monthly relationship with the customer, which was the cooperative's service technicians.",
      "Rebuilt the commercial terms so the technician earned on installation and on the service contract, not on the unit margin.",
      "Simplified the install so one technician could do it alone in under two hours.",
      "Published the service manual publicly rather than gating it behind a dealer agreement.",
    ],
    pitfalls: [
      "The first commission structure paid on the sale and produced installs the technicians did not stand behind.",
      "Two cooperatives read the direct sales history as competition with their own technicians and had to be walked back.",
    ],
    timelineLabel: "14 months direct, then 8 months through technicians",
    capitalRaised: { amountInCents: 26000000, currency: UNITED_STATES_DOLLAR },
    outcomeMetrics: [
      { label: "Units a month, direct", value: { kind: "count", amount: 4 } },
      { label: "Units a month, through technicians", value: { kind: "count", amount: 31 } },
      { label: "Visits to close, direct", value: { kind: "count", amount: 11 } },
      { label: "Visits to close, through technicians", value: { kind: "count", amount: 2 } },
    ],
    sources: [
      {
        label: "Channel comparison, 22 months",
        publisherLabel: "Kumasi Cold Rooms sales record",
        url: "https://example.com/qatoto/kumasi-channel-comparison",
      },
    ],
    relatedLessonSlugs: ["one-city-until-reorders-hold"],
  },
  {
    id: "bp-032",
    slug: "one-city-until-reorders-hold",
    title: "Ship to one city until the reorder rate holds.",
    category: "case_study",
    moderationState: "published",
    summary:
      "A packaged foods brand launched in six cities on the strength of one good month, and spent the next year discovering that only one of the six reordered.",
    author: {
      displayName: "Leila Fasih",
      handle: "leila-distribution",
      avatarUrl: "/dummy/profile_image_04.avif",
    },
    viewCount: 19560,
    likeCount: 1702,
    tags: ["distribution", "retail", "consumer"],
    createdAt: "2026-07-30T15:35:00.000Z",
    discipline: "distribution",
    oneLineAction:
      "Hold at one city until the same stores reorder three times without a promotion.",
    authorRelationship: "first_hand",
    outcomeSummary: null,
    sector: "Packaged food",
    evidenceCompanies: [{ name: "Harar Pantry", locationLabel: "Addis Ababa", yearLabel: "2023" }],
    problem:
      "First-order volume looks identical to demand. Six cities of first orders produced a revenue chart that pointed up and a warehouse full of returns nine months later.",
    context:
      "A shelf-stable spice paste sold through independent grocers. Expanded from 40 stores in one city to 260 stores in six within a quarter.",
    actionSteps: [
      "Stopped opening new cities and let the existing shelves run without promotional support.",
      "Tracked reorder rate per store rather than orders per month.",
      "Withdrew from four cities where the reorder rate stayed under 20% after two cycles.",
      "Reinvested the freed working capital in depth in the two cities that held.",
    ],
    pitfalls: [
      "Promotions ran continuously during the expansion, so no month measured unsupported demand.",
      "Returns from the withdrawn cities arrived over five months and were booked against the months they arrived in, which flattered the expansion quarter twice.",
    ],
    timelineLabel: "One quarter expanding, four contracting",
    capitalRaised: { amountInCents: 3800000, currency: UNITED_STATES_DOLLAR },
    outcomeMetrics: [
      { label: "Stores at peak", value: { kind: "count", amount: 260 } },
      { label: "Stores after contraction", value: { kind: "count", amount: 96 } },
      { label: "Reorder rate, retained cities", value: { kind: "percentage", basisPoints: 6400 } },
      { label: "Reorder rate, withdrawn cities", value: { kind: "percentage", basisPoints: 1700 } },
    ],
    sources: [],
    relatedLessonSlugs: ["sell-to-the-installer", "keep-forty-percent-for-batch-two"],
  },
];

/*
 * `MOCK_SHOWCASE_COMMENTS` WAS DELETED HERE, and it is the one fixture in this file with no reader
 * left of any kind.
 *
 * It existed so the discussion thread's LAYOUT could be designed before a comment table existed —
 * including the tombstone row, which the renderer has to keep drawing so replies keep their anchor.
 * `showcase_launch_comment` and `teardown_comment` are real tables now with a real write path, so
 * the thread reads `GET /blueprints/<arm>/:slug/comments` and an invented thread would sit under a
 * real person's build.
 *
 * Everything else in this file is KEPT: it is the seed corpus the backend reads (see the header).
 * The comments were never part of that — `seed-blueprint-teardowns.ts` and
 * `seed-blueprint-case-studies.ts` import `MOCK_BLUEPRINTS` and nothing else.
 */
