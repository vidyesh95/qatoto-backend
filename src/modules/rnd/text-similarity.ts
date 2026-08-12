/**
 * Deterministic text similarity for problem-report clustering.
 *
 * Why this module exists instead of `pg_trgm`'s `similarity()`:
 *
 *   1. `similarity()` returns `real` — a 4-byte FLOAT. Comparing a float against a
 *      threshold is exactly the class of decision that can land differently on two
 *      machines, and a clustering decision is a permanent, user-visible fact.
 *   2. Its value depends on the pg_trgm EXTENSION VERSION, not just on the input. A
 *      Postgres minor upgrade that ships a new pg_trgm would silently re-score every
 *      pair, so re-running the clusterer over untouched history could split or merge
 *      clusters that a human already curated. Nothing in the schema would record that
 *      the definition of "similar" had moved.
 *
 * So similarity is computed in TypeScript, over integers, with a fixed algorithm that
 * lives in version control. If the definition of "similar" must change, that is a code
 * change with a diff and a migration plan.
 *
 * THE SCOPE OF THAT GUARANTEE, stated honestly, because the paragraph above is easy to
 * over-read: what is pinned is the ARITHMETIC. Given two token sets, the score is exact
 * integer maths and is bit-identical on every machine and every runtime, forever.
 *
 * TOKENIZATION is not equally pinned — it depends on the Unicode data in the runtime's
 * ICU, so this module reduces the pg_trgm problem rather than eliminating it:
 *
 *   - `\p{C}` in TOKEN_SEPARATOR_PATTERN includes Cn (UNASSIGNED). A codepoint therefore
 *     SEPARATES tokens until Unicode assigns it and stops separating afterwards. Worked
 *     example, pinned by a test: U+30000 was unassigned until Unicode 13.0 and is a CJK
 *     ideograph now, so "pothole<U+30000>drain" is two tokens on an older Node and one
 *     token on a current one. Newly assigned emoji move the same way through `\p{S}`.
 *   - NFKC is stable for ASSIGNED characters under the Unicode Normalization Stability
 *     Policy, but a codepoint that is unassigned today can be assigned tomorrow WITH a
 *     compatibility decomposition, changing the NFKC form of a string containing it.
 *
 * The practical exposure is small — real problem reports rarely contain unassigned
 * codepoints — but it is not zero, and it is the same SHAPE of bug as the pg_trgm one:
 * a dependency upgrade silently re-scoring history. Treat a Node major as a potential
 * re-cluster event, pin the runtime alongside this code, and if the tripwire test in
 * text-similarity.test.ts fails after an upgrade, decide whether to re-cluster stored
 * reports rather than updating the snapshot.
 *
 * Everything here is integer-only (R_AND_D_BACKEND_STRUCTURE.md §4c): the score is
 * basis points via `basisPointsOf`, never a ratio in a `number`.
 */

import { basisPointsOf } from "#src/lib/money.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";

/**
 * Tokens carrying no discriminating signal about WHICH problem is being described.
 *
 * Kept deliberately small. A long stopword list is a slow, invisible tuning knob: every
 * word added silently raises the similarity of every pair that shared it, so a big list
 * has to be re-validated against real reports rather than assembled from intuition.
 *
 * NEGATION WORDS ARE DELIBERATELY ABSENT. "not", "no", "nor", "never", "without" all
 * fail this list's own admission test: a negation inverts the predicate, so it is
 * exactly a signal about WHICH problem is being described. "water is safe" and "water
 * is not safe" are opposite reports; dropping "not" scored them 10000 and made a false
 * merge certain, which is the outcome TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS is
 * explicitly tuned to avoid.
 *
 * Keeping them is a mitigation, NOT a fix. It moves that pair from 10000 to 6667 —
 * still far above the 3000 threshold, so the two reports STILL merge. Bag-of-words
 * Jaccard has no representation of scope or negation at all, and no stopword edit can
 * give it one. Detecting "same subject, opposite claim" needs a different signal
 * (a negation-scope pass, or a model) layered on top of this score.
 *
 * KNOWN LIMITATION, not an oversight: this list is English-only. A Hindi or Marathi
 * report keeps its function words, which inflates the similarity of any two reports in
 * that language relative to two English ones. The alternative — shipping half-checked
 * lists for languages nobody here can validate — trades a measurable bias for an
 * unmeasurable one. Fix this by adding a language-tagged list per locale once reports
 * actually carry a language tag, and re-cluster deliberately when you do.
 */
const ENGLISH_STOPWORD_SET: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "very",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
  "your",
]);

/**
 * Apostrophe-like marks, deleted rather than treated as a word boundary.
 *
 * "don't" must become one token `dont`, not `don` + `t`; a stray one-letter `t` is a
 * token that matches every other contraction in the corpus and quietly inflates scores.
 * Both the ASCII apostrophe and U+2019 (what word processors and phone keyboards emit)
 * are listed because NFKC does NOT fold one into the other — they are distinct
 * characters, and only one of them would be handled if you trusted normalization here.
 */
