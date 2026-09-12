import { describe, expect, it } from "vitest";

import {
  MAX_SHOWCASE_WRITE_UP_IMAGES,
  MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS,
  ModerateShowcaseLaunchSchema,
  SHOWCASE_DRAFT_PART_MAXIMUM_BYTES,
  SHOWCASE_LAUNCH_STATEMENT_IDS,
  SHOWCASE_MODERATOR_NOTE_MAXIMUM_CHARACTERS,
  ShowcaseLaunchDraftSchema,
  ShowcaseReviewQueueQuerySchema,
  SubmitShowcaseLaunchMultipartSchema,
} from "#src/modules/home/blueprints/showcase-launch.schemas.js";

/**
 * UNIT tests for the showcase launch request schemas — the boundary the frontend's authoring form
 * mirrors and this file actually enforces (CLAUDE.md §1.1: the form tells a maker early, the server
 * refuses).
 *
 * NO MOCKS. The only runtime import is `blueprintDifficultyEnum` from `#src/db/schema.js`, which is
 * a table definition and never reaches `#src/db/index.js` or `config`, so nothing needs stubbing.
 *
 * The `.strict()` cases are the security half of this file. A draft arrives as a JSON string parsed
 * behind a guard, so `.strict()` is what stops a maker naming their own `moderationState` or
 * `publicSlug` — the fields that decide whether their launch is public.
 */

/** A draft with every field at a legal value, spread-overridden per case. */
function buildValidDraft(): Record<string, unknown> {
  return {
    title: "Solar cold storage unit",
    tagline: "Keeps produce cold on four hours of sun.",
    summary:
      "A 200-litre evaporative store that runs off a single panel, built and field-tested over one season with two farm cooperatives.",
    writeUp: "We started with a broken chest freezer.",
    launchedAt: "2026-08-01T00:00:00.000Z",
    difficulty: "intermediate",
    billOfMaterialsCostRange: { minimumInCents: 12_000, maximumInCents: 48_000, currency: "USD" },
    tags: ["solar", "cold-chain"],
    team: [{ displayName: "Amara", handle: "amara-builds", role: "Thermal design" }],
    builtFromBlueprintSlug: "evaporative-cold-store",
    callToAction: { label: "Order a unit", url: "https://maker.test/order" },
    acceptedLaunchStatementIds: [...SHOWCASE_LAUNCH_STATEMENT_IDS],
  };
}

function buildTeamMember(handle: string): Record<string, unknown> {
  return { displayName: `Maker ${handle}`, handle, role: "Build" };
}

