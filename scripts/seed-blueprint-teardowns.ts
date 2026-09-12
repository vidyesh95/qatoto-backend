import path from "node:path";
import { pathToFileURL } from "node:url";

import "dotenv/config";
import { eq } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
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
  teardownStats,
} from "#src/db/schema.js";
import {
  TeardownImportSchema,
  type TeardownImport,
} from "#src/modules/home/blueprints/teardown-import.schemas.js";

/**
 * Seeds the twelve teardowns the frontend has been serving from fixtures.
 *
 * WHY A SEED AT ALL, when the showcase round refused one. A launch is written by a maker through a
 * real route, so showcase data existed the moment the reads did. A teardown has no authoring path
 * yet — so without this, building the read surface would take a page that shows twelve teardowns
 * down to an empty state, which is a worse answer than the fixtures were.
 *
 * ⚠️ THE FIXTURE MODULE IS LOADED AT RUNTIME, NOT IMPORTED. A static import would pull a file from
 * the sibling repository into this one's TypeScript program, and TypeScript resolves even type-only
 * imports at compile time — so `@/lib/blueprints/schemas` inside it becomes TS2307 and
 * `tsc --noEmit -p tsconfig.scripts.json` goes red. Adding an `@/*` paths entry here would make the
 * backend's typecheck depend on the frontend being checked out next door. A dynamic import of a
 * `file://` URL is invisible to the compiler, and it lands the payload as `unknown`, which is where
 * CLAUDE.md §3.1 wants it anyway.
 *
 * ⚠️ EVERY ROW IS PARSED BEFORE ANY ROW IS WRITTEN. `TeardownImportSchema` is this surface's only
 * write gate — there is no controller to defer to — and it carries the five rules no CHECK can
 * express. A seed that could write what the API would refuse is a seed with its own, laxer rules.
 *
 * IDEMPOTENT BY DELETE-AND-REPLACE, keyed on the slug. Twelve rows carry about ninety children
 * across eight tables, and reconciling positional children on a conflict would be more code and
 * more fragile than replacing a teardown outright. The job is "make the database match the fixture
 * file", not "merge with it". Every child cascades from the teardown row, so one DELETE clears the
 * tree.
 *
 * The fixture ids (`bp-001`, `doc-004`, `part-003`) are STORED but never used as the key: the
 * contract puts them on the wire, and the rights-claim picker mints its radio values from them, but
 * they are fixture identity rather than database identity. The slug is the only value with a
 * uniqueness constraint and a URL behind it.
 */

const DEFAULT_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../frontend/qatoto-frontend/src/mocks/blueprints-mocks.ts",
);

/** A fixture instant is an ISO string; the columns are `timestamp(3)`. */
function toInstant(isoInstant: string): Date {
  return new Date(isoInstant);
}

