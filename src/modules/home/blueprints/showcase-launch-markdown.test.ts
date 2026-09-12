import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";

import { extractWriteUpImageAddresses } from "#src/modules/home/blueprints/showcase-launch-markdown.js";

/**
 * UNIT tests for the write-up image extractor — the gate that decides whether an image a maker
 * embedded is one of their own uploads.
 *
 * NOTHING IS MOCKED, AND mdast/micromark ARE DELIBERATELY REAL. The rule this function feeds is
 * only a rule if the server and the frontend's `react-markdown` + `remark-gfm` agree on what an
 * image IS; stubbing the parser would test a different agreement than the one that ships. Every
 * case below is one half of that agreement:
 *
 *   * the "a regex MISSES this" cases (reference images, angle brackets, escapes) are the ways
 *     past the check that would make every reader's browser call a host nobody approved;
 *   * the "a regex FINDS this" cases (code spans, fenced blocks) are the write-ups a regex would
 *     wrongly refuse — a maker documenting Markdown syntax.
 *
 * A THIRD GROUP was added after this surface answered 500 in production shape: the depth case and
 * the `describe` at the foot of this file, which pin the PARSER CONFIGURATION rather than the
 * parse. The module under test strips GFM's recursive tree transform, and nothing reachable
 * through its public API can tell you whether that is still true.
 */

describe("extractWriteUpImageAddresses", () => {
  it("returns nothing for a write-up with no images", () => {
    expect(extractWriteUpImageAddresses("Just a paragraph about a solar dryer.")).toEqual([]);
  });

  it("returns nothing for an empty write-up", () => {
    expect(extractWriteUpImageAddresses("")).toEqual([]);
  });

  it("finds a plain inline image address", () => {
    expect(extractWriteUpImageAddresses("![The dryer](https://cdn.test/dryer.avif)")).toEqual([
      "https://cdn.test/dryer.avif",
    ]);
  });

  it("keeps inline images in source order", () => {
    const writeUp = [
      "![One](https://cdn.test/one.avif)",
      "",
      "Some prose in between.",
      "",
      "![Two](https://cdn.test/two.avif)",
      "",
      "![Three](https://cdn.test/three.avif)",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([
      "https://cdn.test/one.avif",
      "https://cdn.test/two.avif",
      "https://cdn.test/three.avif",
    ]);
  });

  it("de-duplicates a repeated address", () => {
    const writeUp = "![First](https://cdn.test/one.avif)\n\n![Again](https://cdn.test/one.avif)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/one.avif"]);
  });

  /**
   * The first way past a regex. `![alt][label]` carries no address at all — it is somewhere else
   * in the document, possibly far below the image.
   */
  it("resolves a reference-style image through its definition", () => {
    const writeUp = "![The dryer][dryer]\n\n[dryer]: https://elsewhere.test/dryer.png";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://elsewhere.test/dryer.png"]);
  });

  it("matches a reference label case-insensitively, as CommonMark does", () => {
    const writeUp = "![The dryer][Dryer]\n\n[dryer]: https://elsewhere.test/dryer.png";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://elsewhere.test/dryer.png"]);
  });

  /** CommonMark: the FIRST definition of a label wins and later duplicates are ignored. */
  it("takes the first definition when a label is defined twice", () => {
    const writeUp = [
      "![The dryer][dryer]",
      "",
      "[dryer]: https://cdn.test/mine.avif",
      "[dryer]: https://elsewhere.test/theirs.png",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/mine.avif"]);
  });

  /** No definition means the renderer shows literal text, so there is no address to vet. */
  it("returns nothing for a reference with no matching definition", () => {
    expect(extractWriteUpImageAddresses("![The dryer][missing]")).toEqual([]);
  });

  /**
   * REFERENCE ADDRESSES ARRIVE AFTER THE INLINE ONES, not in source order.
   *
   * The walk collects `image` nodes as it goes and resolves `imageReference` identifiers in a
   * second pass after the loop, so the returned order is "every inline address, then every
   * referenced address". The function's docblock says so explicitly — order is not part of its
   * contract. Pinned here because the only caller compares a count and a set, where order cannot
   * matter, so nothing else would notice if this changed; a future caller rendering a gallery from
   * this list needs to know it must sort first.
   */
  it("returns reference-resolved addresses after the inline ones, not in source order", () => {
    const writeUp = [
      "![Reference first][ref]",
      "",
      "![Inline second](https://cdn.test/inline.avif)",
      "",
      "[ref]: https://cdn.test/referenced.avif",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([
      "https://cdn.test/inline.avif",
      "https://cdn.test/referenced.avif",
    ]);
  });

  /** The second way past a regex: an address the parser unwraps and a pattern would not. */
  it("reads an angle-bracketed address", () => {
    const writeUp = "![The dryer](<https://cdn.test/dryer build.avif>)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/dryer build.avif"]);
  });

  /** The third way: an entity or numeric escape the parser decodes before the address is real. */
  it("decodes an entity escape inside an address", () => {
    const writeUp = "![The dryer](https://cdn.test/dryer&#x2E;avif)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/dryer.avif"]);
  });

  /** The first way a regex over-refuses: syntax a maker is documenting, not rendering. */
  it("ignores an image inside a code span", () => {
    expect(extractWriteUpImageAddresses("Write `![alt](https://elsewhere.test/x.png)` for an image.")).toEqual([]);
  });

  it("ignores an image inside a fenced block", () => {
    const writeUp = ["```markdown", "![alt](https://elsewhere.test/x.png)", "```"].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([]);
  });

  /** The renderer runs with `skipHtml`, so refusing this would refuse something nobody sees. */
  it("ignores a raw HTML img tag, which the renderer never shows", () => {
    expect(extractWriteUpImageAddresses('<img src="https://elsewhere.test/x.png" alt="x">')).toEqual([]);
  });

  /** Proves the walk is total and the gfm extension is actually wired in. */
  it("finds an image nested in a list inside a blockquote inside a GFM table cell", () => {
    const writeUp = [
      "| Step | Evidence |",
      "| --- | --- |",
      "| Dry run | ![Run](https://cdn.test/run.avif) |",
      "",
      "> - A note",
      ">   - ![Nested](https://cdn.test/nested.avif)",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([
      "https://cdn.test/run.avif",
      "https://cdn.test/nested.avif",
    ]);
  });

  /**
   * THE DEEPEST BLOCKQUOTE THE SCHEMA CAN EXPRESS, at exactly the size it allows.
   *
   * Nesting is where a markdown parser meets a call stack. 9,964 `>` characters plus the shortest
   * useful image is exactly 10,000 — the largest `writeUp` `ShowcaseLaunchDraftSchema` accepts — so
   * this is the worst input a maker can actually send, derived from the cap rather than chosen
   * near it. The length is asserted so the number cannot drift away from that reasoning.
   *
   * A REGRESSION LOCK, NOT A CAPABILITY CLAIM. Until the module under test stopped running GFM's
   * recursive autolink transform, 5,630 levels — a 5,658-character write-up, comfortably inside
   * the cap — threw `RangeError: Maximum call stack size exceeded`, and the route answered 500 to
   * a launch the schema had already accepted. Anything that puts a recursive tree walk back into
   * that parse fails here first.
   */
  it("extracts from the deepest blockquote the ten-thousand-character cap allows", () => {
    const maximallyNestedWriteUp = `${">".repeat(9_964)} ![Deep](https://cdn.test/deep.avif)`;

    expect(maximallyNestedWriteUp).toHaveLength(10_000);
    expect(extractWriteUpImageAddresses(maximallyNestedWriteUp)).toEqual(["https://cdn.test/deep.avif"]);
  });

  /**
   * THE PROPERTY THAT MAKES DROPPING THE AUTOLINK TRANSFORM SAFE, asserted rather than argued. A
   * bare URL is a link to the renderer and to nobody here — even one ending in `.png`. This gate
   * vets images, and a URL sitting in prose is not one.
   */
  it("ignores a bare URL beside a real image, even one that looks like an image file", () => {
    const writeUp = "See https://elsewhere.test/photo.png ![Real](https://cdn.test/real.avif)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/real.avif"]);
  });

  it("still resolves a reference image in a table cell that also holds a www autolink", () => {
    const writeUp = [
      "| Source | Evidence |",
      "| --- | --- |",
      "| www.maker.test | ![Run][run] |",
      "",
      "[run]: https://cdn.test/run.avif",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/run.avif"]);
  });
});

