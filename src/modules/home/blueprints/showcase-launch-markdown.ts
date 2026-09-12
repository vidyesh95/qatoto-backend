import type { Nodes } from "mdast";
import { fromMarkdown, type Extension as MdastExtension } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * GFM's mdast extensions with every TREE TRANSFORM removed, built once at module load.
 *
 * WHAT A TRANSFORM IS, AND WHY EXACTLY ONE IS A HAZARD HERE. `gfmFromMarkdown()` returns five
 * extensions. Four are event handlers, driven iteratively by `mdast-util-from-markdown`'s compile
 * loop. The fifth — autolink literals — additionally carries a `transforms` entry that WALKS THE
 * FINISHED TREE RECURSIVELY (`mdast-util-find-and-replace` -> `unist-util-visit-parents`) to turn
 * bare URLs in text into links. Measured on this machine, that walk throws `RangeError: Maximum
 * call stack size exceeded` at 5,630 nested blockquotes — a write-up of 5,658 characters, well
 * UNDER this field's 10,000-character cap. So the input was accepted, reached here, and the throw
 * left `POST /blueprints/showcases` answering 500 to a launch the schema had already approved.
 *
 * WHY ONLY THE TRANSFORM IS DROPPED, RATHER THAN THE WHOLE EXTENSION. Its `enter`/`exit` handlers
 * are not recursive, and `micromark-extension-gfm` tokenizes `literalAutolink` regardless of what
 * this file does. Dropping the extension outright would leave those tokens unhandled and the URL
 * characters would VANISH FROM THE TREE — `"see https://host/x and"` parses to `"see  and"`. That
 * is a trap for any future reader of this parse, and it buys nothing this does not.
 *
 * WHY REMOVING IT IS SOUND FOR THE ONLY QUESTION THIS FILE ASKS. `mdast-util-find-and-replace`
 * visits `text` nodes and nothing else, and the autolink replacements return only `link` and
 * `text`. The transform therefore CANNOT create, remove or move an `image`, `imageReference` or
 * `definition` — the three node types the walk below reads. Its absence cannot change the answer.
 * Measured across 184 markdown shapes: the tree differs in 2, both a bare `www.` autolink hugging
 * a double quote, which micromark's tokenizer does not catch and the transform did. Both stay
 * `text` rather than becoming a `link`; no image address moves.
 *
 * ⚠️ DO NOT REUSE THIS PARSE TO VET LINK DESTINATIONS. It is deliberately not faithful about bare
 * URLs. A rule of the form "every link in a write-up points somewhere allowed" built on this
 * configuration would miss the autolinks the stripped transform used to find, while the renderer
 * still makes them clickable. Such a rule needs its own parse.
 */
function buildGfmMdastExtensionsWithoutTreeTransforms(): readonly MdastExtension[] {
  const gfmExtensions = gfmFromMarkdown();
  const extensionsCarryingTreeTransforms = gfmExtensions.filter(
    (extension) => (extension.transforms?.length ?? 0) > 0,
  );
  const [onlyExtensionCarryingTreeTransforms] = extensionsCarryingTreeTransforms;

  /*
   * A BOOT-TIME ASSERTION, NOT A PER-REQUEST ONE. If an upgrade moves the recursive walk somewhere
   * this file does not expect, the process must refuse to start rather than answer 500 to one
   * maker at a time. It counts transform-carrying extensions rather than naming autolink, so a
   * release that adds a recursive pass to a DIFFERENT extension is caught too;
   * `showcase-launch-markdown.test.ts` pins the same shape, so `pnpm gate` fails before a deploy.
   */
  if (
    extensionsCarryingTreeTransforms.length !== 1 ||
    onlyExtensionCarryingTreeTransforms?.enter?.literalAutolink === undefined
  ) {
    throw new Error(
      "buildGfmMdastExtensionsWithoutTreeTransforms: expected autolink literals to be the only " +
        `GFM mdast extension carrying a tree transform, found ${String(extensionsCarryingTreeTransforms.length)}`,
    );
  }

  // Spread-and-override rather than rebuilding field by field: `Extension` also carries
  // `canContainEols`, which strikethrough sets, and naming the fields would silently drop it on
  // the next upgrade.
  return gfmExtensions.map((extension) => ({ ...extension, transforms: undefined }));
}

