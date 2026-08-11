/**
 * Drives the Phase 22 facet surface over HTTP against a running server.
 *
 *   pnpm run db:migrate
 *   pnpm run dev                 # shell 2
 *   pnpm run db:seed-store-demo
 *   pnpm run db:backfill-store-search-documents
 *   pnpm run db:smoke-store-phase-22
 *
 * THE ONE ASSERTION THIS FILE EXISTS FOR: for every facet value on every dimension, the COUNT
 * equals the number of results returned when that value is applied as a FILTER. That is the
 * whole phase in one check, and it is only meaningful over HTTP because it spans two answers
 * from the same route — a count computed one way and a result set computed another is exactly
 * the defect Phase 22 closed, and a unit test with a mocked database cannot see it.
 *
 * BEFORE PHASE 22 THIS COULD NOT HAVE BEEN WRITTEN AT ALL: `/store/search` published no facets,
 * and the category page's facets came from a different table than any filter could act on.
 *
 * It also checks the drill-down rule that decides how the counts behave once a buyer has
 * clicked something: each facet counts under every OTHER applied filter but not its own, so a
 * buyer who picked "in stock" can still see — and switch to — the alternatives beside it.
 */
import "dotenv/config";
import { config } from "#src/config/index.js";
import { pool } from "#src/db/index.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;

interface CheckOutcome {
  readonly label: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

const outcomes: CheckOutcome[] = [];

function record(label: string, passed: boolean, detail: string): void {
  outcomes.push({ label, status: passed ? "pass" : "fail", detail });
}

function skip(label: string, reason: string): void {
  outcomes.push({ label, status: "skip", detail: reason });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

interface FacetBucket {
  readonly value: string;
  readonly count: number;
}

function readBuckets(facets: Record<string, unknown>, key: string): readonly FacetBucket[] {
  const raw = facets[key];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const bucket = asRecord(entry);
    const value = bucket["value"];
    const count = bucket["count"];
    return typeof value === "string" && typeof count === "number" ? [{ value, count }] : [];
  });
}

interface SearchAnswer {
  readonly status: number;
  readonly itemCount: number;
  readonly hasMore: boolean;
  readonly facets: Record<string, unknown>;
}

/**
 * `limit=48` is the schema's ceiling and it is load bearing: a facet count describes EVERY
 * matching document, so comparing it to one page of results only works while the page holds
 * them all. `hasMore` is reported so a truncated comparison degrades to a SKIP rather than a
 * false failure.
 */
async function search(query: Record<string, string>): Promise<SearchAnswer> {
  const url = new URL("/store/search", BASE_URL);
  for (const [key, value] of Object.entries({ limit: "48", ...query })) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { origin: REQUEST_ORIGIN } });
  const body = asRecord(await response.json().catch(() => ({})));
  const data = asRecord(body["data"]);
  const items = data["items"];
  const page = asRecord(data["page"]);

  return {
    status: response.status,
    itemCount: Array.isArray(items) ? items.length : 0,
    hasMore: page["hasMore"] === true,
    facets: asRecord(data["facets"]),
  };
}

/** The facet dimensions and the query key each one is filtered by. */
const FACET_FILTER_KEYS: readonly { readonly facet: string; readonly filterKey: string }[] = [
  { facet: "sellerCountryCodes", filterKey: "sellerCountryCode" },
  { facet: "stockStates", filterKey: "stockState" },
  { facet: "samplePolicies", filterKey: "samplePolicy" },
  { facet: "conditions", filterKey: "condition" },
  { facet: "verificationStates", filterKey: "verificationState" },
  { facet: "documentKinds", filterKey: "documentKind" },
  { facet: "providerKinds", filterKey: "providerKind" },
  { facet: "leadTimeMaxDays", filterKey: "leadTimeMaxDays" },
];

