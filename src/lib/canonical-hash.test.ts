import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalHashHex, canonicalizeDocument } from "#src/lib/canonical-hash.js";

describe("canonicalizeDocument", () => {
  it("orders object keys independently of insertion order", () => {
    const insertedOneWay = canonicalizeDocument({ zebra: "z", alpha: "a", middle: "m" });
    const insertedAnother = canonicalizeDocument({ middle: "m", zebra: "z", alpha: "a" });

    expect(insertedOneWay).toBe(insertedAnother);
    expect(insertedOneWay).toBe('{"alpha":"a","middle":"m","zebra":"z"}');
  });

  it("keeps ARRAY order — order is data, not incidental", () => {
    expect(canonicalizeDocument(["b", "a"])).toBe('["b","a"]');
    expect(canonicalizeDocument(["b", "a"])).not.toBe(canonicalizeDocument(["a", "b"]));
  });

  it("sorts keys by UTF-16 code units, as RFC 8785 requires", () => {
    // "é" (é) sorts AFTER "z" in code-unit order, which is not alphabetical.
    expect(canonicalizeDocument({ é: 1n, z: 2n })).toBe('{"z":2,"é":1}');
  });

  it("treats null, empty string and an absent key as THREE different documents", () => {
    const withNull = canonicalHashHex({ note: null });
    const withEmptyString = canonicalHashHex({ note: "" });
    const withoutKey = canonicalHashHex({});

    expect(new Set([withNull, withEmptyString, withoutKey]).size).toBe(3);
  });

  it("serializes bigints as decimal strings with no quotes and no precision loss", () => {
    expect(canonicalizeDocument({ amountInCents: 1_200_000_000_000n })).toBe('{"amountInCents":1200000000000}');
    // 560x the int4 ceiling and past 2^53 — the case §4b calls out by name.
    expect(canonicalizeDocument({ big: 9_007_199_254_740_993n })).toBe('{"big":9007199254740993}');
  });

  it("applies RFC 8785 string escaping", () => {
    expect(canonicalizeDocument('say "hi"\n\tdone\\')).toBe('"say \\"hi\\"\\n\\tdone\\\\"');
  });

  it("escapes a control character with no short form as lowercase \\u00XX", () => {
    // Built with fromCharCode rather than a literal: a raw 0x01 byte in a source
    // file is invisible in review and mangled by tooling.
    const startOfHeading = String.fromCharCode(1);
    expect(canonicalizeDocument(`a${startOfHeading}b`)).toBe('"a\\u0001b"');
  });

  it("emits non-ASCII literally rather than escaping it", () => {
    expect(canonicalizeDocument("café 日本 🚀")).toBe('"café 日本 🚀"');
  });

  it("serializes instants as ISO-8601 UTC with exactly millisecond precision", () => {
    expect(canonicalizeDocument({ occurredAt: new Date("2026-07-20T15:20:00.000Z") })).toBe(
      '{"occurredAt":"2026-07-20T15:20:00.000Z"}',
    );
  });

  it("throws on an Invalid Date rather than hashing NaN", () => {
    expect(() => canonicalizeDocument({ at: new Date("nonsense") })).toThrow(/Invalid Date/);
  });

  it("throws on a year outside the 4-digit range", () => {
    expect(() => canonicalizeDocument({ at: new Date("+010000-01-01T00:00:00Z") })).toThrow(/4-digit-year/);
  });

  it("throws on a plain number, naming its path", () => {
    // Floats are banned in this domain (§4c) and JCS's double serialization is easy
    // to get subtly wrong across platforms. Integers must arrive as bigint.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const documentWithFloat = { entry: { amount: 12.5 } } as unknown as Parameters<typeof canonicalizeDocument>[0];
    expect(() => canonicalizeDocument(documentWithFloat)).toThrow(/unsupported number at "\$\.entry\.amount"/);
  });

  it("throws on an explicitly undefined value, naming its path", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const documentWithUndefined = { note: undefined } as unknown as Parameters<typeof canonicalizeDocument>[0];
    expect(() => canonicalizeDocument(documentWithUndefined)).toThrow(/use null explicitly/);
  });

  it("canonicalizes nested structures", () => {
    expect(
      canonicalizeDocument({
        postings: [
          { account: "escrow_held", signedAmountInCents: -500n },
          { account: "provider_clearing", signedAmountInCents: 500n },
        ],
        sequenceNumber: 1n,
      }),
    ).toBe(
      '{"postings":[{"account":"escrow_held","signedAmountInCents":-500},' +
        '{"account":"provider_clearing","signedAmountInCents":500}],"sequenceNumber":1}',
    );
  });
});

describe("canonicalHashHex", () => {
  it("is 64 lowercase hex characters", () => {
    expect(canonicalHashHex({ a: 1n })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a PINNED digest — this vector is the cross-platform contract", () => {
    // A Kotlin or Swift verifier implementing RFC 8785 + SHA-256 must reproduce this
    // exact string for this exact document. If this test ever changes, every stored
    // hash in the domain is invalidated and hashVersion must be bumped.
    const document = {
      projectId: "prj-1",
      sequenceNumber: 1n,
      eventKind: "project_created",
      detailNote: "",
      previousEntryHash: "genesis",
      occurredAt: new Date("2026-07-20T15:20:00.000Z"),
    };

    const canonical = canonicalizeDocument(document);
    expect(canonical).toBe(
      '{"detailNote":"","eventKind":"project_created","occurredAt":"2026-07-20T15:20:00.000Z",' +
        '"previousEntryHash":"genesis","projectId":"prj-1","sequenceNumber":1}',
    );

    // Derived from the canonical string above, so the assertion proves the pipeline
    // end to end rather than restating the implementation.
    const expectedDigest = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(canonicalHashHex(document)).toBe(expectedDigest);
    expect(canonicalHashHex(document)).toBe("07bf9c2ac40a7ee8383763c72aa2dfb6ccedb772aa66870f53ff660bdcc39e9b");
  });

  it("changes when any field changes", () => {
    const base = canonicalHashHex({ note: "a", sequenceNumber: 1n });
    expect(canonicalHashHex({ note: "b", sequenceNumber: 1n })).not.toBe(base);
    expect(canonicalHashHex({ note: "a", sequenceNumber: 2n })).not.toBe(base);
  });
});
