/**
 * The one string a scrubbed attribution shows, shared by the READ that renders it and the
 * WRITE that stores it.
 *
 * ## WHY THIS IS NOT A CONSTANT IN THE SERVICE THAT NEEDED IT FIRST
 *
 * It began life at `community-forum.service.ts:203` as a READ-TIME fallback: a forum row
 * whose `author_user_id` went NULL renders "Former member" because there is no name left to
 * join. That is still exactly right for a `null_out` FK.
 *
 * But four of the erasure's tombstone steps have no name to join EITHER, and no FK to null —
 * `video_team_member.member_name` and `showcase_launch_team_member.display_name` are NOT NULL
 * free text somebody typed by hand. Those steps must WRITE a value, and if they wrote their
 * own literal then the name a reader sees for a severed row and the name stored in a scrubbed
 * one could drift apart one refactor at a time, for no reason anybody would ever notice.
 *
 * ## WHAT IS DELIBERATELY *NOT* HERE
 *
 * - `"Deleted user"`, which `scrubUserAndComplete` writes into `user.name`. That is a
 *   different sentence about a different thing: the row IS the account, and "former member"
 *   would imply a membership that the row no longer records either way.
 * - `"Former contributor"` (`research-program-access.service.ts:250`) — a different role,
 *   and the forum file already argues that case.
 * - `authorOrganizationName`, which the forum service leaves alone on purpose: "somebody who
 *   has since left" is a different fact from "an individual posting without an organization".
 */
export const REMOVED_AUTHOR_DISPLAY_NAME = "Former member";

/**
 * The domain every derived placeholder address uses.
 *
 * RFC 2606 reserves `.invalid`, so a misconfigured mailer fails to resolve it rather than
 * delivering somebody's erasure notice to a real stranger. `scrubUserAndComplete` established
 * this for `user.email`; `tombstone:video_collaborator` follows it because
 * `video_collaborator.invited_email` is NOT NULL under a unique index and therefore needs a
 * value that is unique by construction rather than a literal.
 */
export const ANONYMIZED_EMAIL_DOMAIN = "deleted.qatoto.invalid";