async function loadTeardownFixtures(): Promise<readonly TeardownImport[]> {
  // The two repositories are siblings by convention, not by guarantee — so the path is overridable.
  const fixturePath =
    process.argv[2] ?? process.env.QATOTO_FRONTEND_MOCKS_PATH ?? DEFAULT_FIXTURE_PATH;
  const fixtureModule: unknown = await import(pathToFileURL(fixturePath).href);

  if (
    typeof fixtureModule !== "object" ||
    fixtureModule === null ||
    !("MOCK_BLUEPRINTS" in fixtureModule)
  ) {
    throw new Error(`No MOCK_BLUEPRINTS export in ${fixturePath}`);
  }
  const blueprints: unknown = fixtureModule.MOCK_BLUEPRINTS;
  if (!Array.isArray(blueprints)) throw new Error("MOCK_BLUEPRINTS is not an array.");

  const teardownFixtures: TeardownImport[] = [];
  const failures: string[] = [];

  for (const blueprint of blueprints) {
    if (
      typeof blueprint !== "object" ||
      blueprint === null ||
      !("category" in blueprint) ||
      blueprint.category !== "teardown"
    ) {
      continue;
    }

    const parsed = TeardownImportSchema.safeParse(blueprint);
    if (parsed.success) {
      teardownFixtures.push(parsed.data);
      continue;
    }
    const slug = "slug" in blueprint ? String(blueprint.slug) : "(no slug)";
    for (const issue of parsed.error.issues) {
      failures.push(`  ${slug} · ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Fixtures rejected before any write:\n${failures.join("\n")}`);
  }
  return teardownFixtures;
}

/** Writes one teardown and its whole tree. The caller supplies the transaction. */
async function writeTeardown(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  fixture: TeardownImport,
): Promise<void> {
  // Replace rather than merge. Children cascade, so this clears the tree in one statement.
  await transaction.delete(teardown).where(eq(teardown.slug, fixture.slug));

  const [insertedTeardown] = await transaction
    .insert(teardown)
    .values({
      slug: fixture.slug,
      title: fixture.title,
      summary: fixture.summary,
      thumbnailUrl: fixture.thumbnailUrl,
      authorDisplayName: fixture.author.displayName,
      authorHandle: fixture.author.handle,
      authorAvatarUrl: fixture.author.avatarUrl,
      difficulty: fixture.difficulty,
      cadFormat: fixture.cadFormat,
      tags: [...fixture.tags],
      partCount: fixture.partCount,
      subjectKind: fixture.subjectKind,
      moderationState: fixture.moderationState,
      billOfMaterialsMinimumCents: fixture.billOfMaterialsCostRange?.minimumInCents ?? null,
      billOfMaterialsMaximumCents: fixture.billOfMaterialsCostRange?.maximumInCents ?? null,
      billOfMaterialsCurrency: fixture.billOfMaterialsCostRange?.currency ?? null,
      provenanceKind: fixture.provenance.kind,
      provenanceSubjectProductName: fixture.provenance.subjectProductName,
      provenanceUnitAcquisition: fixture.provenance.unitAcquisition,
      provenanceSurveyMethods: [...fixture.provenance.surveyMethods],
      provenanceSurveyedAt: toInstant(fixture.provenance.surveyedAt),
      provenanceLicenceName: fixture.provenance.licence?.name ?? null,
      provenanceLicenceUrl: fixture.provenance.licence?.url ?? null,
      provenanceAuthorizationNote: fixture.provenance.authorizationNote,
      provenanceAttestationAcceptedAt: toInstant(fixture.provenance.attestationAcceptedAt),
      provenanceNotes: fixture.provenance.notes,
      repairabilityFastenerUniformityScore:
        fixture.repairabilityIndex?.fastenerUniformity.scoreOutOfTen ?? null,
      repairabilityFastenerUniformityNote:
        fixture.repairabilityIndex?.fastenerUniformity.note ?? null,
      repairabilityToolAccessibilityScore:
        fixture.repairabilityIndex?.toolAccessibility.scoreOutOfTen ?? null,
      repairabilityToolAccessibilityNote:
        fixture.repairabilityIndex?.toolAccessibility.note ?? null,
      repairabilityDisassemblyStepCountScore:
        fixture.repairabilityIndex?.disassemblyStepCount.scoreOutOfTen ?? null,
      repairabilityDisassemblyStepCountNote:
        fixture.repairabilityIndex?.disassemblyStepCount.note ?? null,
      repairabilityModularIndependenceScore:
        fixture.repairabilityIndex?.modularIndependence.scoreOutOfTen ?? null,
      repairabilityModularIndependenceNote:
        fixture.repairabilityIndex?.modularIndependence.note ?? null,
      repairabilityOverallScore: fixture.repairabilityIndex?.overallScoreOutOfTen ?? null,
      telemetryFactorOfSafety: fixture.simulationTelemetry?.factorOfSafety ?? null,
      telemetryPeakVonMisesStressMegapascals:
        fixture.simulationTelemetry?.peakVonMisesStressMegapascals ?? null,
      telemetryMaxDisplacementMicrometres:
        fixture.simulationTelemetry?.maxDisplacementMicrometres ?? null,
      telemetryThermalDeltaKelvin: fixture.simulationTelemetry?.thermalDeltaKelvin ?? null,
      telemetryRatedLoadNewtons: fixture.simulationTelemetry?.ratedLoadNewtons ?? null,
      telemetrySource: fixture.simulationTelemetry?.source ?? null,
      storeProductClassCategorySlug: fixture.storeProductClass?.categorySlug ?? null,
      storeProductClassLabel: fixture.storeProductClass?.label ?? null,
      walkthroughVideoSource: fixture.walkthroughVideo?.source ?? null,
      walkthroughYoutubeVideoId: fixture.walkthroughVideo?.youtubeVideoId ?? null,
      walkthroughPosterUrl: fixture.walkthroughVideo?.posterUrl ?? null,
      walkthroughDurationSeconds: fixture.walkthroughVideo?.durationSeconds ?? null,
      createdAt: toInstant(fixture.createdAt),
    })
    .returning({ id: teardown.id });

  if (!insertedTeardown) throw new Error(`${fixture.slug}: insert returned no row`);
  const teardownId = insertedTeardown.id;

  /*
   * A ROW PER TEARDOWN, unlike the showcase sidecar which writes none. These counters are figures
   * the fixture states, so `coalesce` on the read is defence here rather than the mechanism.
   */
  await transaction.insert(teardownStats).values({
    teardownId,
    viewCount: fixture.viewCount,
    likeCount: fixture.likeCount,
    commentCount: fixture.commentCount,
    saveCount: fixture.saveCount,
  });

  if (fixture.documents.length > 0) {
    await transaction.insert(teardownDocument).values(
      fixture.documents.map((document, position) => ({
        id: document.id,
        teardownId,
        position,
        kind: document.kind,
        title: document.title,
        url: document.url,
        byteSize: document.byteSize,
        pageCount: document.pageCount,
      })),
    );
  }

  if (fixture.manufacturingFiles.length > 0) {
    await transaction.insert(teardownManufacturingFile).values(
      fixture.manufacturingFiles.map((manufacturingFile, position) => ({
        id: manufacturingFile.id,
        teardownId,
        position,
        kind: manufacturingFile.kind,
        title: manufacturingFile.title,
        url: manufacturingFile.url,
        byteSize: manufacturingFile.byteSize,
      })),
    );
  }

  if (fixture.fasteners.length > 0) {
    await transaction.insert(teardownFastener).values(
      fixture.fasteners.map((fastener, position) => ({
        teardownId,
        position,
        standardCode: fastener.standardCode,
        sizeLabel: fastener.sizeLabel,
        drive: fastener.drive,
        quantity: fastener.quantity,
        supplierLabel: fastener.supplier?.label ?? null,
        supplierUrl: fastener.supplier?.url ?? null,
      })),
    );
  }

  // The assembly and its parts go in before anything that references a part.
  let assemblyId: string | null = null;
  if (fixture.assembly !== null) {
    const [insertedAssembly] = await transaction
      .insert(teardownAssembly)
      .values({
        teardownId,
        kind: fixture.assembly.kind,
        explosionAxisX: fixture.assembly.explosionAxis?.[0] ?? null,
        explosionAxisY: fixture.assembly.explosionAxis?.[1] ?? null,
        explosionAxisZ: fixture.assembly.explosionAxis?.[2] ?? null,
        modelUrl: fixture.assembly.kind === "composite" ? fixture.assembly.model.url : null,
        modelByteSize:
          fixture.assembly.kind === "composite" ? fixture.assembly.model.byteSize : null,
      })
      .returning({ id: teardownAssembly.id });
    if (!insertedAssembly) throw new Error(`${fixture.slug}: assembly insert returned no row`);
    assemblyId = insertedAssembly.id;

    /*
     * PARENTS BEFORE CHILDREN. The composite self-foreign-key is checked per statement, so a child
     * inserted ahead of its parent is a 23503 — sorting by depth is what makes one bulk insert
     * legal. The import schema has already proved the tree is acyclic, so this terminates.
     */
    const parentByPartId = new Map(
      fixture.assembly.parts.map((part) => [part.id, part.parentPartId]),
    );
    function depthOf(partId: string): number {
      let depth = 0;
      let ancestorId = parentByPartId.get(partId) ?? null;
      while (ancestorId !== null) {
        depth += 1;
        ancestorId = parentByPartId.get(ancestorId) ?? null;
      }
      return depth;
    }

    const orderedParts = fixture.assembly.parts
      .map((part, position) => ({ part, position }))
      .toSorted(
        (left, right) =>
          depthOf(left.part.id) - depthOf(right.part.id) || left.position - right.position,
      );

    const assemblyKind = fixture.assembly.kind;
    for (const { part, position } of orderedParts) {
      const isIndividual = "model" in part;
      await transaction.insert(teardownPart).values({
        id: part.id,
        assemblyId,
        assemblyKind,
        parentPartId: part.parentPartId,
        position,
        label: part.label,
        material: part.material,
        manufacturingMethod: part.manufacturingMethod,
        explosionDirectionX: part.explosionDirection?.[0] ?? null,
        explosionDirectionY: part.explosionDirection?.[1] ?? null,
        explosionDirectionZ: part.explosionDirection?.[2] ?? null,
        explosionDistanceMm: part.explosionDistanceMm,
        layerIndex: part.layerIndex,
        stressRating: part.stressRating,
        calloutText: part.calloutText,
        nodeName: isIndividual ? null : part.nodeName,
        modelUrl: isIndividual ? part.model.url : null,
        modelByteSize: isIndividual ? part.model.byteSize : null,
        placementPositionX: isIndividual ? (part.placement?.positionMm[0] ?? null) : null,
        placementPositionY: isIndividual ? (part.placement?.positionMm[1] ?? null) : null,
        placementPositionZ: isIndividual ? (part.placement?.positionMm[2] ?? null) : null,
        placementRotationX: isIndividual ? (part.placement?.rotationDegrees[0] ?? null) : null,
        placementRotationY: isIndividual ? (part.placement?.rotationDegrees[1] ?? null) : null,
        placementRotationZ: isIndividual ? (part.placement?.rotationDegrees[2] ?? null) : null,
      });
    }
  }

  if (fixture.assemblySteps.length > 0) {
    await transaction.insert(teardownAssemblyStep).values(
      fixture.assemblySteps.map((step) => ({
        teardownId,
        stepNumber: step.stepNumber,
        title: step.title,
        description: step.description,
        // Both columns travel together — the CHECK says so, and the composite FK needs the pair.
        assemblyId: step.focusedPartId === null ? null : assemblyId,
        focusedPartId: step.focusedPartId,
      })),
    );
  }

  for (const [position, material] of fixture.materials.entries()) {
    await transaction.insert(teardownMaterial).values({
      id: material.id,
      teardownId,
      position,
      appliesToLabel: material.appliesToLabel,
      designation: material.designation,
      designationSource: material.designationSource,
      materialClass: material.materialClass,
      process: material.process,
      finish: material.finish,
      assemblyId: material.partId === null ? null : assemblyId,
      partId: material.partId,
    });

    if (material.elements.length > 0) {
      await transaction.insert(teardownMaterialElement).values(
        material.elements.map((element, elementPosition) => ({
          materialId: material.id,
          position: elementPosition,
          symbol: element.symbol,
          minimumPercent: element.weightPercentRange?.minimumPercent ?? null,
          maximumPercent: element.weightPercentRange?.maximumPercent ?? null,
          analysisMethod: element.analysisMethod,
          instrumentLabel: element.instrumentLabel,
          operatorNote: element.operatorNote,
        })),
      );
    }
  }
}

async function main(): Promise<void> {
  const fixtures = await loadTeardownFixtures();
  console.log(`Parsed ${String(fixtures.length)} teardown fixtures. Writing.`);

  // ONE TRANSACTION for all twelve: a half-seeded surface is worse than an unseeded one.
  await db.transaction(async (transaction) => {
    for (const fixture of fixtures) {
      await writeTeardown(transaction, fixture);
    }
  });

  const childCounts = fixtures.reduce(
    (totals, fixture) => ({
      documents: totals.documents + fixture.documents.length,
      manufacturingFiles: totals.manufacturingFiles + fixture.manufacturingFiles.length,
      fasteners: totals.fasteners + fixture.fasteners.length,
      assemblySteps: totals.assemblySteps + fixture.assemblySteps.length,
      materials: totals.materials + fixture.materials.length,
      elements:
        totals.elements +
        fixture.materials.reduce((count, material) => count + material.elements.length, 0),
      assemblies: totals.assemblies + (fixture.assembly === null ? 0 : 1),
      parts: totals.parts + (fixture.assembly?.parts.length ?? 0),
    }),
    {
      documents: 0,
      manufacturingFiles: 0,
      fasteners: 0,
      assemblySteps: 0,
      materials: 0,
      elements: 0,
      assemblies: 0,
      parts: 0,
    },
  );

  console.log("Seeded:");
  console.log(`  teardown                     ${String(fixtures.length)}`);
  console.log(`  teardown_stats               ${String(fixtures.length)}`);
  console.log(`  teardown_assembly            ${String(childCounts.assemblies)}`);
  console.log(`  teardown_part                ${String(childCounts.parts)}`);
  console.log(`  teardown_document            ${String(childCounts.documents)}`);
  console.log(`  teardown_manufacturing_file  ${String(childCounts.manufacturingFiles)}`);
  console.log(`  teardown_fastener            ${String(childCounts.fasteners)}`);
  console.log(`  teardown_assembly_step       ${String(childCounts.assemblySteps)}`);
  console.log(`  teardown_material            ${String(childCounts.materials)}`);
  console.log(`  teardown_material_element    ${String(childCounts.elements)}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Teardown seed failed:", error);
    await pool.end();
    process.exit(1);
  });
