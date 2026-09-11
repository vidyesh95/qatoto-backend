import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * Every image address a launch write-up would render, in source order, without duplicates.
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
 * ITERATIVE, NOT RECURSIVE. A write-up is at most 10,000 characters, and ten thousand `>`
 * characters is a blockquote nested ten thousand deep — deep enough to overflow a recursive
 * walk's call stack on attacker-shaped input.
 */
export function extractWriteUpImageAddresses(markdown: string): readonly string[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
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
