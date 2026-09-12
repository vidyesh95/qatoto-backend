import { z } from "zod";

import { ExternalUrlSchema } from "#src/modules/home/blueprints/blueprint-url.schemas.js";

/**
 * THE WRITE GATE for a case study: what `POST /blueprints/case-studies` parses, and what the seed
 * parses too.
 *
 * ⚠️ A BACKEND-OWNED MIRROR of the frontend's `CaseStudySubmissionDraftSchema`
 * (`src/lib/blueprints/case-study-authoring.schemas.ts`), not an import of it. The frontend file has
 * runtime imports and lives in another repository, so a static import would make this repo's
 * typecheck depend on that one being checked out. The duplication is named here so the next reader
 * knows it is deliberate: every cap below is quoted from that file, and `todo.md` §"Writing a case
 * study" Part 2 lists them again as the server's own limits.
 *
 * ⚠️ ONE GATE FOR BOTH WRITERS. The seed goes through this module rather than carrying its own
 * rules — unlike the teardown round, this arm HAS a live write route, so a seed with laxer rules
 * would be a second, quieter front door into the same tables.
 *
 * `.strict()`, so a field the backend does not model is a loud refusal rather than a silent drop.
 * The frontend's draft is `.strict()` for the same reason in the other direction.
 *
 * ⚠️ WHAT THIS SCHEMA CANNOT SAY, and where those rules live instead. Five rules need a sibling row,
 * another table or a subquery, so they are in `case-study-submission.service.ts` and are listed here
 * so the two files cannot drift: a `public_sources` case study needs at least one source; a figure
 * label may not equal a company's NAME; a related slug must name a published case study; a related
 * slug may not be the row's own; and a withheld company name may not appear in any published free
 * text. The first four are stated in the frontend contract too; the fifth is the server's alone.
 */

/** Both count in hundredths — cents, paise — which is why one integer column carries either. */
export const CASE_STUDY_CURRENCIES = ["USD", "INR"] as const;

export const CASE_STUDY_DISCIPLINES = [
  "tooling",
  "supply_chain",
  "quality",
  "distribution",
  "unit_economics",
] as const;

export const CASE_STUDY_AUTHOR_RELATIONSHIPS = ["first_hand", "public_sources"] as const;

export const CASE_STUDY_STATEMENT_IDS = [
  "was_part_of_it",
  "figures_from_records",
  "figures_in_linked_sources",
  "says_only_what_sources_say",
] as const;

/**
 * The two statements each answer requires.
 *
 * ⚠️ TWO PAIRS, NOT ONE LIST, and the frontend gives the reason: "somebody who was there is
 * vouching for records they saw; somebody writing from a build log is vouching that they added
 * nothing to it. One shared pair would have to be vague enough to fit both, and a vague statement is
 * ticked without reading." `case_study_statements_ck` holds the same rule in SQL.
 */
export const CASE_STUDY_STATEMENT_IDS_BY_RELATIONSHIP: Readonly<
  Record<
    (typeof CASE_STUDY_AUTHOR_RELATIONSHIPS)[number],
    readonly (typeof CASE_STUDY_STATEMENT_IDS)[number][]
  >
> = {
  first_hand: ["was_part_of_it", "figures_from_records"],
  public_sources: ["figures_in_linked_sources", "says_only_what_sources_say"],
};

/** The route literals under `/blueprints/case-studies/`, which no minted slug may shadow. */
export const CASE_STUDY_RESERVED_SLUGS = ["new", "mine", "slugs", "options"] as const;

const EvidenceCompanySubmissionSchema = z
  .object({
    /**
     * ⚠️ ALWAYS THE REAL NAME, WITHHELD OR NOT. A withheld name is withheld from READERS, not from
     * Qatoto: it travels here so a moderator can check the case study against it, and every public
     * read writes `null` in its place. A company a moderator cannot see is a claim nobody can check,
     * which is also why a public-sources case study may not withhold one.
     */
    name: z.string().min(1).max(80),
    /** Only a first-hand case study may set this. Enforced below, and by a CHECK on the row. */
    isNameWithheld: z.boolean(),
    locationLabel: z.string().min(1).max(60),
    yearLabel: z.string().min(1).max(20),
  })
  .strict();

