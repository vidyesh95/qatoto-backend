import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildYoutubeEmbedUrl,
  clearYoutubeVerificationCache,
  extractYoutubeVideoId,
  isYoutubeVideoUrl,
  sanitizeYoutubeThumbnailUrl,
  verifyYoutubeVideo,
  type FetchImplementation,
} from "#src/lib/youtube.js";

/**
 * The parser half of this suite is the frontend-parity check §13.4 asks for: every shape
 * the browser green-ticks must produce the same id here, or the creator gets a 422 after
 * a checkmark. The oEmbed half runs entirely on an injected fetch — no network, so the
 * suite is deterministic and the 502 path is actually exercised rather than assumed.
 */

const VALID_VIDEO_ID = "dQw4w9WgXcQ";

describe("extractYoutubeVideoId — accepted shapes", () => {
  const acceptedInputs: readonly { readonly label: string; readonly input: string }[] = [
    { label: "a bare 11-char id", input: VALID_VIDEO_ID },
    { label: "a bare id with surrounding whitespace", input: `  ${VALID_VIDEO_ID}\n` },
    { label: "youtu.be short link", input: `https://youtu.be/${VALID_VIDEO_ID}` },
    { label: "www.youtu.be short link", input: `https://www.youtu.be/${VALID_VIDEO_ID}` },
    { label: "watch?v=", input: `https://www.youtube.com/watch?v=${VALID_VIDEO_ID}` },
    { label: "watch?v= with no www", input: `https://youtube.com/watch?v=${VALID_VIDEO_ID}` },
    { label: "m. subdomain", input: `https://m.youtube.com/watch?v=${VALID_VIDEO_ID}` },
    { label: "music. subdomain", input: `https://music.youtube.com/watch?v=${VALID_VIDEO_ID}` },
    {
      label: "youtube-nocookie",
      input: `https://www.youtube-nocookie.com/embed/${VALID_VIDEO_ID}`,
    },
    { label: "/embed/ path", input: `https://www.youtube.com/embed/${VALID_VIDEO_ID}` },
    { label: "/shorts/ path", input: `https://www.youtube.com/shorts/${VALID_VIDEO_ID}` },
    { label: "/live/ path", input: `https://www.youtube.com/live/${VALID_VIDEO_ID}` },
    { label: "/v/ path", input: `https://www.youtube.com/v/${VALID_VIDEO_ID}` },
    { label: "a schemeless link", input: `youtu.be/${VALID_VIDEO_ID}` },
    { label: "a schemeless watch link", input: `www.youtube.com/watch?v=${VALID_VIDEO_ID}` },
    { label: "an uppercase scheme", input: `HTTPS://www.youtube.com/watch?v=${VALID_VIDEO_ID}` },
    {
      label: "extra query params after the id",
      input: `https://www.youtube.com/watch?v=${VALID_VIDEO_ID}&t=42s&list=PLabc`,
    },
    {
      label: "a trailing path segment after the id",
      input: `https://www.youtube.com/embed/${VALID_VIDEO_ID}/extra`,
    },
    { label: "http rather than https", input: `http://youtu.be/${VALID_VIDEO_ID}` },
  ];

  it.each(acceptedInputs)("accepts $label", ({ input }) => {
    expect(extractYoutubeVideoId(input)).toBe(VALID_VIDEO_ID);
    expect(isYoutubeVideoUrl(input)).toBe(true);
  });

  it("round-trips every accepted shape through buildYoutubeEmbedUrl", () => {
    for (const { input } of acceptedInputs) {
      const extractedId = extractYoutubeVideoId(input);
      expect(extractedId).not.toBeNull();
      const embedUrl = buildYoutubeEmbedUrl(extractedId ?? "");
      expect(embedUrl).toBe(`https://www.youtube-nocookie.com/embed/${VALID_VIDEO_ID}`);
      // The rebuilt embed URL must itself parse back to the same id.
      expect(extractYoutubeVideoId(embedUrl)).toBe(VALID_VIDEO_ID);
    }
  });
});

