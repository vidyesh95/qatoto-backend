import { describe, expect, it } from "vitest";

import {
  MAX_SUBMITTED_ASSEMBLY_PARTS,
  MAX_SUBMITTED_ASSEMBLY_STEPS,
  MAX_SUBMITTED_FASTENERS,
} from "#src/modules/home/blueprints/teardown-assembly.schemas.js";
import {
  TEARDOWN_DOCUMENT_KINDS,
  TEARDOWN_MANUFACTURING_FILE_KINDS,
} from "#src/modules/home/blueprints/teardown-import.schemas.js";
import {
  isTeardownDocumentKind,
  TeardownModerationDecisionSchema,
  TeardownSubmissionSchema,
} from "#src/modules/home/blueprints/teardown-submission.schemas.js";

/**
 * The write gate for `POST /blueprints/teardowns`.
 *
 * WHAT THIS FILE OWNS: what the wizard is allowed to send, and — more to the point — the five ways
 * its payload differs from the seed's document. Each difference exists because the database would
 * otherwise have refused the row inside a transaction, where the refusal names a constraint instead
 * of a field.
 */

/**
 * Returned as its own INFERRED object type rather than read back off `buildValidSubmission()`,
 * whose `Record<string, unknown>` makes `provenance` `unknown` and so unspreadable without a cast.
 */
function buildValidProvenance() {
  return {
    kind: "community_reverse_engineered",
    subjectProductName: "Rotel RD-18 cordless drill",
    unitAcquisition: "retail_purchase",
    surveyMethods: ["empirical_teardown"],
    surveyedAt: "2026-01-05T12:00:00.000Z",
    licence: null,
    authorizationNote: null,
    attestationAcceptedAt: "2026-01-06T09:00:00.000Z",
    notes: null,
  };
}

function buildValidSubmission(): Record<string, unknown> {
  return {
    subjectKind: "existing_physical_product",
    title: "Inside a supermarket cordless drill",
    summary: "Eleven fasteners, two of them hidden under the label, and a gearbox that comes out in one piece.",
    provenance: buildValidProvenance(),
    materials: [],
    parts: [{ label: "Gearbox housing", material: "Glass-filled nylon" }],
    documents: [],
    manufacturingFiles: [],
    walkthroughVideo: null,
    tags: ["power-tools"],
    acceptedAttestationClauseIds: [
      "lawful_acquisition",
      "own_measurement",
      "no_confidential_material",
      "independent_discovery",
    ],
  };
}

function buildMaterial(): Record<string, unknown> {
  return {
    appliesToLabel: "Gearbox housing",
    partId: null,
    designation: "PA66-GF30",
    designationSource: "contributor_freetext",
    materialClass: "polymer",
    process: "injection_molded",
    finish: null,
    elements: [],
  };
}

function buildMaximalPart(index: number): Record<string, unknown> {
  const longest = "x".repeat(120);
  return {
    id: `${longest.slice(0, 110)}-${String(index).padStart(4, "0")}`,
    label: longest,
    parentPartId: null,
    material: longest,
    manufacturingMethod: "cnc_milled",
    explosionDirection: [1.123456789, 2.123456789, 3.123456789],
    explosionDistanceMm: 123.456789,
    layerIndex: 9999,
    stressRating: 0.987654321,
    calloutText: "y".repeat(400),
    nodeName: longest,
  };
}

