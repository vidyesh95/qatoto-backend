import { describe, expect, it } from "vitest";

import { BASIS_POINTS_TOTAL } from "#src/lib/money.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import {
  jaccardBasisPoints,
  normalizeToTokenSet,
  TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS,
} from "#src/lib/text-similarity.js";

describe("normalizeToTokenSet", () => {
  it("folds case without a locale dependency", () => {
    expect(normalizeToTokenSet("POTHOLE Streetlight")).toEqual(["pothole", "streetlight"]);
  });

  it("folds an uppercase I to a dotted i, as toLocaleLowerCase under a Turkish locale would not", () => {
    // If this ever returns "ırrıgatıon", someone swapped in toLocaleLowerCase and the
    // token set now depends on the server's environment.
    expect(normalizeToTokenSet("IRRIGATION")).toEqual(["irrigation"]);
  });

  it("normalizes half-width and full-width forms of the same CJK text identically", () => {
    // Half-width katakana ｱｲｳ (U+FF71..) NFKC-folds to full-width アイウ (U+30A2..).
    // Without NFKC these two share zero bytes and would score 0.
    const halfWidthTokens = normalizeToTokenSet("ｱｲｳ");
    const fullWidthTokens = normalizeToTokenSet("アイウ");

    expect(halfWidthTokens).toEqual(["アイウ"]);
    expect(halfWidthTokens).toEqual(fullWidthTokens);
    expect(jaccardBasisPoints(halfWidthTokens, fullWidthTokens)).toBe(BASIS_POINTS_TOTAL);
  });

  it("normalizes full-width latin to ascii", () => {
    expect(normalizeToTokenSet("ＰＯＴＨＯＬＥ")).toEqual(["pothole"]);
  });

  it("treats punctuation as a separator, not a deletion", () => {
    // The comma has no space after it. Deleting it would produce the single junk token
    // "potholestreetlight".
    expect(normalizeToTokenSet("pothole,streetlight")).toEqual(["pothole", "streetlight"]);
    expect(normalizeToTokenSet("drainage — blocked! (again)")).toEqual(["again", "blocked", "drainage"]);
  });

  it("deletes apostrophes instead of splitting on them", () => {
    // "don't" must not become "don" + a one-letter "t" that matches every contraction.
    expect(normalizeToTokenSet("don't ’fix’ it")).toEqual(["dont", "fix"]);
  });

  it("splits on zero-width and control characters", () => {
    expect(normalizeToTokenSet("pothole\u200Bstreetlight\u0000drain")).toEqual(["drain", "pothole", "streetlight"]);
  });

  it("drops stopwords", () => {
    expect(normalizeToTokenSet("the water is in the drain")).toEqual(["drain", "water"]);
  });

  it("keeps negation words, which carry discriminating signal about WHICH problem", () => {
    // The stopword list admits words carrying "no discriminating signal about WHICH
    // problem is being described". A negation inverts the predicate, so it fails that
    // test — and "no"/"nor"/"never" were already kept, so dropping "not" treated one
    // spelling of negation as the opposite of its synonyms.
    expect(normalizeToTokenSet("not water supply")).toEqual(["not", "supply", "water"]);
    expect(normalizeToTokenSet("no water supply")).toEqual(["no", "supply", "water"]);
  });

  it("does not score a report and its own negation as identical", () => {
    // "water is safe" vs "water is not safe" are opposite reports. Scoring them 10000
    // makes a false merge CERTAIN, and a false merge destroys the reporter's detail —
    // the failure this module's threshold doc says it is tuned to avoid.
    const safe = normalizeToTokenSet("water is safe");
    const unsafe = normalizeToTokenSet("water is not safe");

    expect(safe).not.toEqual(unsafe);
    expect(jaccardBasisPoints(safe, unsafe)).toBeLessThan(BASIS_POINTS_TOTAL);
  });

  it("dedupes repeated tokens", () => {
    expect(normalizeToTokenSet("pothole pothole POTHOLE pothole")).toEqual(["pothole"]);
  });

  it("returns [] for text that is only stopwords, punctuation, or whitespace", () => {
    expect(normalizeToTokenSet("")).toEqual([]);
    expect(normalizeToTokenSet("   \t\n  ")).toEqual([]);
    expect(normalizeToTokenSet("... !!! --- ")).toEqual([]);
    expect(normalizeToTokenSet("the and it is")).toEqual([]);
  });

  it("sorts by UTF-8 BYTES, which disagrees with the built-in `<` for astral characters", () => {
    // U+FA0E is one of the handful of CJK compatibility ideographs with no NFKC mapping,
    // so it survives normalization. U+10428 (Deseret small long i) is astral and is
    // already lowercase. Their orders differ between the two comparisons:
    //   UTF-8  : U+FA0E = EF A8 8E   <  U+10428 = F0 90 90 A8
    //   UTF-16 : U+10428 = D801 DC28 <  U+FA0E  = FA0E
    const bmpToken = "﨎";
    const astralToken = "\u{10428}";

    expect(normalizeToTokenSet(`${astralToken} ${bmpToken}`)).toEqual([bmpToken, astralToken]);

    const naiveUtf16Order = [bmpToken, astralToken].toSorted((left, right) => (left < right ? -1 : 1));
    expect(naiveUtf16Order).toEqual([astralToken, bmpToken]);
  });

  it("is sorted by UTF-8 bytes over many deterministic multi-token inputs", () => {
    const alphabet = ["pothole", "drain", "﨎", "\u{10428}", "水", "café", "zebra", "acid"];

    for (let inputIndex = 0; inputIndex < 200; inputIndex += 1) {
      // Rotate and slice by the loop index so every failure is reproducible.
      const wordCount = 1 + (inputIndex % alphabet.length);
      const words = Array.from(
        { length: wordCount },
        (_unused, wordIndex) => alphabet[(inputIndex + wordIndex * 3) % alphabet.length] ?? "",
      );

      const tokens = normalizeToTokenSet(words.join(" "));
      expect(tokens).toEqual(tokens.toSorted(compareUtf8Bytes));
      expect(new Set(tokens).size).toBe(tokens.length);
    }
  });

  it("pins the ICU-version-sensitive boundary of the separator class", () => {
    // TRIPWIRE, not a correctness assertion. `\p{C}` includes Cn (UNASSIGNED), so a
    // codepoint separates tokens until Unicode assigns it, then stops. U+30000 is the
    // worked example: unassigned until Unicode 13.0, a CJK ideograph since. On a Node
    // built against Unicode < 13 the line below yields TWO tokens; on Unicode >= 13 it
    // yields ONE. Same input, same code, different cluster — from a runtime upgrade.
    //
    // If this test fails after a Node bump, tokenization moved and stored clusters no
    // longer match what the current code would produce. That is a re-cluster decision,
    // not a snapshot to update blindly.
    expect(normalizeToTokenSet("pothole\u{30000}drain")).toEqual(["pothole\u{30000}drain"]);
    expect(normalizeToTokenSet("pothole͸drain")).toEqual(["drain", "pothole"]);
  });

  it("is idempotent — re-normalizing a token set changes nothing", () => {
    const tokens = normalizeToTokenSet("The Pothole on Café Street — it's DEEP!");
    expect(normalizeToTokenSet(tokens.join(" "))).toEqual(tokens);
  });
});