const INTRA_WORD_MARK_PATTERN = /['‘’ʻʼ]/gu;

/**
 * Everything that separates one token from the next.
 *
 * Punctuation is a SEPARATOR, not a deletion: `"pothole,streetlight"` (a comma with no
 * space, which real user input is full of) must yield two tokens. Deleting the comma
 * instead would manufacture the single token `potholestreetlight`, which matches nothing
 * and drops both real tokens out of the comparison.
 *
 * `\p{C}` is included so zero-width and control characters cannot glue two words into
 * one token — the failure mode where a copy-pasted report never matches its own retype.
 */
const TOKEN_SEPARATOR_PATTERN = /[\s\p{Z}\p{P}\p{S}\p{C}]+/u;

/**
 * Score at or above which two reports are treated as the same problem.
 *
 * 30% Jaccard overlap on content words is a deliberately LOW bar, because the two
 * mistakes are not symmetric: a false merge destroys a distinct report (the reporter's
 * detail is gone from the map), while a false split leaves two clusters a moderator can
 * join later. This threshold is tuned to over-split.
 *
 * Treat this as a versioned policy constant. Changing it changes how already-stored
 * history clusters, so a change belongs with a decision about whether to re-cluster
 * existing reports or freeze them — never as a quiet tweak.
 */
export const TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS = 3_000;

/**
 * Reduces free text to the canonical, deduplicated, byte-sorted token set used for
 * comparison.
 *
 * The pipeline is NFKC → lowercase → NFKC → strip apostrophes → split → drop stopwords →
 * dedupe → sort. Three of those steps exist to defuse a specific trap:
 *
 *   - NFKC runs TWICE because case folding can leave a string denormalized (a few
 *     characters lowercase into sequences that have a shorter NFKC form). One pass would
 *     mean two inputs that should be identical differ by a byte and share zero tokens.
 *   - `toLowerCase`, never `toLocaleLowerCase`: the locale-aware variant maps `I` to the
 *     dotless `ı` under a Turkish locale, so the same report would tokenize differently
 *     depending on the server's environment. That is precisely the non-determinism this
 *     module exists to remove.
 *   - The sort is `compareUtf8Bytes`, never `<`. `<` compares UTF-16 code units, which
 *     disagrees with Postgres `COLLATE "C"` for any astral character (emoji, rare CJK) —
 *     and the token set is meant to be reproducible whether it is built here or ordered
 *     by the database.
 *
 * Returns an empty array when the input holds no content words. That is a legitimate
 * result ("the", "and it is"), not an error, and `jaccardBasisPoints` is defined for it.
 */
export function normalizeToTokenSet(text: string): readonly string[] {
  const caseFoldedText = text.normalize("NFKC").toLowerCase().normalize("NFKC");
  const withoutIntraWordMarks = caseFoldedText.replace(INTRA_WORD_MARK_PATTERN, "");

  const distinctContentTokens = new Set<string>();
  for (const candidateToken of withoutIntraWordMarks.split(TOKEN_SEPARATOR_PATTERN)) {
    if (candidateToken.length === 0 || ENGLISH_STOPWORD_SET.has(candidateToken)) {
      continue;
    }
    distinctContentTokens.add(candidateToken);
  }

  return [...distinctContentTokens].toSorted(compareUtf8Bytes);
}

/**
 * Jaccard overlap — |intersection| / |union| — in basis points, 0 to 10000 inclusive.
 *
 * Both arguments are re-collected into sets rather than trusted to be deduplicated.
 * Jaccard is defined on SETS: if a caller hands over a raw token list where "pothole"
 * appears three times, counting multiplicities would inflate the union and understate
 * the score. Passing `normalizeToTokenSet` output makes the extra pass a no-op; passing
 * anything else still gets the right answer.
 *
 * Tokens are matched by exact string equality, so both sides must have come through the
 * same normalization. Comparing a normalized set against a raw one silently scores near
 * zero rather than failing, which is the one misuse this signature cannot prevent.
 *
 * Never throws. `basisPointsOf` throws on a zero whole, and an empty union is exactly
 * that case — see the guard below for why 0 is the answer instead.
 */
export function jaccardBasisPoints(left: readonly string[], right: readonly string[]): number {
  const leftTokenSet = new Set(left);
  const rightTokenSet = new Set(right);

  let intersectionSize = 0;
  for (const leftToken of leftTokenSet) {
    if (rightTokenSet.has(leftToken)) {
      intersectionSize += 1;
    }
  }

  const unionSize = leftTokenSet.size + rightTokenSet.size - intersectionSize;

  // Two empty token sets. "How similar are two empty strings" has no meaningful answer,
  // and this is a CLUSTERING decision, so the safe default is the one that declines to
  // act: 0 keeps every content-free report in its own cluster. Returning 10000 would
  // make every content-free report identical to every other one and collapse them into
  // a single meaningless cluster; letting basisPointsOf throw would turn an ordinary
  // user input ("...") into a 500.
  if (unionSize === 0) {
    return 0;
  }

  return basisPointsOf(BigInt(intersectionSize), BigInt(unionSize));
}
