/**
 * Request schema for `POST /users/me/terms-acceptance`. Its own module for the reason every
 * `*.schemas.ts` is: importing a controller to reach a schema drags in its service and db graph.
 */
import { z } from "zod";

/**
 * The version the reader was SHOWN, echoed back. Nothing else — the user is the session, the moment
 * is the server's clock, and the surface is fixed by the route.
 */
export const AcceptTermsBodySchema = z
  .object({ acceptedTermsVersion: z.string().trim().min(1).max(32) })
  .strict();
