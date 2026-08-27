/**
 * Request schemas for users, extracted from users.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

/**
 * Display name a user is allowed to set. Trimmed first, then bounded 1–100 and
 * restricted to letters/marks plus spaces, apostrophes, hyphens and periods —
 * the value must START with a letter/mark so it can't be pure punctuation.
 * Unicode-aware (`\p{L}\p{M}`) so non-Latin names are accepted.
 */
export const FullNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(100, "Name must be at most 100 characters.")
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u, "Name contains invalid characters.");

/**
 * Body for PATCH /users/me. `.strict()` rejects unknown keys — in particular any
 * client-sent `id`, which is ignored regardless (the id comes from the session).
 */
export const UpdateMyProfileSchema = z.object({ fullName: FullNameSchema }).strict();

/**
 * The channel description — public free text on `/channel/:handle`.
 *
 * 20..5000, matching `community_cofounder_profile.bio`, the closest public-text-about-a-person
 * precedent. The floor is not fussiness: a two-character description is noise on a public profile,
 * and the same bound is already enforced in the database for its sibling.
 *
 * NULLABLE, because clearing a description has to be expressible. An empty string is NOT the way to
 * do it — that would store text of length zero and fail the CHECK — so the client sends `null` and
 * this schema says so.
 */
export const ChannelBioSchema = z
  .string()
  .trim()
  .min(20, "A description needs at least 20 characters.")
  .max(5000, "A description must be at most 5000 characters.")
  .nullable();

/**
 * One external link.
 *
 * `https://` ONLY, and the refusal happens here as well as in the database CHECK. The check is the
 * control — it is what keeps a `javascript:` scheme off a public anchor — and this is the message
 * that tells somebody why their `http://` link was refused instead of handing them a 23514.
 */
export const ProfileLinkSchema = z
  .object({
    label: z.string().trim().min(1, "A link needs a label.").max(60),
    url: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https:\/\//, "Links must start with https://"),
  })
  .strict();

/**
 * Body for PATCH /users/me/channel-profile.
 *
 * A REPLACE-THE-SET WRITE: `links` is the complete list, not a delta, and the server assigns
 * `sortOrder` from the array index. That is the same shape `PUT /products/:id/variants` uses, and it
 * is why this needs no idempotency key — sending it twice produces the same rows.
 *
 * BOTH FIELDS ARE REQUIRED KEYS. `bio: null` clears the description and `links: []` clears the
 * links; omitting either would make "leave it alone" and "clear it" indistinguishable on the one
 * write that can do both.
 */
export const UpdateMyChannelProfileSchema = z
  .object({
    bio: ChannelBioSchema,
    links: z.array(ProfileLinkSchema).max(10, "At most 10 links."),
  })
  .strict();
