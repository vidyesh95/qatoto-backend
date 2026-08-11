import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { COMMERCE_JOURNAL_ACCOUNT_KINDS, COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL, isMemorandumAccountKind } =
  await import("#src/services/commerce-journal.service.js");

/**
 * The migration that defines `commerce_settlement_rail_account_guard`. Asserted to be the
 * ONLY definition below, so this test cannot silently read a superseded one.
 */
const RAIL_BINDING_MIGRATION_URL = new URL("../../drizzle/0087_store_phase_14_rail_binding.sql", import.meta.url);

/**
 * Pull the `WHEN '<rail>' THEN ARRAY[ ... ]` arms out of the trigger's CASE expression.
 *
 * Parsing SQL in a test is ordinarily a bad idea. It earns its place here because the
 * TypeScript map and the trigger are two hand-maintained copies of one rule, and the
 * service comment says so outright: "THIS MIRRORS `commerce_settlement_rail_account_guard`
 * IN MIGRATION 0087, deliberately." Two copies of a rule drift, and the drift is only
 * discoverable at runtime — as a rolled-back transaction reporting a constraint name — if
 * nothing compares them.
 */
function parseTriggerRailAccountKinds(migrationSql: string): Record<string, readonly string[]> {
  const caseArmPattern = /WHEN\s+'([a-z_]+)'\s+THEN\s+ARRAY\[([^\]]*)\]/g;
  const parsed: Record<string, readonly string[]> = {};

  for (const match of migrationSql.matchAll(caseArmPattern)) {
    const railName = match[1];
    const arrayBody = match[2];
    if (railName === undefined || arrayBody === undefined) continue;
    parsed[railName] = [...arrayBody.matchAll(/'([a-z_]+)'/g)]
      .map((accountKind) => accountKind[1])
      .filter((accountKind): accountKind is string => accountKind !== undefined);
  }

  return parsed;
}

describe("settlement rail account binding (Phase 14)", () => {
  const migrationSql = readFileSync(fileURLToPath(RAIL_BINDING_MIGRATION_URL), "utf8");

  it("reads the only definition of the guard, so parity cannot be checked against a stale one", () => {
    const definitionCount = [
      ...migrationSql.matchAll(/CREATE OR REPLACE FUNCTION commerce_settlement_rail_account_guard/g),
    ].length;
    expect(definitionCount).toBe(1);
  });

  /**
   * The assertion this file exists for. If someone adds an account kind to a rail in
   * TypeScript and not in a migration — or the reverse — the build fails here rather than
   * the next escrow order failing at its first posting, which is exactly how
   * `ensureCommerceJournalAccounts` was found to be a live blocker in Phase 14.
   */
  it("matches the database trigger arm for arm", () => {
    const triggerRailAccountKinds = parseTriggerRailAccountKinds(migrationSql);

    const serviceEntries = Object.entries(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL);
    expect(Object.keys(triggerRailAccountKinds).toSorted()).toEqual(serviceEntries.map(([rail]) => rail).toSorted());

    for (const [rail, serviceKinds] of serviceEntries) {
      expect(
        [...serviceKinds].toSorted(),
        `rail ${rail} disagrees with commerce_settlement_rail_account_guard`,
      ).toEqual([...(triggerRailAccountKinds[rail] ?? [])].toSorted());
    }
  });

  /**
   * §14's decision, expressed as a test. `order_held` means QATOTO holds the funds, and
   * Phase 14 ruled that out — it may therefore appear only on the frozen rail.
   */
  it("keeps `order_held` off every rail but the frozen one", () => {
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.internal_custody).toContain("order_held");
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.direct_offline).not.toContain("order_held");
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.direct_processor).not.toContain("order_held");
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.external_escrow).not.toContain("order_held");
  });

  /**
   * "Qatoto owes the seller money it is holding" can never be true under no-custody.
   * `scripts/verify-store-phase-14-constraints.ts` asserts nothing POSTS it; this asserts
   * no rail introduced since may even hold the account.
   */
  it("keeps `seller_payable` off every rail but the frozen one", () => {
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.internal_custody).toContain("seller_payable");
    for (const rail of ["direct_offline", "direct_processor", "external_escrow"] as const) {
      expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL[rail]).not.toContain("seller_payable");
    }
  });

  /**
   * `direct_offline` posts commission and nothing else. Qatoto cannot observe a wire
   * between two banks it has no relationship with, and a memo entry for money it did not
   * see would assert a fact from an absence — the error A16 refused when it returned an
   * empty estimate array instead of a zero.
   */
  it("gives `direct_offline` no settlement account at all", () => {
    const settlementAccounts = COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.direct_offline.filter((accountKind) =>
      accountKind.startsWith("settlement_"),
    );
    expect(settlementAccounts).toEqual([]);
  });

  /**
   * `direct_processor` settles buyer straight to seller: funding goes directly to
   * released with no custody hop, so a custody balance there would be value nobody holds.
   */
  it("gives `direct_processor` funding and release but no custody", () => {
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.direct_processor).toContain("settlement_funding_memo");
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.direct_processor).toContain("settlement_released_memo");
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.direct_processor).not.toContain("settlement_custody_memo");
    expect(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.external_escrow).toContain("settlement_custody_memo");
  });

  /** The legacy six are exactly the frozen rail's set, which is what their name claims. */
  it("keeps the legacy account list equal to the frozen rail's set", () => {
    expect([...COMMERCE_JOURNAL_ACCOUNT_KINDS].toSorted()).toEqual(
      [...COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL.internal_custody].toSorted(),
    );
  });
});

describe("memorandum account classification", () => {
  /**
   * Off balance sheet: value a third party holds, never a Qatoto asset. Bound to the kind
   * by `commerce_journal_account_memorandum_ck` in both directions, so this predicate and
   * the constraint cannot disagree about a row.
   */
  it("treats exactly the four settlement memos as memorandum accounts", () => {
    for (const memoKind of [
      "settlement_funding_memo",
      "settlement_custody_memo",
      "settlement_released_memo",
      "settlement_refunded_memo",
    ] as const) {
      expect(isMemorandumAccountKind(memoKind)).toBe(true);
    }
  });

  it("treats no real-money account as a memorandum account", () => {
    for (const realKind of [
      "buyer_clearing",
      "order_held",
      "seller_payable",
      "platform_fee",
      "refunds_payable",
      "reconciliation_suspense",
      "platform_fee_receivable",
      "platform_fee_earned",
      "platform_fee_cash",
    ] as const) {
      expect(isMemorandumAccountKind(realKind)).toBe(false);
    }
  });

  /**
   * Every memo account is a `settlement_*`, and every `settlement_*` is a memo account.
   * A future settlement account that is NOT off balance sheet would mean Qatoto holding
   * funds, so this reads as a tripwire on §14 rather than a naming convention.
   */
  it("keeps the memo set and the settlement prefix in lockstep across every rail", () => {
    const settlementAccountKinds = new Set(
      Object.values(COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL)
        .flat()
        .filter((accountKind) => accountKind.startsWith("settlement_")),
    );
    for (const accountKind of settlementAccountKinds) {
      expect(isMemorandumAccountKind(accountKind), `${accountKind} must be off balance sheet`).toBe(true);
    }
  });
});