describe("TeardownSubmissionSchema", () => {
  it("accepts the shape the wizard sends", () => {
    expect(TeardownSubmissionSchema.safeParse(buildValidSubmission()).success).toBe(true);
  });

  it("refuses an unknown key rather than dropping it", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      difficulty: "advanced",
    });

    expect(parsed.success).toBe(false);
  });

  /**
   * ⚠️ THE FRONTEND CURRENTLY SENDS THIS, and the refusal is the point. `teardown_material.id` is a
   * GLOBAL primary key with no default, so the wizard's `"mat-1"` would collide with the second
   * author ever to submit two materials. The server mints them; `.strip()`ing the field instead is
   * what the frontend's own header bans by name.
   */
  it("refuses a client-minted material id", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      materials: [{ ...buildMaterial(), id: "mat-1" }],
    });

    expect(parsed.success).toBe(false);
  });

  /**
   * A submission has no assembly, so `teardown_material_part_fk`'s two hops can never resolve. The
   * refusal names a field; the alternative names a foreign key, halfway through a publish.
   */
  it("refuses a material that names a part", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      materials: [{ ...buildMaterial(), partId: "part-1" }],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a material with no part", () => {
    expect(
      TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        materials: [buildMaterial()],
      }).success,
    ).toBe(true);
  });

  it("refuses a byte size the client chose", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      documents: [
        {
          kind: "schematic",
          title: "Control board schematic",
          url: "https://files.example.com/drill-schematic.pdf",
          byteSize: 1,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  describe("the two arms a submitted file may take", () => {
    const UPLOAD_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    /**
     * ⚠️ THE DEFAULTED DISCRIMINATOR IS WHAT KEEPS v1 DOCUMENTS PARSING. Every submission stored
     * before uploads existed carries no `source` key at all, and `.strict()` refuses unknown keys
     * rather than absent ones — so a document written in March still reads as the pasted arm.
     */
    it("reads a file with no source as a pasted link, which is the v1 shape", () => {
      const parsed = TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        documents: [
          {
            kind: "schematic",
            title: "Control board schematic",
            url: "https://files.example.com/drill-schematic.pdf",
          },
        ],
      });

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.documents[0]?.source).toBe("pasted_link");
    });

    it("accepts an uploaded file naming a staged upload id", () => {
      const parsed = TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        documents: [{ source: "uploaded", kind: "schematic", title: "Schematic", uploadId: UPLOAD_ID }],
      });

      expect(parsed.success).toBe(true);
    });

    /**
     * ⚠️ AN UPLOADED FILE MAY NOT CARRY A URL, and the two arms being `.strict()` is what enforces
     * it. The address of an uploaded file does not exist until a moderator publishes the
     * submission — a client sending one would be asserting a fact it cannot know.
     */
    it("refuses an uploaded file that also carries a url", () => {
      const parsed = TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        documents: [
          {
            source: "uploaded",
            kind: "schematic",
            title: "Schematic",
            uploadId: UPLOAD_ID,
            url: "https://files.example.com/drill-schematic.pdf",
          },
        ],
      });

      expect(parsed.success).toBe(false);
    });

    it("refuses a pasted link that carries an upload id", () => {
      const parsed = TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        documents: [
          {
            source: "pasted_link",
            kind: "schematic",
            title: "Schematic",
            url: "https://files.example.com/drill-schematic.pdf",
            uploadId: UPLOAD_ID,
          },
        ],
      });

      expect(parsed.success).toBe(false);
    });

    it("refuses an upload id that is not a uuid — the server minted it, so it has a shape", () => {
      const parsed = TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        documents: [{ source: "uploaded", kind: "schematic", title: "Schematic", uploadId: "upl_1" }],
      });

      expect(parsed.success).toBe(false);
    });
  });

  /**
   * ⚠️ BOTH SPELLINGS. A browser reads `//host` and the backslash variant as "same scheme,
   * different host", so a leading-slash test alone is an open redirect wearing a same-site test.
   */
  it.each([
    ["//files.evil.test/drill.pdf", "double slash"],
    [`/${String.fromCharCode(92)}files.evil.test/drill.pdf`, "slash backslash"],
  ])("refuses a protocol-relative document link (%s)", (url) => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      documents: [{ kind: "schematic", title: "Schematic", url }],
    });

    expect(parsed.success).toBe(false);
  });

  /**
   * ⚠️ SITE-RELATIVE IS REFUSED ON THE WRITE PATH, though `assetUrlCheck` permits it on the column.
   * That branch exists for values this server minted. Accepting one here would let an author file
   * this API's own responses — `/blueprints/teardowns/x/claim-targets` — as their evidence.
   */
  it("refuses a site-relative document link", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      documents: [{ kind: "schematic", title: "Schematic", url: "/blueprints/teardowns/x/claim-targets" }],
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a document link over 512 characters", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      documents: [
        {
          kind: "schematic",
          title: "Schematic",
          url: `https://files.example.com/${"a".repeat(500)}.pdf`,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  /**
   * BOTH VOCABULARIES ARE ACCEPTED IN `documents[]`. The wizard bug that made this urgent is fixed
   * and no submission carrying the mixed shape was ever stored — what the tolerance guards now is a
   * caller on a cached bundle, which this boundary should file correctly rather than refuse.
   */
  it("accepts either file vocabulary in documents[]", () => {
    for (const kind of ["schematic", "gerber"]) {
      const parsed = TeardownSubmissionSchema.safeParse({
        ...buildValidSubmission(),
        documents: [{ kind, title: "A file", url: "https://files.example.com/file.zip" }],
      });

      expect(parsed.success, `kind ${kind} must be accepted`).toBe(true);
    }
  });

  it("sorts the two vocabularies apart", () => {
    expect(isTeardownDocumentKind("schematic")).toBe(true);
    expect(isTeardownDocumentKind("gerber")).toBe(false);
  });

  /**
   * ⚠️ THE ONE CHANGE THAT WOULD BREAK ROUTING-BY-LABEL SILENTLY.
   *
   * `copySubmissionIntoTeardown` decides which table a file belongs in by asking whether its `kind`
   * is a document kind. That question only has one answer while the two enums share no value — add
   * an overlapping label to either and a file starts landing in whichever table the predicate
   * happens to name first, with nothing failing anywhere to say so.
   *
   * Both lists are read here rather than spot-checked, so a new value in EITHER is covered the day
   * it is added.
   */
  it("keeps the two file vocabularies disjoint", () => {
    // Widened to `string[]` because the two tuples share no member: compared at their literal
    // types, `===` is a TS2367 "no overlap" error rather than the runtime check this test wants.
    const documentKinds: readonly string[] = TEARDOWN_DOCUMENT_KINDS;
    const manufacturingKinds: readonly string[] = TEARDOWN_MANUFACTURING_FILE_KINDS;
    const sharedKinds = documentKinds.filter((documentKind) => manufacturingKinds.includes(documentKind));

    expect(sharedKinds).toEqual([]);
  });

  it("refuses a survey dated in the future", () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const submission = buildValidSubmission();
    const parsed = TeardownSubmissionSchema.safeParse({
      ...submission,
      provenance: { ...buildValidProvenance(), surveyedAt: nextYear },
    });

    expect(parsed.success).toBe(false);
  });

  /** The read schema's `surveyedAt` is a bare string and accepts `""`; this one must not. */
  it("refuses an empty survey date", () => {
    const submission = buildValidSubmission();
    const parsed = TeardownSubmissionSchema.safeParse({
      ...submission,
      provenance: { ...buildValidProvenance(), surveyedAt: "" },
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a submission missing any attestation clause", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      acceptedAttestationClauseIds: ["lawful_acquisition", "own_measurement", "no_confidential_material"],
    });

    expect(parsed.success).toBe(false);
  });

  /** The enum's other label exists so the wizard can name what it refuses; the CHECK is the gate. */
  it("refuses a proposed design", () => {
    const parsed = TeardownSubmissionSchema.safeParse({
      ...buildValidSubmission(),
      subjectKind: "proposed_design",
    });

    expect(parsed.success).toBe(false);
  });

  /**
   * The three-arm permission table, reused whole from the import schema — a reverse-engineered
   * survey records no permission, because there was none to record.
   */
  it("refuses a reverse-engineered survey that carries a licence", () => {
    const submission = buildValidSubmission();
    const parsed = TeardownSubmissionSchema.safeParse({
      ...submission,
      provenance: {
        ...buildValidProvenance(),
        licence: { name: "CERN-OHL-S-2.0", url: "https://licences.example.com/cern-ohl-s" },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    ["parts", 41],
    ["documents", 9],
    ["manufacturingFiles", 9],
    ["materials", 9],
    ["tags", 13],
  ])("caps %s, so the body budget is a number rather than a hope", (field, overCap) => {
    const submission = buildValidSubmission();
    const filler: Record<string, unknown> = {
      parts: { label: "A part", material: "Steel" },
      documents: { kind: "schematic", title: "A file", url: "https://files.example.com/a.pdf" },
      manufacturingFiles: { kind: "gerber", title: "A file", url: "https://files.example.com/a.zip" },
      materials: buildMaterial(),
      tags: "a-tag",
    };

    const parsed = TeardownSubmissionSchema.safeParse({
      ...submission,
      [field]: Array.from({ length: overCap }, () => filler[field]),
    });

    expect(parsed.success, `${field} must be capped`).toBe(false);
  });
});

describe("TeardownModerationDecisionSchema", () => {
  it("accepts a publish with the two editorial fields", () => {
    const parsed = TeardownModerationDecisionSchema.safeParse({
      decision: "published",
      moderatorNote: null,
      thumbnailUrl: "https://images.example.com/drill.webp",
      difficulty: "intermediate",
      desiredSlug: null,
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a rejection with no note", () => {
    const parsed = TeardownModerationDecisionSchema.safeParse({
      decision: "rejected",
      moderatorNote: "",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a publish that omits the thumbnail the column requires", () => {
    const parsed = TeardownModerationDecisionSchema.safeParse({
      decision: "published",
      moderatorNote: null,
      difficulty: "intermediate",
      desiredSlug: null,
    });

    expect(parsed.success).toBe(false);
  });

  /** Derived, not chosen: 2048 put this body at 16,906 bytes against compactBody's 16,384. */
  it("refuses a thumbnail address over 512 characters", () => {
    const parsed = TeardownModerationDecisionSchema.safeParse({
      decision: "published",
      moderatorNote: null,
      thumbnailUrl: `https://images.example.com/${"a".repeat(500)}.webp`,
      difficulty: "intermediate",
      desiredSlug: null,
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a slug that is not kebab-case", () => {
    const parsed = TeardownModerationDecisionSchema.safeParse({
      decision: "published",
      moderatorNote: null,
      thumbnailUrl: "https://images.example.com/drill.webp",
      difficulty: "intermediate",
      desiredSlug: "Inside A Drill",
    });

    expect(parsed.success).toBe(false);
  });
});

/**
 * ⚠️ THE BODY BUDGET, DERIVED HERE BECAUSE THE BUILD GATE CANNOT SEE THIS ROUTE.
 *
 * `json-body-budget.test.ts` asserts that no route's cap is below what its own schema can produce,
 * and it is the reason a cap is "a derived fact rather than a guess". It cannot derive this one:
 * `estimateBodyBytes` does not traverse `ZodEffects`, and `TeardownSubmissionSchema` ends in two
 * `.superRefine` calls — so it reports EIGHT BYTES for the largest body on this surface and passes
 * the route vacuously. That was already true before the assembly arm existed; the arm is what makes
 * it matter, because a 64-part assembly is the first thing on this document that could approach the
 * ceiling.
 *
 * So the worst case is CONSTRUCTED and measured. If a future field pushes it over, this fails with
 * a number rather than a 413 an author cannot act on.
 */
describe("the submission document's worst-case size", () => {
  const LONG_FORM_BODY_BYTES = 128 * 1024;

  it("fits inside longFormBody with a full assembly, its steps and its fasteners", () => {
    const maximal = {
      ...buildValidSubmission(),
      assembly: {
        kind: "composite",
        explosionAxis: [1, 1, 1],
        model: { modelUploadId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
        parts: Array.from({ length: MAX_SUBMITTED_ASSEMBLY_PARTS }, (_unused, index) => buildMaximalPart(index)),
      },
      assemblySteps: Array.from({ length: MAX_SUBMITTED_ASSEMBLY_STEPS }, (_unused, index) => ({
        stepNumber: index + 1,
        title: "t".repeat(120),
        description: "d".repeat(600),
        focusedPartId: null,
      })),
      fasteners: Array.from({ length: MAX_SUBMITTED_FASTENERS }, () => ({
        standardCode: "s".repeat(60),
        sizeLabel: "M3 x 12",
        drive: "torx",
        quantity: 99,
        supplier: null,
      })),
    };

    const serializedBytes = Buffer.byteLength(JSON.stringify(maximal), "utf8");

    expect(
      serializedBytes,
      `a maximal submission is ${String(serializedBytes)}B against a ${String(LONG_FORM_BODY_BYTES)}B cap`,
    ).toBeLessThan(LONG_FORM_BODY_BYTES);
  });

  /**
   * ⚠️ AND UNDER THE COLUMN'S OWN CEILING TOO. `teardown_submission_document_ck` bounds
   * `document_json` at 262,144 CHARACTERS — a second, independent limit, and the one that would
   * refuse the write as a 23514 after the request had already been accepted.
   */
  it("fits inside the stored document CHECK as well", () => {
    const maximal = {
      ...buildValidSubmission(),
      assembly: {
        kind: "composite",
        explosionAxis: [1, 1, 1],
        model: { modelUploadId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
        parts: Array.from({ length: MAX_SUBMITTED_ASSEMBLY_PARTS }, (_unused, index) => buildMaximalPart(index)),
      },
    };

    expect(JSON.stringify(maximal).length).toBeLessThan(262_144);
  });
});