const GFM_MDAST_EXTENSIONS_WITHOUT_TREE_TRANSFORMS = buildGfmMdastExtensionsWithoutTreeTransforms();

/**
 * Every image address a launch write-up would render, without duplicates.
 *
 * ORDER IS NOT PART OF THE CONTRACT, and the summary above used to claim it was. Inline images come
 * out in source order, but a reference image (`![a][ref]`) is resolved in a second pass and its
 * address is appended after ALL of them — so `![a][ref]` followed by `![b](url)` returns `url`
 * first. The only caller compares a count and a set membership, where order cannot matter. A caller
 * that needs source order has to sort it out here first, not assume it.
 *
 * THE SAME PARSER AS THE RENDERER, AND THAT IS THE WHOLE REASON THIS FILE HAS DEPENDENCIES.
 * The frontend renders a write-up with `react-markdown` + `remark-gfm`, which is micromark
 * underneath. The rule this feeds — "every image in a write-up is one of this maker's own
 * uploads" — is only a rule if the server and the renderer agree on what an image IS. A regex
 * disagrees in both directions:
 *
 *   * it MISSES images the renderer shows: a reference-style image (`![a][ref]` with
 *     `[ref]: https://elsewhere/x.png` further down), an `<angle-bracketed>` address, and any
 *     backslash or entity escape the parser decodes. Each of those is a way past the check that
 *     makes every reader's browser call a host nobody approved;
 *   * it FINDS images the renderer does not show — an `![x](y)` inside a code span or a fenced
 *     block — and would refuse a write-up that documents Markdown syntax.
 *
 * RAW HTML IS IGNORED ON PURPOSE. The renderer runs with `skipHtml`, so an `<img>` tag in a
 * write-up renders nothing, and refusing it here would refuse something no reader ever sees.
 *
 * THE WALK BELOW IS ITERATIVE — an explicit stack, no recursion — so a write-up's nesting depth
 * costs heap rather than call frames. That is necessary but was never sufficient: until the
 * extension list above stopped running GFM's recursive tree transform, a 5,658-character write-up
 * overflowed the stack before this loop ever ran. See that docblock for the measurements.
 */
export function extractWriteUpImageAddresses(markdown: string): readonly string[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    // Spread because `mdastExtensions` wants a mutable array and the module-level list is readonly.
    mdastExtensions: [...GFM_MDAST_EXTENSIONS_WITHOUT_TREE_TRANSFORMS],
  });

  const imageAddresses: string[] = [];
  const referencedIdentifiers: string[] = [];
  const definitionAddressesByIdentifier = new Map<string, string>();

  // A stack, so children are pushed in REVERSE to be visited in source order.
  const pendingNodes: Nodes[] = [tree];
  for (
    let pendingNode = pendingNodes.pop();
    pendingNode !== undefined;
    pendingNode = pendingNodes.pop()
  ) {
    switch (pendingNode.type) {
      case "image":
        imageAddresses.push(pendingNode.url);
        break;
      case "imageReference":
        referencedIdentifiers.push(pendingNode.identifier);
        break;
      case "definition":
        // CommonMark: the FIRST definition of a label wins, later duplicates are ignored.
        if (!definitionAddressesByIdentifier.has(pendingNode.identifier)) {
          definitionAddressesByIdentifier.set(pendingNode.identifier, pendingNode.url);
        }
        break;
      default:
        break;
    }

    if ("children" in pendingNode) {
      for (let childIndex = pendingNode.children.length - 1; childIndex >= 0; childIndex -= 1) {
        const childNode = pendingNode.children[childIndex];
        if (childNode !== undefined) pendingNodes.push(childNode);
      }
    }
  }

  // A reference with no matching definition renders as literal text, not an image, so it
  // contributes no address.
  for (const referencedIdentifier of referencedIdentifiers) {
    const definitionAddress = definitionAddressesByIdentifier.get(referencedIdentifier);
    if (definitionAddress !== undefined) imageAddresses.push(definitionAddress);
  }

  return [...new Set(imageAddresses)];
}