describe("ShowcaseLaunchDraftSchema", () => {
  it("accepts a draft with every field at a legal value", () => {
    const parsed = ShowcaseLaunchDraftSchema.safeParse(buildValidDraft());

    // Asserted as the issue list rather than as a boolean, so a failure PRINTS what was refused.
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("accepts a draft with every nullable field null", () => {
    const parsed = ShowcaseLaunchDraftSchema.safeParse({
      ...buildValidDraft(),
      writeUp: null,
      billOfMaterialsCostRange: null,
      builtFromBlueprintSlug: null,
      callToAction: null,
    });

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  describe("server-owned fields", () => {
    it.each(["id", "slug", "publicSlug", "authorUserId", "moderationState", "createdAt", "reviewedByUserId"])(
      "refuses the server-owned key %s",
      (serverOwnedKey) => {
        const parsed = ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          [serverOwnedKey]: "anything",
        });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
      },
    );

    /**
     * `JSON.parse` makes `__proto__` an ORDINARY own key rather than touching the prototype, which
     * is the reason the controller's guarded parse is considered safe. `.strict()` is what refuses
     * it; this proves the claim rather than trusting it.
     */
    it("refuses __proto__, which JSON.parse makes an ordinary own key", () => {
      // Built by splicing the raw JSON text, NOT with an object literal: in a literal, `__proto__:`
      // sets the prototype instead of defining a key, and `JSON.stringify` would then drop it —
      // the test would pass while exercising nothing.
      const draftJson = JSON.stringify(buildValidDraft());
      const withProtoKey = `{"__proto__":{"isAdmin":true},${draftJson.slice(1)}`;
      const parsedDraft: unknown = JSON.parse(withProtoKey);

      expect(Object.hasOwn(parsedDraft as object, "__proto__"), "JSON.parse must make it an own key").toBe(true);
      expect(ShowcaseLaunchDraftSchema.safeParse(parsedDraft).success).toBe(false);
    });

    /** The heading image travels as the file part, so naming it in the draft is a client bug. */
    it("refuses a headingImage key in the draft", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          headingImage: "https://cdn.test/x.avif",
        }).success,
      ).toBe(false);
    });
  });

  describe("text lengths", () => {
    it.each([
      ["title", 8, 120],
      ["tagline", 10, 80],
      ["summary", 40, 1000],
    ] as const)("bounds %s between %i and %i characters", (fieldName, minimum, maximum) => {
      const underMinimum = ShowcaseLaunchDraftSchema.safeParse({
        ...buildValidDraft(),
        [fieldName]: "a".repeat(minimum - 1),
      });
      const atMinimum = ShowcaseLaunchDraftSchema.safeParse({
        ...buildValidDraft(),
        [fieldName]: "a".repeat(minimum),
      });
      const atMaximum = ShowcaseLaunchDraftSchema.safeParse({
        ...buildValidDraft(),
        [fieldName]: "a".repeat(maximum),
      });
      const overMaximum = ShowcaseLaunchDraftSchema.safeParse({
        ...buildValidDraft(),
        [fieldName]: "a".repeat(maximum + 1),
      });

      expect(underMinimum.success).toBe(false);
      expect(atMinimum.success).toBe(true);
      expect(atMaximum.success).toBe(true);
      expect(overMaximum.success).toBe(false);
    });

    /** `.trim()` runs BEFORE the length check, so padding cannot buy a shorter title. */
    it("trims before measuring, so a padded short title is still short", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), title: `   ${"a".repeat(7)}   ` }).success,
      ).toBe(false);
    });

    /**
     * THE SECOND CAP ON THE WRITE-UP, and the one that is not about length.
     *
     * Matching emphasis and link delimiters is quadratic, and the submit path parses every
     * write-up, so a 9,801-character input of nothing but `*` stalled the event loop for ~800 ms —
     * every request in flight, not just this maker's. The character cap cannot catch it, because
     * the worst input is comfortably under the character cap.
     */
    it("refuses a write-up that is mostly markup characters", () => {
      const markupStorm = "*".repeat(4_900) + "x" + "*".repeat(4_900);
      const parsed = ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), writeUp: markupStorm });

      expect(markupStorm.length).toBeLessThan(10_000);
      expect(parsed.success, "the length cap alone must not be what refuses this").toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(["writeUp"]);
    });

    it.each(["*", "_", "[", "]"])("counts %s toward the markup budget", (markupCharacter) => {
      const atTheCap = markupCharacter.repeat(MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS);
      const overTheCap = markupCharacter.repeat(MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS + 1);

      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), writeUp: atTheCap }).success).toBe(true);
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), writeUp: overTheCap }).success).toBe(false);
    });

    /**
     * THE CASE THAT KEEPS THE CAP HONEST. A cap that refuses real write-ups is worse than the stall
     * it prevents, so this is a deliberately over-formatted build log — bold or italic in every
     * sentence, bulleted specs, a block quote, an image and two links — repeated to the character
     * limit. It measures ~1,188 markup characters, well inside the budget.
     */
    it("accepts a heavily formatted write-up at the character limit", () => {
      const section = [
        "## **Thermal** design",
        "",
        "We started with a *broken* chest freezer and rebuilt the **evaporator** loop.",
        "The _first_ prototype held **4 degrees** for *six hours*; the _second_ held **eleven**.",
        "",
        "- **Panel**: 220W, *monocrystalline*",
        "- **Controller**: _custom_ MPPT, **12V**",
        "",
        "> The **key** insight was *airflow*, not _capacity_.",
        "",
        "![Build step](https://cdn.test/step.avif)",
        "",
        "See [the teardown](https://cdn.test/teardown) and [the notes](https://cdn.test/notes).",
        "",
      ].join("\n");
      let heavilyFormattedWriteUp = "";
      while (heavilyFormattedWriteUp.length + section.length < 10_000) {
        heavilyFormattedWriteUp += section;
      }

      const parsed = ShowcaseLaunchDraftSchema.safeParse({
        ...buildValidDraft(),
        writeUp: heavilyFormattedWriteUp,
      });

      expect(heavilyFormattedWriteUp.length).toBeGreaterThan(9_000);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    });

    it("accepts a 10,000-character write-up and refuses one character more", () => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), writeUp: "a".repeat(10_000) }).success).toBe(
        true,
      );
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), writeUp: "a".repeat(10_001) }).success).toBe(
        false,
      );
    });
  });

  describe("launch statements", () => {
    /**
     * BOTH STATEMENTS ARE THE CONSENT RECORD for a launch being published under the maker's name.
     * Every partial shape has to be refused, not just the empty one.
     */
    it("refuses an empty statement list", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), acceptedLaunchStatementIds: [] }).success,
      ).toBe(false);
    });

    it.each(SHOWCASE_LAUNCH_STATEMENT_IDS)("refuses a draft with only %s ticked", (statementId) => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          acceptedLaunchStatementIds: [statementId],
        }).success,
      ).toBe(false);
    });

    it("refuses a third statement entry", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          acceptedLaunchStatementIds: [...SHOWCASE_LAUNCH_STATEMENT_IDS, "built_it_ourselves"],
        }).success,
      ).toBe(false);
    });

    it("refuses an unrecognized statement id", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          acceptedLaunchStatementIds: ["built_it_ourselves", "we_are_very_honest"],
        }).success,
      ).toBe(false);
    });
  });

  describe("tags", () => {
    it("accepts ten tags and refuses eleven", () => {
      const tenTags = Array.from({ length: 10 }, (_unused, index) => `tag-${String(index)}`);

      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), tags: tenTags }).success).toBe(true);
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), tags: [...tenTags, "tag-10"] }).success).toBe(
        false,
      );
    });

    /** Case-insensitive, because "Solar" and "solar" are one tag to every reader. */
    it("refuses two tags differing only in case", () => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), tags: ["Solar", "solar"] }).success).toBe(
        false,
      );
    });

    it("refuses an empty tag and a tag over 32 characters", () => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), tags: [""] }).success).toBe(false);
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), tags: ["a".repeat(33)] }).success).toBe(false);
    });
  });

  describe("team", () => {
    it("accepts twelve people and refuses thirteen", () => {
      const twelve = Array.from({ length: 12 }, (_unused, index) => buildTeamMember(`maker-${String(index)}`));

      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), team: twelve }).success).toBe(true);
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          team: [...twelve, buildTeamMember("maker-12")],
        }).success,
      ).toBe(false);
    });

    it("accepts an empty team", () => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), team: [] }).success).toBe(true);
    });

    it("refuses two team rows sharing a handle in different cases", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          team: [buildTeamMember("amara-builds"), buildTeamMember("AMARA-BUILDS")],
        }).success,
      ).toBe(false);
    });

    it.each(["@amara", "amara builds", "amara/builds", ""])("refuses the handle %o", (handle) => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), team: [buildTeamMember(handle)] }).success,
      ).toBe(false);
    });

    it("refuses a team row with an extra key", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          team: [{ ...buildTeamMember("amara-builds"), equityBasisPoints: 500 }],
        }).success,
      ).toBe(false);
    });
  });

  describe("bill of materials cost range", () => {
    it("keys a max-below-min refusal to maximumInCents", () => {
      const parsed = ShowcaseLaunchDraftSchema.safeParse({
        ...buildValidDraft(),
        billOfMaterialsCostRange: { minimumInCents: 48_000, maximumInCents: 12_000, currency: "USD" },
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(["billOfMaterialsCostRange", "maximumInCents"]);
    });

    /** The comparison is `<=`, so one exact cost is a legal range. */
    it("accepts a range where the minimum equals the maximum", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          billOfMaterialsCostRange: { minimumInCents: 12_000, maximumInCents: 12_000, currency: "USD" },
        }).success,
      ).toBe(true);
    });

    it.each([
      ["a currency other than USD", { minimumInCents: 1, maximumInCents: 2, currency: "EUR" }],
      ["fractional cents", { minimumInCents: 1.5, maximumInCents: 2, currency: "USD" }],
      ["a negative minimum", { minimumInCents: -1, maximumInCents: 2, currency: "USD" }],
      ["a maximum over the cap", { minimumInCents: 1, maximumInCents: 100_000_001, currency: "USD" }],
    ])("refuses %s", (_label, billOfMaterialsCostRange) => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), billOfMaterialsCostRange }).success).toBe(
        false,
      );
    });
  });

  describe("the rest of the draft", () => {
    it("requires launchedAt to be an ISO datetime, not a date", () => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), launchedAt: "2026-08-01" }).success).toBe(
        false,
      );
      expect(
        ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), launchedAt: "2026-08-01T00:00:00.000Z" }).success,
      ).toBe(true);
    });

    it("refuses an unrecognized difficulty", () => {
      expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), difficulty: "expert" }).success).toBe(false);
    });

    it.each(["Not_A_Slug", "-leading", "trailing-", "ab", "Double--Dash"])(
      "refuses the teardown address %o",
      (builtFromBlueprintSlug) => {
        expect(ShowcaseLaunchDraftSchema.safeParse({ ...buildValidDraft(), builtFromBlueprintSlug }).success).toBe(
          false,
        );
      },
    );

    it("refuses a call to action missing its label or its url", () => {
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          callToAction: { url: "https://maker.test/order" },
        }).success,
      ).toBe(false);
      expect(
        ShowcaseLaunchDraftSchema.safeParse({
          ...buildValidDraft(),
          callToAction: { label: "Order a unit" },
        }).success,
      ).toBe(false);
    });

    /**
     * NULLABLE IS NOT OPTIONAL. The form always sends every key, so an absent one means a client
     * that has drifted from the contract — and silently defaulting it would store a null the maker
     * never chose.
     */
    it.each(["writeUp", "tags", "team", "callToAction", "billOfMaterialsCostRange", "builtFromBlueprintSlug"])(
      "requires the key %s to be present",
      (requiredKey) => {
        const draft = buildValidDraft();
        // oxlint-disable-next-line typescript/no-dynamic-delete
        delete draft[requiredKey];

        expect(ShowcaseLaunchDraftSchema.safeParse(draft).success).toBe(false);
      },
    );
  });
});

