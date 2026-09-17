import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  canonicalHashHex,
  canonicalizeDocument,
  type CanonicalValue,
} from "#src/lib/canonical-hash.js";
import { BENCHMARK_OPTIONS } from "#src/test-support/bench-fixtures.js";

/**
 * Every hash chain in the domain serializes through here, and the serializer is the half that
 * costs: `serializeString` walks a string CODE POINT BY CODE POINT to apply the RFC 8785 escapes,
 * which is where a long `detailNote` spends its time, and object keys are re-sorted at every level
 * of nesting.
 *
 * The three shapes below are the three the domain actually appends: a flat journal entry, an audit
 * entry carrying a free-text note, and a batch — a nightly job appending two hundred entries pays
 * the serializer two hundred times, so that is the unit a regression would be felt in.
 *
 * `canonicalizeDocument` and `canonicalHashHex` are measured separately on purpose. They differ by
 * exactly one SHA-256 over the serialized bytes, so the pair localises a change to the
 * serialization or to the digest rather than leaving it somewhere in between.
 */

const ESCROW_JOURNAL_ENTRY: CanonicalValue = {
  hashVersion: "1",
  entryId: "01JB3K8QF4M2WQ9G7YD5N6R7S",
  projectId: "01JB3K8QF4M2WQ9G7YD5N6R7T",
  previousEntryHash: "9f2c4e1a7b3d5f8096a1c2e4d6b8f0a2c4e6d8b0f2a4c6e8d0b2f4a6c8e0d2b4",
  amountMinorUnits: "125000",
  currencyCode: "INR",
  occurredAt: new Date("2026-03-14T09:26:53.589Z"),
  reversalOf: null,
  actorUserId: "01JB3K8QF4M2WQ9G7YD5N6R7U",
  idempotencyKey: "escrow-release-2026-03-14-000117",
};

/**
 * The audit shape, with the free-text field that decides the serializer's cost. The note carries
 * the characters the escape table exists for — quotes, backslashes, newlines, tabs and a control
 * character — plus non-ASCII, which RFC 8785 emits literally and must therefore not be escaped.
 */
const PROJECT_AUDIT_ENTRY: CanonicalValue = {
  hashVersion: "1",
  entryId: "01JB3K8QF4M2WQ9G7YD5N6R80",
  projectId: "01JB3K8QF4M2WQ9G7YD5N6R7T",
  action: "milestone.approved",
  detailNote: [
    'Reviewer said "the tolerance is 0.05\u00A0mm", then filed\tthe measurement sheet.',
    "Path: C:\\\\fixtures\\\\run-17\\\\sheet.csv\nSigned off — ✅ — by the workshop lead.",
    "\u0007 A control character, which serializes as a lowercase \\u escape.",
  ].join("\n"),
  occurredAt: new Date("2026-03-14T09:26:53.589Z"),
  actorUserId: "01JB3K8QF4M2WQ9G7YD5N6R7U",
  attachments: [
    { objectKey: "projects/01JB3K/sheet.csv", contentSha256: "a".repeat(64) },
    { objectKey: "projects/01JB3K/photo.jpg", contentSha256: "b".repeat(64) },
  ],
};

const JOURNAL_BATCH: readonly CanonicalValue[] = Array.from(
  { length: 200 },
  (unusedValue, entryIndex) => ({
    hashVersion: "1",
    entryId: `01JB3K8QF4M2WQ9G7YD5N${String(entryIndex).padStart(4, "0")}`,
    projectId: "01JB3K8QF4M2WQ9G7YD5N6R7T",
    amountMinorUnits: String(1000n + BigInt(entryIndex) * 37n),
    currencyCode: "INR",
    occurredAt: new Date(Date.UTC(2026, 2, 14, 9, 26, 53, entryIndex % 1000)),
    reversalOf: null,
  }),
);

export const canonicalHashBenchmarks = withCodSpeed(
  new Bench({ name: "canonical-hash", ...BENCHMARK_OPTIONS }),
);

canonicalHashBenchmarks.add("canonicalizeDocument — escrow journal entry", () => {
  canonicalizeDocument(ESCROW_JOURNAL_ENTRY);
});

canonicalHashBenchmarks.add("canonicalHashHex — escrow journal entry", () => {
  canonicalHashHex(ESCROW_JOURNAL_ENTRY);
});

canonicalHashBenchmarks.add(
  "canonicalizeDocument — audit entry with an escaped free-text note",
  () => {
    canonicalizeDocument(PROJECT_AUDIT_ENTRY);
  },
);

canonicalHashBenchmarks.add("canonicalHashHex — 200-entry journal batch", () => {
  for (const entry of JOURNAL_BATCH) {
    canonicalHashHex(entry);
  }
});
