import { describe, expect, it } from "vitest";

import { CaseStudySubmissionSchema } from "#src/modules/home/blueprints/case-study-submission.schemas.js";

/**
 * The case-study write gate, rule by rule.
 *
 * ⚠️ EVERY CASE HERE MUTATES ONE FIELD OF A DRAFT THAT OTHERWISE PASSES, so a failure names the rule
 * under test rather than the fixture. A suite built from hand-written invalid payloads passes when a
 * rule is deleted and some unrelated rule catches the payload anyway — which is how a gate ends up
 * with rules nobody has watched fire.
 *
 * THE ISSUE PATHS ARE ASSERTED, NOT JUST THE REFUSAL. A 422 keyed to the wrong field is a message
 * the writer never sees beside the input they have to fix, and the composer renders these paths
 * directly.
 */

/** A draft the gate accepts. Every case below changes exactly one thing about it. */
function buildFirstHandSubmission(): Record<string, unknown> {
  return {
    title: "Budget for the second mould before the first one ships",
    oneLineAction: "Put the bridge tool in the schedule before committing to steel.",
    discipline: "tooling",
    sector: "Industrial components",
    outcomeSummary: "Shipped eleven variants off one bridge tool.",
    authorRelationship: "first_hand",
    summary:
      "A cable bracket had eleven mounting variants and no way to know which the market wanted before parts existed.",
    problem: "Committing to steel meant committing to a variant list nobody had tested.",
    context: "A three-person spin-out working with a local mould shop.",
    actionSteps: ["Quoted a bridge tool", "Ran 300 parts", "Cut the variant list to four"],
    pitfalls: ["Assumed the steel quote would hold"],
    evidenceCompanies: [
      {
        name: "Norrfall Bracketworks",
        isNameWithheld: false,
        locationLabel: "Gothenburg",
        yearLabel: "2024",
      },
    ],
    timelineLabel: "14 months, two production runs",
    capitalRaised: { amountInCents: 25_000_000, currency: "USD" },
    outcomeMetrics: [
      { label: "Units shipped", value: { kind: "count", amount: 4200 } },
      { label: "Scrap rate", value: { kind: "percentage", basisPoints: 438 } },
      { label: "Tooling spend", value: { kind: "money", amountInCents: 1_200_000, currency: "USD" } },
    ],
    sources: [],
    relatedLessonSlugs: ["find-the-step-that-stopped-scaling"],
    tags: ["tooling", "injection-molding"],
    acceptedStatementIds: ["was_part_of_it", "figures_from_records"],
  };
}

/** The same draft, written from public sources — which requires a linked source. */
function buildPublicSourcesSubmission(): Record<string, unknown> {
  return {
    ...buildFirstHandSubmission(),
    authorRelationship: "public_sources",
    acceptedStatementIds: ["figures_in_linked_sources", "says_only_what_sources_say"],
    sources: [
      {
        label: "Run-by-run cost breakdown",
        publisherLabel: "Norrfall build log",
        url: "https://example.test/qatoto/run-costs",
      },
    ],
  };
}

/** Every issue path a parse produced, joined, so a case can assert the field it expects. */
function refusalPaths(submission: Record<string, unknown>): readonly string[] {
  const parsed = CaseStudySubmissionSchema.safeParse(submission);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => issue.path.join("."));
}

/**
 * The keys `.strict()` refused, which do NOT arrive as issue paths.
 *
 * An `unrecognized_keys` issue carries an EMPTY path and names the offending keys in its own field —
 * the key is not part of the schema, so there is no path to it. Asserting on the path would make an
 * unknown-key case pass on any refusal at all.
 */
function unrecognizedKeys(submission: Record<string, unknown>): readonly string[] {
  const parsed = CaseStudySubmissionSchema.safeParse(submission);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
}

