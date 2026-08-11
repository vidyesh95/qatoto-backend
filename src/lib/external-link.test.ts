import { describe, expect, it } from "vitest";

import { extractExternalId, parseExternalLink, type ParsedExternalLink } from "#src/lib/external-link.js";

/**
 * A linked file has no bytes to scan and no size to measure, so the HOST is the entire
 * security model of the deferred object-storage path (§8). These tests exist to keep it
 * exact — a substring match or a missing scheme check would quietly make the allowlist
 * decorative.
 */

function expectAllowed(rawUrl: string): ParsedExternalLink {
  const parsed = parseExternalLink(rawUrl);
  if (!parsed.success) {
    throw new Error(`expected ${rawUrl} to be allowed, got ${parsed.error.type}`);
  }
  return parsed.value;
}

describe("parseExternalLink", () => {
  it("accepts the allowlisted hosts and reports their provider", () => {
    expect(expectAllowed("https://drive.google.com/file/d/abc123/view").provider).toBe("google_docs");
    expect(expectAllowed("https://github.com/qatoto/backend/commit/abc1234").provider).toBe("github");
    expect(expectAllowed("https://www.figma.com/file/KEY123/Board").provider).toBe("figma");
    expect(expectAllowed("https://www.dropbox.com/s/xyz/spec.pdf").provider).toBe("other");
    expect(expectAllowed("https://gitlab.com/group/repo/-/commit/abc").provider).toBe("gitlab");
  });

  it("accepts a workspace subdomain only through the leading-dot suffix rule", () => {
    expect(expectAllowed("https://team.notion.site/Spec-abc").provider).toBe("notion");
    // Without the leading dot in the suffix rule, this lookalike would pass.
    expect(parseExternalLink("https://evil-notion.site/x")).toStrictEqual({
      success: false,
      error: { type: "LINK_HOST_NOT_ALLOWED", host: "evil-notion.site" },
    });
  });

  it("refuses lookalike hosts in both directions", () => {
    // Suffix attack: the allowlisted name is a PREFIX of a domain someone else owns.
    expect(parseExternalLink("https://drive.google.com.evil.tld/x")).toStrictEqual({
      success: false,
      error: { type: "LINK_HOST_NOT_ALLOWED", host: "drive.google.com.evil.tld" },
    });
    // Path attack: the allowlisted name appears in the PATH, not the authority.
    expect(parseExternalLink("https://evil.tld/drive.google.com/x")).toStrictEqual({
      success: false,
      error: { type: "LINK_HOST_NOT_ALLOWED", host: "evil.tld" },
    });
  });

  it("refuses every scheme but https", () => {
    expect(parseExternalLink("http://github.com/a/b")).toStrictEqual({
      success: false,
      error: { type: "LINK_NOT_HTTPS", scheme: "http" },
    });
    // The two that would execute if they ever reached an href.
    expect(parseExternalLink("javascript:alert(1)")).toStrictEqual({
      success: false,
      error: { type: "LINK_NOT_HTTPS", scheme: "javascript" },
    });
    expect(parseExternalLink("data:text/html;base64,PHN2Zz4=")).toStrictEqual({
      success: false,
      error: { type: "LINK_NOT_HTTPS", scheme: "data" },
    });
  });

  it("refuses a string that is not a URL at all, rather than guessing a scheme", () => {
    expect(parseExternalLink("drive.google.com/file/d/abc")).toStrictEqual({
      success: false,
      error: { type: "LINK_UNPARSEABLE" },
    });
    expect(parseExternalLink("")).toStrictEqual({
      success: false,
      error: { type: "LINK_UNPARSEABLE" },
    });
  });

  it("strips credentials out of the stored URL", () => {
    // Otherwise a member's token lands in the workshop file list for the whole team.
    const parsed = expectAllowed("https://someone:s3cr3t@github.com/qatoto/backend");
    expect(parsed.normalizedUrl).not.toContain("s3cr3t");
    expect(parsed.normalizedUrl).not.toContain("someone");
    expect(parsed.normalizedUrl).toBe("https://github.com/qatoto/backend");
  });

  it("strips the fragment but keeps the query", () => {
    // ?usp=sharing and ?dl=0 are load-bearing parts of a share link; dropping them hands
    // the team a URL that 404s.
    const parsed = expectAllowed("https://drive.google.com/file/d/abc/view?usp=sharing#heading");
    expect(parsed.normalizedUrl).toBe("https://drive.google.com/file/d/abc/view?usp=sharing");
  });

  it("lowercases the host, so the allowlist cannot be bypassed by case", () => {
    expect(expectAllowed("https://GitHub.com/a/b").host).toBe("github.com");
  });

  it("refuses a URL past the column's length bound", () => {
    const tooLong = `https://github.com/${"a".repeat(2100)}`;
    expect(parseExternalLink(tooLong)).toStrictEqual({
      success: false,
      error: { type: "LINK_TOO_LONG", length: tooLong.length },
    });
  });
});

describe("extractExternalId", () => {
  it("reads a GitHub commit as owner/repo@sha", () => {
    const parsed = expectAllowed("https://github.com/qatoto/backend/commit/A1B2C3D4E5F6");
    // Lowercased: §9 dedupes artifacts on this value, and one commit must not fund two
    // members' claims because two people pasted it in different case.
    expect(extractExternalId(parsed)).toBe("qatoto/backend@a1b2c3d4e5f6");
  });

  it("reads a GitHub pull request as owner/repo#number", () => {
    const parsed = expectAllowed("https://github.com/qatoto/backend/pull/42");
    expect(extractExternalId(parsed)).toBe("qatoto/backend#42");
  });

  it("reads a Figma file key from both /file/ and /design/", () => {
    expect(extractExternalId(expectAllowed("https://www.figma.com/file/KEY123/Board"))).toBe("KEY123");
    expect(extractExternalId(expectAllowed("https://www.figma.com/design/KEY456/Board"))).toBe("KEY456");
  });

  it("reads a Google document id", () => {
    expect(extractExternalId(expectAllowed("https://docs.google.com/document/d/DOC789/edit"))).toBe("DOC789");
  });

  it("returns null rather than guessing when no id is present", () => {
    // A wrong id merges two distinct artifacts into one, which is worse than having none.
    expect(extractExternalId(expectAllowed("https://github.com/qatoto/backend"))).toBeNull();
    expect(extractExternalId(expectAllowed("https://www.dropbox.com/s/xyz/spec.pdf"))).toBeNull();
  });
});