describe("SubmitShowcaseLaunchMultipartSchema", () => {
  it("accepts a single draft text part", () => {
    expect(SubmitShowcaseLaunchMultipartSchema.safeParse({ draft: "{}" }).success).toBe(true);
  });

  it("refuses a second text part, so a client cannot smuggle a flat field past the draft", () => {
    expect(SubmitShowcaseLaunchMultipartSchema.safeParse({ draft: "{}", moderationState: "published" }).success).toBe(
      false,
    );
  });

  it("refuses a draft shorter than two characters and one over the byte cap", () => {
    expect(SubmitShowcaseLaunchMultipartSchema.safeParse({ draft: "{" }).success).toBe(false);
    expect(
      SubmitShowcaseLaunchMultipartSchema.safeParse({
        draft: "a".repeat(SHOWCASE_DRAFT_PART_MAXIMUM_BYTES + 1),
      }).success,
    ).toBe(false);
  });
});

describe("ModerateShowcaseLaunchSchema", () => {
  it("accepts a publish decision with no note and with one", () => {
    expect(ModerateShowcaseLaunchSchema.safeParse({ decision: "published", moderatorNote: null }).success).toBe(true);
    expect(
      ModerateShowcaseLaunchSchema.safeParse({ decision: "published", moderatorNote: "Nice build." }).success,
    ).toBe(true);
  });

  /** The key is on both arms so a client cannot forget it on one and have it silently default. */
  it("refuses a publish decision with the moderatorNote key absent", () => {
    expect(ModerateShowcaseLaunchSchema.safeParse({ decision: "published" }).success).toBe(false);
  });

  it("accepts a rejection with a note", () => {
    expect(
      ModerateShowcaseLaunchSchema.safeParse({ decision: "rejected", moderatorNote: "Needs a photo." }).success,
    ).toBe(true);
  });

  /** "No" without a reason is not a review — and the column CHECK agrees. */
  it.each([
    ["an absent note", {}],
    ["a null note", { moderatorNote: null }],
    ["an empty note", { moderatorNote: "" }],
    ["a whitespace-only note", { moderatorNote: "   \n  " }],
  ])("refuses a rejection with %s", (_label, notePart) => {
    expect(ModerateShowcaseLaunchSchema.safeParse({ decision: "rejected", ...notePart }).success).toBe(false);
  });

  it("refuses an unrecognized decision", () => {
    const parsed = ModerateShowcaseLaunchSchema.safeParse({ decision: "quarantined", moderatorNote: null });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.code).toBe("invalid_union");
  });

  it.each(["published", "rejected"] as const)("refuses an extra key on the %s arm", (decision) => {
    expect(
      ModerateShowcaseLaunchSchema.safeParse({
        decision,
        moderatorNote: "Reviewed.",
        publicSlug: "chosen-by-the-client",
      }).success,
    ).toBe(false);
  });

  it("refuses a note over the maximum length on either arm", () => {
    const tooLong = "a".repeat(SHOWCASE_MODERATOR_NOTE_MAXIMUM_CHARACTERS + 1);

    expect(ModerateShowcaseLaunchSchema.safeParse({ decision: "published", moderatorNote: tooLong }).success).toBe(
      false,
    );
    expect(ModerateShowcaseLaunchSchema.safeParse({ decision: "rejected", moderatorNote: tooLong }).success).toBe(
      false,
    );
  });
});