describe("the drafts that must pass", () => {
  it("accepts a first-hand case study with no sources", () => {
    // The paths come first, so a regression names the rule that refused rather than just "false".
    expect(refusalPaths(buildFirstHandSubmission())).toEqual([]);
  });

  it("accepts a public-sources case study that links one", () => {
    expect(refusalPaths(buildPublicSourcesSubmission())).toEqual([]);
  });

  /** Every list may be empty except `actionSteps`; a lesson with nothing done is not a lesson. */
  it("accepts a draft with every optional list empty", () => {
    const parsed = CaseStudySubmissionSchema.safeParse({
      ...buildFirstHandSubmission(),
      pitfalls: [],
      evidenceCompanies: [],
      outcomeMetrics: [],
      sources: [],
      relatedLessonSlugs: [],
      tags: [],
      outcomeSummary: null,
      timelineLabel: null,
      capitalRaised: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("how the writer knows it", () => {
  it("refuses a first-hand draft missing one of its two statements", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        acceptedStatementIds: ["was_part_of_it"],
      }),
    ).toContain("acceptedStatementIds");
  });

  /** A tick carried over from the other answer is a statement about a different claim. */
  it("refuses a statement belonging to the other relationship", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        acceptedStatementIds: ["was_part_of_it", "figures_from_records", "says_only_what_sources_say"],
      }),
    ).toContain("acceptedStatementIds");
  });

  it("refuses a public-sources draft with no source", () => {
    expect(refusalPaths({ ...buildPublicSourcesSubmission(), sources: [] })).toContain("sources");
  });
});