describe("jaccardBasisPoints", () => {
  it("scores identical sets at exactly 10000", () => {
    const tokens = normalizeToTokenSet("broken streetlight on main road");
    expect(jaccardBasisPoints(tokens, tokens)).toBe(BASIS_POINTS_TOTAL);
  });

  it("scores disjoint sets at 0", () => {
    const left = normalizeToTokenSet("broken streetlight");
    const right = normalizeToTokenSet("contaminated well");
    expect(jaccardBasisPoints(left, right)).toBe(0);
  });

  it("scores partial overlap as intersection over union", () => {
    // {a,b,c} vs {b,c,d}: 2 shared, 4 in union -> 5000.
    expect(jaccardBasisPoints(["a", "b", "c"], ["b", "c", "d"])).toBe(5_000);
    // {a,b} vs {b,c,d}: 1 shared, 4 in union -> 2500.
    expect(jaccardBasisPoints(["a", "b"], ["b", "c", "d"])).toBe(2_500);
    // 1/3 rounds half away from zero, matching Postgres round(), not toward even.
    expect(jaccardBasisPoints(["a"], ["a", "b", "c"])).toBe(3_333);
  });

  it("returns 0 for two empty sets rather than throwing", () => {
    // basisPointsOf throws on a zero whole; an empty union is that case, and a
    // content-free user report must not become a 500.
    expect(() => jaccardBasisPoints([], [])).not.toThrow();
    expect(jaccardBasisPoints([], [])).toBe(0);
    expect(jaccardBasisPoints(normalizeToTokenSet("the and it"), normalizeToTokenSet("!!!"))).toBe(0);
  });

  it("returns 0 when exactly one side is empty", () => {
    const populated = normalizeToTokenSet("collapsed footbridge");
    expect(jaccardBasisPoints([], populated)).toBe(0);
    expect(jaccardBasisPoints(populated, [])).toBe(0);
  });

  it("is symmetric", () => {
    const left = normalizeToTokenSet("no water supply in sector twelve since monday");
    const right = normalizeToTokenSet("water supply cut in sector nine");

    expect(jaccardBasisPoints(left, right)).toBe(jaccardBasisPoints(right, left));
    expect(jaccardBasisPoints(left, [])).toBe(jaccardBasisPoints([], left));
  });

  it("is symmetric over many deterministic token-set pairs", () => {
    const alphabet = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

    for (let pairIndex = 0; pairIndex < 300; pairIndex += 1) {
      const leftTokens = alphabet.filter((_unused, index) => ((pairIndex >> index) & 1) === 1);
      const rightTokens = alphabet.filter((_unused, index) => (((pairIndex * 7 + 3) >> index) & 1) === 1);

      expect(jaccardBasisPoints(leftTokens, rightTokens)).toBe(jaccardBasisPoints(rightTokens, leftTokens));
    }
  });

  it("collapses duplicates, because Jaccard is defined on sets", () => {
    // A raw (non-deduplicated) list must score the same as its deduplicated form.
    expect(jaccardBasisPoints(["pothole", "pothole", "drain"], ["pothole", "drain"])).toBe(BASIS_POINTS_TOTAL);
    expect(jaccardBasisPoints(["a", "a", "a"], ["a", "b"])).toBe(5_000);
  });

  it("stays within 0..10000 over many deterministic inputs", () => {
    const alphabet = ["pothole", "drain", "streetlight", "water", "bridge", "﨎", "\u{10428}", "水", "café", "sewer"];

    for (let pairIndex = 0; pairIndex < 1_000; pairIndex += 1) {
      // Both sides derived from the loop index — no Math.random, so a failure replays.
      const leftWords = Array.from(
        { length: pairIndex % 6 },
        (_unused, wordIndex) => alphabet[(pairIndex + wordIndex) % alphabet.length] ?? "",
      );
      const rightWords = Array.from(
        { length: (pairIndex * 3) % 7 },
        (_unused, wordIndex) => alphabet[(pairIndex * 5 + wordIndex * 2) % alphabet.length] ?? "",
      );

      const score = jaccardBasisPoints(
        normalizeToTokenSet(leftWords.join(" ")),
        normalizeToTokenSet(rightWords.join(" ")),
      );

      expect(Number.isSafeInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(BASIS_POINTS_TOTAL);
    }
  });

  it("produces a bit-identical score on repeated runs of the same input", () => {
    // §4c: one server run twice must agree. Any float or locale dependency in the
    // pipeline would show up as drift here.
    const leftText = "Overflowing sewer near the Café on 5th — smells awful!";
    const rightText = "sewer OVERFLOWING near café, 5th street";

    const firstScore = jaccardBasisPoints(normalizeToTokenSet(leftText), normalizeToTokenSet(rightText));
    for (let runIndex = 0; runIndex < 100; runIndex += 1) {
      expect(jaccardBasisPoints(normalizeToTokenSet(leftText), normalizeToTokenSet(rightText))).toBe(firstScore);
    }
  });
});

describe("TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS", () => {
  it("is a whole-number basis-point value inside the representable range", () => {
    expect(TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS).toBe(3_000);
    expect(Number.isSafeInteger(TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS)).toBe(true);
    expect(TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS).toBeGreaterThan(0);
    expect(TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS).toBeLessThan(BASIS_POINTS_TOTAL);
  });

  it("merges two reports of the same problem and declines two unrelated ones", () => {
    const brokenStreetlight = normalizeToTokenSet("The streetlight on Elm Road is broken");
    const sameProblemRestated = normalizeToTokenSet("broken streetlight, Elm Road");
    const unrelatedProblem = normalizeToTokenSet("Well water tastes contaminated in Sector 9");

    expect(jaccardBasisPoints(brokenStreetlight, sameProblemRestated)).toBeGreaterThanOrEqual(
      TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS,
    );
    expect(jaccardBasisPoints(brokenStreetlight, unrelatedProblem)).toBeLessThan(
      TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS,
    );
  });

  it("declines to merge two content-free reports", () => {
    // The empty-union guard returning 10000 instead of 0 would collapse every
    // content-free report into one cluster; this is the test that would catch it.
    expect(jaccardBasisPoints(normalizeToTokenSet("..."), normalizeToTokenSet("the"))).toBeLessThan(
      TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS,
    );
  });
});