describe("ShowcaseReviewQueueQuerySchema", () => {
  it("defaults the limit to 20 when the query is empty", () => {
    const parsed = ShowcaseReviewQueueQuerySchema.safeParse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data?.limit).toBe(20);
    expect(parsed.data?.cursor).toBeUndefined();
  });

  it("coerces a string limit, because a query string has no numbers", () => {
    expect(ShowcaseReviewQueueQuerySchema.safeParse({ limit: "50" }).data?.limit).toBe(50);
  });

  it.each(["51", "0", "-1", "1.5", "abc", ""])("refuses the limit %o", (limit) => {
    expect(ShowcaseReviewQueueQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("accepts a 200-character cursor and refuses 201 or an empty one", () => {
    expect(ShowcaseReviewQueueQuerySchema.safeParse({ cursor: "a".repeat(200) }).success).toBe(true);
    expect(ShowcaseReviewQueueQuerySchema.safeParse({ cursor: "a".repeat(201) }).success).toBe(false);
    expect(ShowcaseReviewQueueQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });

  /**
   * STRIPS RATHER THAN REFUSING, which is this schema's one deliberate departure from every other
   * query schema in the codebase. A `utm_source` from an emailed link or a stale `?page=` in a
   * bookmark is not a client trying to set something — it is noise the moderator never typed, and
   * refusing the request for it means the queue simply does not load.
   */
  it("ignores an unknown query key rather than refusing the whole request", () => {
    const parsed = ShowcaseReviewQueueQuerySchema.safeParse({
      limit: "20",
      cursor: "abc",
      utm_source: "newsletter",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ limit: 20, cursor: "abc" });
  });

  /** Stripping the unknown ones does not soften the known ones. */
  it("still refuses an out-of-range limit sent beside an unknown key", () => {
    expect(ShowcaseReviewQueueQuerySchema.safeParse({ limit: "51", utm_source: "newsletter" }).success).toBe(false);
  });
});

describe("the exported limits the frontend form mirrors", () => {
  it("states the write-up image cap and the staging cap it has to stay under", () => {
    expect(MAX_SHOWCASE_WRITE_UP_IMAGES).toBe(20);
    expect(MAX_SHOWCASE_WRITE_UP_MARKUP_CHARACTERS).toBe(3000);
    expect(SHOWCASE_DRAFT_PART_MAXIMUM_BYTES).toBe(128 * 1024);
    expect(SHOWCASE_LAUNCH_STATEMENT_IDS).toEqual(["built_it_ourselves", "results_are_our_own"]);
  });
});
