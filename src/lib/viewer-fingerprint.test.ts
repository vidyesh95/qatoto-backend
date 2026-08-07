import { describe, expect, it } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

// `config` is parsed once at module load and throws on a bad shape, so the environment
// has to be satisfied before the dynamic import below.
stubServerEnvironment();

const { computeViewerFingerprint, utcDayStringOf } = await import("#src/lib/viewer-fingerprint.js");

describe("computeViewerFingerprint", () => {
  const anonymousViewer = {
    utcDayString: "2026-08-02",
    viewerUserId: null,
    clientIp: "203.0.113.7",
    userAgent: "Mozilla/5.0",
  } as const;

  it("is deterministic and 64 lowercase hex characters", () => {
    const first = computeViewerFingerprint(anonymousViewer);
    const second = computeViewerFingerprint(anonymousViewer);

    expect(first).toBe(second);
    // The storage-layer CHECK on viewer_fingerprint asserts exactly this shape.
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rotates with the UTC day", () => {
    expect(computeViewerFingerprint({ ...anonymousViewer, utcDayString: "2026-08-03" })).not.toBe(
      computeViewerFingerprint(anonymousViewer),
    );
  });

  it("separates two signed-in users behind one IP and user agent", () => {
    // THE BUG THIS FUNCTION EXISTS TO PREVENT. Under §3.2's literal formula these two
    // hash identically, collapse into one video_view_session row, and one person's
    // watch time is credited to the other — into the component carrying 40 of 100
    // ranking points.
    const firstColleague = computeViewerFingerprint({ ...anonymousViewer, viewerUserId: "user_a" });
    const secondColleague = computeViewerFingerprint({
      ...anonymousViewer,
      viewerUserId: "user_b",
    });

    expect(firstColleague).not.toBe(secondColleague);
  });

  it("ignores the network a signed-in viewer watched from", () => {
    const atTheOffice = computeViewerFingerprint({ ...anonymousViewer, viewerUserId: "user_a" });
    const onMobile = computeViewerFingerprint({
      ...anonymousViewer,
      viewerUserId: "user_a",
      clientIp: "198.51.100.4",
      userAgent: "QatotoApp/1.0",
    });

    expect(atTheOffice).toBe(onMobile);
  });

  it("does not let a crafted user id collide with an anonymous viewer", () => {
    // Without the "u:"/"a:" domain separators this id would hash into the anonymous
    // viewer's bucket, which is a way to write to somebody else's session row.
    const craftedIdentity = computeViewerFingerprint({
      ...anonymousViewer,
      viewerUserId: `${anonymousViewer.clientIp}:${anonymousViewer.userAgent}`,
    });

    expect(craftedIdentity).not.toBe(computeViewerFingerprint(anonymousViewer));
  });

  it("distinguishes anonymous viewers by user agent", () => {
    expect(computeViewerFingerprint({ ...anonymousViewer, userAgent: "Mozilla/5.1" })).not.toBe(
      computeViewerFingerprint(anonymousViewer),
    );
  });
});

describe("utcDayStringOf", () => {
  it("reads the UTC day regardless of the process time zone", () => {
    expect(utcDayStringOf(new Date("2026-08-02T23:59:59.999Z"))).toBe("2026-08-02");
    expect(utcDayStringOf(new Date("2026-08-03T00:00:00.000Z"))).toBe("2026-08-03");
  });
});
