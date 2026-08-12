import { createHash } from "node:crypto";

import { config } from "#src/config/index.js";
import { deriveClientNetworkBlock } from "#src/lib/network-block.js";

/**
 * A salted, coarse network key for the subnet concentration guard (STORE Phase 13,
 * refinement 3).
 *
 * WHAT THIS IS FOR. The guard asks one question: of the saves, shares and views a product
 * received, what share came from a single network block? A click farm answers ~1.0. A
 * healthy product answers something small. Without a network key there is no way to ask —
 * `commerce_product_engagement` stored only `(productId, userId, kind, createdAt)`, and
 * the only raw address anywhere in this database is better-auth's `session.ip_address`.
 *
 * IT IS NOT AN IDENTITY, AND THE RAW ADDRESS IS NEVER WRITTEN TO THE DATABASE. It appears
 * here, inside a hash, and nowhere else — the same posture `viewer-fingerprint.ts` takes.
 * Two properties make that meaningful rather than decorative:
 *
 *   1. The address is truncated to a BLOCK before hashing — /24 for IPv4, /56 for IPv6 —
 *      so even someone holding the salt cannot recover which host acted, only which
 *      neighbourhood. That is all the guard needs.
 *   2. The salt is derived from `BETTER_AUTH_SECRET`, so a leaked table is not a rainbow
 *      table away from being a list of addresses.
 *
 * ## Why /24 and /56
 *
 * They are what `ipKeyGenerator` already uses for rate limiting in this codebase, which
 * matters more than the specific numbers: two subsystems that disagree about what "one
 * network" means would produce a rate limiter and a fraud guard that draw different
 * boundaries around the same attacker.
 *
 * /56 for IPv6 rather than /64 or /128 because a single residential or office allocation
 * is typically a /56 or larger, and keying on /128 would make every device its own
 * "network" — which is precisely the concentration a farm would then be able to hide
 * behind.
 *
 * ## The salt is NOT rotated daily, and that is deliberate
 *
 * `viewer-fingerprint.ts` folds the UTC day into its hash because a fingerprint's job is
 * to be a per-day bucket key. This one is the opposite: concentration is measured across a
 * window of days, so a key that changed at midnight would split one farm into two
 * networks every night and dilute exactly the signal being measured.
 *
 * The trade-off is real — a stable hash is a stable pseudonym for a network block — and it
 * is bounded by the truncation above and by the retention sweep on the rows that carry it.
 *
 * ## What this cannot do
 *
 * It cannot tell a click farm from a corporate NAT. One procurement team behind one office
 * egress address produces the same concentration as forty scripted accounts, and the
 * `verified_business` domain corpus that would distinguish them does not exist (see
 * `commerce_business_email_domain`). That is why the penalty this feeds carries a floor
 * rather than the `max(0, 1 - concentration)` the specification asked for.
 */

/**
 * The value written to `subnet_hash` columns. `null` when the block cannot be derived —
 * see `deriveClientNetworkBlock`.
 *
 * The `:commercesubnet:` domain separator keeps this hash from ever colliding with a
 * viewer fingerprint, which is derived from the same secret. Without it, a crafted input
 * to one could address a row belonging to the other.
 */
export function computeClientSubnetHash(clientIp: string | undefined): string | null {
  const networkBlock = deriveClientNetworkBlock(clientIp);
  if (networkBlock === null) return null;

  return createHash("sha256")
    .update(`${config.BETTER_AUTH_SECRET}:commercesubnet:${networkBlock}`, "utf8")
    .digest("hex");
}

/**
 * Re-exported from `network-block.ts`, which holds the parsing so a test can exercise it
 * without this module's `config` dependency.
 */
export { deriveClientNetworkBlock } from "#src/lib/network-block.js";
