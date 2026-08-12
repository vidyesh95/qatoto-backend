/**
 * Request schemas for platform-audit, extracted from platform-audit.controller.ts.
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

export const PLATFORM_AUDIT_EVENT_KINDS = [
  "taxonomy_category_approved",
  "taxonomy_category_rejected",
  "cluster_merge_approved",
  "cluster_merge_rejected",
  "discovery_skill_created",
  "discovery_skill_updated",
  "discovery_skill_deleted",
  "discovery_region_created",
  "discovery_region_updated",
  "discovery_region_deleted",
  "market_insight_created",
  "market_insight_updated",
  "market_insight_deleted",
  "market_insight_published",
  "market_insight_unpublished",
  "supplier_created",
  "supplier_updated",
  "content_review_approved",
  "content_review_rejected",
  "platform_role_granted",
  "platform_role_revoked",
] as const;

/**
 * `fromSequence`, not `page`. The sequence is gapless and monotonic by construction, so it
 * is a better cursor than any timestamp — and an append-only log is exactly the shape where
 * OFFSET drifts under concurrent writes (§4c rule 4).
 */
export const ListPlatformAuditQuerySchema = z
  .object({
    fromSequence: z.coerce.number().int().min(1).optional(),
    eventKind: z.enum(PLATFORM_AUDIT_EVENT_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
