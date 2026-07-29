/**
 * Teaches TypeScript that `requireAuth` attaches the authenticated user to the
 * request. The shape mirrors the columns Better Auth selects for the session user.
 *
 * Ambient (no top-level import/export) so it merges into the global Express
 * namespace declared by @types/express.
 */
declare namespace Express {
  interface Request {
    /**
     * The correlation id for this request — minted or echoed by `requestId`, returned in
     * `X-Request-Id`, carried into every log line, and included in an error body so a
     * user's report can be found (§11l.2 item 6).
     *
     * Optional because the augmentation applies to every Express request in the process,
     * including any constructed before the middleware runs. Everything mounted under
     * `app.use` in `src/app.ts` has it.
     */
    requestId?: string;
    user?: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
      readonly emailVerified: boolean;
      // Current active handle (normalized, no leading "@"); null until claimed.
      readonly handle: string | null;
    };
  }
}
