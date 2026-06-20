/**
 * Teaches TypeScript that `requireAuth` attaches the authenticated user to the
 * request. The shape mirrors the columns Better Auth selects for the session user.
 *
 * Ambient (no top-level import/export) so it merges into the global Express
 * namespace declared by @types/express.
 */
declare namespace Express {
  interface Request {
    user?: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
      readonly emailVerified: boolean;
    };
  }
}