describe("extractYoutubeVideoId — rejected shapes", () => {
  const rejectedInputs: readonly { readonly label: string; readonly input: string }[] = [
    { label: "an empty string", input: "" },
    { label: "whitespace only", input: "   " },
    { label: "a non-YouTube host", input: "https://vimeo.com/123456" },
    {
      label: "a lookalike host",
      input: `https://youtube.com.evil.tld/watch?v=${VALID_VIDEO_ID}`,
    },
    {
      label: "a host with youtube.com in the path",
      input: `https://evil.tld/youtube.com/watch?v=${VALID_VIDEO_ID}`,
    },
    {
      label: "a subdomain not on the allowlist",
      input: `https://evil.youtube.com.attacker.tld/watch?v=${VALID_VIDEO_ID}`,
    },
    { label: "a 10-char id", input: "dQw4w9WgXc" },
    { label: "a 12-char id", input: "dQw4w9WgXcQQ" },
    { label: "an id with an illegal character", input: "dQw4w9WgXc+" },
    { label: "a javascript: payload", input: "javascript:alert(1)" },
    { label: "a data: payload", input: "data:text/html,<script>alert(1)</script>" },
    { label: "watch with no v param", input: "https://www.youtube.com/watch" },
    { label: "a channel URL", input: "https://www.youtube.com/@somechannel" },
    { label: "a short link with no id", input: "https://youtu.be/" },
    { label: "an embed path with a bad id", input: "https://www.youtube.com/embed/short" },
  ];

  it.each(rejectedInputs)("rejects $label", ({ input }) => {
    expect(extractYoutubeVideoId(input)).toBeNull();
    expect(isYoutubeVideoUrl(input)).toBe(false);
  });
});

describe("sanitizeYoutubeThumbnailUrl", () => {
  it("accepts YouTube's own https thumbnail hosts", () => {
    expect(sanitizeYoutubeThumbnailUrl(`https://i.ytimg.com/vi/${VALID_VIDEO_ID}/hqdefault.jpg`)).toBe(
      `https://i.ytimg.com/vi/${VALID_VIDEO_ID}/hqdefault.jpg`,
    );
    expect(sanitizeYoutubeThumbnailUrl(`https://img.youtube.com/vi/${VALID_VIDEO_ID}/0.jpg`)).toBe(
      `https://img.youtube.com/vi/${VALID_VIDEO_ID}/0.jpg`,
    );
  });

  it("rejects a non-https scheme, a foreign host and an unparseable string", () => {
    expect(sanitizeYoutubeThumbnailUrl("http://i.ytimg.com/vi/x/0.jpg")).toBeNull();
    expect(sanitizeYoutubeThumbnailUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeYoutubeThumbnailUrl("https://evil.tld/thumb.jpg")).toBeNull();
    expect(sanitizeYoutubeThumbnailUrl("https://i.ytimg.com.evil.tld/thumb.jpg")).toBeNull();
    expect(sanitizeYoutubeThumbnailUrl("not a url at all")).toBeNull();
  });
});

