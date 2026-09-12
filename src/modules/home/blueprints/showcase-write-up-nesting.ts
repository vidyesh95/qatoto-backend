/**
 * How deeply a write-up nests block containers — quotes, lists and footnote definitions.
 *
 * ⚠️ A DELIBERATE COPY of the frontend's
 * `qatoto-frontend/src/lib/blueprints/showcase-write-up-nesting.ts`.
 * Everything below this comment is identical in both files, down to the constant; only the
 * pointer above differs. There is no package shared between the two repositories, so they are
 * kept in step by hand and diffed when either changes — a test on each side pins the constant,
 * so the two cannot drift silently.
 *
 * WHY A WRITE-UP NEEDS A SECOND SHAPE RULE, when it already has a character cap and a markup cap.
 * Nesting is where a markdown parser meets a call stack, and the character cap does not bound it —
 * one marker character buys one level. Measured on this machine, all UNDER the 10,000-character
 * cap and all accepted before this rule existed:
 *
 *   `"- ".repeat(4900)`    7,073 ms of synchronous parse on the server
 *   `"-\t".repeat(4900)`  10,273 ms
 *   `"1. ".repeat(3300)`     458 ms
 *
 * Ten seconds is single-threaded and blocks every other request in flight. The markup cap does not
 * catch any of them: it counts `*`, `_`, `[` and `]`, and the expensive markers here are `-`, `+`
 * and the ordered ones.
 *
 * AND THE READER'S BROWSER, which is the half this server cannot see. The frontend renders a
 * write-up with `react-markdown` + `remark-gfm`, which still runs the recursive tree transform
 * `showcase-launch-markdown.ts` strips here. Against the frontend's own installed copies,
 * `">".repeat(6000)`, `"- ".repeat(4900)`, `"+ ".repeat(3200)` and `"1. ".repeat(3333)` all throw
 * `RangeError: Maximum call stack size exceeded` — so a launch this server stored happily would
 * blank the page of every reader and moderator who opened it. A row that cannot be rendered is
 * worse than one that was never posted, which is why this refuses rather than truncates.
 *
 * THE OPENER ALPHABET IS CLOSED, and that is what makes this scanner complete rather than a list of
 * shapes that happened to be tried. micromark's `document` construct table is exactly `42 (*)`,
 * `43 (+)`, `45 (-)`, `48-57 (digits)` and `62 (>)`; `micromark-extension-gfm` adds exactly one
 * more, `91 ([`, from its footnote extension. Nothing else can open a block container, so nothing
 * else can add a level. `showcase-write-up-nesting.test.ts` pins both of those key sets, so a
 * dependency upgrade that adds a container fails the gate rather than opening a silent bypass.
 */

/**
 * The deepest a write-up may nest block containers.
 *
 * WHY 32, AND WHY IT CANNOT BE RAISED BY EYE. Real content scores 0 to 4 — a four-deep quote is an
 * email chain someone pasted, and a list holding a sub-list holding a quote still scores 1. The
 * renderer's ceiling is roughly 2,600 levels, measured on a full render rather than a parse, which
 * is about half what parsing alone survives; a browser's stack is tighter still than Node's.
 *
 * The number is not the depth, though. Indentation alone also nests, without any marker for this
 * scanner to count, and it costs about d² characters to reach depth d — so the character cap bounds
 * that route at about 98 levels on its own. The relation to keep in mind is:
 *
 *   reachable depth ≈ this cap + sqrt(2 × the character cap)
 *
 * At 32 that is roughly 262, about ten times under the renderer's ceiling. At 1,000 — which sounds
 * conservative — it would be roughly 2,100, inside the band where the renderer dies.
 */
export const MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH = 32;

/** CommonMark's limit on an ordered list marker's start number. */
const MAXIMUM_ORDERED_MARKER_DIGITS = 9;

/** Space or tab, the two characters markdown lets follow a list marker. Undefined means line end. */
function isMarkerDelimiter(character: string | undefined): boolean {
  return character === undefined || character === " " || character === "\t";
}

/**
 * The deepest run of block-container openers on any one line.
 *
 * A LINEAR SCAN, NOT A PARSE, because the thing it protects is the parse. It deliberately
 * over-counts in two harmless places — `- - -` is a thematic break rather than three lists, and
 * `[ref]: https://…` is a link definition rather than a container — and neither goes anywhere near
 * the cap. Over-counting refuses a document that would have been fine; under-counting ships the
 * bypass, so the scanner leans the first way on purpose.
 */
export function deepestWriteUpNestingDepth(writeUp: string): number {
  let deepestDepth = 0;

  // Split on all three line endings: micromark treats a bare `\r` as one, and a write-up arrives as
  // a JSON string that carries whatever the maker's editor produced.
  for (const line of writeUp.split(/\r\n|\r|\n/)) {
    let openerCount = 0;
    let cursor = 0;

    while (cursor < line.length) {
      const character = line[cursor];

      // Indentation between markers belongs to the container that opened before it.
      if (character === " " || character === "\t") {
        cursor += 1;
        continue;
      }

      if (character === ">") {
        openerCount += 1;
        cursor += 1;
        continue;
      }

      if (character === "-" || character === "*" || character === "+") {
        if (!isMarkerDelimiter(line[cursor + 1])) break;
        openerCount += 1;
        cursor += 2;
        continue;
      }

      if (character !== undefined && character >= "0" && character <= "9") {
        let digitCount = 0;
        while (cursor + digitCount < line.length) {
          const digit = line[cursor + digitCount];
          if (digit === undefined || digit < "0" || digit > "9") break;
          digitCount += 1;
        }
        const delimiter = line[cursor + digitCount];
        if (
          // CommonMark caps an ordered marker at nine digits, so `1234567890.` is a paragraph
          // beginning with a number rather than a list. Counting it would be a harmless over-count,
          // but matching the parser keeps the scanner's claim about the opener alphabet honest.
          digitCount > MAXIMUM_ORDERED_MARKER_DIGITS ||
          (delimiter !== "." && delimiter !== ")") ||
          !isMarkerDelimiter(line[cursor + digitCount + 1])
        ) {
          break;
        }
        openerCount += 1;
        cursor += digitCount + 2;
        continue;
      }

      // `[^1]: ` opens a footnote definition, and everything after it on the line is block content.
      // They chain — `[^1]: [^2]: [^3]: …` is a level each — so the scan resumes past the colon
      // rather than stopping, and it steps over backslash escapes the way micromark's label does.
      if (character === "[") {
        let labelCursor = cursor + 1;
        while (labelCursor < line.length) {
          if (line[labelCursor] === "\\") {
            labelCursor += 2;
            continue;
          }
          if (line[labelCursor] === "]") break;
          labelCursor += 1;
        }
        if (line[labelCursor] !== "]" || line[labelCursor + 1] !== ":") break;
        openerCount += 1;
        cursor = labelCursor + 2;
        continue;
      }

      break;
    }

    if (openerCount > deepestDepth) deepestDepth = openerCount;
  }

  return deepestDepth;
}
