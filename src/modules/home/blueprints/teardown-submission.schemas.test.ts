import { describe, expect, it } from "vitest";

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

function buildValidSubmission(): Record<string, unknown> {
  return {
    subjectKind: "existing_physical_product",
    title: "Inside a supermarket cordless drill",
    summary: "Eleven fasteners, two of them hidden under the label, and a gearbox that comes out in one piece.",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Rotel RD-18 cordless drill",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-01-05T12:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-01-06T09:00:00.000Z",
      notes: null,
    },
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
   * BOTH VOCABULARIES ARE ACCEPTED IN `documents[]`, which absorbs a frontend bug rather than
   * translating it: that composer serves both file lists from one schema whose `kind` is the
   * manufacturing-file enum. The publish routes each file by its own label.
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

  it("refuses a survey dated in the future", () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const submission = buildValidSubmission();
    const parsed = TeardownSubmissionSchema.safeParse({
      ...submission,
      provenance: { ...(submission.provenance as object), surveyedAt: nextYear },
    });

    expect(parsed.success).toBe(false);
  });

  /** The read schema's `surveyedAt` is a bare string and accepts `""`; this one must not. */
  it("refuses an empty survey date", () => {
    const submission = buildValidSubmission();
    const parsed = TeardownSubmissionSchema.safeParse({
      ...submission,
      provenance: { ...(submission.provenance as object), surveyedAt: "" },
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
        ...(submission.provenance as object),
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