const MoneySubmissionSchema = z
  .object({
    /** Integer minor units. A negative raise is not a state; the read shape permits one, a write does not. */
    amountInCents: z.number().int().nonnegative(),
    currency: z.enum(CASE_STUDY_CURRENCIES),
  })
  .strict();

/** PERCENTAGES ARE BASIS POINTS so a fraction survives the integer: 43.8% is 4380. */
const MetricValueSubmissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count"), amount: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("money"),
      amountInCents: z.number().int().nonnegative(),
      currency: z.enum(CASE_STUDY_CURRENCIES),
    })
    .strict(),
  z.object({ kind: z.literal("percentage"), basisPoints: z.number().int() }).strict(),
]);

const OutcomeMetricSubmissionSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(60)
      /**
       * A figure may not be labelled as if it were a withheld company. The frontend's version of
       * this rule is conditional on some company actually being withheld; unconditional is stricter,
       * harmless — no honest figure is called that — and it is what `case_study_outcome_metric`'s
       * CHECK can hold without reading a sibling row.
       */
      .refine((label) => !label.trim().toLowerCase().startsWith("name withheld"), {
        message: "A figure cannot be labelled as a withheld company.",
      }),
    value: MetricValueSubmissionSchema,
  })
  .strict();

const SourceSubmissionSchema = z
  .object({
    label: z.string().min(1).max(120),
    publisherLabel: z.string().min(1).max(80),
    url: ExternalUrlSchema,
  })
  .strict();

const ListItemSchema = z.string().min(1).max(300);

/**
 * The indexes of values already seen earlier in a list, compared trimmed and case-insensitively.
 *
 * ⚠️ THE COMPARISON MATCHES THE FORM'S AND THE UNIQUE INDEXES', AND ALL THREE MUST AGREE. The form
 * uses `value.trim().toLowerCase()`; the indexes use `lower(btrim(...))`. A schema that also
 * collapsed internal whitespace would be STRICTER than the index, so a draft this gate accepted
 * could still raise a 23505 the service has no error type for.
 */
function findRepeatedValueIndexes(values: readonly string[]): readonly number[] {
  const seenValues = new Set<string>();
  const repeatedValueIndexes: number[] = [];
  values.forEach((value, valueIndex) => {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "") return;
    if (seenValues.has(normalizedValue)) repeatedValueIndexes.push(valueIndex);
    seenValues.add(normalizedValue);
  });
  return repeatedValueIndexes;
}