describe("the withheld company name", () => {
  it("accepts a first-hand draft that withholds one", () => {
    const parsed = CaseStudySubmissionSchema.safeParse({
      ...buildFirstHandSubmission(),
      evidenceCompanies: [
        { name: "Halden Toolroom", isNameWithheld: true, locationLabel: "Bergen", yearLabel: "2024" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  /** A withheld company in a public-sources case study hides one its readers could check. */
  it("refuses a public-sources draft that withholds one, keyed to the company", () => {
    expect(
      refusalPaths({
        ...buildPublicSourcesSubmission(),
        evidenceCompanies: [
          {
            name: "Halden Toolroom",
            isNameWithheld: true,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
        ],
      }),
    ).toContain("evidenceCompanies.0.isNameWithheld");
  });

  /**
   * ⚠️ THE SERVER-ONLY SWEEP. Nulling one column withholds nothing if the writer names the company
   * in the prose — and the frontend has no equivalent rule, so this gate is the only thing between a
   * withheld name and a reader.
   */
  it("refuses a withheld name that appears in the summary", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        summary: "Halden Toolroom had eleven mounting variants and no way to know which the market wanted.",
        evidenceCompanies: [
          {
            name: "Halden Toolroom",
            isNameWithheld: true,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
        ],
      }),
    ).toContain("summary");
  });

  it("refuses a withheld name that appears in a source's publisher label", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: [
          {
            name: "Halden Toolroom",
            isNameWithheld: true,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
        ],
        sources: [
          {
            label: "Run-by-run cost breakdown",
            publisherLabel: "Halden Toolroom quality log",
            url: "https://example.test/qatoto/run-costs",
          },
        ],
      }),
    ).toContain("sources.0.publisherLabel");
  });

  it("refuses a withheld name that appears in a step, a tag or a figure label", () => {
    const withheldCompany = {
      name: "Halden Toolroom",
      isNameWithheld: true,
      locationLabel: "Bergen",
      yearLabel: "2024",
    };
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: [withheldCompany],
        actionSteps: ["Asked Halden Toolroom for a bridge quote"],
      }),
      "a step",
    ).toContain("actionSteps.0");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: [withheldCompany],
        tags: ["halden toolroom"],
      }),
      "a tag",
    ).toContain("tags.0");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: [withheldCompany],
        outcomeMetrics: [{ label: "Halden Toolroom runs", value: { kind: "count", amount: 3 } }],
      }),
      "a figure label",
    ).toContain("outcomeMetrics.0.label");
  });

  /** A named company is public, so it may not carry a different company's withheld name. */
  it("refuses a withheld name that appears inside another company's name", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: [
          {
            name: "Halden Toolroom",
            isNameWithheld: true,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
          {
            name: "Halden Toolroom Fixtures",
            isNameWithheld: false,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
        ],
      }),
    ).toContain("evidenceCompanies.1.name");
  });

  /** The sweep is case-insensitive, or a capitalisation would walk straight through it. */
  it("refuses a withheld name that appears in a different case", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        problem: "HALDEN TOOLROOM had never quoted a bridge tool before.",
        evidenceCompanies: [
          {
            name: "Halden Toolroom",
            isNameWithheld: true,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
        ],
      }),
    ).toContain("problem");
  });

  /** And it must not fire on a company that is NOT withheld, or naming one becomes impossible. */
  it("allows a named company to appear in the prose", () => {
    const parsed = CaseStudySubmissionSchema.safeParse({
      ...buildFirstHandSubmission(),
      summary: "Norrfall Bracketworks had eleven mounting variants and no way to know which the market wanted.",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("the duplicate rules the renderer depends on", () => {
  it("refuses two steps that differ only by case and spacing", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        actionSteps: ["Quoted a bridge tool", "  quoted a bridge tool  "],
      }),
    ).toContain("actionSteps.1");
  });

  it("refuses two pitfalls with the same text", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        pitfalls: ["Assumed the quote would hold", "Assumed the quote would hold"],
      }),
    ).toContain("pitfalls.1");
  });

  it("refuses two companies with the same name", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: [
          { name: "Norrfall", isNameWithheld: false, locationLabel: "Gothenburg", yearLabel: "2024" },
          { name: "norrfall", isNameWithheld: false, locationLabel: "Gothenburg", yearLabel: "2023" },
        ],
      }),
    ).toContain("evidenceCompanies.1.name");
  });

  it("refuses two figures with the same label", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        outcomeMetrics: [
          { label: "Units shipped", value: { kind: "count", amount: 1 } },
          { label: "units shipped", value: { kind: "count", amount: 2 } },
        ],
      }),
    ).toContain("outcomeMetrics.1.label");
  });

  it("refuses the same source linked twice", () => {
    expect(
      refusalPaths({
        ...buildPublicSourcesSubmission(),
        sources: [
          { label: "One", publisherLabel: "Log", url: "https://example.test/a" },
          { label: "Two", publisherLabel: "Log", url: "https://example.test/a" },
        ],
      }),
    ).toContain("sources.1.url");
  });

  it("refuses the same related lesson picked twice", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        relatedLessonSlugs: ["read-the-returns-first", "read-the-returns-first"],
      }),
    ).toContain("relatedLessonSlugs");
  });

  /**
   * ⚠️ THE CROSS-TABLE RULE, which no CHECK can hold. The detail page puts companies and figures in
   * ONE list keyed by label, so a collision drops a row there rather than failing here.
   */
  it("refuses a figure label that equals a company's name", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        outcomeMetrics: [{ label: "Norrfall Bracketworks", value: { kind: "count", amount: 4200 } }],
      }),
    ).toContain("outcomeMetrics.0.label");
  });

  /** Unconditional, unlike the form's version — a figure is never honestly called this. */
  it("refuses a figure labelled as a withheld company", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        outcomeMetrics: [{ label: "Name withheld (2)", value: { kind: "count", amount: 1 } }],
      }),
    ).toContain("outcomeMetrics.0.label");
  });
});