/** Builds a fetch stub that records the URL it was called with. */
function stubFetch(respond: () => Response | Promise<Response>): {
  readonly fetchImplementation: FetchImplementation;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const fetchImplementation: FetchImplementation = vi.fn<FetchImplementation>(async (input) => {
    if (input instanceof URL) calls.push(input.href);
    else if (input instanceof Request) calls.push(input.url);
    else calls.push(input);
    return respond();
  });
  return { fetchImplementation, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("verifyYoutubeVideo", () => {
  beforeEach(() => {
    clearYoutubeVerificationCache();
  });

  it("builds the oEmbed request from the parsed id, never a raw string", async () => {
    const { fetchImplementation, calls } = stubFetch(() =>
      jsonResponse({
        title: "A demo",
        thumbnail_url: `https://i.ytimg.com/vi/${VALID_VIDEO_ID}/0.jpg`,
      }),
    );

    await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(calls).toHaveLength(1);
    const requestedUrl = new URL(calls[0] ?? "");
    expect(requestedUrl.origin).toBe("https://www.youtube.com");
    expect(requestedUrl.pathname).toBe("/oembed");
    expect(requestedUrl.searchParams.get("format")).toBe("json");
    expect(requestedUrl.searchParams.get("url")).toBe(`https://www.youtube.com/watch?v=${VALID_VIDEO_ID}`);
  });

  it("returns the title and thumbnail on 200", async () => {
    const { fetchImplementation } = stubFetch(() =>
      jsonResponse({
        title: "  Seed round demo  ",
        thumbnail_url: `https://i.ytimg.com/vi/${VALID_VIDEO_ID}/hqdefault.jpg`,
      }),
    );

    const result = await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(result).toEqual({
      success: true,
      value: {
        suggestedTitle: "Seed round demo",
        thumbnailUrl: `https://i.ytimg.com/vi/${VALID_VIDEO_ID}/hqdefault.jpg`,
      },
    });
  });

  it("drops a thumbnail URL that is not an allowlisted https host", async () => {
    const { fetchImplementation } = stubFetch(() => jsonResponse({ title: "x", thumbnail_url: "javascript:alert(1)" }));

    const result = await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(result.success).toBe(true);
    expect(result.success && result.value.thumbnailUrl).toBeNull();
  });

  it.each([400, 401, 403, 404])("maps %i to YOUTUBE_VIDEO_UNAVAILABLE", async (status) => {
    const { fetchImplementation } = stubFetch(() => new Response("", { status }));

    const result = await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(result).toEqual({
      success: false,
      error: { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: VALID_VIDEO_ID },
    });
  });

  it.each([429, 500, 502, 503])("maps %i to YOUTUBE_VERIFY_FAILED", async (status) => {
    const { fetchImplementation } = stubFetch(() => new Response("", { status }));

    const result = await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(result).toEqual({ success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } });
  });

  it("maps a thrown network error to YOUTUBE_VERIFY_FAILED, not a rejection", async () => {
    const { fetchImplementation } = stubFetch(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const result = await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(result).toEqual({ success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } });
  });

  it("maps a 200 with an unparseable body to YOUTUBE_VERIFY_FAILED", async () => {
    const { fetchImplementation } = stubFetch(() => new Response("<html>not json</html>", { status: 200 }));

    const result = await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(result).toEqual({ success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } });
  });

  it("rejects an id that is not 11 legal characters without making a request", async () => {
    const { fetchImplementation, calls } = stubFetch(() => jsonResponse({}));

    const result = await verifyYoutubeVideo("../../etc/passwd", { fetchImplementation });

    expect(result).toEqual({ success: false, error: { type: "INVALID_YOUTUBE_URL" } });
    expect(calls).toHaveLength(0);
  });

  it("caches a verified outcome so a retrying client makes one outbound request", async () => {
    const { fetchImplementation, calls } = stubFetch(() => jsonResponse({ title: "x" }));

    await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });
    await verifyYoutubeVideo(VALID_VIDEO_ID, { fetchImplementation });

    expect(calls).toHaveLength(1);
  });

  it("caches an unavailable outcome, but never a transient failure", async () => {
    const unavailable = stubFetch(() => new Response("", { status: 404 }));
    await verifyYoutubeVideo(VALID_VIDEO_ID, {
      fetchImplementation: unavailable.fetchImplementation,
    });
    await verifyYoutubeVideo(VALID_VIDEO_ID, {
      fetchImplementation: unavailable.fetchImplementation,
    });
    expect(unavailable.calls).toHaveLength(1);

    clearYoutubeVerificationCache();

    const transient = stubFetch(() => new Response("", { status: 503 }));
    await verifyYoutubeVideo(VALID_VIDEO_ID, {
      fetchImplementation: transient.fetchImplementation,
    });
    await verifyYoutubeVideo(VALID_VIDEO_ID, {
      fetchImplementation: transient.fetchImplementation,
    });
    expect(transient.calls).toHaveLength(2);
  });
});