async function main(): Promise<void> {
  console.log("smoke-store-phase-22\n");

  const unfiltered = await search({});
  record(
    "A39 · /store/search answers facets beside its results",
    unfiltered.status === 200 && Object.keys(unfiltered.facets).length > 0,
    `status ${String(unfiltered.status)}, ${String(Object.keys(unfiltered.facets).length)} facet dimension(s)`,
  );

  if (unfiltered.status !== 200) {
    console.log("\nsearch is not answering; nothing further can be checked.");
    process.exitCode = 1;
    return;
  }

  // ── THE PHASE. Every count must equal its own filtered result count. ──────────────────
  for (const { facet, filterKey } of FACET_FILTER_KEYS) {
    const buckets = readBuckets(unfiltered.facets, facet);
    if (buckets.length === 0) {
      skip(`A39 · ${facet} counts match their filtered results`, "no values in the seeded data");
      continue;
    }

    const mismatches: string[] = [];
    let truncated = false;
    for (const bucket of buckets) {
      const filtered = await search({ [filterKey]: bucket.value });
      if (filtered.hasMore) {
        truncated = true;
        continue;
      }
      if (filtered.status !== 200 || filtered.itemCount !== bucket.count) {
        mismatches.push(
          `${bucket.value}: facet said ${String(bucket.count)}, filter returned ${String(filtered.itemCount)}${
            filtered.status === 200 ? "" : ` (status ${String(filtered.status)})`
          }`,
        );
      }
    }

    if (truncated && mismatches.length === 0) {
      skip(
        `A39 · ${facet} counts match their filtered results`,
        "a value returned more than one page — the comparison would be false either way",
      );
      continue;
    }

    record(
      `A39 · ${facet} counts match their filtered results`,
      mismatches.length === 0,
      mismatches.length === 0
        ? `${String(buckets.length)} value(s) verified`
        : mismatches.join("; "),
    );
  }

  // ── The price facet is a range, so it is checked differently. ─────────────────────────
  const priceRange = asRecord(unfiltered.facets["priceRangesInCents"]);
  const minInCents = priceRange["minInCents"];
  const maxInCents = priceRange["maxInCents"];
  if (typeof minInCents !== "number" || typeof maxInCents !== "number") {
    skip("A39 · the published price range contains every priced document", "no priced documents");
  } else {
    const withinRange = await search({
      priceMinInCents: String(minInCents),
      priceMaxInCents: String(maxInCents),
    });
    const priceCount = priceRange["count"];
    record(
      "A39 · the published price range contains every priced document",
      !withinRange.hasMore &&
        typeof priceCount === "number" &&
        withinRange.itemCount === priceCount,
      `range ${String(minInCents)}–${String(maxInCents)} says ${String(priceCount)}, filter returned ${String(withinRange.itemCount)}`,
    );
  }

  // ── Drill-down, blind to self. ───────────────────────────────────────────────────────
  /**
   * Driven by whichever dimension the seeded data actually has more than one value on. Pinning
   * this to `stockStates` made it SKIP against the demo seed, which has exactly one — and a
   * check that never runs is the one most likely to be wrong when it finally does.
   */
  const drillDownDimension = FACET_FILTER_KEYS.map((dimension) => ({
    ...dimension,
    buckets: readBuckets(unfiltered.facets, dimension.facet),
  })).find((dimension) => dimension.buckets.length >= 2);
  const drillDownValue = drillDownDimension?.buckets[0];

  if (!drillDownDimension || !drillDownValue) {
    skip(
      "A39 · a facet still shows its alternatives once its own filter is applied",
      "no facet in the seeded data has two values to choose between",
    );
  } else {
    const narrowed = await search({ [drillDownDimension.filterKey]: drillDownValue.value });
    const narrowedSelf = readBuckets(narrowed.facets, drillDownDimension.facet);
    /**
     * THE DRILL-DOWN RULE. A facet must NOT narrow to the one value just picked — counting it
     * under its own filter collapses it, and the only way back is to clear the filter and lose
     * every other narrowing with it. Amazon and Alibaba both keep the alternatives visible.
     */
    record(
      "A39 · a facet still shows its alternatives once its own filter is applied",
      narrowedSelf.length === drillDownDimension.buckets.length,
      `${drillDownDimension.facet} offered ${String(drillDownDimension.buckets.length)} value(s), and ${String(narrowedSelf.length)} after filtering on "${drillDownValue.value}"`,
    );

    /**
     * And every OTHER facet must narrow, or the counts stop describing what a click returns.
     *
     * BOUNDED ABOVE BY THE SELECTED COUNT, not equal to it: a facet only counts documents that
     * carry its column, and `stockState` is NULL on organizations and provider offerings. So
     * `stockStates` under `sellerCountryCode=IN` is the PRODUCT subset of IN, which is smaller
     * than IN itself. Asserting equality here failed for exactly that reason and the assertion
     * was the thing that was wrong.
     */
    const otherFacet = FACET_FILTER_KEYS.find(
      (dimension) => dimension.facet !== drillDownDimension.facet,
    );
    const totalOf = (facets: Record<string, unknown>, key: string): number =>
      readBuckets(facets, key).reduce((sum, bucket) => sum + bucket.count, 0);
    if (!otherFacet) {
      skip("A39 · every OTHER facet narrows under an applied filter", "no second dimension");
    } else {
      const before = totalOf(unfiltered.facets, otherFacet.facet);
      const after = totalOf(narrowed.facets, otherFacet.facet);
      record(
        "A39 · every OTHER facet narrows under an applied filter",
        after <= before && after <= drillDownValue.count,
        `${otherFacet.facet} totalled ${String(before)} unfiltered and ${String(after)} under ${drillDownDimension.filterKey}=${drillDownValue.value}, which selected ${String(drillDownValue.count)}`,
      );
    }
  }

  // ── The category page reads the same table. ──────────────────────────────────────────
  const categoriesResponse = await fetch(new URL("/store/categories", BASE_URL), {
    headers: { origin: REQUEST_ORIGIN },
  });
  const categoriesBody = asRecord(await categoriesResponse.json().catch(() => ({})));
  const categoryItems = asRecord(categoriesBody["data"])["items"];
  const categorySlugs = (Array.isArray(categoryItems) ? categoryItems : []).flatMap((item) => {
    const slug = asRecord(item)["slug"];
    return typeof slug === "string" ? [slug] : [];
  });

  const asText = (buckets: readonly FacetBucket[]): string =>
    buckets
      .map((bucket) => `${bucket.value}=${String(bucket.count)}`)
      .toSorted()
      .join(",");

  /**
   * THE FIRST CATEGORY THAT ACTUALLY HOLDS SOMETHING, not simply the first one listed. Taking
   * `items[0]` compared an empty facet list to an empty facet list and passed — the shape of
   * check this repo's own smoke rule calls worse than no check at all.
   */
  let comparedCategory: {
    readonly slug: string;
    readonly fromCategory: string;
    readonly fromSearch: string;
  } | null = null;
  for (const slug of categorySlugs) {
    const categoryResponse = await fetch(new URL(`/store/categories/${slug}`, BASE_URL), {
      headers: { origin: REQUEST_ORIGIN },
    });
    const categoryBody = asRecord(await categoryResponse.json().catch(() => ({})));
    const categoryFacets = asRecord(asRecord(categoryBody["data"])["facets"]);
    const fromCategory = asText(readBuckets(categoryFacets, "stockStates"));
    if (fromCategory === "") continue;

    const searchInCategory = await search({ category: slug, documentKind: "product" });
    comparedCategory = {
      slug,
      fromCategory,
      fromSearch: asText(readBuckets(searchInCategory.facets, "stockStates")),
    };
    break;
  }

  if (!comparedCategory) {
    skip(
      "A39 · a category page's facets agree with the same filter on search",
      "no seeded category holds a product with a stock state",
    );
  } else {
    /**
     * The two reads scope the same way now — both by `category_slug`, both over
     * `store_search_document` — so a category page's counts and the same query on search must
     * agree bucket for bucket. Before Phase 22 they came from different tables entirely.
     */
    record(
      "A39 · a category page's facets agree with the same filter on search",
      comparedCategory.fromCategory === comparedCategory.fromSearch,
      `category "${comparedCategory.slug}" → [${comparedCategory.fromCategory}] vs search → [${comparedCategory.fromSearch}]`,
    );
  }
  // ── Report. ─────────────────────────────────────────────────────────────────────────
  console.log("");
  for (const outcome of outcomes) {
    const marker =
      outcome.status === "pass" ? "  ok  " : outcome.status === "skip" ? "  skip" : "  FAIL";
    console.log(`${marker}  ${outcome.label} — ${outcome.detail}`);
  }

  const failures = outcomes.filter((outcome) => outcome.status === "fail").length;
  const passes = outcomes.filter((outcome) => outcome.status === "pass").length;
  const skipped = outcomes.filter((outcome) => outcome.status === "skip").length;
  console.log(
    `\n${String(passes)} passed, ${String(failures)} failed, ${String(skipped)} skipped.`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