describe("the shapes and the caps", () => {
  it("refuses an unknown key rather than dropping it", () => {
    expect(unrecognizedKeys({ ...buildFirstHandSubmission(), conceptNumber: 12 })).toContain("conceptNumber");
  });

  it("refuses a title shorter than one instruction", () => {
    expect(refusalPaths({ ...buildFirstHandSubmission(), title: "Too short" })).toContain("title");
  });

  it("refuses a thirteenth step and a thirteenth pitfall", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        actionSteps: Array.from({ length: 13 }, (_unused, index) => `Step ${String(index)}`),
      }),
      "thirteen steps",
    ).toContain("actionSteps");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        pitfalls: Array.from({ length: 13 }, (_unused, index) => `Pitfall ${String(index)}`),
      }),
      "thirteen pitfalls",
    ).toContain("pitfalls");
  });

  it("refuses a draft with no steps at all", () => {
    expect(refusalPaths({ ...buildFirstHandSubmission(), actionSteps: [] })).toContain("actionSteps");
  });

  /** A negative raise is not a state. The read shape permits one; a write does not. */
  it("refuses a negative capital raise and an unlisted currency", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        capitalRaised: { amountInCents: -1, currency: "USD" },
      }),
      "a negative amount",
    ).toContain("capitalRaised.amountInCents");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        capitalRaised: { amountInCents: 100, currency: "EUR" },
      }),
      "an unlisted currency",
    ).toContain("capitalRaised.currency");
  });

  /** An amount without a currency is an unanswerable question, so the object is nullable, not its fields. */
  it("refuses a capital raise missing its currency", () => {
    expect(refusalPaths({ ...buildFirstHandSubmission(), capitalRaised: { amountInCents: 100 } })).toContain(
      "capitalRaised.currency",
    );
  });

  it("refuses a fractional count and a fractional basis-point figure", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        outcomeMetrics: [{ label: "Units", value: { kind: "count", amount: 4.5 } }],
      }),
      "a fractional count",
    ).toContain("outcomeMetrics.0.value.amount");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        outcomeMetrics: [{ label: "Scrap", value: { kind: "percentage", basisPoints: 4.38 } }],
      }),
      "a fractional basis point",
    ).toContain("outcomeMetrics.0.value.basisPoints");
  });

  /** A negative percentage IS legal — a figure can go down — which is why only this one is signed. */
  it("accepts a negative basis-point figure", () => {
    const parsed = CaseStudySubmissionSchema.safeParse({
      ...buildFirstHandSubmission(),
      outcomeMetrics: [{ label: "Returns", value: { kind: "percentage", basisPoints: -1200 } }],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a source link that is not https", () => {
    expect(
      refusalPaths({
        ...buildPublicSourcesSubmission(),
        sources: [{ label: "One", publisherLabel: "Log", url: "http://example.test/a" }],
      }),
    ).toContain("sources.0.url");
  });

  it("refuses a related lesson slug that is not kebab-case", () => {
    expect(refusalPaths({ ...buildFirstHandSubmission(), relatedLessonSlugs: ["Not_A_Slug"] })).toContain(
      "relatedLessonSlugs.0",
    );
  });

  it("refuses a fourth related lesson and an eleventh tag", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        relatedLessonSlugs: ["one-a", "two-b", "three-c", "four-d"],
      }),
      "four related lessons",
    ).toContain("relatedLessonSlugs");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        tags: Array.from({ length: 11 }, (_unused, index) => `tag-${String(index)}`),
      }),
      "eleven tags",
    ).toContain("tags");
  });

  it("refuses a sixth company and a ninth figure", () => {
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        evidenceCompanies: Array.from({ length: 6 }, (_unused, index) => ({
          name: `Company ${String(index)}`,
          isNameWithheld: false,
          locationLabel: "Gothenburg",
          yearLabel: "2024",
        })),
      }),
      "six companies",
    ).toContain("evidenceCompanies");
    expect(
      refusalPaths({
        ...buildFirstHandSubmission(),
        outcomeMetrics: Array.from({ length: 9 }, (_unused, index) => ({
          label: `Figure ${String(index)}`,
          value: { kind: "count", amount: index },
        })),
      }),
      "nine figures",
    ).toContain("outcomeMetrics");
  });

  it("refuses an eleventh source", () => {
    expect(
      refusalPaths({
        ...buildPublicSourcesSubmission(),
        sources: Array.from({ length: 11 }, (_unused, index) => ({
          label: `Source ${String(index)}`,
          publisherLabel: "Log",
          url: `https://example.test/a/${String(index)}`,
        })),
      }),
    ).toContain("sources");
  });
});