/**
 * THE ASSUMPTION THE MODULE UNDER TEST MAKES ABOUT ITS DEPENDENCY, restated here on purpose.
 *
 * `showcase-launch-markdown.ts` strips `transforms` from GFM's mdast extensions because exactly one
 * of them — autolink literals — walks the finished tree recursively. It asserts that at module load
 * and refuses to boot otherwise. This is the same assertion somewhere that fails during `pnpm gate`
 * rather than during a deploy: if an upgrade adds a tree transform to another extension, or moves
 * autolink detection out of micromark's tokenizer and into the transform, this says so by name.
 */
describe("the GFM mdast extensions this module reconfigures", () => {
  it("gives autolink literals the only tree transform among the five", () => {
    const gfmExtensions = gfmFromMarkdown();
    const extensionsCarryingTreeTransforms = gfmExtensions.filter(
      (extension) => (extension.transforms?.length ?? 0) > 0,
    );

    expect(gfmExtensions).toHaveLength(5);
    expect(extensionsCarryingTreeTransforms).toHaveLength(1);
    expect(extensionsCarryingTreeTransforms[0]?.enter?.literalAutolink).toBeTypeOf("function");
  });

  /**
   * Bare URLs are recognised by micromark's TOKENIZER, not by the stripped transform — which is
   * why removing the transform costs no text. If this ever fails, the transform has become
   * load-bearing and the module under test is silently dropping link content.
   */
  it("keeps building link nodes from micromark's tokens without the transform", () => {
    const extensionsWithoutTreeTransforms = gfmFromMarkdown().map((extension) => ({
      ...extension,
      transforms: undefined,
    }));

    const tree = fromMarkdown("Visit https://example.test/x now.", {
      extensions: [gfm()],
      mdastExtensions: [...extensionsWithoutTreeTransforms],
    });

    expect(JSON.stringify(tree)).toContain('"type":"link"');
    expect(JSON.stringify(tree)).toContain("https://example.test/x");
  });
});