export const CaseStudySubmissionSchema = z
  .object({
    /** THE LESSON, AS ONE INSTRUCTION. There is deliberately no second title field. */
    title: z.string().min(12).max(140),
    oneLineAction: z.string().min(10).max(140),
    discipline: z.enum(CASE_STUDY_DISCIPLINES),
    /** Free text. A closed list would refuse the first sector somebody actually worked in. */
    sector: z.string().min(1).max(60),
    /** `null` when nobody can say tidily what came of it. Not "Unknown", and not a failure. */
    outcomeSummary: z.string().min(1).max(120).nullable(),
    authorRelationship: z.enum(CASE_STUDY_AUTHOR_RELATIONSHIPS),
    summary: z.string().min(40).max(600),
    problem: z.string().min(20).max(2000),
    context: z.string().min(20).max(2000),
    actionSteps: z.array(ListItemSchema).min(1).max(12),
    pitfalls: z.array(ListItemSchema).max(12),
    evidenceCompanies: z.array(EvidenceCompanySubmissionSchema).max(5),
    timelineLabel: z.string().min(1).max(60).nullable(),
    /** `null` MEANS NOT DISCLOSED, never zero — the row says nothing about money rather than a number. */
    capitalRaised: MoneySubmissionSchema.nullable(),
    outcomeMetrics: z.array(OutcomeMetricSubmissionSchema).max(8),
    sources: z.array(SourceSubmissionSchema).max(10),
    relatedLessonSlugs: z
      .array(
        z
          .string()
          .min(3)
          .max(120)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
      )
      .max(3),
    tags: z.array(z.string().min(1).max(40)).max(10),
    acceptedStatementIds: z.array(z.enum(CASE_STUDY_STATEMENT_IDS)),
  })
  .strict()
  .superRefine((submission, context) => {
    /*
     * THE STATEMENT PAIR. `case_study_statements_ck` holds the same rule, and this is not
     * belt-and-braces: the CHECK names a constraint and this names a field, so a writer whose ticks
     * are wrong gets told which statement is missing instead of a 500 with a constraint name in it.
     */
    const requiredStatementIds =
      CASE_STUDY_STATEMENT_IDS_BY_RELATIONSHIP[submission.authorRelationship];
    const acceptedStatementIds = new Set(submission.acceptedStatementIds);
    const missingStatementIds = requiredStatementIds.filter(
      (statementId) => !acceptedStatementIds.has(statementId),
    );
    if (missingStatementIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["acceptedStatementIds"],
        message: `Both statements have to be ticked. Still unticked: ${missingStatementIds.join(", ")}.`,
      });
    }
    // A tick carried over from the other answer is a statement about a different claim.
    if (
      submission.acceptedStatementIds.some(
        (statementId) => !requiredStatementIds.includes(statementId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptedStatementIds"],
        message: "A statement for the other way of knowing this is ticked.",
      });
    }

    /*
     * A WITHHELD NAME IN A PUBLIC-SOURCES CASE STUDY hides a company its readers could otherwise
     * check. Reported per company, so the writer knows which row to fix.
     */
    if (submission.authorRelationship === "public_sources") {
      submission.evidenceCompanies.forEach((company, companyIndex) => {
        if (!company.isNameWithheld) return;
        context.addIssue({
          code: "custom",
          path: ["evidenceCompanies", companyIndex, "isNameWithheld"],
          message:
            "Only someone who worked on this can withhold a company's name. From public sources, name it the way the sources do.",
        });
      });
    }

    /*
     * THE DUPLICATE RULES ARE NOT TIDINESS. The detail page keys its fact rows by label, its sources
     * by address and its steps by their text, so a repeat collides there rather than failing here.
     * Each one also has a unique index behind it; this layer is what turns a 23505 into a path.
     */
    for (const stepIndex of findRepeatedValueIndexes(submission.actionSteps)) {
      context.addIssue({
        code: "custom",
        path: ["actionSteps", stepIndex],
        message: "This step is already on the list.",
      });
    }
    for (const pitfallIndex of findRepeatedValueIndexes(submission.pitfalls)) {
      context.addIssue({
        code: "custom",
        path: ["pitfalls", pitfallIndex],
        message: "This is already on the list.",
      });
    }
    for (const companyIndex of findRepeatedValueIndexes(
      submission.evidenceCompanies.map((company) => company.name),
    )) {
      context.addIssue({
        code: "custom",
        path: ["evidenceCompanies", companyIndex, "name"],
        message: "This company is already listed.",
      });
    }
    for (const metricIndex of findRepeatedValueIndexes(
      submission.outcomeMetrics.map((metric) => metric.label),
    )) {
      context.addIssue({
        code: "custom",
        path: ["outcomeMetrics", metricIndex, "label"],
        message: "A figure with this label is already listed.",
      });
    }
    /*
     * SOURCE ADDRESSES ARE COMPARED THE FORM'S WAY, case-insensitively, even though
     * `case_study_source_url_uidx` is case-SENSITIVE. The index is deliberately the laxer of the two
     * — a URL path is case-sensitive, so two addresses differing in case are two addresses — and
     * being stricter here only ever refuses earlier with a better message.
     */
    for (const sourceIndex of findRepeatedValueIndexes(
      submission.sources.map((source) => source.url),
    )) {
      context.addIssue({
        code: "custom",
        path: ["sources", sourceIndex, "url"],
        message: "This source is already linked.",
      });
    }
    if (findRepeatedValueIndexes(submission.relatedLessonSlugs).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["relatedLessonSlugs"],
        message: "The same lesson is picked twice.",
      });
    }

    /*
     * ⚠️ A FIGURE LABEL MAY NOT EQUAL A COMPANY'S NAME, and this is the rule that could not be a
     * CHECK: companies and figures are two tables, and a CHECK may not cross one. The detail page
     * puts both in ONE list keyed by label, so a collision there drops a row silently.
     */
    const companyNamesNormalized = new Set(
      submission.evidenceCompanies.map((company) => company.name.trim().toLowerCase()),
    );
    submission.outcomeMetrics.forEach((metric, metricIndex) => {
      if (!companyNamesNormalized.has(metric.label.trim().toLowerCase())) return;
      context.addIssue({
        code: "custom",
        path: ["outcomeMetrics", metricIndex, "label"],
        message: "A figure cannot share its label with a company on this case study.",
      });
    });

    /*
     * A CASE STUDY FROM PUBLIC SOURCES HAS TO LINK AT LEAST ONE. This one COULD have been a CHECK
     * only by inlining the first source onto the parent row, which would give "a source" two
     * spellings and make the read re-number the author's order. It lives here instead, and
     * `verify-case-study-constraints.ts` records that the database does not enforce it.
     */
    if (submission.authorRelationship === "public_sources" && submission.sources.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "A case study from public sources has to link at least one of them.",
      });
    }

    /*
     * ⚠️ THE WITHHELD NAME MAY NOT APPEAR IN ANY PUBLISHED FREE TEXT, and this rule is the SERVER'S
     * ALONE — the frontend has no equivalent.
     *
     * Nulling one column withholds nothing if the writer names the company in the summary, in a step,
     * in a tag, or in a source's publisher label. That shape is not hypothetical: a fixture's
     * publisher label is literally "Verdant Sensing build log", which is a company name. So every
     * field a reader can see is swept for the withheld name, and a hit is a path the writer can act
     * on rather than a silent half-withholding.
     */
    const withheldNames = submission.evidenceCompanies
      .filter((company) => company.isNameWithheld)
      .map((company) => company.name.trim().toLowerCase())
      .filter((withheldName) => withheldName.length > 0);

    if (withheldNames.length > 0) {
      const publiclyVisibleText: readonly {
        readonly path: readonly (string | number)[];
        readonly value: string;
      }[] = [
        { path: ["title"], value: submission.title },
        { path: ["oneLineAction"], value: submission.oneLineAction },
        { path: ["sector"], value: submission.sector },
        { path: ["summary"], value: submission.summary },
        { path: ["problem"], value: submission.problem },
        { path: ["context"], value: submission.context },
        ...(submission.outcomeSummary === null
          ? []
          : [{ path: ["outcomeSummary"], value: submission.outcomeSummary }]),
        ...(submission.timelineLabel === null
          ? []
          : [{ path: ["timelineLabel"], value: submission.timelineLabel }]),
        ...submission.actionSteps.map((step, stepIndex) => ({
          path: ["actionSteps", stepIndex],
          value: step,
        })),
        ...submission.pitfalls.map((pitfall, pitfallIndex) => ({
          path: ["pitfalls", pitfallIndex],
          value: pitfall,
        })),
        ...submission.tags.map((tag, tagIndex) => ({ path: ["tags", tagIndex], value: tag })),
        ...submission.outcomeMetrics.map((metric, metricIndex) => ({
          path: ["outcomeMetrics", metricIndex, "label"],
          value: metric.label,
        })),
        ...submission.sources.flatMap((source, sourceIndex) => [
          { path: ["sources", sourceIndex, "label"], value: source.label },
          { path: ["sources", sourceIndex, "publisherLabel"], value: source.publisherLabel },
          { path: ["sources", sourceIndex, "url"], value: source.url },
        ]),
        // A named company is public, so it may not carry a DIFFERENT company's withheld name.
        ...submission.evidenceCompanies.flatMap((company, companyIndex) =>
          company.isNameWithheld
            ? []
            : [{ path: ["evidenceCompanies", companyIndex, "name"], value: company.name }],
        ),
      ];

      for (const visibleField of publiclyVisibleText) {
        const normalizedValue = visibleField.value.toLowerCase();
        if (!withheldNames.some((withheldName) => normalizedValue.includes(withheldName))) continue;
        context.addIssue({
          code: "custom",
          path: [...visibleField.path],
          message:
            "This names a company whose name you asked to withhold. Readers would see it here.",
        });
      }
    }
  });

export type CaseStudySubmission = z.infer<typeof CaseStudySubmissionSchema>;
