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
    /**
     * The raw JSON body's length IN BYTES, recorded by `parseJsonBodyOnce` and read by
     * `limitBodyBytes` to enforce a per-route cap (§11l.4).
     *
     * UNDEFINED means no JSON body was parsed — a bodiless request, a content type the
     * parser does not claim, or a multipart upload multer owns. That is distinct from a
     * body of length zero, and a cap check must treat it as "nothing to check".
     */
    rawBodyBytes?: number;
    user?: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
      readonly emailVerified: boolean;
      // Current active handle (normalized, no leading "@"); null until claimed.
      readonly handle: string | null;
    };
    authSession?: {
      /** Safe identifier for revocation, audit correlation, and tenant selection. */
      readonly id: string;
      /** Server-owned selection only; authorization is re-proven separately. */
      readonly activeOrganizationId: string | null;
    };
    commerceOrganization?: {
      readonly organizationId: string;
      readonly memberId: string;
      readonly memberRole:
        | "owner"
        | "administrator"
        | "buyer"
        | "seller"
        | "provider_operator"
        | "finance"
        | "support"
        | "viewer";
      readonly tradeState: "active";
    };
  }
}
