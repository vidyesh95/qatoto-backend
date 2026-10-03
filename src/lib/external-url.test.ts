import { describe, expect, it } from "vitest";

import { parseHttpsUrl } from "#src/lib/external-url.js";

describe("external-url", () => {
  it("accepts a valid https URL, lowercases the hostname, and keeps the query string", () => {
    const result = parseHttpsUrl("  https://EXAMPLE.com/path?ref=123&campaign=spring  ");

    expect(result).toEqual({
      success: true,
      value: "https://example.com/path?ref=123&campaign=spring",
    });
  });

  it("strips the URL hash fragment", () => {
    const result = parseHttpsUrl("https://example.com/page#section-2");

    expect(result).toEqual({
      success: true,
      value: "https://example.com/page",
    });
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(parseHttpsUrl("")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_EMPTY" },
    });
    expect(parseHttpsUrl("   \t  ")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_EMPTY" },
    });
  });

  it("rejects URLs with illegal control characters or embedded spaces", () => {
    expect(parseHttpsUrl("https://example.com/path with spaces")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS" },
    });
    expect(parseHttpsUrl("https://example.com/path\u0000bad")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS" },
    });
    expect(parseHttpsUrl("https://example.com/path\u007Fbad")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS" },
    });
  });

  it("rejects URLs exceeding 2048 characters", () => {
    const longPath = "a".repeat(2040);
    const longUrl = `https://example.com/${longPath}`;

    expect(parseHttpsUrl(longUrl)).toEqual({
      success: false,
      error: {
        type: "EXTERNAL_URL_TOO_LONG",
        length: longUrl.length,
        maximum: 2048,
      },
    });
  });

  it("rejects non-HTTPS protocols (http, ftp, javascript, data)", () => {
    expect(parseHttpsUrl("http://example.com")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_NOT_HTTPS", scheme: "http" },
    });
    expect(parseHttpsUrl("javascript:alert(1)")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_NOT_HTTPS", scheme: "javascript" },
    });
    expect(parseHttpsUrl("data:text/html,<b>hello</b>")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_NOT_HTTPS", scheme: "data" },
    });
  });

  it("rejects embedded user credentials in the URL", () => {
    expect(parseHttpsUrl("https://admin:secret@example.com/login")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HAS_CREDENTIALS" },
    });
    expect(parseHttpsUrl("https://user@example.com/")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HAS_CREDENTIALS" },
    });
  });

  it("rejects hostnames without a dot or with invalid dot placement", () => {
    expect(parseHttpsUrl("https://localhost/api")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HOST_INVALID", host: "localhost" },
    });
    expect(parseHttpsUrl("https://intranethost/dashboard")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HOST_INVALID", host: "intranethost" },
    });
    expect(parseHttpsUrl("https://.example.com/")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HOST_INVALID", host: ".example.com" },
    });
    expect(parseHttpsUrl("https://example.com./")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_HOST_INVALID", host: "example.com." },
    });
  });

  it("rejects malformed unparseable URLs", () => {
    expect(parseHttpsUrl("not-a-valid-url")).toEqual({
      success: false,
      error: { type: "EXTERNAL_URL_UNPARSEABLE" },
    });
  });
});
