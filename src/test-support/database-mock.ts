import { vi } from "vitest";

/**
 * The shape `#src/db/index.js` exports, stubbed.
 *
 * WHY IT IS A FUNCTION rather than an object: `vi.mock` factories are hoisted above every
 * import in the file that calls them, so a factory cannot close over a module-level value.
 * The usable form is
 *
 *   vi.mock("#src/db/index.js", async () =>
 *     (await import("#src/test-support/database-mock.js")).databaseModuleMock());
 *
 * which defers the import to call time and therefore survives hoisting.
 *
 * `pool.query` RESOLVES rather than returning undefined. A readiness probe pings the pool
 * (§11l.2 item 5), and a mock that returns undefined makes `GET /ready` reject with a
 * TypeError — a failure that looks like a broken probe rather than a stubbed one.
 */
export function databaseModuleMock(): Record<string, unknown> {
  return {
    pool: {
      query: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ rows: [{ ok: 1 }] }),
      end: vi.fn<() => unknown>().mockResolvedValue(undefined),
    },
    db: {},
    query: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue([]),
    createDedicatedPool: vi.fn<(...args: unknown[]) => unknown>(),
  };
}
