import type { Response } from "express";
import { vi } from "vitest";

/**
 * A minimal Express `Response` double for the `respond*Error` helpers, which only ever call
 * `res.status(code).json(body)`.
 *
 * The assertion below cannot be typed away: a real `Response` carries ~50 methods, and stubbing
 * them all to satisfy the compiler would assert nothing about the two lines under test. Confining
 * it here means the two callers carry no suppression of their own. Other suites still spin their
 * own `Response`/`Request` doubles inline (`studio-error-response.test.ts`,
 * `users.controller.test.ts`, and others); they can move onto this helper when next touched.
 */
export function createResponseSpy(): {
  readonly res: Response;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn<(body: unknown) => unknown>();
  const status = vi.fn<(statusCode: number) => { json: typeof json }>(() => ({ json }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const res = { status } as unknown as Response;

  return { res, status, json };
}
