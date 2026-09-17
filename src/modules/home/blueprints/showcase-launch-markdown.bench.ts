import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import { extractWriteUpImageAddresses } from "#src/modules/home/blueprints/showcase-launch-markdown.js";
import { BENCHMARK_OPTIONS } from "#src/test-support/bench-fixtures.js";

/**
 * The only CommonMark parse on a request path.
 *
 * `POST /blueprints/showcases` runs this over a write-up of up to 10 000 characters to prove that
 * every image a reader's browser will fetch is one of the maker's own uploads. It is a full
 * micromark tokenize plus an mdast compile plus an iterative walk of the tree — several orders of
 * magnitude more work than anything else on that route, and the one place where an upgrade of
 * `micromark-extension-gfm` or `mdast-util-gfm` could change the cost of a route without a single
 * line of this repository changing.
 *
 * THE DEEP-NESTING CASE IS DELIBERATE. A recursive tree transform used to overflow the stack at
 * ~5 600 nested blockquotes, well under the field's character cap, and the fix was to strip that
 * transform rather than to bound the input. Keeping a deeply nested write-up in the benchmark set
 * means the cost of that shape is tracked rather than rediscovered.
 */

/** A write-up at the field's 10 000-character cap, in the shape makers actually submit. */
function buildLaunchWriteUp(): string {
  const sections: string[] = [
    "# Bringing the Mark III workshop press to market",
    "",
    "We spent fourteen months getting the frame tolerance under 0.05 mm. Here is what that took,",
    "what it cost, and what we would do differently on the next revision.",
    "",
    "![Assembled press on the shop floor](https://cdn.qatoto.com/showcases/mark-iii/hero.jpg)",
    "",
  ];

  for (let sectionIndex = 0; sectionIndex < 12; sectionIndex += 1) {
    sections.push(
      `## Iteration ${String(sectionIndex + 1)}`,
      "",
      "The die stack was re-cut twice. The second cut held, the first did not, and the difference",
      "was the feed rate rather than the tooling — which is not what the supplier told us.",
      "",
      `![Iteration ${String(sectionIndex + 1)} teardown](https://cdn.qatoto.com/showcases/mark-iii/iteration-${String(sectionIndex + 1)}.png "teardown")`,
      "",
      "| Part | Supplier | Lead time |",
      "| --- | --- | --- |",
      "| Frame | Local | 9 days |",
      "| Die stack | Imported | 41 days |",
      "",
      "> A quote from the workshop lead about the *second* cut, with `inline code`,",
      "> a [link](https://qatoto.com/blueprints) and a trailing note.",
      "",
      "```ts",
      "// Not an image, and the parser must agree: ![nope](https://example.com/not-rendered.png)",
      "const feedRate = 0.42;",
      "```",
      "",
      `![Reference-style figure][figure-${String(sectionIndex + 1)}]`,
      "",
    );
  }

  for (let sectionIndex = 0; sectionIndex < 12; sectionIndex += 1) {
    sections.push(
      `[figure-${String(sectionIndex + 1)}]: https://cdn.qatoto.com/showcases/mark-iii/figure-${String(sectionIndex + 1)}.webp`,
    );
  }

  return sections.join("\n");
}

const LAUNCH_WRITE_UP = buildLaunchWriteUp();

/** The short form: a paragraph and one inline image, which is the median submission. */
const SHORT_WRITE_UP = [
  "A one-paragraph launch note about the press, with a single figure.",
  "",
  "![Press](https://cdn.qatoto.com/showcases/mark-iii/hero.jpg)",
].join("\n");

/** The shape that used to overflow the stack, at a depth a launch write-up can actually reach. */
const DEEPLY_NESTED_WRITE_UP = `${"> ".repeat(1000)}![Buried](https://cdn.qatoto.com/showcases/mark-iii/buried.png)`;

export const showcaseLaunchMarkdownBenchmarks = withCodSpeed(
  new Bench({ name: "showcase-launch-markdown", ...BENCHMARK_OPTIONS }),
);

showcaseLaunchMarkdownBenchmarks.add("extractWriteUpImageAddresses — median write-up", () => {
  extractWriteUpImageAddresses(SHORT_WRITE_UP);
});

showcaseLaunchMarkdownBenchmarks.add(
  "extractWriteUpImageAddresses — write-up at the character cap",
  () => {
    extractWriteUpImageAddresses(LAUNCH_WRITE_UP);
  },
);

showcaseLaunchMarkdownBenchmarks.add(
  "extractWriteUpImageAddresses — 1000 nested blockquotes",
  () => {
    extractWriteUpImageAddresses(DEEPLY_NESTED_WRITE_UP);
  },
);
